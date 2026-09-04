// NIP-9a relay push: bounded registrations, durable work and authenticated delivery.
//
// The queue keeps references rather than event payloads. A deleted event or
// registration therefore disappears at the next validation pass, and a
// callback never receives an event that the author can no longer read.
import { canonical, type Event } from "./event.ts";
import { match, parseFilter, type Filter } from "./filter.ts";
import { callbackOrigin } from "./push-policy.ts";

export const PUSH_KIND = KIND_PUSH_REGISTRATION;
export const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS push_queue (
  registration_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  due INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL,
  PRIMARY KEY (registration_id,event_id)
);
CREATE INDEX IF NOT EXISTS push_queue_due ON push_queue(due,expires);
CREATE TABLE IF NOT EXISTS push_delivered (
  registration_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (registration_id,event_id)
);
CREATE INDEX IF NOT EXISTS push_delivered_at ON push_delivered(delivered_at);
CREATE TRIGGER IF NOT EXISTS push_event_deleted AFTER DELETE ON events BEGIN
  DELETE FROM push_queue WHERE registration_id=old.id OR event_id=old.id;
  DELETE FROM push_delivered WHERE registration_id=old.id;
END;
CREATE TRIGGER IF NOT EXISTS push_member_removed AFTER DELETE ON members BEGIN
  DELETE FROM events WHERE kind=30390 AND pubkey=old.pubkey;
END;
CREATE TRIGGER IF NOT EXISTS push_policy_changed AFTER UPDATE OF value ON settings
WHEN new.key='policy' AND (
  json_extract(new.value,'$.features.push') IS NOT 1 OR
  json_extract(new.value,'$.owner') IS NOT json_extract(old.value,'$.owner') OR
  json_extract(new.value,'$.pushCallbacks') IS NOT json_extract(old.value,'$.pushCallbacks') OR
  json_extract(new.value,'$.reads') IS NOT json_extract(old.value,'$.reads') OR
  json_extract(new.value,'$.writes') IS NOT json_extract(old.value,'$.writes')
) BEGIN
  DELETE FROM push_queue;
