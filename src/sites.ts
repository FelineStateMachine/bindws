// NIP-5A manifests and their single-label addresses. The routing index is
// an outbox: event mutations and pending KV writes commit together in SQL.
import { sha256 } from "@noble/hashes/sha2.js";
import { decode, npubEncode } from "nostr-tools/nip19";
import { expiration, now, tag, type Event } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";
import { KIND_SITE, KIND_NAMED_SITE, KIND_SITE_SNAPSHOT } from "./kinds.ts";
import type { Filter } from "./filter.ts";
import type { Relay } from "./relay.ts";
import { SITE_AUTH_PATH, siteIdentity } from "./site-auth.ts";
import { denyStatus } from "./auth.ts";
import { featureOn } from "./settings.ts";
import { remoteSiteBlob } from "./site-mirror.ts";
import { blobBlocked, type Blob } from "./blossom.ts";
import { eventFilter, isWebAddressRequest, requestedPath, webAddressResponse } from "./nipad.ts";

export const SITE_KINDS = [KIND_SITE, KIND_NAMED_SITE, KIND_SITE_SNAPSHOT];
const HEX = /^[0-9a-f]{64}$/;
export const SITE_NAME = /^[a-z0-9-]{1,13}(?<!-)$/;
export type Site = { kind: typeof KIND_SITE; pubkey: string } | { kind: typeof KIND_NAMED_SITE; pubkey: string; d: string } | { kind: typeof KIND_SITE_SNAPSHOT; id: string };

