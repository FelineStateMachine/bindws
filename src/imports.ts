// Imports: the reverse of dumps. PUT /import takes a file of events, a
// JSONL (strfry's export is one) or a JSON array, keeps it in R2 under
// <name>/imports/, and hands it to a job that reads it back in bounded
// byte ranges, one round at a time, so a big file never has to fit in a
// request. Signatures are checked, bans and kind rules apply, the write
// rule does not: the owner asked for these. The file counts as media while
// it exists and is deleted when the job is done.
import { validate, now, type Event } from "./event.ts";
import { verifyNIP98 } from "./manage.ts";
import { can } from "./roles.ts";
import { ERR_DUPLICATE } from "./store.ts";
import { newJobID, type Job } from "./jobs.ts";
import type { Relay } from "./relay.ts";

// The door reads the body whole to check the NIP-98 payload hash, so the
// cap is what an object can hold comfortably next to its own work.
export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024; // bytes read from R2 per round
const MAX_LINE = 512 * 1024; // a line longer than this is not an event

export function importKey(slug: string, id: string): string {
  return `${slug}/imports/${id}.jsonl`;
}

export function importBytes(sql: SqlStorage): number {
  return sql.exec<{ n: number | null }>(`SELECT sum(bytes) AS n FROM imports`).one().n ?? 0;
}

// importUpload serves PUT /import for a NIP-98 signer with the storage
// action. The body is JSONL or a JSON array; arrays are rewritten to JSONL
// so the job has one shape to read.
export async function importUpload(relay: Relay, req: Request): Promise<Response> {
  const json = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  const declared = Number(req.headers.get("content-length"));
  if (declared > IMPORT_MAX_BYTES) return json({ error: `invalid: at most ${IMPORT_MAX_BYTES / 1024 / 1024} MB per import` }, 413);
  const body = await req.text();
  if (body.length > IMPORT_MAX_BYTES) return json({ error: `invalid: at most ${IMPORT_MAX_BYTES / 1024 / 1024} MB per import` }, 413);
  const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, body);
  if (typeof auth === "string") return json({ error: auth }, 401);
  if (!can(relay.settings.roleOf(auth.pubkey), "storage")) return json({ error: "restricted: not the relay owner" }, 403);
  if (relay.settings.policy.owner === "") return json({ error: "restricted: this relay is unclaimed" }, 403);
  if (relay.fuelStatus().outOfFuel) return json({ error: "restricted: this relay is out of fuel" }, 403);
  let text = body.trim();
  if (text === "") return json({ error: "invalid: the file is empty" }, 400);
  if (text.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      return json({ error: "invalid: not a JSON array" }, 400);
    }
    if (!Array.isArray(arr)) return json({ error: "invalid: not a JSON array" }, 400);
    text = arr.map((e) => JSON.stringify(e)).join("\n");
  }
  const bytes = new TextEncoder().encode(text + "\n");
  const id = newJobID();
  const name = (new URL(req.url).searchParams.get("name") ?? "import.jsonl").replace(/[^\w.-]/g, "_").slice(0, 80) || "import.jsonl";
  await relay.media.put(importKey(relay.slug, id), bytes, { httpMetadata: { contentType: "application/x-ndjson" } });
  relay.sql.exec(`INSERT INTO imports(id,name,bytes,at) VALUES(?,?,?,?)`, id, name, bytes.length, now());
  relay.meterBytes(bytes.length, 0);
  const job = await relay.addChecked({ kind: "import", label: "import", relays: [name], filter: {}, every: 0, running: false, startedAt: 0, rounds: 0, failures: 0, relayIndex: 0, cursor: 0, stored: 0, skipped: 0, blobs: 0, sent: 0, refused: 0, duplicates: 0, last: null, object: id, size: bytes.length, carry: "" });
  if (typeof job === "string") {
    await forgetImport(relay, id);
    return json({ error: job }, 409);
  }
  return json({ job: job.id, bytes: bytes.length, name }, 202);
}

// forgetImport drops the object and its row, whatever state the job is in.
export async function forgetImport(relay: Relay, id: string) {
  await relay.media.delete(importKey(relay.slug, id)).catch(() => {});
  relay.sql.exec(`DELETE FROM imports WHERE id=?`, id);
}

const b64 = {
  enc: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

// runImportRound reads the next byte range, finishes the line carried over
// from the last round, and stores what checks out. more: call again.
export async function runImportRound(relay: Relay, job: Job): Promise<{ more: boolean; error: string }> {
  job.rounds++;
  const id = job.object ?? "";
  const size = job.size ?? 0;
  if (!id || job.cursor >= size) {
    await forgetImport(relay, id);
    return { more: false, error: "" };
  }
  const obj = await relay.media.get(importKey(relay.slug, id), { range: { offset: job.cursor, length: Math.min(CHUNK, size - job.cursor) } });
  if (!obj) return { more: false, error: "the import file is gone" };
  const fresh = new Uint8Array(await obj.arrayBuffer());
  const carried = job.carry ? b64.dec(job.carry) : new Uint8Array(0);
  const buf = new Uint8Array(carried.length + fresh.length);
  buf.set(carried);
  buf.set(fresh, carried.length);
  job.cursor += fresh.length;
  const atEnd = job.cursor >= size;
  // Split on newlines; the tail after the last one waits for the next round.
  let start = 0;
  const dec = new TextDecoder();
  const t = now();
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 10) continue;
    take(relay, dec.decode(buf.subarray(start, i)), job, t);
    start = i + 1;
  }
  const tail = buf.subarray(start);
  if (atEnd) {
    if (tail.length) take(relay, dec.decode(tail), job, t);
    job.carry = "";
    await forgetImport(relay, id);
    return { more: false, error: "" };
  }
  if (tail.length > MAX_LINE) {
    job.skipped++;
    job.carry = "";
  } else job.carry = b64.enc(tail);
  return { more: true, error: "" };
}

// take stores one line, counting what became of it.
function take(relay: Relay, line: string, job: Job, t: number) {
  const s = line.trim();
  if (s === "" || s === "[" || s === "]") return;
  let e: Event;
  try {
    e = JSON.parse(s.replace(/,$/, "")) as Event;
  } catch {
    job.skipped++;
    return;
  }
  if (validate(e) || !relay.settings.kindAllowed(e.kind)) {
    job.skipped++;
    return;
  }
  const r = relay.accept(e, null);
  if (r.stored) {
    job.stored++;
    relay.broadcast(e);
  } else if (r.msg === ERR_DUPLICATE) job.duplicates = (job.duplicates ?? 0) + 1;
  else job.skipped++;
  void t;
}
