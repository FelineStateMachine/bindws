// Blossom media (BUD-01, BUD-02): every relay is also its members' media
// server. Blobs live in R2 under <relay>/<sha256>; descriptors live in the
// relay's database so storage counts toward fuel and the owner can see and
// remove them. Authorization is a kind 24242 event in the Authorization header.
//
//   PUT    /upload              t=upload, x=<sha256 of body>   -> descriptor
//   HEAD   /upload              t=upload; X-SHA-256, X-Content-Type, X-Content-Length (BUD-06)
//   PUT    /mirror              t=upload, x=<sha256>; body {url}  -> descriptor (BUD-04)
//   GET    /<sha256>[.ext]      public
//   HEAD   /<sha256>[.ext]      public
//   DELETE /<sha256>            t=delete, x=<sha256>; uploader or owner
//   GET    /list/<pubkey>       public
import { sha256 } from "@noble/hashes/sha2.js";
import { tagValues, validate, type Event } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";
import { localName } from "./pull.ts";
import type { Relay } from "./relay.ts";

export type Blob = {
  sha256: string;
  size: number;
  type: string;
  uploader: string;
  uploaded: number;
};

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mp4": "m4a",
  "application/pdf": "pdf", "text/plain": "txt", "application/json": "json", "text/markdown": "md",
};
const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type]));
const SHA_RE = /^\/([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?$/;
const HEX64 = /^[0-9a-f]{64}$/;

// verifyBlossom checks a kind 24242 event for the given action.
export function verifyBlossom(header: string, action: "upload" | "delete", now: number): Event | string {
  const m = /^Nostr\s+(\S+)$/i.exec(header.trim());
  if (!m) return "auth-required: missing Blossom Authorization header";
  let e: Event;
  try {
    e = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return "auth-required: malformed Blossom token";
  }
  const bad = validate(e);
  if (bad) return "auth-required: " + bad;
  if (e.kind !== 24242) return "auth-required: token must be kind 24242";
  if (tagValues(e, "t")[0] !== action) return `auth-required: token is not for ${action}`;
  const exp = Number(tagValues(e, "expiration")[0]);
  if (!Number.isFinite(exp) || exp <= now) return "auth-required: token expired";
  if (e.created_at > now + 300) return "auth-required: token is from the future";
  return e;
}

export function isBlobPath(path: string): boolean {
  return SHA_RE.test(path);
}

export function descriptor(host: string, b: Blob) {
  const ext = EXT[b.type];
  return { url: `https://${host}/${b.sha256}${ext ? "." + ext : ""}`, sha256: b.sha256, size: b.size, type: b.type, uploaded: b.uploaded };
}

export function blobBytes(sql: SqlStorage): number {
  return sql.exec<{ n: number | null }>(`SELECT sum(size) AS n FROM blobs`).one().n ?? 0;
}

// fetchOrigin gets a blob for mirroring. Our own relays are reached through
// their object, which also works in wrangler dev and tests; anything else is
// fetched over https. Returns a Response or a reason.
async function fetchOrigin(relay: Relay, raw: string): Promise<Response | string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid: url is not a URL";
  }
  const local = localName(u, relay.domain);
  try {
    if (local) return await relay.relays.getByName(local).fetch(u.href, { headers: { "x-relay-name": local } });
    if (u.protocol !== "https:") return "invalid: only https urls can be mirrored";
    return await fetch(u.href, { redirect: "follow" });
  } catch (err) {
    return "error: could not fetch the origin: " + (err instanceof Error ? err.message : String(err));
  }
}