// base36 preserves all 32 bytes at a fixed width, including leading zeros. The
// draft's "no padding" and "always exactly 50" conflict for small integers;
// the parser and DNS boundary require the latter (see docs/20).
export function base36(hex: string): string {
  if (!HEX.test(hex)) throw new Error("expected 32 bytes in lowercase hex");
  return BigInt("0x" + hex).toString(36).padStart(50, "0");
}
export function unbase36(s: string): string | null {
  if (!/^[0-9a-z]{50}$/.test(s)) return null;
  let n = 0n;
  for (const c of s) n = n * 36n + BigInt(parseInt(c, 36));
  return n < 1n << 256n ? n.toString(16).padStart(64, "0") : null;
}
export function parseSite(label: string): Site | null {
  if (label.startsWith("npub1")) {
    try {
      const p = decode(label);
      if (p.type === "npub" && npubEncode(p.data) === label) return { kind: KIND_SITE, pubkey: p.data };
    } catch { /* continue in the draft's specified order */ }
  }
  if (/^v[0-9a-z]{50}$/.test(label)) {
    const id = unbase36(label.slice(1));
    return id ? { kind: KIND_SITE_SNAPSHOT, id } : null;
  }
  if (!/^[0-9a-z]{50}[a-z0-9-]{1,13}$/.test(label) || label.endsWith("-")) return null;
  const pubkey = unbase36(label.slice(0, 50));
  return pubkey ? { kind: KIND_NAMED_SITE, pubkey, d: label.slice(50) } : null;
}
export function siteLabel(e: Event): string {
  if (e.kind === KIND_SITE) return npubEncode(e.pubkey);
  if (e.kind === KIND_NAMED_SITE) return base36(e.pubkey) + tag(e, "d");
  if (e.kind === KIND_SITE_SNAPSHOT) return "v" + base36(e.id);
  return "";
}
export const siteKey = (label: string) => "nsite:" + label;
export const sitePaths = (e: Event) => e.tags.filter((t) => t[0] === "path");
export function aggregate(e: Pick<Event, "tags">): string {
  const lines = e.tags.filter((t) => t[0] === "path").map((t) => `${t[2]} ${t[1]}\n`).sort().join("");
  return bytesToHex(sha256(new TextEncoder().encode(lines)));
}
function reference(s: string): boolean {
  const [k, pubkey, d, extra] = s.split(":");
  return extra === undefined && HEX.test(pubkey ?? "") && (k === String(KIND_SITE) ? d === "" : k === String(KIND_NAMED_SITE) && SITE_NAME.test(d ?? ""));
}
export function checkSite(e: Event): string {
  if (!SITE_KINDS.includes(e.kind)) return "";
  const ds = e.tags.filter((t) => t[0] === "d");
  if (e.kind === KIND_NAMED_SITE ? ds.length !== 1 || !SITE_NAME.test(ds[0][1] ?? "") : ds.length !== 0) return "invalid: site d tag must be a 1-13 character named-site identifier; root sites and snapshots have none";
  const paths = sitePaths(e);
  if (!paths.length) return "invalid: a site needs at least one path tag";
  const seen = new Set<string>();
  for (const t of paths) {
    const p = t[1] ?? "";
    if (t.length !== 3 || !/^\/(?:[^/]+\/)*[^/]+\.[^/.]+$/.test(p) || /[\\?#\x00-\x1f\x7f]/.test(p) || p.split("/").some((s) => s === "." || s === "..") || !HEX.test(t[2])) return "invalid: site paths must map absolute filenames with extensions to lowercase sha256 hashes";
    if (seen.has(p)) return "invalid: duplicate site path";
    seen.add(p);
  }
  const xs = e.tags.filter((t) => t[0] === "x");
  if (xs.length > 1 || (e.kind === KIND_SITE_SNAPSHOT && xs.length !== 1) || xs.some((t) => t.length !== 3 || t[2] !== "aggregate" || t[1] !== aggregate(e))) return "invalid: site x tag must match the aggregate hash";
  const a = e.tags.filter((t) => t[0] === "a");
  const A = e.tags.filter((t) => t[0] === "A");
  if (a.length > 1 || A.length > 1 || [...a, ...A].some((t) => !reference(t[1] ?? ""))) return "invalid: site lineage must reference a root or named site";
  if (e.kind === KIND_SITE_SNAPSHOT ? a.length !== 1 : a.length !== A.length) return "invalid: snapshot needs a source a tag; copies need a and A tags";
  return "";
}

export function manifest(relay: Relay, site: Site): Event | null {
  const f: Filter = site.kind === KIND_SITE_SNAPSHOT ? { ids: [site.id], kinds: [site.kind], tags: {} } : { authors: [site.pubkey], kinds: [site.kind], tags: site.kind === KIND_NAMED_SITE ? { d: [site.d] } : {} };
  const raw = relay.store.query(f, { pubkeys: [] }, 1, now()).rows[0];
  if (!raw) return null;
  const e = JSON.parse(raw) as Event;
  return checkSite(e) ? null : e;
}

export const SITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS site_mirror_queue (event_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS site_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, raw TEXT NOT NULL, removed INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS site_added AFTER INSERT ON events WHEN new.kind IN (${SITE_KINDS.join(",")}) BEGIN
  INSERT INTO site_outbox(raw,removed) VALUES(new.raw,0);
  INSERT OR IGNORE INTO site_mirror_queue(event_id) VALUES(new.id);
END;
CREATE TRIGGER IF NOT EXISTS site_removed AFTER DELETE ON events WHEN old.kind IN (${SITE_KINDS.join(",")}) BEGIN
  INSERT INTO site_outbox(raw,removed) VALUES(old.raw,1);
  DELETE FROM site_mirror_queue WHERE event_id=old.id;
END;
`;

// syncSiteIndex coalesces replacements into one KV write per label, keeping
// the old route usable if a write is throttled. Failed groups stay queued.
export async function syncSiteIndex(relay: Relay): Promise<boolean> {
  if (!relay.hosts || !relay.slug) return false;
  const rows = relay.sql.exec<{ seq: number; raw: string; removed: number }>(`SELECT * FROM site_outbox ORDER BY seq LIMIT 100`).toArray();
  const groups = new Map<string, { seq: number; e: Event; removed: number }[]>();
  for (const row of rows) {
    const e = JSON.parse(row.raw) as Event;
    if (checkSite(e)) { relay.sql.exec(`DELETE FROM site_outbox WHERE seq=?`, row.seq); continue; }
    const label = siteLabel(e);
    const group = groups.get(label) ?? [];
    group.push({ seq: row.seq, e, removed: row.removed });
    groups.set(label, group);
  }
  for (const [label, group] of groups) {
    const last = group[group.length - 1];
    const removed = last.removed || (expiration(last.e) > 0 && expiration(last.e) <= now());
    // A batch can end between a replacement's removal and insertion. A
    // different live version keeps the route; teardown removes the same
    // version explicitly even while it still exists in the events table.
    const current = manifest(relay, parseSite(label)!);
    const target = removed ? current && current.id !== last.e.id ? current : null : current;
    const key = siteKey(label);
    const existing = await relay.hosts.get(key);
    if (target) {
      const value = JSON.stringify({ name: relay.slug, event: target.id });
      if (existing !== value) await relay.hosts.put(key, value);
    } else if (group.some(({ e }) => existing === JSON.stringify({ name: relay.slug, event: e.id }))) {
      await relay.hosts.delete(key);
    }
    for (const row of group) relay.sql.exec(`DELETE FROM site_outbox WHERE seq=?`, row.seq);
  }
  return relay.sql.exec(`SELECT 1 FROM site_outbox LIMIT 1`).toArray().length > 0;
}

export async function forgetSites(relay: Relay): Promise<void> {
  if (!relay.hosts) return;
  relay.sql.exec(`INSERT INTO site_outbox(raw,removed) SELECT raw,1 FROM events WHERE kind IN (${SITE_KINDS.join(",")})`);
  do { await relay.syncSites(); } while (relay.sql.exec(`SELECT 1 FROM site_outbox LIMIT 1`).toArray().length);
}

const SITE_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  txt: "text/plain; charset=utf-8", xml: "application/xml", wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2", pdf: "application/pdf",
};
export const siteType = (path: string) => SITE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
const siteError = (req: Request, status: number, message: string) => new Response(req.method === "HEAD" ? null : message, { status, headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8" } });
const discoveryError = (req: Request, status: number, message: string) => {
  const response = siteError(req, status, message);
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(response.body, { status: response.status, headers });
};

// siteRelayURL gives a discovery document the relay address behind a hosted
// site. A custom site hostname must never become the relay hint.
const siteRelayURL = (relay: Relay, url: URL): string => {
  const host = url.hostname.endsWith(".localhost")
    ? `${relay.slug}.localhost${url.port ? ":" + url.port : ""}`
    : `${relay.slug}.${relay.domain}`;
  return relay.relayURL(host);
};

// sitePath selects the browser's exact escaped filename before its decoded
// counterpart. Discovery follows a directory's redirect to its index page.
function sitePath(e: Event, pathname: string): { redirect: boolean; mapping: string[] | undefined } | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const directory = !/[^/]+\.[^/.]+$/.test(decoded);
  const redirect = directory && !decoded.endsWith("/");
  if (redirect) { pathname += "/"; decoded += "/"; }
  if (directory) decoded += "index.html";
  const paths = sitePaths(e);
  return { redirect, mapping: paths.find((t) => t[1] === pathname) ?? paths.find((t) => t[1] === decoded) };
}

// serveSite answers the site origin, under the read rule. Relay handlers
// and content negotiation never run here, even on paths the relay uses.
export async function serveSite(relay: Relay, req: Request, label: string): Promise<Response> {
  const site = parseSite(label);
  const url = new URL(req.url);
  const discovery = isWebAddressRequest(url);
  const fail = (status: number, message: string) => discovery ? discoveryError(req, status, message) : siteError(req, status, message);
  const host = url.hostname;
  const canonical = host === `${label}.${relay.domain.toLowerCase()}` || host === `${label}.localhost`;
  if (!canonical && relay.settings.policy.customHosts?.find((h) => h.host === host)?.site !== label) return fail(404, "Not found");
  if (!site || !featureOn(relay.settings.policy, "sites") || relay.settings.isUnclaimed() || relay.settings.leaseExpired(now())) return fail(404, "Not found");
  if (discovery && req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, accept", "access-control-allow-methods": "GET, HEAD, OPTIONS", "cache-control": "no-store" } });
  }
  if (req.headers.get("upgrade") || (!["GET", "HEAD"].includes(req.method) && !(url.pathname === SITE_AUTH_PATH && req.method === "POST"))) {
    return discovery ? webAddressResponse(req, null, null, siteRelayURL(relay, url), 405) : siteError(req, 405, "Method not allowed");
  }
  const who = await siteIdentity(relay, req, label);
  if (who instanceof Response) return discovery ? (() => { const headers = new Headers(who.headers); headers.set("access-control-allow-origin", "*"); return new Response(who.body, { status: who.status, headers }); })() : who;
  const gate = relay.settings.mayRead(who.pubkeys);
  if (gate) return fail(denyStatus(gate), gate);
  const e = manifest(relay, site);
  if (!e) return discovery ? webAddressResponse(req, requestedPath(url), null, siteRelayURL(relay, url), 404) : siteError(req, 404, "Not found");
  if (discovery) {
    if (!featureOn(relay.settings.policy, "sites") || relay.settings.isUnclaimed() || relay.settings.leaseExpired(now())) return fail(404, "Not found");
    if (!canonical && relay.settings.policy.customHosts?.find((h) => h.host === host)?.site !== label) return fail(404, "Not found");
    const path = requestedPath(url);
    if (path === null) return webAddressResponse(req, null, null, siteRelayURL(relay, url), 400);
    const mapping = sitePath(e, path)?.mapping;
    return webAddressResponse(req, path, mapping && !blobBlocked(relay, mapping[2]) ? eventFilter(e) : null, siteRelayURL(relay, url));
  }
  const selected = sitePath(e, url.pathname);
  if (!selected) return siteError(req, 404, "Not found");
  if (selected.redirect) {
    url.pathname += "/";
    return new Response(null, { status: 308, headers: { location: url.href, "cache-control": "private, no-store" } });
  }
  const paths = sitePaths(e);
  let mapping = selected.mapping;
  let status = 200;
  if (!mapping) { mapping = paths.find((t) => t[1] === "/404.html"); status = 404; }
  if (!mapping || blobBlocked(relay, mapping[2])) return siteError(req, 404, "Not found");
  const sha = mapping[2];
  const blob = relay.sql.exec<Blob>(`SELECT * FROM blobs WHERE sha256=?`, sha).toArray()[0];
  const obj = blob ? await relay.media.get(`${relay.slug}/${sha}`) : null;
  let remote: Awaited<ReturnType<typeof remoteSiteBlob>> = null;
  if (obj) {
    // Verify in a streaming pass, then serve the same immutable R2 version.
    const hash = sha256.create();
    const reader = obj.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    if (bytesToHex(hash.digest()) !== sha) return siteError(req, 404, "Not found");
  } else {
    remote = await remoteSiteBlob(relay, e, mapping);
    if (!remote) return siteError(req, 404, "Not found");
  }
  // Every asynchronous fetch is followed by the live policy and manifest
  // check, including HEAD and conditional responses.
  if (!featureOn(relay.settings.policy, "sites") || blobBlocked(relay, sha) || manifest(relay, site)?.id !== e.id || relay.settings.mayRead(who.pubkeys)) return siteError(req, 404, "Not found");
  const headers = new Headers({
    etag: `"${sha}"`,
    // Revalidation respects policy changes and expiry, including snapshots.
    // Edge transforms must preserve the bytes named by the signed manifest.
    "cache-control": relay.settings.policy.reads === "open" ? "public, no-cache, must-revalidate, no-transform" : "private, no-store, no-transform",
    "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
  });
  if (obj && blob) {
    headers.set("content-type", blob.type || siteType(mapping[1]));
    headers.set("content-length", String(obj.size));
  } else if (remote) {
    if (remote.type) headers.set("content-type", remote.type);
    if (remote.length !== null) headers.set("content-length", remote.length);
  }
  if (status === 200 && req.headers.get("if-none-match")?.split(",").some((v) => v.trim().replace(/^W\//, "") === headers.get("etag") || v.trim() === "*")) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  if (req.method === "HEAD") return new Response(null, { status, headers });
  if (remote) {
    relay.meterBytes(0, remote.bytes.length);
    return new Response(remote.bytes, { status, headers });
  }
  if (!obj) return siteError(req, 404, "Not found");
  const verified = await relay.media.get(`${relay.slug}/${sha}`, { onlyIf: { etagMatches: obj.etag } });
  if (!verified || !("body" in verified) || !featureOn(relay.settings.policy, "sites") || relay.settings.leaseExpired(now()) || blobBlocked(relay, sha) || manifest(relay, site)?.id !== e.id || relay.settings.mayRead(who.pubkeys)) return siteError(req, 404, "Not found");
  relay.meterBytes(0, verified.size);
  return new Response(verified.body, { status, headers });
}
