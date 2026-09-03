// Dumps: the relay's whole event set as JSONL in R2, written by the alarm on
// the schedule the owner picks, kept for a few runs, and downloadable with a
// signature. The way out that needs no other relay.
//
// The file is streamed in pages by sequence into an R2 multipart upload, so
// a large relay never holds its history in memory. Every part but the last
// is exactly PART bytes, which is what R2 requires.
import { verifyNIP98 } from "./manage.ts";
import { can } from "./roles.ts";
import type { Relay } from "./relay.ts";

export type Dump = { name: string; bytes: number; events: number; at: number };

const PAGE = 500;
const PART = 8 * 1024 * 1024;
export const DUMP_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function dumpName(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10) + ".jsonl";
}
export function dumpKey(slug: string, name: string): string {
  return `${slug}/dumps/${name}`;
}
export function dumpBytes(sql: SqlStorage): number {
  return sql.exec<{ n: number | null }>(`SELECT sum(bytes) AS n FROM dumps`).one().n ?? 0;
}
export function listDumps(sql: SqlStorage): Dump[] {
  return sql.exec<Dump>(`SELECT * FROM dumps ORDER BY at DESC`).toArray();
}

// dumpDue says whether the schedule owes a dump: daily means one a day,
// weekly one every seven, with an hour of slack so a tick that comes a
// little early still counts.
export function dumpDue(relay: Relay, t: number): boolean {
  const p = relay.settings.policy;
  if (p.dumps === "off" || p.owner === "") return false;
  const last = relay.sql.exec<{ at: number | null }>(`SELECT max(at) AS at FROM dumps`).one().at;
  if (last === null) return true;
  const period = p.dumps === "daily" ? 86400 : 7 * 86400;
  return t - last >= period - 3600;
}

// writeDump writes today's file, replacing one of the same name, records it
// and drops the oldest beyond the keep count.
export async function writeDump(relay: Relay, t: number): Promise<Dump> {
  const name = dumpName(t);
  const key = dumpKey(relay.slug, name);
  const enc = new TextEncoder();
  const upload = await relay.media.createMultipartUpload(key, { httpMetadata: { contentType: "application/x-ndjson" } });
  const parts: R2UploadedPart[] = [];
  let pending = new Uint8Array(0);
  let total = 0;
  let events = 0;
  let seq = 0;
  const append = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };
  try {
    for (;;) {
      const page = relay.store.dumpPage(seq, PAGE);
      if (page.length === 0) break;
      const chunk = enc.encode(page.map((r) => r.raw + "\n").join(""));
      pending = append(pending, chunk);
      events += page.length;
      seq = page[page.length - 1].seq;
      while (pending.length >= PART) {
        parts.push(await upload.uploadPart(parts.length + 1, pending.slice(0, PART)));
        total += PART;
        pending = pending.slice(PART);
      }
    }
    parts.push(await upload.uploadPart(parts.length + 1, pending));
    total += pending.length;
    await upload.complete(parts);
  } catch (err) {
    await upload.abort().catch(() => {});
    throw err;
  }
  relay.sql.exec(`INSERT INTO dumps(name,bytes,events,at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes, events=excluded.events, at=excluded.at`, name, total, events, t);
  relay.meterBytes(0, total);
  await rotateDumps(relay);
  return { name, bytes: total, events, at: t };
}

// rotateDumps keeps the newest `dumpsKeep` files.
export async function rotateDumps(relay: Relay) {
  const keep = Math.max(1, relay.settings.policy.dumpsKeep);
  const old = listDumps(relay.sql).slice(keep);
  for (const d of old) await deleteDump(relay, d.name);
}

export async function deleteDump(relay: Relay, name: string): Promise<boolean> {
  await relay.media.delete(dumpKey(relay.slug, name));
  return relay.sql.exec(`DELETE FROM dumps WHERE name=?`, name).rowsWritten > 0;
}

// dumpDownload serves GET /dumps/<name> to a NIP-98 signer with the storage
// action. A private relay's history is never a public URL.
export async function dumpDownload(relay: Relay, req: Request): Promise<Response> {
  const json = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, "");
  if (typeof auth === "string") return json({ error: auth }, 401);
  if (!can(relay.settings.roleOf(auth.pubkey), "storage")) return json({ error: "restricted: not the relay owner" }, 403);
  const name = new URL(req.url).pathname.slice("/dumps/".length);
  if (!DUMP_NAME_RE.test(name)) return json({ error: "invalid: not a dump name" }, 400);
  const row = relay.sql.exec<Dump>(`SELECT * FROM dumps WHERE name=?`, name).toArray()[0];
  const obj = row ? await relay.media.get(dumpKey(relay.slug, name)) : null;
  if (!row || !obj) return json({ error: "not found" }, 404);
  relay.meterBytes(0, obj.size);
  return new Response(obj.body, {
    headers: {
      "content-type": "application/x-ndjson",
      "content-length": String(obj.size),
      "content-disposition": `attachment; filename="${relay.slug}-${name}"`,
      "cache-control": "private, no-store",
      "access-control-allow-origin": "*",
    },
  });
}
