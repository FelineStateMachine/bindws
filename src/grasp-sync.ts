// Bounded GRASP-02/03 reconciliation. Durable windows retain history gaps;
// each connection follows EOSE with a live tail and overlaps the next wake.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "./negentropy.ts";
import { Socket, localName, type PullSocket } from "./pull.ts";
import { validate, now, isPrivate, isEphemeral, type Event } from "./event.ts";
import { match, type Filter } from "./filter.ts";
import { featureOn } from "./settings.ts";
import { announcements, hostedAnnouncements, graspEvents, graspVisible } from "./grasp-state.ts";
import { repositoryCoordinate, recursiveMaintainers, relatedRepositoryCoordinates } from "./grasp-policy.ts";
import { gitSource } from "./grasp-git-sync.ts";
import { KIND_GIT_ISSUE, KIND_GIT_PATCH, KIND_GIT_PR, KIND_GIT_PR_UPDATE, KIND_REPO, KIND_REPO_STATE } from "./kinds.ts";
import type { Relay } from "./relay.ts";

export const GRASP_SYNC_PAGE = 256;
const MAX_JOBS = 512, MAX_SOURCES = 16, MAX_WINDOWS = 128, LIVE_MS = 1500, ROUND_MS = 10_000;
const UTF8 = new TextEncoder();
type Window = { since: number; until: number };
type Scope = { repo: string; mode: "repository" | "thread" | "metadata"; filters: Filter[] };
type Job = { id: string; source: string; scope: Scope };
type Row = { id: string; source: string; scope: string; windows: string; live_since: number; due: number; failures: number; error: string };
export type GraspSyncConnect = (relay: Relay, source: string) => Promise<PullSocket>;
const enabled = (relay: Relay) => featureOn(relay.settings.policy, "grasp02") && relay.settings.policy.reads === "open" && !relay.settings.isUnclaimed() && !relay.fuelStatus().outOfFuel;

export function eventSource(relay: Relay, raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "wss:") return null;
    u.protocol = "https:";
    const safe = gitSource(relay, u.href);
    return safe ? safe.replace(/^https:/u, "wss:") : null;
  } catch { return null; }
}

const productionConnect: GraspSyncConnect = async (relay, source) => {
  const safe = eventSource(relay, source);
  if (!safe) throw new Error("source-not-admitted");
  const url = new URL(safe.replace(/^wss:/u, "https:"));
  const local = localName(url, relay.domain);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ROUND_MS);
  try {
    const init: RequestInit = { headers: { upgrade: "websocket", ...(local ? { "x-relay-name": local } : {}) }, redirect: "manual", signal: abort.signal };
    const response = local ? await relay.relays.getByName(local).fetch(url.href, init) : await relay.fetcher(url.href, init);
    if (response.status !== 101 || !response.webSocket) { await response.body?.cancel(); throw new Error("websocket-refused"); }
    response.webSocket.accept();
    return new Socket(response.webSocket);
  } finally { clearTimeout(timer); }
};

