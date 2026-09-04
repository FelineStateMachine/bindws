// GRASP-01 Smart HTTP on a relay origin. Nostr events authorize changes;
// ntig owns the conditional R2 root, pack verification and Git protocol.
import { createGitHandler, createAcceptedStateRepository, WalRepository, NativeGitEngine, R2ObjectStore, parseRepositoryPath, repositoryAddress, repositoryStoragePrefix, readObjects, LimitError, type ObjectStore, type CommitRequest, type GitRepository } from "ntig";
import { npubEncode, naddrEncode } from "nostr-tools/nip19";
import { now, tag, type Event } from "./event.ts";
import { KIND_REPO, KIND_REPO_STATE, KIND_GIT_PR, KIND_GIT_PR_UPDATE } from "./kinds.ts";
import { featureOn } from "./settings.ts";
import { page, escapeHTML as esc } from "./ui.ts";
import { repositoryCoordinate, type RepositoryAnnouncement } from "./grasp-policy.ts";
import { hostedAnnouncements, repository, repositoryState, graspBytes, requiredObjects, eventRepository, PR_REF_SECONDS } from "./grasp-state.ts";
import type { Relay } from "./relay.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "Content-Type, Authorization, Git-Protocol, X-Git-Request-Id" };
export function graspCORS(response: Response, preflight = false): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  if (preflight) { void response.body?.cancel(); return new Response(null, { status: 204, headers }); }
  return new Response(response.body, { status: response.status, headers });
}
const answer = (reason: string, status: number) => new Response(reason, { status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
// isGitPath reserves malformed Git paths too, so every failure has CORS.
export const isGitPath = (url: URL) => /^\/(?:npub|prs\/)/.test(url.pathname) || /\.git(?:\/|$)/.test(url.pathname);

// gitRepository records each R2 key's retained size, including orphan writes.
// Reservations precede PUT: an ambiguous response never makes bytes free.
export async function gitRepository(relay: Relay, repo: RepositoryAnnouncement): Promise<WalRepository> {
  const prefix = `${relay.slug}/git/${await repositoryStoragePrefix(repositoryAddress(npubEncode(repo.owner), repo.identifier))}`;
  const r2 = new R2ObjectStore(relay.media, { prefix, maxObjectBytes: 4 * 1024 * 1024 });
  const store: ObjectStore = {
    get: async (key) => r2.get(key),
    put: async (key, bytes, expected) => {
      const full = prefix + key;
      const old = relay.sql.exec<{ size: number }>(`SELECT size FROM grasp_objects WHERE key=?`, full).toArray()[0]?.size ?? 0;
      const increase = Math.max(0, bytes.length - old);
      if (increase && relay.fuelStatus().outOfFuel) throw new LimitError("Relay storage or fuel limit reached");
      const limit = relay.settings.limitsOf(repo.owner)?.cap ?? 0;
      const owned = relay.sql.exec<{ n: number }>(`SELECT coalesce(sum(size),0) AS n FROM grasp_objects WHERE owner=?`, repo.owner).one().n;
      if (limit && owned + relay.store.authorBytes(repo.owner) + increase > limit) throw new LimitError("Repository owner's storage cap reached");
      if (graspBytes(relay) + increase > 320 * 1024 * 1024) throw new LimitError("Relay Git storage quota reached");
      relay.sql.exec(`INSERT INTO grasp_objects(key,owner,size) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET size=max(size,excluded.size)`, full, repo.owner, bytes.length);
      const stored = await r2.put(key, bytes, expected);
      if (stored) relay.sql.exec(`UPDATE grasp_objects SET size=? WHERE key=?`, bytes.length, full);
      else {
        const actual = await relay.media.head(full);
        if (actual) relay.sql.exec(`UPDATE grasp_objects SET size=? WHERE key=?`, actual.size, full);
        else relay.sql.exec(`DELETE FROM grasp_objects WHERE key=?`, full);
      }
      return stored;
    },
  };
  return new WalRepository(store, new NativeGitEngine(), { prefix: "data/" });
}

// prTip distinguishes unknown IDs from known events that cannot authorize
// this repository. Purgatory PRs may authorize their own arriving objects.
function prTip(relay: Relay, repo: RepositoryAnnouncement, id: string): string | null | false {
  const row = relay.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE id=?`, id).toArray()[0];
  if (!row) {
    const timed = relay.sql.exec<{ until: number }>(`SELECT until FROM grasp_pr_refs WHERE repo=? AND ref=?`, repositoryCoordinate(repo), `refs/nostr/${id}`).toArray()[0];
    return timed && timed.until <= now() ? false : null;
  }
  const e = JSON.parse(row.raw) as Event;
  if (![KIND_GIT_PR, KIND_GIT_PR_UPDATE].includes(e.kind) || relay.settings.isEventHidden(id) || relay.settings.isEventBanned(id) || relay.settings.isBanned(e.pubkey)) return false;
  const exp = Number(tag(e, "expiration"));
  if (exp && exp <= now()) return false;
  if (eventRepository(relay, e)?.id !== repo.id) return false;
  return /^[0-9a-f]{40}$/.test(tag(e, "c")) ? tag(e, "c") : false;
}

// promote checks pending work before loading Git packs, and rechecks authority
// after the read. Replays still finish promotion left pending by an earlier write.
async function promote(relay: Relay, repo: RepositoryAnnouncement, wal: WalRepository) {
  const requiredFor = (e: Event) => {
    if (relay.settings.isEventHidden(e.id) || relay.settings.isEventBanned(e.id) || relay.settings.isBanned(e.pubkey)) return null;
    const relevant = e.kind === KIND_REPO ? repository(relay, repo.owner, repo.identifier)?.id === e.id : e.kind === KIND_REPO_STATE ? tag(e, "d") === repo.identifier && repositoryState(relay, repo)?.id === e.id : eventRepository(relay, e)?.id === repo.id;
    return relevant ? requiredObjects(relay, e) : null;
  };
  const pending = () => relay.sql.exec<{ raw: string }>(`SELECT raw FROM events JOIN grasp_pending ON grasp_pending.id=events.id WHERE grasp_pending.until>? AND (events.expires=0 OR events.expires>?) LIMIT 1024`, now(), now()).toArray();
  if (!pending().some(({ raw }) => requiredFor(JSON.parse(raw) as Event) !== null)) return;
  const snapshot = await wal.load();
  if (!snapshot.sequence) return;
  const objects = await readObjects(snapshot.packs);
  for (const { raw } of pending()) {
    const e = JSON.parse(raw) as Event;
    const required = requiredFor(e);
    if (required && required.every((oid) => objects.has(oid))) {
      relay.sql.exec(`DELETE FROM grasp_pending WHERE id=?`, e.id);
      relay.broadcast(e);
    }
  }
}

// authorizedRepository adds event authority to the WAL without duplicating refs.
function authorizedRepository(relay: Relay, repo: RepositoryAnnouncement, wal: WalRepository): GitRepository {
  const authorized = createAcceptedStateRepository(wal, {
    lookupState: async () => { const state = repositoryState(relay, repo); return state ? { eventId: state.id, refs: state.refs, head: state.head } : null; },
    lookupPrTip: async (id) => prTip(relay, repo, id),
    allowUnknownPrRefs: true,
  });
  return {
    load: () => authorized.load(),
    loadRefs: () => authorized.loadRefs ? authorized.loadRefs() : authorized.load(),
    commit: async (request: CommitRequest) => {
      const receipt = await authorized.commit(request);
      for (const update of request.updates) {
        if (!/^refs\/nostr\/[0-9a-f]{64}$/.test(update.name)) continue;
        if (update.new === null) relay.sql.exec(`DELETE FROM grasp_pr_refs WHERE repo=? AND ref=?`, repositoryCoordinate(repo), update.name);
        else relay.sql.exec(`INSERT INTO grasp_pr_refs(repo,ref,until) VALUES(?,?,?) ON CONFLICT(repo,ref) DO NOTHING`, repositoryCoordinate(repo), update.name, now() + PR_REF_SECONDS);
      }
      await promote(relay, repo, wal);
      return receipt;
    },
  };
}

// grasp serves Git only while open reads, admission and fuel permit hosting.
// One in-flight operation bounds memory and fences all relay-side mutations.
export async function grasp(relay: Relay, req: Request, url: URL): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!featureOn(relay.settings.policy, "grasp")) return answer("not found", 404);
  if (relay.settings.policy.reads !== "open") return answer("restricted: public Git hosting requires open reads", 403);
  if (relay.settings.isUnclaimed() || relay.settings.leaseExpired(now())) return answer("restricted: relay is not active", 403);
  const parsed = parseRepositoryPath(url.pathname);
  if (!parsed || parsed.alternativePRs) return answer("not found", 404);
  const repo = repository(relay, parsed.address.pubkey, parsed.address.identifier);
  if (!repo) return answer("not found", 404);
  const limited = relay.ipLimit(req.headers.get("x-relay-ip") || "unknown", req.method === "POST" ? "events" : "reqs");
  if (limited) return answer(limited, 429);
  if (relay.fuelStatus().outOfFuel) return answer("restricted: relay storage or fuel limit reached", 403);
  if (relay.graspBusy || relay.graspControls) return answer("restricted: Git transaction in progress; retry", 429);
  relay.graspBusy = true;
  try {
    if (parsed.endpoint === "root") {
      if (req.method !== "GET" && req.method !== "HEAD") return answer("invalid: method not allowed", 405);
      const coordinate = naddrEncode({ kind: KIND_REPO, pubkey: repo.owner, identifier: repo.identifier });
      const html = page(repo.identifier, `<h1>${esc(repo.identifier)}</h1><p>Git storage follows signed Nostr repository state.</p><p><a href="nostr:${coordinate}">Open in a Nostr Git client</a></p><pre>git clone ${esc(relay.webURL(url.host) + parsed.prefix)}</pre>`);
      return new Response(req.method === "HEAD" ? null : html, { headers: { ...CORS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    const wal = await gitRepository(relay, repo);
    const handler = createGitHandler(authorizedRepository(relay, repo, wal), { prefix: parsed.prefix, authorizePush: () => true, observe: (event) => relay.meterBytes(event.requestBytes, event.responseBytes) });
    const response = await handler(req);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return answer(error instanceof LimitError ? "restricted: Git repository limit reached" : "error: Git repository unavailable", error instanceof LimitError ? 413 : 503);
  } finally {
    relay.graspBusy = false;
    await relay.ensureAlarm(now() + 60);
  }
}

// graspTick expires purgatory and cleans one repository per alarm. Event
// deletion removes visibility; retained R2 objects remain charged until teardown.
export async function graspTick(relay: Relay): Promise<number> {
  relay.sql.exec(`DELETE FROM events WHERE id IN (SELECT id FROM grasp_pending WHERE until<=?)`, now());
  const all = hostedAnnouncements(relay);
  const last = relay.sql.exec<{ coordinate: string }>(`SELECT coordinate FROM grasp_tick WHERE id=1`).toArray()[0]?.coordinate ?? "";
  const ordered = all.sort((a, b) => repositoryCoordinate(a).localeCompare(repositoryCoordinate(b)));
  const repo = ordered.find((r) => repositoryCoordinate(r) > last) ?? ordered[0];
  if (repo) relay.sql.exec(`INSERT OR REPLACE INTO grasp_tick(id,coordinate) VALUES(1,?)`, repositoryCoordinate(repo));
  for (const { repo: coordinate } of relay.sql.exec<{ repo: string }>(`SELECT DISTINCT repo FROM grasp_pr_refs`).toArray()) {
    if (!all.some((r) => repositoryCoordinate(r) === coordinate)) relay.sql.exec(`DELETE FROM grasp_pr_refs WHERE repo=?`, coordinate);
  }
  if (repo && featureOn(relay.settings.policy, "grasp") && !relay.fuelStatus().outOfFuel) {
    try {
      const wal = await gitRepository(relay, repo);
      const snapshot = await wal.load();
      const refs = relay.sql.exec<{ ref: string }>(`SELECT ref FROM grasp_pr_refs WHERE repo=? AND until<=?`, repositoryCoordinate(repo), now()).toArray();
      for (const { ref } of refs) {
        const current = snapshot.refs[ref];
        const tip = prTip(relay, repo, ref.slice("refs/nostr/".length));
        if (current && tip !== current) await wal.commit({ id: `expire:${ref.slice(-64)}:${current}`, updates: [{ name: ref, old: current, new: null }] });
        relay.sql.exec(`DELETE FROM grasp_pr_refs WHERE repo=? AND ref=?`, repositoryCoordinate(repo), ref);
      }
      await promote(relay, repo, wal);
    } catch { /* The next bounded alarm retries; retained bytes stay metered. */ }
  }
  const earliest = relay.sql.exec<{ n: number | null }>(`SELECT min(at) AS n FROM (SELECT until AS at FROM grasp_pending UNION ALL SELECT until AS at FROM grasp_pr_refs)`).one().n;
  return earliest === null ? 0 : now() + 60;
}
