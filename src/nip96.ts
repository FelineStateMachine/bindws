// NIP-96 HTTP file storage with NIP-94 metadata: a second door for clients
// that do not speak Blossom. Same bucket, same blobs table, same gates; the
// file URL is the Blossom one, so a file uploaded through either door is
// served, listed and deleted through both. NIP-96 is marked unrecommended
// upstream in favour of Blossom, which is why this stays a thin adapter.
//
//   GET    /.well-known/nostr/nip96.json     discovery
//   POST   /nip96                            multipart, NIP-98  -> nip94_event
//   GET    /nip96?page=&count=               NIP-98, the caller's files
//   GET    /nip96/<sha256>[.ext]             the blob, as Blossom serves it
//   DELETE /nip96/<sha256>[.ext]             NIP-98; uploader or storage role
import { sha256 } from "@noble/hashes/sha2.js";
import { tagValues } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";
import { verifyNIP98 } from "./auth.ts";
import { can } from "./roles.ts";
import { EXT, blobBlocked, blobURL, blossom, nip94Tags, storeBlob, type Blob } from "./blossom.ts";
import type { Relay } from "./relay.ts";

const SHA_RE = /^\/nip96\/([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?$/;
const MAX_PAGE = 100;

export async function nip96(relay: Relay, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const host = url.host;
  const now = Math.floor(Date.now() / 1000);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };
  const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...cors, ...extra } });
  const fail = (message: string, status: number) => json({ status: "error", message }, status, { "x-reason": message });

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  if (url.pathname === "/.well-known/nostr/nip96.json") {
    return json({
      api_url: `https://${host}/nip96`,
      download_url: `https://${host}`,
      supported_nips: [94, 98],
      content_types: Object.keys(EXT),
      plans: {
        free: { name: "Free", is_nip98_required: true, max_byte_size: relay.settings.policy.maxBlobMB * 1024 * 1024, file_expiration: [0, 0], media_transformations: {} },
      },
    });
  }

  // Downloads are the Blossom door under a different prefix; the request
  // goes over unchanged so a signature over this URL still fits.
  const m = SHA_RE.exec(url.pathname);
  if (m && (req.method === "GET" || req.method === "HEAD")) return blossom(relay, req);

  const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, "");
  if (typeof auth === "string") return fail(auth, 401);

  if (m && req.method === "DELETE") {
    const sha = m[1];
    const blob = relay.sql.exec<Blob>(`SELECT * FROM blobs WHERE sha256=?`, sha).toArray()[0];
    if (!blob) return fail("not found", 404);
    if (blob.uploader !== auth.pubkey && !can(relay.settings.roleOf(auth.pubkey), "storage")) return fail("restricted: not the uploader", 403);
    await relay.deleteBlob(sha);
    return json({ status: "success", message: "File deleted." });
  }

  if (url.pathname !== "/nip96") return fail("not found", 404);

  if (req.method === "GET") {
    const gate = relay.settings.mayRead([auth.pubkey]);
    if (gate) return fail(gate, 403);
    const count = Math.max(1, Math.min(MAX_PAGE, Number(url.searchParams.get("count")) || 20));
    const page = Math.max(0, Math.floor(Number(url.searchParams.get("page")) || 0));
    const total = relay.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM blobs WHERE uploader=?`, auth.pubkey).one().n;
    const rows = relay.sql.exec<Blob>(`SELECT * FROM blobs WHERE uploader=? ORDER BY uploaded DESC LIMIT ? OFFSET ?`, auth.pubkey, count, page * count).toArray();
    return json({ count, total, page, files: rows.map((b) => ({ tags: nip94Tags(host, b), content: "", created_at: b.uploaded })) });
  }

  if (req.method !== "POST") return fail("method not allowed", 405);
  const gate = relay.mayUpload(auth.pubkey, host);
  if (gate) return fail(gate, 403);
  const max = relay.settings.policy.maxBlobMB * 1024 * 1024;
  const tooBig = `invalid: file exceeds ${relay.settings.policy.maxBlobMB} MB`;
  if (Number(req.headers.get("content-length")) > max) return fail(tooBig, 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("invalid: body is not multipart form data", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return fail("invalid: form needs a file field", 400);
  const declared = String(form.get("size") ?? "");
  if (declared !== "" && Number(declared) !== file.size) return fail("invalid: size field does not match the file", 400);
  if (file.size === 0) return fail("invalid: empty file", 400);
  if (file.size > max) return fail(tooBig, 413);
  const body = new Uint8Array(await file.arrayBuffer());
  const digest = sha256(body);
  const sha = bytesToHex(digest);
  // NIP-96 puts the file's hash in the token's payload tag, hex per NIP-98
  // or base64 per NIP-96's own wording; either is accepted, a mismatch is not.
  const payload = tagValues(auth, "payload")[0];
  if (payload !== undefined && payload !== sha && payload !== btoa(String.fromCharCode(...digest))) return fail("restricted: token payload does not match the file", 403);
  if (blobBlocked(relay, sha)) return fail("blocked: this file was removed by a moderator", 403);
  const type = (file.type || String(form.get("content_type") ?? "") || "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";
  const { blob, created } = await storeBlob(relay, body, type, auth.pubkey, now);
  relay.meterBytes(body.length, 0);
  return json(
    {
      status: "success",
      message: created ? "Upload successful." : "File already stored.",
      nip94_event: { tags: nip94Tags(host, blob), content: String(form.get("caption") ?? "").slice(0, 2000) },
      url: blobURL(host, blob),
    },
    created ? 201 : 200,
  );
}