// readCapped collects a body, giving up as soon as it passes max bytes.
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | "too big"> {
  if (!body) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return "too big";
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function blossom(relay: Relay, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const host = url.host;
  const now = Math.floor(Date.now() / 1000);
  const sql = relay.sql;
  const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra } });
  const reason = (msg: string, status: number) => json({ error: msg }, status, { "x-reason": msg });
  const key = (sha: string) => `${relay.slug}/${sha}`;
  const maxBytes = () => relay.settings.policy.maxBlobMB * 1024 * 1024;
  const tooBig = () => `invalid: blob exceeds ${relay.settings.policy.maxBlobMB} MB`;

  // BUD-06: would this upload be accepted? No body either way.
  if (req.method === "HEAD" && url.pathname === "/upload") {
    const head = (status: number, msg = "") => new Response(null, { status, headers: { "access-control-allow-origin": "*", ...(msg ? { "x-reason": msg } : {}) } });
    const sha = (req.headers.get("x-sha-256") ?? "").trim().toLowerCase();
    if (!HEX64.test(sha)) return head(400, "invalid: X-SHA-256 must be a lowercase hex sha256");
    const lengthHeader = req.headers.get("x-content-length");
    if (lengthHeader === null || lengthHeader.trim() === "") return head(411, "invalid: X-Content-Length is required");
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0) return head(400, "invalid: X-Content-Length must be a whole number of bytes");
    const auth = verifyBlossom(req.headers.get("authorization") ?? "", "upload", now);
    if (typeof auth === "string") return head(401, auth);
    const gate = relay.mayUpload(auth.pubkey, host);
    if (gate) return head(403, gate);
    if (length === 0) return head(400, "invalid: empty body");
    if (length > maxBytes()) return head(413, tooBig());
    const claimed = tagValues(auth, "x");
    if (claimed.length && !claimed.includes(sha)) return head(400, "invalid: token x tag does not match the blob");
    return head(200);
  }

  // BUD-04: copy a blob from a URL instead of receiving the bytes.
  if (req.method === "PUT" && url.pathname === "/mirror") {
    const auth = verifyBlossom(req.headers.get("authorization") ?? "", "upload", now);
    if (typeof auth === "string") return reason(auth, 401);
    const gate = relay.mayUpload(auth.pubkey, host);
    if (gate) return reason(gate, 403);
    let from = "";
    try {
      from = String((JSON.parse(await req.text()) as { url?: unknown }).url ?? "");
    } catch {
      return reason("invalid: body is not JSON", 400);
    }
    if (!from) return reason("invalid: body needs a url", 400);
    const origin = await fetchOrigin(relay, from);
    if (typeof origin === "string") return reason(origin, origin.startsWith("invalid:") ? 400 : 502);
    if (!origin.ok) return reason(`error: the origin answered ${origin.status}`, 502);
    const declared = Number(origin.headers.get("content-length"));
    if (declared > maxBytes()) return reason(tooBig(), 413);
    const body = await readCapped(origin.body, maxBytes());
    if (body === "too big") return reason(tooBig(), 413);
    if (body.length === 0) return reason("error: the origin sent an empty body", 502);
    const sha = bytesToHex(sha256(body));
    const claimed = tagValues(auth, "x");
    if (claimed.length && !claimed.includes(sha)) return reason("invalid: the mirrored blob does not match the token x tag", 409);
    const originType = (origin.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = new URL(from).pathname.split(".").pop()?.toLowerCase() ?? "";
    const type = originType && originType !== "application/octet-stream" ? originType : (TYPE_BY_EXT[ext] ?? originType) || "application/octet-stream";
    const existing = sql.exec<Blob>(`SELECT * FROM blobs WHERE sha256=?`, sha).toArray()[0];
    if (!existing) {
      await relay.media.put(key(sha), body, { httpMetadata: { contentType: type } });
      sql.exec(`INSERT INTO blobs(sha256,size,type,uploader,uploaded) VALUES(?,?,?,?,?)`, sha, body.length, type, auth.pubkey, now);
    }
    relay.meterBytes(body.length, 0);
    return json(descriptor(host, existing ?? { sha256: sha, size: body.length, type, uploader: auth.pubkey, uploaded: now }), existing ? 200 : 201);
  }

  if (req.method === "PUT" && url.pathname === "/upload") {
    const auth = verifyBlossom(req.headers.get("authorization") ?? "", "upload", now);
    if (typeof auth === "string") return reason(auth, 401);
    const gate = relay.mayUpload(auth.pubkey, host);
    if (gate) return reason(gate, 403);
    const max = maxBytes();
    const declared = Number(req.headers.get("content-length"));
    if (declared > max) return reason(`invalid: blob exceeds ${relay.settings.policy.maxBlobMB} MB`, 413);
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length === 0) return reason("invalid: empty body", 400);
    if (body.length > max) return reason(`invalid: blob exceeds ${relay.settings.policy.maxBlobMB} MB`, 413);
    const sha = bytesToHex(sha256(body));
    const claimed = tagValues(auth, "x");
    if (claimed.length && !claimed.includes(sha)) return reason("invalid: token x tag does not match the blob", 400);
    const type = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";
    const existing = sql.exec<Blob>(`SELECT * FROM blobs WHERE sha256=?`, sha).toArray()[0];
    if (!existing) {
      await relay.media.put(key(sha), body, { httpMetadata: { contentType: type } });
      sql.exec(`INSERT INTO blobs(sha256,size,type,uploader,uploaded) VALUES(?,?,?,?,?)`, sha, body.length, type, auth.pubkey, now);
    }
    relay.meterBytes(body.length, 0);
    return json(descriptor(host, existing ?? { sha256: sha, size: body.length, type, uploader: auth.pubkey, uploaded: now }));
  }

  if (req.method === "GET" && url.pathname.startsWith("/list/")) {
    const pk = url.pathname.slice(6);
    if (!/^[0-9a-f]{64}$/.test(pk)) return reason("invalid: bad pubkey", 400);
    const rows = sql.exec<Blob>(`SELECT * FROM blobs WHERE uploader=? ORDER BY uploaded DESC LIMIT 500`, pk).toArray();
    return json(rows.map((b) => descriptor(host, b)));
  }

  const m = SHA_RE.exec(url.pathname);
  if (!m) return reason("not found", 404);
  const sha = m[1];
  const blob = sql.exec<Blob>(`SELECT * FROM blobs WHERE sha256=?`, sha).toArray()[0];

  if (req.method === "DELETE") {
    const auth = verifyBlossom(req.headers.get("authorization") ?? "", "delete", now);
    if (typeof auth === "string") return reason(auth, 401);
    if (!tagValues(auth, "x").includes(sha)) return reason("invalid: token x tag does not name this blob", 400);
    if (!blob) return reason("not found", 404);
    if (blob.uploader !== auth.pubkey && !relay.settings.isOwner(auth.pubkey)) return reason("restricted: not the uploader", 403);
    await relay.deleteBlob(sha);
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return reason("method not allowed", 405);
  if (!blob) return reason("not found", 404);
  const headers: Record<string, string> = {
    "content-type": blob.type,
    "content-length": String(blob.size),
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
    etag: `"${sha}"`,
  };
  if (req.method === "HEAD") return new Response(null, { headers });
  const ranged = req.headers.has("range");
  const obj = await relay.media.get(key(sha), ranged ? { range: req.headers } : undefined);
  if (!obj) return reason("not found", 404);
  relay.meterBytes(0, obj.size);
  if (ranged && obj.range) {
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const start = r.suffix !== undefined ? blob.size - r.suffix : (r.offset ?? 0);
    const len = r.suffix !== undefined ? r.suffix : (r.length ?? blob.size - start);
    headers["content-range"] = `bytes ${start}-${start + len - 1}/${blob.size}`;
    headers["content-length"] = String(len);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}
