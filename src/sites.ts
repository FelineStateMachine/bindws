// NIP-5A manifests and their single-label addresses. The routing index is
// an outbox: event mutations and pending KV writes commit together in SQL.
import { sha256 } from "@noble/hashes/sha2.js";
import { decode, npubEncode } from "nostr-tools/nip19";
import { expiration, now, tag, type Event } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";
import { KIND_SITE, KIND_NAMED_SITE, KIND_SITE_SNAPSHOT } from "./kinds.ts";
import type { Filter } from "./filter.ts";
import type { Relay } from "./relay.ts";

export const SITE_KINDS = [KIND_SITE, KIND_NAMED_SITE, KIND_SITE_SNAPSHOT];
const HEX = /^[0-9a-f]{64}$/;
export const SITE_NAME = /^[a-z0-9-]{1,13}(?<!-)$/;
export type Site = { kind: typeof KIND_SITE; pubkey: string } | { kind: typeof KIND_NAMED_SITE; pubkey: string; d: string } | { kind: typeof KIND_SITE_SNAPSHOT; id: string };

// Fixed width preserves all 32 bytes, including leading zero bytes. The
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
  if (e.kind === KIND_NAMED_SITE ? ds.length !== 1 || !SITE_NAME.test(ds[0][1] ?? "") : ds.length !== 0) return "invalid: site d tag must be a 1–13 character named-site identifier; root sites and snapshots have none";
  const paths = sitePaths(e);
  if (!paths.length) return "invalid: a site needs at least one path tag";
  const seen = new Set<string>();
  for (const t of paths) {
    const p = t[1] ?? "";
    if (t.length !== 3 || !/^\/(?:[^/]+\/)*[^/]+\.[^/.]+$/.test(p) || /[\\?#\x00-\x20\x7f]/.test(p) || p.split("/").some((s) => s === "." || s === "..") || !HEX.test(t[2])) return "invalid: site paths must map absolute filenames with extensions to lowercase sha256 hashes";
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
CREATE TABLE IF NOT EXISTS site_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, raw TEXT NOT NULL, removed INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS site_added AFTER INSERT ON events WHEN new.kind IN (15128,35128,5128) BEGIN
  INSERT INTO site_outbox(raw,removed) VALUES(new.raw,0);
END;
CREATE TRIGGER IF NOT EXISTS site_removed AFTER DELETE ON events WHEN old.kind IN (15128,35128,5128) BEGIN
  INSERT INTO site_outbox(raw,removed) VALUES(old.raw,1);
END;
`;

// Never clear another relay's mapping, or a newer publication's mapping.
// A failed KV write leaves the SQL entry intact for the next alarm.
export async function syncSiteIndex(relay: Relay): Promise<boolean> {
  if (!relay.hosts || !relay.slug) return false;
  const rows = relay.sql.exec<{ seq: number; raw: string; removed: number }>(`SELECT * FROM site_outbox ORDER BY seq LIMIT 100`).toArray();
  for (const row of rows) {
    const e = JSON.parse(row.raw) as Event;
    if (!checkSite(e)) {
      const key = siteKey(siteLabel(e));
      if (row.removed || (expiration(e) > 0 && expiration(e) <= now())) {
        const existing = await relay.hosts.get(key);
        if (existing === JSON.stringify({ name: relay.slug, event: e.id })) await relay.hosts.delete(key);
      } else {
        await relay.hosts.put(key, JSON.stringify({ name: relay.slug, event: e.id }));
      }
    }
    relay.sql.exec(`DELETE FROM site_outbox WHERE seq=?`, row.seq);
  }
  return rows.length === 100;
}

export async function forgetSites(relay: Relay): Promise<void> {
  relay.sql.exec(`INSERT INTO site_outbox(raw,removed) SELECT raw,1 FROM events WHERE kind IN (15128,35128,5128)`);
  while (await relay.syncSites()) { /* bounded batches */ }
}
