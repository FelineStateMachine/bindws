// Per-relay settings and policy, kept in the same SQLite database.
import { callbackOrigins } from "./push-policy.ts";
import { notifySettings, type NotifySettings } from "./notify.ts";
import type { CustomHost } from "./domains.ts";
import type { Role } from "./roles.ts";

// A lease makes an unclaimed relay usable for a while: open to everyone,
// then wiped at `until` unless somebody claims it first. holder "" means
// anyone may claim; a pubkey means only that key.
export interface Lease {
  until: number;
  holder: string;
}

// Succession is the dead-man's switch: when the owner has not signed in for
// `afterDays`, the relay warns them for a month, then hands itself to the
// heir, who must be a member.
export interface Succession {
  heir: string;
  afterDays: number;
}
export const SUCCESSION_DAYS = [90, 180, 365];
// How long the warnings run before the handover.
export const SUCCESSION_WARN_DAYS = 30;

export interface Policy {
  owner: string; // pubkey; "" while unclaimed
  succession: Succession | null; // off until the owner names an heir
  lease: Lease | null; // set while the relay is a temporary lease
  customHosts: CustomHost[]; // this relay's own domains (see domains.ts)
  name: string;
  description: string;
  icon: string;
  banner: string; // NIP-11 banner image URL
  contact: string;
  // NIP-11 extras: links to written policies, and what the relay is about.
  postingPolicy: string; // URL
  privacyPolicy: string; // URL
  tags: string[]; // short topic words
  languageTags: string[]; // BCP-47, such as en or pt-BR
  relayCountries: string[]; // ISO 3166-1 alpha-2, such as US
  notify: NotifySettings; // relay-signed NIP-17 messages to the owner
  writes: "open" | "allowlist" | "wot" | "owner"; // who may publish; wot is members and their follows
  // Guests: kinds anyone may write whatever the write rule says, and
  // whether anyone may reply to a member's note or comment thread.
  openKinds: number[];
  guestReplies: boolean;
  // Content containing one of these, case-insensitive, is refused unless the
  // author is the owner or a moderator. An entry written /like this/ is a
  // regular expression; blockedWordsInTags searches tag values as well.
  blockedWords: string[];
  blockedWordsInTags: boolean;
  // Open reports from this many distinct reporters hide an event until a
  // moderator resolves them; 0 turns it off.
  reportThreshold: number;
  reads: "open" | "auth" | "members"; // whether REQ/COUNT need NIP-42, or membership
  joinTerms: string; // shown before an invite is accepted (markdown-ish plain text)
  directoryPublic: boolean; // whether the people directory is shown to visitors
  maxBlobMB: number; // Blossom upload size cap
  eventsPerMinute: number; // per-connection write rate
  reqsPerMinute: number; // per-connection query rate
  minPow: number;
  maxFuture: number; // seconds; 0 disables
  maxLimit: number;
  maxSubs: number;
  maxMessageKB: number; // largest socket message, in KB; MAX_MESSAGE in relay.ts is the ceiling
  // Nightly dumps: a JSONL of every event, written to R2 by the alarm and
  // kept for `dumpsKeep` runs. Counted as media for fuel.
  dumps: "off" | "daily" | "weekly";
  dumpsKeep: number;
  // Members inviting members: a member whose distance from the owner along
  // invited_by is below `depth` may hold up to `quota` live invites. depth 0
  // turns it off, which leaves inviting to the owner and moderators.
  memberInvites: { depth: number; quota: number };
  // Views (views.ts): a name maps to false when the owner switched it off.
  views: Record<string, ViewSetting>;
  features: Features;
  pushCallbacks: string[]; // HTTPS origins approved by the owner and the host operator
  letteredNips: boolean; // opt into mixed NIP-11 identifiers; push also requires them
}

export const VIEW_NAMES = ["profiles", "relays", "calendar", "moderation", "articles", "zaps", "presence"];
// A view's setting: off, or the trigger it runs on. A view not named here
// runs on its own trigger (views.ts); a setting a view cannot take (a
// schedule for the live presence view) is ignored there.
export const VIEW_SETTINGS = ["off", "write", "hourly", "daily"] as const;
export type ViewSetting = (typeof VIEW_SETTINGS)[number];

// viewFields applies a `views` patch of name to boolean; unknown names are dropped.
// Features an operator may switch off, each a door or a cost. The bridge
// is not one: the console runs on it. What is off leaves supported_nips
// (nip11.ts), answers 404 at its door (routes.ts) and is refused at the
// socket (gates.ts, relay.ts).
export const FEATURE_NAMES = ["search", "sync", "count", "discovery", "names", "files", "pages", "signer", "sites", "marmot", "grasp", "push"] as const;
export type Feature = (typeof FEATURE_NAMES)[number];
export type SearchMode = "full" | "prose" | "off";
export interface Features {
  search: SearchMode; // NIP-50: full indexes every public kind with content, prose the kinds that carry prose
  sync: boolean; // NIP-77 negentropy
  count: boolean; // NIP-45 COUNT, with HLL
  discovery: boolean; // NIP-66: the record the relay signs about itself
  names: boolean; // NIP-05 under the relay's domain
  files: boolean; // Blossom and NIP-96
  pages: boolean; // notes and articles as pages, the feed
  sites: { enabled: boolean; mirror: boolean }; // NIP-5A hosting and automatic blob copies
  grasp: boolean; // GRASP Git repositories and accepted repository state
  signer: boolean; // NIP-46 traffic carried for anyone
  push: boolean; // NIP-9a relay-to-callback delivery
  marmot: boolean; // Marmot's opaque MLS transport events
}
export const DEFAULT_FEATURES: Features = { search: "prose", sync: true, count: true, discovery: true, names: true, files: true, pages: true, signer: true, sites: { enabled: true, mirror: true }, marmot: false, grasp: false, push: false };
export const featureOn = (p: Policy, f: Feature): boolean => f === "sites" ? p.features.sites.enabled : p.features[f] !== false && p.features[f] !== "off";

