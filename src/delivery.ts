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

function list(r: Relay, pk: string): { read: string[]; write: string[] } {
  const row = r.store.query({ kinds: [10002], authors: [pk], tags: {} }, { pubkeys: [], all: true }, 1, now()).rows[0];
  const out = { read: [] as string[], write: [] as string[] };
  if (!row) return out;
  try {
    for (const t of (JSON.parse(row) as Event).tags) {
      if (t[0] !== "r" || !t[1]) continue;
      let u: URL; try { u = new URL(t[1]); } catch { continue; }
      if (u.protocol !== "wss:" && u.protocol !== "ws:") continue;
      const url = u.toString().replace(/\/$/, "");
      const marker = t[2] === "read" ? "read" : t[2] === "write" ? "write" : "both";
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
  if (!p?.enabled || e.pubkey === r.identity.pubkey || isPrivate(e.kind) || e.tags.some((t: string[]) => t[0] === "-")) return false;
  const ts = targets(r, e);
  if (!ts.length) return false;
  let n = rows<{ n: number }>(r, `SELECT count(*) n FROM delivery_queue WHERE status='pending'`)[0]?.n ?? 0;
  let added = false;
  for (const target of ts) {
    if (n >= MAX_QUEUE) break;
    r.sql.exec(`INSERT OR IGNORE INTO delivery_queue(event_id,target,author,due,attempts,status,error,updated_at) VALUES(?,?,?,?,0,'pending','',?)`, e.id, target, e.pubkey, now(), now());
    if (r.sql.exec(`SELECT changes() AS n`).one().n) { n++; added = true; }
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
  if (!r.settings.policy.delivery?.enabled) { r.sql.exec(`DELETE FROM delivery_queue`); return 0; }
  const t = now();
  const jobs = rows<{ event_id: string; target: string; attempts: number }>(r, `SELECT event_id,target,attempts FROM delivery_queue WHERE status='pending' AND due<=? ORDER BY due LIMIT ?`, t, BATCH);
  for (const j of jobs) {
    const ev = rows<{ raw: string }>(r, `SELECT raw FROM events WHERE id=? AND pubkey=? AND kind NOT IN (4,1059,21059,24133)`, j.event_id, rows<{ author: string }>(r, `SELECT author FROM delivery_queue WHERE event_id=? AND target=?`, j.event_id, j.target)[0]?.author ?? "")[0];
    if (!ev) { r.sql.exec(`UPDATE delivery_queue SET status='rejected',error='event unavailable',updated_at=? WHERE event_id=? AND target=?`, t, j.event_id, j.target); continue; }
    r.sql.exec(`UPDATE delivery_queue SET attempts=attempts+1,due=?,updated_at=? WHERE event_id=? AND target=?`, t + 60, t, j.event_id, j.target);
    const result = await send(r, j.target, JSON.parse(ev.raw) as Event);
    const attempts = j.attempts + 1;
    if (result.ok || attempts >= MAX_ATTEMPTS || (result.error !== "timeout" && !/5\d\d|tempor/i.test(result.error))) {
      r.sql.exec(`UPDATE delivery_queue SET status=?,error=?,updated_at=? WHERE event_id=? AND target=?`, result.ok ? "accepted" : "rejected", result.error, now(), j.event_id, j.target);
    } else r.sql.exec(`UPDATE delivery_queue SET due=?,error=?,updated_at=? WHERE event_id=? AND target=?`, now() + [30, 120, 600][Math.min(attempts - 1, 2)], result.error, now(), j.event_id, j.target);
  }
  const next = rows<{ next: number | null }>(r, `SELECT min(due) next FROM delivery_queue WHERE status='pending'`)[0]?.next ?? 0;
  return next;
}

export function deliveryStatus(r: Relay) {
  return rows<{ event_id: string; target: string; status: string; attempts: number; error: string; updated_at: number }>(r, `SELECT event_id,target,status,attempts,error,updated_at FROM delivery_queue ORDER BY updated_at DESC LIMIT 100`);
}
