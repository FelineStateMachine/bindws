// GRASP-02 Git reconciliation uses signed event targets and one bounded source
// attempt per alarm. Durable due times survive restarts and rotate failed sources.
import { fetchGitPack, readObjects, objectLinks, encodePack, sha256, classifyError } from "ntig";
import { now, tag, type Event } from "./event.ts";
import { featureOn } from "./settings.ts";
import { KIND_GIT_PR, KIND_GIT_PR_UPDATE } from "./kinds.ts";
import { graspEvents, hostedAnnouncements, repositoryState, eventRepository, repository } from "./grasp-state.ts";
import { authorizedRepository, alternativePrAddress, gitRepository, promote } from "./grasp.ts";
import { localName } from "./pull.ts";
import type { RepositoryAnnouncement } from "./grasp-policy.ts";
import type { Relay } from "./relay.ts";

interface Task { id: string; repo: RepositoryAnnouncement; eventId: string; event?: Event; refs: Record<string, string>; sources: string[]; }
const HOUR = 3600;
const RETRY = 300;

// gitSource accepts public HTTPS names or another local relay's binding path.
export function gitSource(relay: Relay, raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/\.$/u, "");
    url.hostname = host;
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) return null;
    if (!host.includes(".") || /^[0-9.]+$/.test(host) || host.includes(":") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return null;
    if (localName(url, relay.domain) === relay.slug || relay.settings.policy.customHosts.some(h => h.host === host)) return null;
    return url.href.replace(/\/$/u, "");
  } catch { return null; }
}

async function sourceFetch(relay: Relay, request: Request): Promise<Response> {
  if (!gitSource(relay, request.url.split("?")[0])) throw new Error("restricted: Git source is not admitted");
  const url = new URL(request.url);
  const local = localName(url, relay.domain);
  if (local) {
    const headers = new Headers(request.headers);
    headers.set("x-relay-name", local);
    return relay.relays.getByName(local).fetch(new Request(request, { headers }));
  }
  return relay.fetcher(request.url, {
    method: request.method, headers: request.headers, redirect: "manual", signal: request.signal,
    ...(request.method === "POST" ? { body: await request.arrayBuffer() } : {}),
  });
}

function tasks(relay: Relay): Task[] {
  const result: Task[] = [];
  for (const repo of hostedAnnouncements(relay)) {
    const state = repositoryState(relay, repo);
    if (state) result.push({ id: `state:${repo.id}:${state.id}`, repo, eventId: state.id, refs: { ...state.refs }, sources: repo.clone });
  }
  for (const e of [...graspEvents(relay, KIND_GIT_PR), ...graspEvents(relay, KIND_GIT_PR_UPDATE)]) {
    const repo = eventRepository(relay, e);
    const tip = tag(e, "c");
    if (!repo || !/^(?!0{40}$)[0-9a-f]{40}$/.test(tip)) continue;
    // PR objects belong to the target's ordinary repository, as GRASP-02 requires.
    // GRASP-06 is an independent upload service, not a sync destination.
    result.push({ id: `pr:${repo.id}:${e.id}`, repo, eventId: e.id, event: e, refs: { [`refs/nostr/${e.id}`]: tip }, sources: e.tags.filter(t => t[0] === "clone").flatMap(t => t.slice(1)) });
  }
  return result;
}