function jobs(relay: Relay): { jobs: Job[]; partial: boolean } {
  const result = new Map<string, Job>();
  let partial = false;
  const sources = (raw: string[]) => {
    const values = [...new Set(raw.map(s => eventSource(relay, s)).filter((s): s is string => s !== null))].sort();
    if (values.length > MAX_SOURCES) partial = true;
    return values.slice(0, MAX_SOURCES);
  };
  const add = (scope: Scope, urls: string[]) => {
    for (const source of sources(urls)) {
      const id = bytesToHex(sha256(UTF8.encode(JSON.stringify({ source, scope }))));
      if (result.has(id)) continue;
      if (result.size >= MAX_JOBS) { partial = true; return; }
      result.set(id, { id, source, scope });
    }
  };
  const all = announcements(relay);
  const roots = [KIND_GIT_ISSUE, KIND_GIT_PATCH, KIND_GIT_PR, KIND_GIT_PR_UPDATE].flatMap(k => { const events = graspEvents(relay, k); if (events.length >= 1025) partial = true; return events; }).filter(e => graspVisible(relay, e.id));
  const rootCoordinates = new Map(roots.map(e => [e.id, relatedRepositoryCoordinates(e)]));
  for (const repo of hostedAnnouncements(relay)) {
    const coordinate = repositoryCoordinate(repo);
    const maintainers = recursiveMaintainers(repo, all);
    if (!maintainers) { partial = true; continue; }
    add({ repo: coordinate, mode: "repository", filters: [
      { kinds: [KIND_REPO, KIND_REPO_STATE], authors: [...maintainers].sort(), tags: { d: [repo.identifier] } },
      { tags: { a: [coordinate] } }, { tags: { A: [coordinate] } },
      { tags: { e: [repo.id] } }, { tags: { E: [repo.id] } },
    ] }, repo.relays);
    const threads = roots.filter(e => rootCoordinates.get(e.id)?.includes(coordinate) || e.tags.some(t => (t[0] === "e" || t[0] === "E") && rootCoordinates.get(t[1])?.includes(coordinate))).sort((a, b) => a.id.localeCompare(b.id));
    for (let start = 0; start < threads.length; start += 50) {
      const batch = threads.slice(start, start + 50), ids = batch.map(e => e.id);
      const filters: Filter[] = [{ tags: { e: ids } }, { tags: { E: ids } }];
      const mentioned = [...new Set(batch.flatMap(e => e.tags.filter(t => t[0] === "e" || t[0] === "E").map(t => t[1]).filter(id => /^[0-9a-f]{64}$/u.test(id))))];
      if (mentioned.length > 50) partial = true;
      if (mentioned.length) filters.push({ ids: mentioned.slice(0, 50).sort(), tags: {} });
      const outboxes: string[] = [];
      if (featureOn(relay.settings.policy, "grasp03")) {
        const authors = new Set(batch.map(e => e.pubkey));
        for (const f of filters.slice(0, 2)) {
          const rows = relay.store.query(f, { pubkeys: [], all: true }, GRASP_SYNC_PAGE, now()).rows;
          if (rows.length >= GRASP_SYNC_PAGE) partial = true;
          for (const raw of rows) { const e = JSON.parse(raw) as Event; if (!isPrivate(e.kind) && graspVisible(relay, e.id)) authors.add(e.pubkey); }
        }
        if (authors.size > 64) partial = true;
        for (const author of [...authors].sort().slice(0, 64)) {
          const lists = relay.store.query({ kinds: [10002], authors: [author], tags: {} }, { pubkeys: [], all: true }, 1, now()).rows;
          const outbox = lists.flatMap(raw => (JSON.parse(raw) as Event).tags.filter(t => t[0] === "r" && (!t[2] || t[2] === "write")).map(t => t[1]));
          outboxes.push(...outbox);
          add({ repo: coordinate, mode: "metadata", filters: [{ kinds: [0, 10002, 10317], authors: [author], tags: {} }] }, [...repo.relays, ...outbox]);
        }
      }
      add({ repo: coordinate, mode: "thread", filters }, [...repo.relays, ...outboxes]);
    }
  }
  return { jobs: [...result.values()], partial };
}

const wire = (f: Filter, range: Partial<Window>) => ({ ...(f.ids ? { ids: f.ids } : {}), ...(f.kinds ? { kinds: f.kinds } : {}), ...(f.authors ? { authors: f.authors } : {}), ...Object.fromEntries(Object.entries(f.tags).map(([k, v]) => ["#" + k, v])), ...range, limit: GRASP_SYNC_PAGE });