END;
`;

const MAX_REGISTRATIONS = 32;
const MAX_AUTHOR_REGISTRATIONS = 4;
const MAX_FILTERS = 8;
const MAX_REGISTRATION_BYTES = 8192;
const MAX_PENDING = 256;
// A NIP event can occupy up to the relay's one MiB message ceiling. The
// larger bound keeps include_event lossless while retaining a hard callback
// allocation limit and room for JSON envelope overhead.
const MAX_EVENT_TEXT = 1024 * 1024;
const MAX_PAYLOAD = 4 * MAX_EVENT_TEXT + 4096;
const MAX_DEDUP = 2048;
const MAX_ATTEMPTS = 4;
const RETRY_SECONDS = [30, 120, 600];
const QUEUE_TTL = 24 * 60 * 60;
const DEDUP_TTL = 7 * 24 * 60 * 60;
const REQUEST_TIMEOUT = 5000;

// All authorization uses the relay's current policy and event read path.
import type { Relay, ConnState } from "./relay.ts";
import { KIND_PUSH_REGISTRATION } from "./kinds.ts";
export type PushRelay = Relay;
export type PushConn = Pick<ConnState, "authed">;

// rows consumes each SQL cursor before recording its billing units.
function rows<T extends Record<string, SqlStorageValue>>(r: Relay, query: string, ...args: SqlStorageValue[]): T[] {
  const cursor = r.sql.exec<T>(query, ...args);
  const result = cursor.toArray();
  r.meterPush(cursor.rowsRead, cursor.rowsWritten);
  return result;
}
const utf8Size = (s: string) => new TextEncoder().encode(s).byteLength;

const tagValues = (e: Event, name: string) => e.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1]);
const tag = (e: Event, name: string) => tagValues(e, name)[0] ?? "";
const featureEnabled = (r: PushRelay) => r.settings.policy.features.push === true;
const ownRelay = (r: PushRelay) => {
  try { return new URL(r.relayURL(r.slug + "." + r.domain)); }
  catch { return null; }
};

function originAllowed(r: PushRelay, raw: string): string {
  const origin = callbackOrigin(raw);
  if (!origin) return "";
  const host = r.pushCallbackOrigins ?? [];
  const owner = r.settings.policy.pushCallbacks ?? [];
  return host.includes(origin) && owner.includes(origin) ? (() => { try { return new URL(raw).href; } catch { return ""; } })() : "";
}

function parseRegistration(e: Event, r: PushRelay): { relay: string; filters: Filter[]; ignores: Filter[]; callback: string; include: boolean } | string {
  if (e.kind !== PUSH_KIND) return "invalid: not a push registration";
  if (utf8Size(canonical(e)) > MAX_REGISTRATION_BYTES) return "invalid: push registration is too large";
  const d = tagValues(e, "d");
  const relays = tagValues(e, "relay");
  const callbacks = tagValues(e, "callback");
  if (d.length !== 1 || !d[0] || d[0].length > 256) return "invalid: push registration needs one d tag";
  if (!relays.length || relays.length > 4 || callbacks.length !== 1) return "invalid: push registration needs relay and callback tags";
  const self = ownRelay(r);
  const relayURL = relays.map((raw) => { try { return new URL(raw); } catch { return null; } }).find((u) => u && /^wss?:$/.test(u.protocol) && u.toString() === self?.toString())?.toString() ?? "";
  if (!self || !relayURL) return "invalid: registration does not name this relay";
  const callback = originAllowed(r, callbacks[0]);
  if (!callback) return "restricted: callback origin is not approved by this relay";
  const read = (name: string): Filter[] | string => {
    const vals = tagValues(e, name);
    if (vals.length > MAX_FILTERS) return "invalid: too many push filters";
    const out: Filter[] = [];
    for (const raw of vals) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return "invalid: push filter is not JSON"; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed as Record<string, unknown>).some((k) => !(["ids", "authors", "kinds", "since", "until"].includes(k) || (k.length === 2 && k[0] === "#")))) return "invalid: unknown push filter field";
      const f = parseFilter(parsed);
      if (typeof f === "string") return "invalid: bad push filter: " + f;
      if (f.kinds?.some((n) => n < 0 || n > 65535) || (f.since !== undefined && f.since < 0) || (f.until !== undefined && f.until < 0)) return "invalid: push filter value out of range";
      out.push(f);
    }
    return out;
  };
  const filters = read("filter");
  const ignores = read("ignore");
  if (typeof filters === "string") return filters;
  if (typeof ignores === "string") return ignores;
  if (!filters.length) return "invalid: push registration needs a filter";
  return { relay: relayURL, filters, ignores, callback, include: e.tags.some((t) => t[0] === "include_event") };
}


// checkPush validates the opt-in registration. Its caller still applies the
// ordinary write gate, while this gate requires the author's AUTH identity.
export function checkPush(r: PushRelay, e: Event, conn: PushConn | null): string {
  if (e.kind !== PUSH_KIND) return "";
  if (!featureEnabled(r)) return "unsupported: relay push is switched off";
  if (!conn?.authed.includes(e.pubkey)) return "auth-required: push registration must be authenticated as its author";
  if (!r.settings.isAllowed(e.pubkey)) return "restricted: push registrations are limited to relay members";
  const parsed = parseRegistration(e, r);
  if (typeof parsed === "string") return parsed;
  const total = rows<{ n: number }>(r, `SELECT count(*) AS n FROM events WHERE kind=?`, PUSH_KIND)[0].n;
  if (total >= MAX_REGISTRATIONS && !rows(r, `SELECT 1 FROM events WHERE pubkey=? AND kind=? AND d=?`, e.pubkey, PUSH_KIND, tag(e, "d")).length) return "restricted: relay push registration limit reached";
  const mine = rows<{ n: number }>(r, `SELECT count(*) AS n FROM events WHERE kind=? AND pubkey=?`, PUSH_KIND, e.pubkey)[0].n;
  if (mine >= MAX_AUTHOR_REGISTRATIONS && !rows(r, `SELECT 1 FROM events WHERE pubkey=? AND kind=? AND d=?`, e.pubkey, PUSH_KIND, tag(e, "d")).length) return "restricted: author push registration limit reached";
  return "";
}

// authorized checks current membership and both read/write policy. Callback
// destinations never inherit the owner's broad export privileges.
function authorized(r: Relay, pubkey: string): boolean {
  return !r.settings.isUnclaimed() && !r.settings.leaseExpired(Math.floor(Date.now() / 1000)) && r.settings.isAllowed(pubkey) && !r.settings.isBanned(pubkey) && !r.settings.mayRead([pubkey]) && !r.settings.mayWrite(pubkey);
}

function visible(r: Relay, id: string, author: string, t: number): Event | null {
  if (r.settings.isEventBanned(id)) return null;
  // Imports and the HTTP bridge may hold events larger than websocket
  // messages. Do not materialize those rows for callback fanout.
  if (!rows(r, `SELECT 1 FROM events WHERE id=? AND length(raw)<=?`, id, MAX_EVENT_TEXT).length) return null;
  const raw = r.store.query({ ids: [id], tags: {} }, { pubkeys: [author] }, 1, t).rows[0];
  return raw ? JSON.parse(raw) as Event : null;
}

// queuePush persists bounded references without any callback I/O. A true
// return asks the caller to keep alarm scheduling alive beyond its response.
export function queuePush(r: Relay, e: Event): boolean {
  if (!featureEnabled(r) || e.kind === PUSH_KIND) return false;
  const t = Math.floor(Date.now() / 1000);
  const registrations = rows<{ id: string; pubkey: string }>(r, `SELECT id,pubkey FROM events WHERE kind=? ORDER BY created_at DESC LIMIT ?`, PUSH_KIND, MAX_REGISTRATIONS);
  let added = false;
  for (const row of registrations) {
    if (!authorized(r, row.pubkey)) continue;
    const reg = visible(r, row.id, row.pubkey, t);
    if (!reg || !visible(r, e.id, row.pubkey, t)) continue;
    const p = parseRegistration(reg, r);
    if (typeof p === "string" || !p.filters.some((f) => match(f, e)) || p.ignores.some((f) => match(f, e))) continue;
    if (rows(r, `SELECT 1 FROM push_delivered WHERE registration_id=? AND event_id=?`, row.id, e.id).length) continue;
    if (rows<{ n: number }>(r, `SELECT count(*) AS n FROM push_queue`)[0].n >= MAX_PENDING) break;
    rows(r, `INSERT OR IGNORE INTO push_queue(registration_id,event_id,due,attempts,expires) VALUES(?,?,?,?,?)`, row.id, e.id, t, 0, t + QUEUE_TTL);
    added = true;
  }
  return added;
}

function payload(e: Event, relayURL: string, include: boolean): string {
  return JSON.stringify({ id: e.id, relay: relayURL, ...(include ? { event: e } : {}) });
}

function finish(r: Relay, registration: string, event: string, t: number) {
  rows(r, `DELETE FROM push_queue WHERE registration_id=? AND event_id=?`, registration, event);
  rows(r, `INSERT OR REPLACE INTO push_delivered(registration_id,event_id,delivered_at) VALUES(?,?,?)`, registration, event, t);
  rows(r, `DELETE FROM push_delivered WHERE rowid IN (SELECT rowid FROM push_delivered ORDER BY delivered_at ASC,rowid ASC LIMIT max(0,(SELECT count(*) FROM push_delivered)-?))`, MAX_DEDUP);
}

// pushTick runs outside the repository admission lock, so slow callbacks
// cannot block event acceptance. Each attempt is checked again after prior I/O.
export async function pushTick(r: Relay): Promise<number> {
  const started = Date.now();
  let t = Math.floor(started / 1000);
  rows(r, `DELETE FROM push_queue WHERE expires<=?`, t);
  rows(r, `DELETE FROM push_delivered WHERE delivered_at<?`, t - DEDUP_TTL);
  if (!featureEnabled(r)) {
    rows(r, `DELETE FROM push_queue`);
    return 0;
  }
  const jobs = rows<{ registration_id: string; event_id: string; attempts: number }>(r, `SELECT registration_id,event_id,attempts FROM push_queue WHERE due<=? ORDER BY due,rowid LIMIT 4`, t);
  for (const job of jobs) {
    t = Math.floor(Date.now() / 1000);
    // Rows can disappear during the previous callback (deletion, teardown,
    // member removal). An alarm restart cannot exceed the reserved attempt cap.
    if (r.repositoryAccess.busy) return t + 1;
    const current = rows<{ attempts: number }>(r, `SELECT attempts FROM push_queue WHERE registration_id=? AND event_id=? AND expires>? AND due<=?`, job.registration_id, job.event_id, t, t)[0];
    if (!current) continue;
    job.attempts = current.attempts;
    if (!featureEnabled(r) || job.attempts >= MAX_ATTEMPTS) { finish(r, job.registration_id, job.event_id, t); continue; }
    r.tally();
    if (r.fuelStatus().outOfFuel) {
      rows(r, `UPDATE push_queue SET due=max(due,?)`, t + 60);
      return t + 60;
    }
    const owner = rows<{ pubkey: string }>(r, `SELECT pubkey FROM events WHERE id=? AND kind=?`, job.registration_id, PUSH_KIND)[0]?.pubkey;
    const reg = owner && authorized(r, owner) ? visible(r, job.registration_id, owner, t) : null;
    const e = owner ? visible(r, job.event_id, owner, t) : null;
    const p = reg ? parseRegistration(reg, r) : "missing registration";
    if (!reg || !e || typeof p === "string" || !p.filters.some((f) => match(f, e)) || p.ignores.some((f) => match(f, e))) {
      finish(r, job.registration_id, job.event_id, t); continue;
    }
    const body = payload(e, p.relay, p.include);
    const bytes = utf8Size(body);
    if (bytes > MAX_PAYLOAD) { finish(r, job.registration_id, job.event_id, t); continue; }
    // Reserve before external I/O. A crash consumes the attempt and waits
    // longer than the request timeout before another alarm may retry it.
    rows(r, `UPDATE push_queue SET attempts=attempts+1,due=? WHERE registration_id=? AND event_id=?`, t + 60, job.registration_id, job.event_id);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    let response: Response | null = null;
    const requestStarted = Date.now();
    r.meterBytes(0, bytes);
    try { response = await r.fetcher(p.callback, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body, signal: ctrl.signal }); }
    catch { response = null; }
    finally { clearTimeout(timer); r.meterPush(0, 0, Date.now() - requestStarted); }
    if (response?.body) await response.body.cancel().catch(() => {});
    // An obsolete in-flight response must not mutate a replacement row.
    if (!rows(r, `SELECT 1 FROM push_queue WHERE registration_id=? AND event_id=?`, job.registration_id, job.event_id).length) continue;
    if (response?.status === 404) {
      r.store.deleteEvent(job.registration_id);
    } else if ((response && response.status >= 200 && response.status < 300) || job.attempts + 1 >= MAX_ATTEMPTS || (response && response.status < 500 && response.status !== 429)) {
      finish(r, job.registration_id, job.event_id, t);
    } else {
      rows(r, `UPDATE push_queue SET due=? WHERE registration_id=? AND event_id=?`, Math.floor(Date.now() / 1000) + RETRY_SECONDS[job.attempts], job.registration_id, job.event_id);
    }
  }
  r.tally();
  const next = rows<{ next: number | null }>(r, `SELECT MIN(due) AS next FROM push_queue`)[0].next;
  return next ? Math.max(next, Math.floor(Date.now() / 1000) + 1) : 0;
}

// nextPush includes work enqueued by views or discovery after the push round.
export function nextPush(r: Relay): number {
  return rows<{ next: number | null }>(r, `SELECT MIN(due) AS next FROM push_queue`)[0].next ?? 0;
}
