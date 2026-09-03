// Blossom media (BUD-01, BUD-02): every relay is also its members' media
// server. Blobs live in R2 under <relay>/<sha256>; descriptors live in the
// relay's database so storage counts toward fuel and the owner can see and
// remove them. Authorization is a kind 24242 event in the Authorization header.
//
//   PUT    /upload              t=upload, x=<sha256 of body>   -> descriptor
//   GET    /<sha256>[.ext]      public
//   HEAD   /<sha256>[.ext]      public
//   DELETE /<sha256>            t=delete, x=<sha256>; uploader or owner
//   GET    /list/<pubkey>       public
import { sha256 } from "@noble/hashes/sha2.js";
import { tagValues, validate, type Event } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";
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
const SHA_RE = /^\/([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?$/;

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

export async function blossom(relay: Relay, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const host = url.host;
  const now = Math.floor(Date.now() / 1000);
  const sql = relay.sql;
  const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra } });
  const reason = (msg: string, status: number) => json({ error: msg }, status, { "x-reason": msg });
  const key = (sha: string) => `${relay.slug}/${sha}`;

  if (req.method === "PUT" && url.pathname === "/upload") {
    const auth = verifyBlossom(req.headers.get("authorization") ?? "", "upload", now);
    if (typeof auth === "string") return reason(auth, 401);
    const gate = relay.mayUpload(auth.pubkey, host);
    if (gate) return reason(gate, 403);
    const max = relay.settings.policy.maxBlobMB * 1024 * 1024;
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