export function featureFields(patch: Record<string, unknown>, cur: Features): Partial<Policy> {
  if (!patch.features || typeof patch.features !== "object") return {};
  const out: Features = { ...cur };
  for (const [k, v] of Object.entries(patch.features as Record<string, unknown>)) {
    if (k === "sites") {
      if (typeof v === "boolean") out.sites = { ...cur.sites, enabled: v };
      else if (v && typeof v === "object") {
        const patch = v as Record<string, unknown>;
        out.sites = { enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.sites.enabled, mirror: typeof patch.mirror === "boolean" ? patch.mirror : cur.sites.mirror };
      }
    } else if (k === "search") {
      if (v === "full" || v === "prose" || v === "off") out.search = v;
    } else if ((FEATURE_NAMES as readonly string[]).includes(k) && typeof v === "boolean") (out as unknown as Record<string, boolean>)[k] = v;
  }
  return { features: out };
}

// policyPatch is what setpolicy and a configuration document accept: every
// field checked, the rest dropped.
export function policyPatch(patch: Record<string, unknown>, cur: Policy): Partial<Policy> {
  const clean: Record<string, unknown> = {};
  for (const k of ["name", "description", "icon", "contact"]) if (typeof patch[k] === "string") clean[k] = (patch[k] as string).slice(0, 2000);
  Object.assign(clean, publicFields(patch), dumpFields(patch), gateFields(patch), viewFields(patch, cur.views), featureFields(patch, cur.features));
  if (isWriteRule(patch.writes)) clean.writes = patch.writes;
  if (patch.reads === "open" || patch.reads === "auth" || patch.reads === "members") clean.reads = patch.reads;
  if (typeof patch.joinTerms === "string") clean.joinTerms = patch.joinTerms.slice(0, 20000);
  if (typeof patch.directoryPublic === "boolean") clean.directoryPublic = patch.directoryPublic;
  if (typeof patch.letteredNips === "boolean") clean.letteredNips = patch.letteredNips;
  const callbacks = callbackOrigins(patch.pushCallbacks);
  if (callbacks) clean.pushCallbacks = callbacks;
  const notifyPatch = notifySettings(patch.notify, cur.notify);
  if (notifyPatch) clean.notify = notifyPatch;
  Object.assign(clean, limitFields(patch));
  return clean as Partial<Policy>;
}

// viewFields takes a view's setting; true and false still mean the default
// trigger and off, as they did before settings were triggers.
export function viewFields(patch: Record<string, unknown>, cur: Record<string, ViewSetting>): Partial<Policy> {
  if (!patch.views || typeof patch.views !== "object") return {};
  const out: Record<string, ViewSetting> = { ...cur };
  for (const [k, v] of Object.entries(patch.views as Record<string, unknown>)) {
    if (!VIEW_NAMES.includes(k)) continue;
    if (v === true) delete out[k];
    else if (v === false) out[k] = "off";
    else if ((VIEW_SETTINGS as readonly unknown[]).includes(v)) out[k] = v as ViewSetting;
  }
  return { views: out };
}

export const DEFAULT_POLICY: Policy = {
  owner: "",
  lease: null,
  customHosts: [],
  name: "",
  description: "",
  icon: "",
  banner: "",
  contact: "",
  postingPolicy: "",
  privacyPolicy: "",
  tags: [],
  languageTags: [],
  relayCountries: [],
  notify: { reports: false, fuel: false, jobs: false, succession: false, digest: false },
  succession: null,
  writes: "open",
  openKinds: [],
  guestReplies: false,
  blockedWords: [],
  blockedWordsInTags: false,
  reportThreshold: 0,
  reads: "open",
  joinTerms: "",
  directoryPublic: true,
  maxBlobMB: 25,
  eventsPerMinute: 120,
  reqsPerMinute: 240,
  minPow: 0,
  maxFuture: 900,
  maxLimit: 500,
  maxSubs: 20,
  maxMessageKB: 128,
  dumps: "off",
  dumpsKeep: 7,
  memberInvites: { depth: 0, quota: 0 },
  views: {},
  features: { ...DEFAULT_FEATURES },
  pushCallbacks: [],
  letteredNips: false,
};

