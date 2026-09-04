// NIP-AD web addresses: a browser path names a live Nostr event on this
// relay. Discovery only reads local state; no supplied path becomes a fetch.
// Proposal revision: b82a9bf66ec9757149b5aa3b3cd36190dd4e6fed (PR 2406).
import { whoAsks, denyStatus } from "./auth.ts";
import { isAddressable, isReplaceable, now, tag, type Event } from "./event.ts";
import { KIND_GROUP_METADATA } from "./kinds.ts";
import { pageEvent } from "./pages.ts";
import type { Relay } from "./relay.ts";
import { featureOn } from "./settings.ts";

// A name lookup retains NIP-05 semantics even when a path is also supplied.
export const isWebAddressRequest = (url: URL): boolean => url.pathname === "/.well-known/nostr.json" && url.searchParams.has("path") && !url.searchParams.has("name");

// requestedPath keeps the original escaped spelling as the response key.
// Full URLs, queries, fragments, dot segments and ambiguous separators are
// not pathnames. One decoding pass matches the browser page and site doors.
export function requestedPath(url: URL): string | null {
  const paths = url.searchParams.getAll("path");
  if (paths.length !== 1) return null;
  const path = paths[0];
  if (path.length > 4096 || !path.startsWith("/") || path.startsWith("//") || /[\\?#\s\x00-\x1f\x7f]/.test(path)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  if (/[\\\x00-\x1f\x7f]/.test(decoded) || decoded.startsWith("//") || decoded.split("/").some((s) => s === "." || s === "..")) return null;
  return path;
}

export function eventFilter(e: Event): Record<string, unknown> {
  if (isAddressable(e.kind)) return { kinds: [e.kind], authors: [e.pubkey], "#d": [tag(e, "d")], limit: 1 };
  if (isReplaceable(e.kind)) return { kinds: [e.kind], authors: [e.pubkey], limit: 1 };
  return { ids: [e.id], limit: 1 };
}

export function webAddressResponse(req: Request, path: string | null, filter: Record<string, unknown> | null, relayURL: string, status = 200): Response {
  const headers = {
    "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
    "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "authorization, accept", "x-content-type-options": "nosniff",
    ...(status === 405 ? { allow: "GET, HEAD, OPTIONS" } : {}),
  };
  const body = path !== null && filter ? { [path]: { filter, relays: [relayURL] } } : {};
  return new Response(req.method === "HEAD" || req.method === "OPTIONS" ? null : JSON.stringify(body), { status, headers });
}

export function webAddress(relay: Relay, req: Request, url: URL): Response {
  const relayURL = relay.relayURL(url.host);
  const reply = (path: string | null, filter: Record<string, unknown> | null = null, status = 200) => webAddressResponse(req, path, filter, relayURL, status);
  if (req.method === "OPTIONS") return reply(null);
  if (req.method !== "GET" && req.method !== "HEAD") return reply(null, null, 405);
  const path = requestedPath(url);
  if (path === null) return reply(null, null, 400);
  const who = whoAsks(req, "", null);
  if (typeof who === "string") return reply(null, null, 401);
  if (relay.settings.isUnclaimed() || relay.settings.leaseExpired(now())) return reply(null);
  if (path === "/") {
    const gate = relay.settings.mayRead(who.pubkeys);
    if (gate) return reply(null, null, denyStatus(gate));
    const authors = [relay.identity.pubkey];
    const kinds = [KIND_GROUP_METADATA];
    const raw = relay.store.query({ authors, kinds, tags: { d: [relay.slug] }, limit: 1 }, who, 1, now()).rows[0];
    return reply(path, raw ? eventFilter(JSON.parse(raw) as Event) : null);
  }
  const e = featureOn(relay.settings.policy, "pages") ? pageEvent(relay, path) : null;
  // An /e URL always names that exact version, including an article version.
  return reply(path, e ? (path.startsWith("/e/") ? { ids: [e.id], limit: 1 } : eventFilter(e)) : null);
}
