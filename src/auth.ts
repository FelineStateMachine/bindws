// Who is asking over HTTP. Two token shapes arrive in the Authorization
// header: NIP-98 (kind 27235, signed over this URL, method and body) for
// management, the bridge, dumps and views, and Blossom (kind 24242, a t tag
// naming the action) for files. whoAsks accepts either, so every read door
// can learn the caller's pubkeys the same way and hand them to the one read
// gate, Settings.mayRead. Nothing here decides access; it only identifies.
import { sha256 } from "@noble/hashes/sha2.js";
import { now, tagValues, validate, type Event } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";

export type BlossomAction = "get" | "list" | "upload" | "delete";

// verifyNIP98 checks an "Authorization: Nostr <base64 event>" header against
// the request: kind 27235, fresh, u tag naming this URL, method tag, and a
// payload tag equal to the SHA-256 of the exact body. Returns the event or
// the reason it was rejected.
export function verifyNIP98(header: string, url: string, method: string, body: string): Event | string {
  const m = /^Nostr\s+(\S+)$/i.exec(header.trim());
  if (!m) return "auth-required: missing NIP-98 Authorization header";
  let e: Event;
  try {
    e = JSON.parse(atob(m[1]));
  } catch {
    return "auth-required: malformed NIP-98 token";
  }
  const bad = validate(e);
  if (bad) return "auth-required: " + bad;
  if (e.kind !== 27235) return "auth-required: token must be kind 27235";
  if (Math.abs(now() - e.created_at) > 60) return "auth-required: token expired";
  const want = new URL(url);
  const got = (() => {
    try {
      return new URL(tagValues(e, "u")[0] ?? "");
    } catch {
      return null;
    }
  })();
  if (!got || got.host.toLowerCase() !== want.host.toLowerCase() || got.pathname !== want.pathname) return "auth-required: token was signed for another URL";
  if ((tagValues(e, "method")[0] ?? "").toUpperCase() !== method.toUpperCase()) return "auth-required: token was signed for another method";
  if (body !== "" && tagValues(e, "payload")[0] !== bytesToHex(sha256(new TextEncoder().encode(body)))) return "auth-required: token payload hash does not match the body";
  return e;
}

// verifyBlossom checks a kind 24242 event for the given action.
export function verifyBlossom(header: string, action: BlossomAction, now: number): Event | string {
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

// whoAsks reads an optional Authorization header on a read door. No header
// is a stranger, an empty list. A NIP-98 token must fit this URL and method;
// a Blossom token must be for `action`, and when it carries x tags one of
// them must name `sha`. A header that fits neither is the reason, so a
// caller who tried to sign learns what went wrong instead of being served
// as a stranger.
export function whoAsks(req: Request, body: string, action: BlossomAction | null, sha = ""): { pubkeys: string[] } | string {
  const header = req.headers.get("authorization") ?? "";
  if (header.trim() === "") return { pubkeys: [] };
  let peek: { kind?: unknown } | null = null;
  try {
    const m = /^Nostr\s+(\S+)$/i.exec(header.trim());
    peek = m ? JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))) : null;
  } catch {
    peek = null;
  }
  if (peek?.kind === 24242) {
    if (!action) return "auth-required: this door takes a NIP-98 signature";
    const e = verifyBlossom(header, action, now());
    if (typeof e === "string") return e;
    const named = tagValues(e, "x");
    if (sha && named.length && !named.includes(sha)) return "auth-required: token x tag does not name this blob";
    return { pubkeys: [e.pubkey] };
  }
  const e = verifyNIP98(header, req.url, req.method, body);
  if (typeof e === "string") return e;
  return { pubkeys: [e.pubkey] };
}

// deny maps a gate's reason to a status: auth-required is 401, anything
// else the gate says is 403.
export const denyStatus = (reason: string) => (reason.startsWith("auth-required") ? 401 : 403);