export const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pubkey_rules (pubkey TEXT PRIMARY KEY, rule TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS event_rules (id TEXT PRIMARY KEY, rule TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ip_rules (ip TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kind_rules (kind INTEGER PRIMARY KEY, rule TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retention (kind INTEGER PRIMARY KEY, days INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS members (pubkey TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member', name TEXT, note TEXT NOT NULL DEFAULT '', joined_at INTEGER NOT NULL, via TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS members_name ON members(name) WHERE name IS NOT NULL;
CREATE TABLE IF NOT EXISTS nip05 (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter TEXT NOT NULL, target_pubkey TEXT NOT NULL, target_event TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_by TEXT NOT NULL DEFAULT '', resolved_at INTEGER NOT NULL DEFAULT 0, action TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, uploader TEXT NOT NULL, uploaded INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS blobs_uploader ON blobs(uploader, uploaded DESC);
CREATE TABLE IF NOT EXISTS dumps (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, events INTEGER NOT NULL, at INTEGER NOT NULL);
`;

// Columns added after the first release. There are no PRAGMAs in this
// SQLite, so a probing SELECT stands in for "does the column exist".
const MEMBER_COLUMNS: [string, string][] = [
  ["keep_days", "INTEGER NOT NULL DEFAULT 0"], // per-member keep-for; 0 = the relay's rules
  ["max_bytes", "INTEGER NOT NULL DEFAULT 0"], // per-member storage cap; 0 = unlimited
  ["invited_by", "TEXT NOT NULL DEFAULT ''"], // who minted the invite they joined with
];
function ensureColumns(sql: SqlStorage, table: string, cols: [string, string][]) {
  for (const [col, decl] of cols) {
    try {
      sql.exec(`SELECT ${col} FROM ${table} LIMIT 1`).toArray();
    } catch {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  }
}

// A member is one person of this relay: the owner or someone let in. Their
// optional name is their NIP-05 handle at the relay's host.
export type Member = {
  pubkey: string;
  role: Role;
  name: string | null;
  note: string;
  joined_at: number;
  via: string; // claimed | invite <code> | added | profile
  keep_days: number; // 0 = the relay's rules
  max_bytes: number; // 0 = unlimited
  invited_by: string; // pubkey of the inviter, "" when added by the owner or joined open
};

// Limits the write path checks per author, cached so a write costs no query.
export type MemberLimits = { keep: number; cap: number };

// dumpFields validates the dump and member-invite settings of a policy patch.
export function dumpFields(patch: Record<string, unknown>): Partial<Policy> {
  const out: Partial<Policy> = {};
  if (patch.dumps === "off" || patch.dumps === "daily" || patch.dumps === "weekly") out.dumps = patch.dumps;
  if (Number.isInteger(patch.dumpsKeep) && (patch.dumpsKeep as number) >= 1 && (patch.dumpsKeep as number) <= 60) out.dumpsKeep = patch.dumpsKeep as number;
  const mi = patch.memberInvites as Record<string, unknown> | undefined;
  if (mi && typeof mi === "object" && Number.isInteger(mi.depth) && Number.isInteger(mi.quota) && (mi.depth as number) >= 0 && (mi.depth as number) <= 10 && (mi.quota as number) >= 0 && (mi.quota as number) <= 100) {
    out.memberInvites = { depth: mi.depth as number, quota: mi.quota as number };
  }
  return out;
}

export const NAME_RE = /^[a-z0-9._-]{1,64}$/;

export const WRITE_RULES = ["open", "allowlist", "wot", "owner"] as const;
export type WriteRule = (typeof WRITE_RULES)[number];
export const isWriteRule = (v: unknown): v is WriteRule => typeof v === "string" && (WRITE_RULES as readonly string[]).includes(v);

const MAX_OPEN_KINDS = 50;
const MAX_BLOCKED_WORDS = 200;
// How many pubkeys the web of trust may hold; past it the newest lists are dropped.
export const MAX_WOT = 50_000;

const MAX_PATTERN = 200;

// wordPattern says whether a blocked-word entry is a regular expression,
// written /like this/, and gives its source.
export function wordPattern(w: string): string | null {
  return w.length >= 3 && w.startsWith("/") && w.endsWith("/") ? w.slice(1, -1) : null;
}

// badBlockedWord is the reason an entry cannot be used, or "" when it can:
// a pattern that does not compile or is too long. Plain words are never bad,
// merely dropped when too short or too long.
export function badBlockedWord(x: unknown): string {
  if (typeof x !== "string") return "";
  const src = wordPattern(x.trim());
  if (src === null) return "";
  if (x.trim().length > MAX_PATTERN) return `invalid: pattern is longer than ${MAX_PATTERN} characters: ${x.trim().slice(0, 40)}`;
  try {
    new RegExp(src, "i");
  } catch (err) {
    return "invalid: " + (err instanceof Error ? err.message : "bad pattern");
  }
  return "";
}

// blockedWords cleans a list: trimmed, unique, capped. A plain word is
// lowercased and 2 to 64 characters; a /pattern/ keeps its case, since it is
// compiled case-insensitive, and must compile.
export function blockedWords(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (wordPattern(t) !== null) {
      if (badBlockedWord(t) === "") seen.add(t);
    } else {
      const w = t.toLowerCase().replace(/\s+/g, " ");
      if (w.length >= 2 && w.length <= 64) seen.add(w);
    }
    if (seen.size === MAX_BLOCKED_WORDS) break;
  }
  return [...seen];
}

// gateFields validates the guest, blocked-word and report-threshold parts of
// a policy patch. Anything that does not fit is dropped.
export function gateFields(patch: Record<string, unknown>): Partial<Policy> {
  const out: Partial<Policy> = {};
  if (Array.isArray(patch.openKinds)) {
    const seen = new Set<number>();
    for (const k of patch.openKinds) if (Number.isInteger(k) && (k as number) >= 0 && (k as number) <= 65535) seen.add(k as number);
    out.openKinds = [...seen].sort((a, b) => a - b).slice(0, MAX_OPEN_KINDS);
  }
  if (typeof patch.guestReplies === "boolean") out.guestReplies = patch.guestReplies;
  const words = blockedWords(patch.blockedWords);
  if (words) out.blockedWords = words;
  if (typeof patch.blockedWordsInTags === "boolean") out.blockedWordsInTags = patch.blockedWordsInTags;
  if (Number.isInteger(patch.reportThreshold) && (patch.reportThreshold as number) >= 0 && (patch.reportThreshold as number) <= 100) out.reportThreshold = patch.reportThreshold as number;
  return out;
}

// limitFields validates the numeric limits of a policy patch, clamped to
// what the relay can honour. Anything that is not a whole number is dropped.
export function limitFields(patch: Record<string, unknown>): Partial<Policy> {
  const out: Partial<Policy> = {};
  const clamp = (k: keyof Policy, lo: number, hi: number) => {
    const v = patch[k];
    if (Number.isInteger(v) && (v as number) >= 0) (out as Record<string, unknown>)[k] = Math.min(Math.max(v as number, lo), hi);
  };
  clamp("minPow", 0, 256);
  clamp("maxFuture", 0, Number.MAX_SAFE_INTEGER);
  clamp("maxLimit", 1, 5000);
  clamp("maxSubs", 1, 200);
  clamp("maxMessageKB", 16, 1024);
  clamp("maxBlobMB", 1, 95);
  clamp("eventsPerMinute", 1, Number.MAX_SAFE_INTEGER);
  clamp("reqsPerMinute", 1, Number.MAX_SAFE_INTEGER);
  return out;
}

// validIP accepts an IPv4 or IPv6 address, nothing fancier: no ranges, no names.
export function validIP(ip: string): boolean {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip)) return true;
  return /^[0-9a-f:]{2,39}$/.test(ip) && ip.includes(":") && !ip.includes(":::") && ip.split("::").length <= 2;
}

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const MAX_LIST = 20;

// publicFields validates the NIP-11 extras of a policy patch: three https
// links (an empty string clears one) and three short lists. Anything that
// does not fit is dropped, never stored half-right.
export function publicFields(patch: Record<string, unknown>): Partial<Policy> {
  const out: Partial<Policy> = {};
  const link = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.trim().slice(0, 2000);
    if (s === "") return "";
    try {
      const u = new URL(s);
      return u.protocol === "https:" ? u.href : undefined;
    } catch {
      return undefined;
    }
  };
  const list = (v: unknown, re: RegExp, map: (s: string) => string): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const seen = new Set<string>();
    for (const x of v) {
      if (typeof x !== "string") continue;
      const s = map(x.trim());
      if (s !== "" && re.test(s)) seen.add(s);
    }
    return [...seen].slice(0, MAX_LIST);
  };
  const banner = link(patch.banner);
  if (banner !== undefined) out.banner = banner;
  const posting = link(patch.postingPolicy);
  if (posting !== undefined) out.postingPolicy = posting;
  const privacy = link(patch.privacyPolicy);
  if (privacy !== undefined) out.privacyPolicy = privacy;
  const tags = list(patch.tags, TAG_RE, (s) => s.toLowerCase());
  if (tags) out.tags = tags;
  const langs = list(patch.languageTags, LANG_RE, (s) => s);
  if (langs) out.languageTags = langs;
  const countries = list(patch.relayCountries, COUNTRY_RE, (s) => s.toUpperCase());
  if (countries) out.relayCountries = countries;
  return out;
}

export class Settings {
  policy: Policy = { ...DEFAULT_POLICY };
  private banned = new Set<string>();
  private memberSet = new Set<string>();
  private bannedEvents = new Set<string>();
  // Events hidden by reports until a moderator looks. The store holds the
  // same Set and leaves them out of every read.
  readonly hiddenEvents = new Set<string>();
  // The web of trust: members and the owner, plus everyone in their newest
  // contact lists. Only consulted when the write rule is wot.
  private wot = new Set<string>();
  private blockedIPs = new Set<string>();
  private limits = new Map<string, MemberLimits>();
  private allowedKinds = new Set<number>();
  private blockedKinds = new Set<number>();
  // Days to keep events of a kind; RETENTION_ANY is the rule for kinds without one.
  private retention = new Map<number, number>();

  constructor(private sql: SqlStorage) {}

  load() {
    this.sql.exec(SETTINGS_SCHEMA);
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key='policy'`).toArray()[0];
    if (row) {
      const stored = JSON.parse(row.value) as Partial<Policy>;
      this.policy = { ...DEFAULT_POLICY, ...stored, features: { ...DEFAULT_FEATURES, ...(stored.features ?? {}) } };
      // Views were on or off before they had triggers.
      const views: Record<string, ViewSetting> = {};
      for (const [k, v] of Object.entries((stored.views ?? {}) as Record<string, unknown>)) {
        if (v === false) views[k] = "off";
        else if ((VIEW_SETTINGS as readonly unknown[]).includes(v)) views[k] = v as ViewSetting;
      }
      this.policy.views = views;
    }
    ensureColumns(this.sql, "members", MEMBER_COLUMNS);
    this.migrateMembers();
    for (const r of this.sql.exec<{ pubkey: string }>(`SELECT pubkey FROM pubkey_rules WHERE rule='ban'`)) this.banned.add(r.pubkey);
    for (const r of this.sql.exec<{ pubkey: string; keep_days: number; max_bytes: number }>(`SELECT pubkey, keep_days, max_bytes FROM members`)) {
      this.memberSet.add(r.pubkey);
      if (r.keep_days > 0 || r.max_bytes > 0) this.limits.set(r.pubkey, { keep: r.keep_days, cap: r.max_bytes });
    }
    for (const r of this.sql.exec<{ id: string; rule: string }>(`SELECT id, rule FROM event_rules WHERE rule IN ('ban','hide')`)) (r.rule === "ban" ? this.bannedEvents : this.hiddenEvents).add(r.id);
    for (const r of this.sql.exec<{ ip: string }>(`SELECT ip FROM ip_rules`)) this.blockedIPs.add(r.ip);
    for (const r of this.sql.exec<{ kind: number; rule: string }>(`SELECT kind, rule FROM kind_rules`)) {
      (r.rule === "allow" ? this.allowedKinds : this.blockedKinds).add(r.kind);
    }
    for (const r of this.sql.exec<{ kind: number; days: number }>(`SELECT kind, days FROM retention`)) this.retention.set(r.kind, r.days);
    if (this.policy.writes === "wot") this.rebuildWot();
  }

  // ---- the write rule ----

  // mayWrite applies the write rule to a pubkey: "" allows, else the reason.
  mayWrite(pubkey: string): string {
    switch (this.policy.writes) {
      case "open":
        return "";
      case "owner":
        return this.isOwner(pubkey) ? "" : "restricted: only the relay owner may publish here";
      case "allowlist":
        return this.isAllowed(pubkey) ? "" : "restricted: this relay only accepts events from its members";
      case "wot":
        return this.isAllowed(pubkey) || this.wot.has(pubkey) ? "" : "restricted: this relay only accepts events from its members and the people they follow";
    }
  }
  isTrusted(pubkey: string) {
    return this.wot.has(pubkey);
  }
  get wotSize() {
    return this.wot.size;
  }
  // rebuildWot reads the newest kind 3 of the owner and every member, one hop.
  rebuildWot() {
    const next = new Set<string>();
    const people = [this.policy.owner, ...this.memberSet].filter(Boolean);
    for (const pk of people) {
      const row = this.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE kind=3 AND pubkey=? ORDER BY created_at DESC LIMIT 1`, pk).toArray()[0];
      if (!row) continue;
      let tags: unknown;
      try {
        tags = (JSON.parse(row.raw) as { tags?: unknown }).tags;
      } catch {
        continue;
      }
      if (!Array.isArray(tags)) continue;
      for (const t of tags) {
        if (Array.isArray(t) && t[0] === "p" && typeof t[1] === "string" && /^[0-9a-f]{64}$/.test(t[1])) next.add(t[1]);
        if (next.size >= MAX_WOT) break;
      }
      if (next.size >= MAX_WOT) break;
    }
    this.wot = next;
  }
  // noteContacts is called when a kind 3 lands: a member's list changes the web.
  noteContacts(pubkey: string) {
    if (this.policy.writes === "wot" && this.isAllowed(pubkey)) this.rebuildWot();
  }
  private membersChanged() {
    if (this.policy.writes === "wot") this.rebuildWot();
  }

  // The blocked words as they are matched: a lowercased substring or a
  // compiled pattern. Rebuilt when the list changes, by identity.
  private wordsFor: string[] | null = null;
  private words: (string | RegExp)[] = [];

  // hasBlockedWord says where an event carries a blocked word: "content",
  // "tags" when the rule reaches into tag values, or "" when it is clean.
  hasBlockedWord(text: string, tags: string[][] = []): "" | "content" | "tags" {
    const list = this.policy.blockedWords;
    if (list.length === 0) return "";
    if (this.wordsFor !== list) {
      this.wordsFor = list;
      this.words = list.map((w) => {
        const src = wordPattern(w);
        return src === null ? w : new RegExp(src, "i");
      });
    }
    const hit = (s: string) => {
      if (s === "") return false;
      const lower = s.toLowerCase();
      return this.words.some((w) => (typeof w === "string" ? lower.includes(w) : w.test(s)));
    };
    if (hit(text)) return "content";
    if (this.policy.blockedWordsInTags && tags.length && hit(tags.map((t) => t.slice(1).join(" ")).join(" "))) return "tags";
    return "";
  }

  // migrateMembers folds the earlier allow list and names table into members,
  // and makes sure the owner has a row.
  private migrateMembers() {
    const now = Math.floor(Date.now() / 1000);
    for (const r of this.sql.exec<{ pubkey: string; reason: string; at: number }>(`SELECT pubkey, reason, at FROM pubkey_rules WHERE rule='allow'`)) {
      this.sql.exec(`INSERT OR IGNORE INTO members(pubkey,role,note,joined_at,via) VALUES(?,'member',?,?,'added')`, r.pubkey, r.reason, r.at);
    }
    this.sql.exec(`DELETE FROM pubkey_rules WHERE rule='allow'`);
    for (const r of this.sql.exec<{ name: string; pubkey: string; at: number }>(`SELECT name, pubkey, at FROM nip05`)) {
      this.sql.exec(`INSERT OR IGNORE INTO members(pubkey,role,joined_at,via) VALUES(?,'member',?,'profile')`, r.pubkey, r.at);
      this.sql.exec(`UPDATE members SET name=? WHERE pubkey=? AND name IS NULL AND NOT EXISTS (SELECT 1 FROM members WHERE name=?)`, r.name, r.pubkey, r.name);
    }
    this.sql.exec(`DELETE FROM nip05`);
    if (this.policy.owner) {
      this.sql.exec(`INSERT OR IGNORE INTO members(pubkey,role,joined_at,via) VALUES(?,'owner',?,'claimed')`, this.policy.owner, now);
      this.sql.exec(`UPDATE members SET role='owner' WHERE pubkey=?`, this.policy.owner);
    }
  }

  update(patch: Partial<Policy>) {
    const wasWot = this.policy.writes === "wot";
    this.policy = { ...this.policy, ...patch };
    this.sql.exec(`INSERT INTO settings(key,value) VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(this.policy));
    if (this.policy.writes === "wot" && !wasWot) this.rebuildWot();
    if (this.policy.writes !== "wot") this.wot.clear();
  }

  // ---- pins: the group's pinned events, e and a tags in order ----

  pins(): string[][] {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key='pins'`).toArray()[0];
    return row ? (JSON.parse(row.value) as string[][]) : [];
  }
  setPins(tags: string[][]) {
    this.sql.exec(`INSERT INTO settings(key,value) VALUES('pins',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(tags));
  }

  isOwner(pubkey: string) {
    return this.policy.owner !== "" && this.policy.owner === pubkey;
  }

  // Three states: unclaimed (nobody, nothing), leased (nobody yet, open
  // until a date), claimed (an owner). Only the first refuses writes.
  isUnclaimed() {
    return this.policy.owner === "" && this.policy.lease === null;
  }
  isLeased() {
    return this.policy.owner === "" && this.policy.lease !== null;
  }
  leaseExpired(now: number) {
    return this.isLeased() && (this.policy.lease as Lease).until <= now;
  }

  // resetRules puts the access rules, limits, kind rules and retention back
  // to the defaults. Identity, people and bans stay.
  resetRules() {
    const d = DEFAULT_POLICY;
    this.update({ writes: d.writes, reads: d.reads, openKinds: d.openKinds, guestReplies: d.guestReplies, directoryPublic: d.directoryPublic, maxBlobMB: d.maxBlobMB, eventsPerMinute: d.eventsPerMinute, reqsPerMinute: d.reqsPerMinute, minPow: d.minPow, maxFuture: d.maxFuture, maxLimit: d.maxLimit, maxSubs: d.maxSubs });
    for (const k of [...this.listKinds("allow"), ...this.listKinds("block")]) this.setKind(k, null);
    for (const r of this.listRetention()) this.setRetention(r.kind, 0);
  }

  // ---- people ----

  members(): Member[] {
    return this.sql.exec<Member>(`SELECT * FROM members ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, joined_at, pubkey`).toArray();
  }
  member(pubkey: string): Member | null {
    return this.sql.exec<Member>(`SELECT * FROM members WHERE pubkey=?`, pubkey).toArray()[0] ?? null;
  }
  memberByName(name: string): Member | null {
    return this.sql.exec<Member>(`SELECT * FROM members WHERE name=?`, name.toLowerCase()).toArray()[0] ?? null;
  }
  isAllowed(pubkey: string) {
    return this.memberSet.has(pubkey) || this.isOwner(pubkey);
  }

  // ---- the read rule ----

  // mayRead applies the read rule to whoever is asking, given the pubkeys
  // they have proved: "" admits, else the reason. This is the one gate every
  // door that shows events, files, names or presence goes through, on the
  // socket and over HTTP alike.
  mayRead(pubkeys: string[]): string {
    switch (this.policy.reads) {
      case "open":
        return "";
      case "auth":
        return pubkeys.length ? "" : "auth-required: this relay requires authentication";
      case "members":
        if (pubkeys.some((pk) => this.isAllowed(pk))) return "";
        return pubkeys.length ? "restricted: this relay only serves its members" : "auth-required: this relay requires authentication";
    }
  }

  // mayList says whether the member directory, names and counts, may be
  // shown to this caller: to anyone when the directory is public, else only
  // to members, whatever the read rule says.
  mayList(pubkeys: string[]): string {
    if (this.policy.directoryPublic) return "";
    if (pubkeys.some((pk) => this.isAllowed(pk))) return "";
    return pubkeys.length ? "restricted: the directory is for members" : "auth-required: the directory is for members; sign the request";
  }
  // roleOf is the pubkey's role, or null for a stranger.
  roleOf(pubkey: string): Role | null {
    if (this.isOwner(pubkey)) return "owner";
    return this.member(pubkey)?.role ?? null;
  }
  // setRole promotes or demotes a member; the owner's role only changes by transfer.
  setRole(pubkey: string, role: "moderator" | "member"): boolean {
    return this.sql.exec(`UPDATE members SET role=? WHERE pubkey=? AND role!='owner'`, role, pubkey).rowsWritten > 0;
  }
  // transferOwner hands the relay to a member. The old owner stays on as a
  // moderator so nobody is locked out. Returns "" or a reason.
  // setSuccession names an heir, who must be a member, and switches the
  // warnings on. Returns "" or a reason.
  setSuccession(heir: string, afterDays: number): string {
    if (this.policy.owner === "") return "restricted: this relay has no owner";
    if (heir === this.policy.owner) return "invalid: the heir must be someone else";
    if (!this.member(heir)) return "invalid: the heir must be a member first";
    if (!SUCCESSION_DAYS.includes(afterDays)) return "invalid: afterDays must be one of " + SUCCESSION_DAYS.join(", ");
    this.update({ succession: { heir, afterDays }, notify: { ...this.policy.notify, succession: true } });
    return "";
  }

  transferOwner(pubkey: string): string {
    const old = this.policy.owner;
    if (old === "" || pubkey === old) return "invalid: that is already the owner";
    if (!this.member(pubkey)) return "invalid: the new owner must be a member first";
    // A handover, by whatever route, ends the succession set for the old owner.
    this.update({ owner: pubkey, succession: null });
    this.sql.exec(`UPDATE members SET role='moderator' WHERE pubkey=?`, old);
    this.sql.exec(`UPDATE members SET role='owner' WHERE pubkey=?`, pubkey);
    this.membersChanged();
    return "";
  }

  // limitsOf is a member's keep-for and cap, or null when neither is set.
  // The owner is never limited.
  limitsOf(pubkey: string): MemberLimits | null {
    if (this.isOwner(pubkey)) return null;
    return this.limits.get(pubkey) ?? null;
  }
  // limited lists members with a keep-for rule, for the daily sweep.
  limited(): { pubkey: string; keep: number }[] {
    return [...this.limits].filter(([pk, l]) => l.keep > 0 && !this.isOwner(pk)).map(([pubkey, l]) => ({ pubkey, keep: l.keep }));
  }

  // inviteDepth is a member's distance from the owner along invited_by:
  // the owner is 0, someone the owner added or invited is 1, and so on. A
  // chain that ends at a departed member counts the hops it has.
  inviteDepth(pubkey: string): number {
    if (this.isOwner(pubkey)) return 0;
    let depth = 0;
    let cur = pubkey;
    const seen = new Set<string>();
    while (depth < 50 && !seen.has(cur)) {
      seen.add(cur);
      depth++;
      const m = this.member(cur);
      if (!m || m.invited_by === "" || this.isOwner(m.invited_by)) break;
      cur = m.invited_by;
    }
    return depth;
  }
  // subtree lists a member and everyone under them along invited_by, plain
  // members only: a moderator in the tree, and everyone below them, stays.
  subtree(pubkey: string): string[] {
    const root = this.member(pubkey);
    if (!root || root.role !== "member") return [];
    const out = [pubkey];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      for (const r of this.sql.exec<{ pubkey: string; role: string }>(`SELECT pubkey, role FROM members WHERE invited_by=?`, out[i])) {
        if (seen.has(r.pubkey) || r.role !== "member") continue;
        seen.add(r.pubkey);
        out.push(r.pubkey);
      }
    }
    return out;
  }

  // upsertMember adds or edits a member. name "" clears the name; a name held
  // by someone else is refused unless force (owner action). Returns "" or a reason.
  upsertMember(pubkey: string, patch: { name?: string | null; note?: string; via?: string; invitedBy?: string; keepDays?: number; maxBytes?: number }, now: number, force = false): string {
    const cur = this.member(pubkey);
    let name = cur?.name ?? null;
    if (patch.name !== undefined) {
      const n = (patch.name ?? "").trim().toLowerCase();
      if (n === "") name = null;
      else {
        if (!NAME_RE.test(n)) return "invalid: name may use lowercase letters, digits, dot, dash and underscore";
        const holder = this.memberByName(n);
        if (holder && holder.pubkey !== pubkey) {
          if (!force) return "restricted: that name is taken";
          this.sql.exec(`UPDATE members SET name=NULL WHERE pubkey=?`, holder.pubkey);
        }
        name = n;
      }
    }
    const note = patch.note !== undefined ? patch.note.slice(0, 200) : (cur?.note ?? "");
    const keep = patch.keepDays !== undefined ? Math.max(0, Math.min(Math.floor(patch.keepDays), 36500)) : (cur?.keep_days ?? 0);
    const cap = patch.maxBytes !== undefined ? Math.max(0, Math.floor(patch.maxBytes)) : (cur?.max_bytes ?? 0);
    if (cur) this.sql.exec(`UPDATE members SET name=?, note=?, keep_days=?, max_bytes=? WHERE pubkey=?`, name, note, keep, cap, pubkey);
    else {
      const role = this.isOwner(pubkey) ? "owner" : "member";
      this.sql.exec(`INSERT INTO members(pubkey,role,name,note,joined_at,via,keep_days,max_bytes,invited_by) VALUES(?,?,?,?,?,?,?,?,?)`, pubkey, role, name, note, now, (patch.via ?? "added").slice(0, 40), keep, cap, patch.invitedBy ?? "");
      this.memberSet.add(pubkey);
      this.membersChanged();
    }
    if (keep > 0 || cap > 0) this.limits.set(pubkey, { keep, cap });
    else this.limits.delete(pubkey);
    return "";
  }

  removeMember(pubkey: string): boolean {
    if (this.isOwner(pubkey)) return false;
    this.memberSet.delete(pubkey);
    this.limits.delete(pubkey);
    const gone = this.sql.exec(`DELETE FROM members WHERE pubkey=?`, pubkey).rowsWritten > 0;
    if (gone) this.membersChanged();
    return gone;
  }

  // ---- portable configuration ----

  // exportConfig is everything that makes this relay itself, minus its
  // data: policy, people, bans, address blocks and kind rules. Enough to
  // rebuild it.
  // ---- bans ----

  setBan(pubkey: string, banned: boolean, reason = "", now = 0) {
    this.banned.delete(pubkey);
    this.sql.exec(`DELETE FROM pubkey_rules WHERE pubkey=?`, pubkey);
    if (banned) {
      this.banned.add(pubkey);
      this.sql.exec(`INSERT INTO pubkey_rules(pubkey,rule,reason,at) VALUES(?,'ban',?,?)`, pubkey, reason, now);
      this.removeMember(pubkey);
    }
  }
  listBans() {
    return this.sql.exec<{ pubkey: string; reason: string }>(`SELECT pubkey, reason FROM pubkey_rules WHERE rule='ban' ORDER BY at DESC`).toArray();
  }
  isBanned(pubkey: string) {
    return this.banned.has(pubkey);
  }

  // Event rules: ban refuses an id for good; hide keeps it out of every read
  // until a moderator resolves the reports on it.
  setEvent(id: string, rule: "ban" | "hide" | null, reason = "", now = 0) {
    this.bannedEvents.delete(id);
    this.hiddenEvents.delete(id);
    this.sql.exec(`DELETE FROM event_rules WHERE id=?`, id);
    if (rule) {
      (rule === "ban" ? this.bannedEvents : this.hiddenEvents).add(id);
      this.sql.exec(`INSERT INTO event_rules(id,rule,reason,at) VALUES(?,?,?,?)`, id, rule, reason, now);
    }
  }
  listEvents(rule: "ban" | "hide") {
    return this.sql.exec<{ id: string; reason: string }>(`SELECT id, reason FROM event_rules WHERE rule=? ORDER BY at DESC`, rule).toArray();
  }
  isEventBanned(id: string) {
    return this.bannedEvents.has(id);
  }
  isEventHidden(id: string) {
    return this.hiddenEvents.has(id);
  }

  // Address blocks (NIP-86 blockip). Addresses churn, so these are not part
  // of the portable configuration: they describe a moment, not the relay.
  setIPBlock(ip: string, blocked: boolean, reason = "", now = 0) {
    this.blockedIPs.delete(ip);
    this.sql.exec(`DELETE FROM ip_rules WHERE ip=?`, ip);
    if (blocked) {
      this.blockedIPs.add(ip);
      this.sql.exec(`INSERT INTO ip_rules(ip,reason,at) VALUES(?,?,?)`, ip, reason, now);
    }
  }
  listIPBlocks() {
    return this.sql.exec<{ ip: string; reason: string }>(`SELECT ip, reason FROM ip_rules ORDER BY at DESC`).toArray();
  }
  isIPBlocked(ip: string) {
    return this.blockedIPs.has(ip);
  }

  // Kind rules: an allow list, if non-empty, is exclusive; blocks always apply.
  setKind(kind: number, rule: "allow" | "block" | null) {
    this.allowedKinds.delete(kind);
    this.blockedKinds.delete(kind);
    this.sql.exec(`DELETE FROM kind_rules WHERE kind=?`, kind);
    if (rule) {
      (rule === "allow" ? this.allowedKinds : this.blockedKinds).add(kind);
      this.sql.exec(`INSERT INTO kind_rules(kind,rule) VALUES(?,?)`, kind, rule);
    }
  }
  listKinds(rule: "allow" | "block") {
    return [...(rule === "allow" ? this.allowedKinds : this.blockedKinds)].sort((a, b) => a - b);
  }
  kindAllowed(kind: number) {
    if (this.blockedKinds.has(kind)) return false;
    return this.allowedKinds.size === 0 || this.allowedKinds.has(kind);
  }

  // ---- retention ----

  // setRetention keeps a kind's events for `days`; 0 removes the rule. A null
  // kind is the rule for everything without one. Returns a reason if refused.
  setRetention(kind: number | null, days: number): string {
    if (kind !== null && isProtected(kind)) return `invalid: kind ${kind} is part of how the relay works and is always kept`;
    const k = kind === null ? RETENTION_ANY : kind;
    this.retention.delete(k);
    this.sql.exec(`DELETE FROM retention WHERE kind=?`, k);
    if (days > 0) {
      this.retention.set(k, days);
      this.sql.exec(`INSERT INTO retention(kind,days) VALUES(?,?)`, k, days);
    }
    return "";
  }
  listRetention(): { kind: number | null; days: number }[] {
    return [...this.retention].map(([k, days]) => ({ kind: k === RETENTION_ANY ? null : k, days })).sort((a, b) => (a.kind ?? 1e9) - (b.kind ?? 1e9));
  }
  // retentionDays is how long a kind is kept, or 0 for forever. The catch-all
  // rule skips replaceable kinds (profiles, contact lists, relay lists...):
  // clients re-send those with their original timestamps, and losing the
  // latest one is never what "keep everything else N days" meant.
  retentionDays(kind: number): number {
    if (isProtected(kind)) return 0;
    const own = this.retention.get(kind);
    if (own !== undefined) return own;
    if (isReplaceable(kind)) return 0;
    // Gift wraps are mail. "Keep everything else N days" never meant the
    // owner's inbox; an explicit rule for 1059 still applies.
    if (kind === 1059) return 0;
    return this.retention.get(RETENTION_ANY) ?? 0;
  }
}

const RETENTION_ANY = -1;

// Kinds the relay itself depends on: who people are (profiles, contact and
// relay lists), what was paid (zap receipts), and who belongs (the roster and
// its deltas, the NIP-29 put-user and remove-user records, and the group's
// metadata, admins, members and roles). Never expired, never purged, only
// deleted one at a time.
export const PROTECTED_KINDS = new Set([0, 3, 10002, 9735, 13534, 8000, 8001, 9000, 9001, 33534, 39000, 39001, 39002, 39003, 39005]);
export function isProtected(kind: number): boolean {
  return PROTECTED_KINDS.has(kind);
}
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000);
}