async function reconcile(relay: Relay, task: Task, attempt: number): Promise<boolean> {
  const wal = await gitRepository(relay, task.repo);
  const snapshot = await wal.loadRefs();
  const names = new Set(Object.keys(task.refs));
  if (!task.event) for (const name of Object.keys(snapshot.refs)) if (!name.startsWith("refs/nostr/")) names.add(name);
  const updates = [...names].filter(name => (snapshot.refs[name] ?? null) !== (task.refs[name] ?? null)).map(name => ({ name, old: snapshot.refs[name] ?? null, new: task.refs[name] ?? null }));
  if (!updates.length) { await promote(relay, task.repo, wal); return true; }
  const current = await wal.load();
  const objects = await readObjects(current.packs);
  const missing = [...new Set(Object.values(task.refs))].filter(oid => !objects.has(oid));
  let pack: Uint8Array | undefined;
  if (missing.length && task.event) {
    // A contributor may have uploaded here through GRASP-06. Copy its
    // authorized object graph locally instead of fetching this relay over HTTP.
    const address = alternativePrAddress(relay, task.event);
    if (address) {
      const local = await gitRepository(relay, address, true);
      const ref = `refs/nostr/${task.event.id}`;
      if ((await local.loadRefs()).refs[ref] === tag(task.event, "c")) {
        const available = await readObjects((await local.load()).packs);
        const needed = new Set<string>(), queue = new Set(missing);
        while (queue.size) {
          const oid = queue.values().next().value!;
          queue.delete(oid);
          if (needed.has(oid)) continue;
          const object = available.get(oid);
          if (!object) throw new Error("Local PR object graph is incomplete");
          needed.add(oid);
          for (const link of objectLinks(object)) {
            if (!available.has(link.oid)) throw new Error("Local PR dependency is missing");
            if (!needed.has(link.oid)) queue.add(link.oid);
          }
        }
        pack = await encodePack([...needed].map(oid => available.get(oid)!));
      }
    }
  }
  if (missing.length && !pack) {
    const sources = [...new Set(task.sources.map(raw => gitSource(relay, raw)).filter((value): value is string => value !== null))].slice(0, 16);
    if (!sources.length) throw new Error("No admitted Git source");
    const source = sources[attempt % sources.length];
    const fetched = await fetchGitPack(source, {
      wants: missing,
      fetch: request => sourceFetch(relay, request),
      timeoutMs: 10_000,
      observe: event => relay.meterBytes(event.responseBytes, event.requestBytes),
    });
    pack = fetched.pack;
  }
  // The alarm owns the authority fence, but clocks, event expiry and fuel may change.
  if (!featureOn(relay.settings.policy, "grasp02") || relay.fuelStatus().outOfFuel || repository(relay, task.repo.owner, task.repo.identifier)?.id !== task.repo.id) return false;
  if (!task.event && repositoryState(relay, task.repo)?.id !== task.eventId) return false;
  const hash = await sha256(new TextEncoder().encode(JSON.stringify({ event: task.eventId, updates })));
  await authorizedRepository(relay, task.repo, wal).commit({ id: `grasp02:${hash}`, updates, ...(pack ? { pack } : {}) });
  return true;
}

// syncGitTick runs under the shared alarm fence and never schedules background writes.
export async function syncGitTick(relay: Relay): Promise<number> {
  if (!featureOn(relay.settings.policy, "grasp02") || relay.settings.policy.reads !== "open" || relay.settings.isUnclaimed() || relay.fuelStatus().outOfFuel) return 0;
  if (!relay.repositoryAccess.owned) throw new Error("Git synchronization requires repository authority");
  const pending = tasks(relay);
  const ids = new Set(pending.map(task => task.id));
  for (const row of relay.sql.exec<{ id: string }>(`SELECT id FROM grasp_git_sync`).toArray()) if (!ids.has(row.id)) relay.sql.exec(`DELETE FROM grasp_git_sync WHERE id=?`, row.id);
  for (const task of pending) relay.sql.exec(`INSERT OR IGNORE INTO grasp_git_sync(id) VALUES(?)`, task.id);
  const candidate = relay.sql.exec<{ id: string; due: number; attempts: number }>(`SELECT id,due,attempts FROM grasp_git_sync ORDER BY due,id LIMIT 1`).toArray()[0];
  if (!candidate) return 0;
  if (candidate.due > now()) return candidate.due;
  const task = pending.find(task => task.id === candidate.id)!;
  // Reserve the retry before network I/O so interruption cannot form a hot loop.
  relay.sql.exec(`UPDATE grasp_git_sync SET due=?,attempts=attempts+1 WHERE id=?`, now() + RETRY, candidate.id);
  try {
    if (await reconcile(relay, task, candidate.attempts)) relay.sql.exec(`UPDATE grasp_git_sync SET due=?,attempts=0,error='' WHERE id=?`, now() + HOUR, candidate.id);
  } catch (error) { relay.sql.exec(`UPDATE grasp_git_sync SET error=? WHERE id=?`, classifyError(error).code, candidate.id); }
  const next = relay.sql.exec<{ due: number | null }>(`SELECT min(due) AS due FROM grasp_git_sync`).one().due;
  return next === null ? 0 : Math.max(now() + 1, next);
}
