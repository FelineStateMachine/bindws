// NIP-65 delivery: a small, durable, opt-in fanout queue. This is deliberately
// separate from NIP-9a callbacks: targets are Nostr relays and receive EVENT.
import { isPrivate, now, tagValues, type Event } from "./event.ts";
import { dial, Socket, checkPullURL } from "./pull.ts";
import type { Relay } from "./relay.ts";

export const DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_queue (
 event_id TEXT NOT NULL, target TEXT NOT NULL, author TEXT NOT NULL,
 due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '',
 updated_at INTEGER NOT NULL, PRIMARY KEY(event_id,target)
);
CREATE INDEX IF NOT EXISTS delivery_due ON delivery_queue(status,due);
`;
const MAX_QUEUE = 512, MAX_ATTEMPTS = 4, TIMEOUT = 5000, BATCH = 4;
const rows = <T extends Record<string, any>>(r: Relay, q: string, ...a: any[]): T[] => r.sql.exec<T>(q, ...a).toArray();
const exec = (r: Relay, q: string, ...a: any[]) => { const c = r.sql.exec(q, ...a); r.meterPush(c.rowsRead, c.rowsWritten); return c; };

function list(r: Relay, pk: string): { read: string[]; write: string[] } {
  const row = r.store.query({ kinds: [10002], authors: [pk], tags: {} }, { pubkeys: [], all: true }, 1, now()).rows[0];
  const out = { read: [] as string[], write: [] as string[] };
  if (!row) return out;
  try {
    for (const t of (JSON.parse(row) as Event).tags) {
      if (t[0] !== "r" || !t[1]) continue;
      let u: URL; try { u = new URL(t[1]); } catch { continue; }
      if (u.protocol !== "wss:" && u.protocol !== "ws:") continue;
      // NIP-65 is user supplied egress. Refuse obvious loopback/private
      // destinations; public DNS names remain the interoperable path.
      const h = u.hostname.toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(h) || /\.(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(h)) continue;
      const url = u.toString().replace(/\/$/, "");
      const marker = !t[2] ? "both" : t[2] === "read" ? "read" : t[2] === "write" ? "write" : "";
      if (!marker) continue;
      if ((marker === "read" || marker === "both") && !out.read.includes(url)) out.read.push(url);
      if ((marker === "write" || marker === "both") && !out.write.includes(url)) out.write.push(url);
    }
  } catch { /* malformed historical list */ }
  return out;
}

function targets(r: Relay, e: Event): string[] {
  const max = r.settings.policy.delivery?.maxTargets ?? 8;
  const out: string[] = [];
  const add = (u: string) => {
    if (out.length >= max || out.includes(u)) return;
    if (checkPullURL(u, r.slug, r.domain)) return;
    out.push(u);
  };
  for (const u of list(r, e.pubkey).write) add(u);
  for (const pk of tagValues(e, "p").slice(0, 32)) for (const u of list(r, pk).read) add(u);
  return out;
}

export function queueDelivery(r: Relay, e: Event): boolean {
  const p = r.settings.policy.delivery;
  if (!p?.enabled || e.pubkey === r.identity.pubkey || !r.settings.isAllowed(e.pubkey) || isPrivate(e.kind) || e.tags.some((t: string[]) => t[0] === "-")) return false;
  const ts = targets(r, e);
  if (!ts.length) return false;
  let n = rows<{ n: number }>(r, `SELECT count(*) n FROM delivery_queue WHERE status='pending'`)[0]?.n ?? 0;
  let added = false;
  for (const target of ts) {
    if (n >= MAX_QUEUE) break;
    exec(r, `INSERT OR IGNORE INTO delivery_queue(event_id,target,author,due,attempts,status,error,updated_at) VALUES(?,?,?,?,0,'pending','',?)`, e.id, target, e.pubkey, now(), now());
    if (rows<{ n: number }>(r, `SELECT changes() AS n`)[0]?.n) { n++; added = true; }
  }
  return added;
}

async function send(r: Relay, target: string, e: Event): Promise<{ ok: boolean; error: string }> {
  let s: Socket | null = null;
  try {
    s = new Socket(await dial(r, target));
    s.send("EVENT", e);
    const end = Date.now() + TIMEOUT;
    while (Date.now() < end) {
      const m = await Promise.race([s.recv(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), Math.max(1, end - Date.now()))) ]);
      if (m[0] !== "OK" || m[1] !== e.id) continue;
      if (m[2] === true || String(m[3] ?? "").startsWith("duplicate:")) return { ok: true, error: "" };
      return { ok: false, error: String(m[3] ?? "rejected") };
    }
    return { ok: false, error: "timeout" };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  finally { s?.close(); }
}

export async function deliveryTick(r: Relay): Promise<number> {
  if (!r.settings.policy.delivery?.enabled) { exec(r, `DELETE FROM delivery_queue`); return 0; }
  const t = now();
  exec(r, `DELETE FROM delivery_queue WHERE status<>'pending' AND updated_at<?`, t - 7 * 86400);
  exec(r, `DELETE FROM delivery_queue WHERE rowid IN (SELECT rowid FROM delivery_queue WHERE status<>'pending' ORDER BY updated_at ASC LIMIT max(0,(SELECT count(*) FROM delivery_queue WHERE status<>'pending')-1024))`);
  const jobs = rows<{ event_id: string; target: string; attempts: number }>(r, `SELECT event_id,target,attempts FROM delivery_queue WHERE status='pending' AND due<=? ORDER BY due LIMIT ?`, t, BATCH);
  for (const j of jobs) {
    const author = rows<{ author: string }>(r, `SELECT author FROM delivery_queue WHERE event_id=? AND target=?`, j.event_id, j.target)[0]?.author ?? "";
    const ev = rows<{ raw: string }>(r, `SELECT raw FROM events WHERE id=? AND pubkey=? AND kind NOT IN (4,1059,21059,24133)`, j.event_id, author)[0];
    if (!ev) { exec(r, `UPDATE delivery_queue SET status='rejected',error='event unavailable',updated_at=? WHERE event_id=? AND target=?`, t, j.event_id, j.target); continue; }
    const event = JSON.parse(ev.raw) as Event;
    if (!r.settings.isAllowed(author) || !targets(r, event).includes(j.target)) { exec(r, `UPDATE delivery_queue SET status='rejected',error='routing no longer permitted',updated_at=? WHERE event_id=? AND target=?`, t, j.event_id, j.target); continue; }
    exec(r, `UPDATE delivery_queue SET attempts=attempts+1,due=?,updated_at=? WHERE event_id=? AND target=?`, t + 60, t, j.event_id, j.target);
    const result = await send(r, j.target, event);
    const attempts = j.attempts + 1;
    if (result.ok || attempts >= MAX_ATTEMPTS) {
      exec(r, `UPDATE delivery_queue SET status=?,error=?,updated_at=? WHERE event_id=? AND target=?`, result.ok ? "accepted" : "rejected", result.error, now(), j.event_id, j.target);
    } else exec(r, `UPDATE delivery_queue SET due=?,error=?,updated_at=? WHERE event_id=? AND target=?`, now() + [30, 120, 600][Math.min(attempts - 1, 2)], result.error, now(), j.event_id, j.target);
  }
  const next = rows<{ next: number | null }>(r, `SELECT min(due) next FROM delivery_queue WHERE status='pending'`)[0]?.next ?? 0;
  return next;
}

export function deliveryStatus(r: Relay) {
  return rows<{ event_id: string; target: string; status: string; attempts: number; error: string; updated_at: number }>(r, `SELECT event_id,target,status,attempts,error,updated_at FROM delivery_queue ORDER BY updated_at DESC LIMIT 100`);
}