async function round(relay: Relay, job: Job, row: Row, connect: GraspSyncConnect) {
  const windows: Window[] = JSON.parse(row.windows);
  let warning = "", liveSince = row.live_since;
  const socket = await connect(relay, job.source);
  const deadline = Date.now() + ROUND_MS;
  let messages = 0, bytes = 0;
  const send = (...m: unknown[]) => { relay.meterBytes(0, UTF8.encode(JSON.stringify(m)).length); socket.send(...m); };
  const recv = async (end: number) => {
    if (++messages > 1024 || Date.now() >= deadline) throw new Error("round-limit");
    const m = await socket.recv(Math.max(1, Math.min(end, deadline) - Date.now()));
    const n = UTF8.encode(JSON.stringify(m)).length;
    relay.meterBytes(n, 0); bytes += n;
    if (bytes > 4 * 1024 * 1024 || n > 512 * 1024) throw new Error("byte-limit");
    return m;
  };
  const accept = async (raw: unknown, range: Partial<Window>) => {
    if (validate(raw)) { warning = "invalid-event"; return; }
    const e = raw as Event;
    if (!job.scope.filters.some(f => match({ ...f, ...range }, e))) { warning = "out-of-scope-event"; return; }
    if (isPrivate(e.kind) || isEphemeral(e.kind) || e.tags.some(t => t[0] === "-")) { warning = "private-event-skipped"; return; }
    if (!enabled(relay)) throw new Error("sync-disabled");
    const result = await relay.acceptAny(e, { host: `${relay.slug}.${relay.domain}`, ip: "grasp-sync", challenge: "", authed: [], subs: {} });
    if (result.stored) relay.broadcast(e, false);
    if (!result.ok) warning = "admission-gap";
  };
  try {
    if (windows.length) {
      const range = windows[windows.length - 1], sub = "grasp-history";
      let received = 0;
      send("REQ", sub, ...job.scope.filters.map(f => wire(f, range)));
      while (true) {
        const m = await recv(deadline);
        if (m[1] !== sub) continue;
        if (m[0] === "EOSE") break;
        if (m[0] === "CLOSED") throw new Error("history-refused");
        if (m[0] !== "EVENT") continue;
        if (++received > GRASP_SYNC_PAGE * job.scope.filters.length) throw new Error("page-limit");
        await accept(m[2], range);
      }
      send("CLOSE", sub);
      if (received >= GRASP_SYNC_PAGE) {
        if (range.since >= range.until) warning = "partial-single-second";
        else if (windows.length >= MAX_WINDOWS) warning = "partial-window-limit";
        else {
          windows.pop();
          const mid = range.since + Math.floor((range.until - range.since) / 2);
          windows.push({ since: range.since, until: mid }, { since: mid + 1, until: range.until });
        }
      } else if (!warning) windows.pop(); // Invalid/refused coverage remains repairable.
    }
    const historyWarning = warning;
    warning = "";
    const sub = "grasp-live", began = now(), range = { since: row.live_since };
    const end = Math.min(deadline, Date.now() + LIVE_MS);
    let eose = false, received = 0;
    send("REQ", sub, ...job.scope.filters.map(f => wire(f, range)));
    while (Date.now() < end) {
      let m: unknown[];
      try { m = await recv(end); } catch (error) { if (!eose || messages > 1024 || bytes > 4 * 1024 * 1024 || (error instanceof Error && error.message === "byte-limit")) throw error; break; }
      if (m[1] !== sub) continue;
      if (m[0] === "CLOSED") throw new Error("live-refused");
      if (m[0] === "EOSE") { eose = true; continue; }
      if (m[0] !== "EVENT") continue;
      if (++received > GRASP_SYNC_PAGE) { warning = "partial-live-limit"; break; }
      await accept(m[2], range);
    }
    send("CLOSE", sub);
    if (!eose) throw new Error("live-missing-eose");
    if (received >= GRASP_SYNC_PAGE || warning) {
      if (windows.length < MAX_WINDOWS) windows.push({ since: row.live_since, until: began });
      else warning = "partial-window-limit";
      // Keep the inclusive live cursor when coverage was uncertain.
    } else liveSince = began;
    return { windows, liveSince, warning: warning || historyWarning };
  } finally { socket.close(); }
}

// One fair, bounded source round per wake; failed jobs reserve their retry
// before I/O. Source/filter changes remove stale jobs, including outboxes.
export async function graspSyncTick(relay: Relay, connect: GraspSyncConnect = productionConnect): Promise<number> {
  if (!enabled(relay)) return 0;
  if (!relay.repositoryAccess.owned) throw new Error("event synchronization requires repository authority");
  const current = jobs(relay), ids = new Set(current.jobs.map(j => j.id));
  relay.sql.exec(`INSERT INTO grasp_sync_status(id,partial) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET partial=excluded.partial WHERE partial!=excluded.partial`, current.partial ? 1 : 0);
  const existing = new Set(relay.sql.exec<{ id: string }>(`SELECT id FROM grasp_event_sync`).toArray().map(row => row.id));
  for (const id of existing) if (!ids.has(id)) relay.sql.exec(`DELETE FROM grasp_event_sync WHERE id=?`, id);
  for (const j of current.jobs) if (!existing.has(j.id)) relay.sql.exec(`INSERT OR IGNORE INTO grasp_event_sync(id,source,scope,windows,live_since) VALUES(?,?,?,?,?)`, j.id, j.source, JSON.stringify(j.scope), JSON.stringify([{ since: 0, until: now() }]), now());
  const row = relay.sql.exec<Row>(`SELECT * FROM grasp_event_sync ORDER BY due,id LIMIT 1`).toArray()[0];
  if (!row) return 0;
  if (row.due > now()) return row.due;
  relay.sql.exec(`UPDATE grasp_event_sync SET due=?,failures=failures+1 WHERE id=?`, now() + Math.min(300, 30 * 2 ** Math.min(row.failures, 4)), row.id);
  try {
    const result = await round(relay, current.jobs.find(j => j.id === row.id)!, row, connect);
    relay.sql.exec(`UPDATE grasp_event_sync SET windows=?,live_since=?,due=?,failures=0,error=? WHERE id=?`, JSON.stringify(result.windows), result.liveSince, now() + (result.warning ? 300 : result.windows.length ? 1 : 60), result.warning, row.id);
  } catch (error) {
    relay.sql.exec(`UPDATE grasp_event_sync SET error=? WHERE id=?`, (error instanceof Error ? error.message : "sync-failed").slice(0, 120), row.id);
  }
  const next = relay.sql.exec<{ due: number | null }>(`SELECT min(due) AS due FROM grasp_event_sync`).one().due;
  return next === null ? 0 : Math.max(now() + 1, next);
}
