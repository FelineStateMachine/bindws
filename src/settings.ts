// Per-relay settings and policy, kept in the same SQLite database.

// A lease makes an unclaimed relay usable for a while: open to everyone,
// then wiped at `until` unless somebody claims it first. holder "" means
// anyone may claim; a pubkey means only that key.
export interface Lease {
  until: number;
  holder: string;
}

export interface Policy {
  owner: string; // pubkey; "" while unclaimed
  lease: Lease | null; // set while the relay is a temporary lease
  name: string;
  description: string;
  icon: string;
  contact: string;
  writes: "open" | "allowlist" | "owner"; // who may publish
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
}

export const DEFAULT_POLICY: Policy = {
  owner: "",
  lease: null,
  name: "",
  description: "",
  icon: "",
  contact: "",
  writes: "open",
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
};

export const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pubkey_rules (pubkey TEXT PRIMARY KEY, rule TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS event_rules (id TEXT PRIMARY KEY, rule TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kind_rules (kind INTEGER PRIMARY KEY, rule TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS retention (kind INTEGER PRIMARY KEY, days INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS members (pubkey TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member', name TEXT, note TEXT NOT NULL DEFAULT '', joined_at INTEGER NOT NULL, via TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS members_name ON members(name) WHERE name IS NOT NULL;
CREATE TABLE IF NOT EXISTS nip05 (name TEXT PRIMARY KEY, pubkey TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter TEXT NOT NULL, target_pubkey TEXT NOT NULL, target_event TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_by TEXT NOT NULL DEFAULT '', resolved_at INTEGER NOT NULL DEFAULT 0, action TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, uploader TEXT NOT NULL, uploaded INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS blobs_uploader ON blobs(uploader, uploaded DESC);
`;

// A member is one person of this relay: the owner or someone let in. Their
// optional name is their NIP-05 handle at the relay's host.
export type Member = {
  pubkey: string;
  role: "owner" | "member";
  name: string | null;
  note: string;
  joined_at: number;
  via: string; // claimed | invite <code> | added | profile
};

export const NAME_RE = /^[a-z0-9._-]{1,64}$/;

export class Settings {
  policy: Policy = { ...DEFAULT_POLICY };
  private banned = new Set<string>();
  private memberSet = new Set<string>();
  private bannedEvents = new Set<string>();
  private allowedKinds = new Set<number>();
  private blockedKinds = new Set<number>();
  // Days to keep events of a kind; RETENTION_ANY is the rule for kinds without one.
  private retention = new Map<number, number>();

  constructor(private sql: SqlStorage) {}

  load() {
    this.sql.exec(SETTINGS_SCHEMA);
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key='policy'`).toArray()[0];
    if (row) this.policy = { ...DEFAULT_POLICY, ...JSON.parse(row.value) };
    this.migrateMembers();
    for (const r of this.sql.exec<{ pubkey: string }>(`SELECT pubkey FROM pubkey_rules WHERE rule='ban'`)) this.banned.add(r.pubkey);
    for (const r of this.sql.exec<{ pubkey: string }>(`SELECT pubkey FROM members`)) this.memberSet.add(r.pubkey);
    for (const r of this.sql.exec<{ id: string }>(`SELECT id FROM event_rules WHERE rule='ban'`)) this.bannedEvents.add(r.id);
    for (const r of this.sql.exec<{ kind: number; rule: string }>(`SELECT kind, rule FROM kind_rules`)) {
      (r.rule === "allow" ? this.allowedKinds : this.blockedKinds).add(r.kind);
    }
    for (const r of this.sql.exec<{ kind: number; days: number }>(`SELECT kind, days FROM retention`)) this.retention.set(r.kind, r.days);
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
    this.policy = { ...this.policy, ...patch };
    this.sql.exec(`INSERT INTO settings(key,value) VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(this.policy));
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
    this.update({ writes: d.writes, reads: d.reads, directoryPublic: d.directoryPublic, maxBlobMB: d.maxBlobMB, eventsPerMinute: d.eventsPerMinute, reqsPerMinute: d.reqsPerMinute, minPow: d.minPow, maxFuture: d.maxFuture, maxLimit: d.maxLimit, maxSubs: d.maxSubs });
    for (const k of [...this.listKinds("allow"), ...this.listKinds("block")]) this.setKind(k, null);
    for (const r of this.listRetention()) this.setRetention(r.kind, 0);
  }

  // ---- people ----

  members(): Member[] {
    return this.sql.exec<Member>(`SELECT * FROM members ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, joined_at, pubkey`).toArray();
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

  // upsertMember adds or edits a member. name "" clears the name; a name held
  // by someone else is refused unless force (owner action). Returns "" or a reason.
  upsertMember(pubkey: string, patch: { name?: string | null; note?: string; via?: string }, now: number, force = false): string {
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
    if (cur) this.sql.exec(`UPDATE members SET name=?, note=? WHERE pubkey=?`, name, note, pubkey);
    else {
      const role = this.isOwner(pubkey) ? "owner" : "member";
      this.sql.exec(`INSERT INTO members(pubkey,role,name,note,joined_at,via) VALUES(?,?,?,?,?,?)`, pubkey, role, name, note, now, (patch.via ?? "added").slice(0, 40));
      this.memberSet.add(pubkey);
    }
    return "";
  }

  removeMember(pubkey: string): boolean {
    if (this.isOwner(pubkey)) return false;
    this.memberSet.delete(pubkey);
    return this.sql.exec(`DELETE FROM members WHERE pubkey=?`, pubkey).rowsWritten > 0;
  }

  // ---- portable configuration ----

  // exportConfig is everything that makes this relay itself, minus its
  // data: policy, people, bans, and kind rules. Enough to rebuild it.
  exportConfig(name: string) {
    return {
      format: "bind.ws/relay-config/1",
      exported_at: Math.floor(Date.now() / 1000),
      name,
      policy: { ...this.policy, owner: undefined, lease: undefined },
      members: this.members().filter((m) => m.role !== "owner").map((m) => ({ pubkey: m.pubkey, name: m.name, note: m.note })),
      bans: this.listBans(),
      banned_events: this.listEvents("ban"),
      kinds: { allow: this.listKinds("allow"), block: this.listKinds("block") },
      retention: this.listRetention(),
    };
  }

  // importConfig applies an export. Replaces the lists; the owner is never
  // touched. Returns a reason on a malformed document.
  importConfig(raw: unknown, now: number): string {
    const c = raw as Record<string, unknown>;
    if (!c || typeof c !== "object" || c.format !== "bind.ws/relay-config/1") return "invalid: not a bind.ws relay configuration";
    const hex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    const policy = (c.policy && typeof c.policy === "object" ? c.policy : {}) as Record<string, unknown>;
    const clean: Partial<Policy> = {};
    for (const k of ["name", "description", "icon", "contact", "joinTerms"] as const) if (typeof policy[k] === "string") clean[k] = (policy[k] as string).slice(0, 20000);
    if (policy.writes === "open" || policy.writes === "allowlist" || policy.writes === "owner") clean.writes = policy.writes;
    if (policy.reads === "open" || policy.reads === "auth" || policy.reads === "members") clean.reads = policy.reads;
    if (typeof policy.directoryPublic === "boolean") clean.directoryPublic = policy.directoryPublic;
    for (const k of ["minPow", "maxFuture", "maxLimit", "maxSubs", "maxBlobMB", "eventsPerMinute", "reqsPerMinute"] as const) if (Number.isInteger(policy[k]) && (policy[k] as number) >= 0) clean[k] = policy[k] as number;
    this.update(clean);
    for (const m of this.members()) if (m.role !== "owner") this.removeMember(m.pubkey);
    for (const m of Array.isArray(c.members) ? c.members : []) {
      const r = m as Record<string, unknown>;
      if (hex64(r.pubkey)) this.upsertMember(r.pubkey, { name: typeof r.name === "string" ? r.name : null, note: typeof r.note === "string" ? r.note : "", via: "import" }, now, true);
    }
    for (const b of this.listBans()) this.setBan(b.pubkey, false);
    for (const b of Array.isArray(c.bans) ? c.bans : []) {
      const r = b as Record<string, unknown>;
      if (hex64(r.pubkey) && !this.isOwner(r.pubkey)) this.setBan(r.pubkey, true, typeof r.reason === "string" ? r.reason : "", now);
    }
    for (const e of this.listEvents("ban")) this.setEvent(e.id, null);
    for (const e of Array.isArray(c.banned_events) ? c.banned_events : []) {
      const r = e as Record<string, unknown>;
      if (hex64(r.id)) this.setEvent(r.id, "ban", typeof r.reason === "string" ? r.reason : "", now);
    }
    for (const k of [...this.listKinds("allow"), ...this.listKinds("block")]) this.setKind(k, null);
    const kinds = (c.kinds && typeof c.kinds === "object" ? c.kinds : {}) as Record<string, unknown>;
    for (const k of Array.isArray(kinds.allow) ? kinds.allow : []) if (Number.isInteger(k) && (k as number) >= 0 && (k as number) <= 65535) this.setKind(k as number, "allow");
    for (const k of Array.isArray(kinds.block) ? kinds.block : []) if (Number.isInteger(k) && (k as number) >= 0 && (k as number) <= 65535) this.setKind(k as number, "block");
    for (const r of this.listRetention()) this.setRetention(r.kind, 0);
    for (const r of Array.isArray(c.retention) ? c.retention : []) {
      const x = r as Record<string, unknown>;
      const kind = x.kind === null ? null : x.kind;
      if ((kind === null || (Number.isInteger(kind) && (kind as number) >= 0 && (kind as number) <= 65535)) && Number.isInteger(x.days) && (x.days as number) > 0) this.setRetention(kind as number | null, x.days as number);
    }
    return "";
  }

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

  // Event rules
  setEvent(id: string, rule: "ban" | null, reason = "", now = 0) {
    this.bannedEvents.delete(id);
    this.sql.exec(`DELETE FROM event_rules WHERE id=?`, id);
    if (rule) {
      this.bannedEvents.add(id);
      this.sql.exec(`INSERT INTO event_rules(id,rule,reason,at) VALUES(?,?,?,?)`, id, rule, reason, now);
    }
  }
  listEvents(rule: "ban") {
    return this.sql.exec<{ id: string; reason: string }>(`SELECT id, reason FROM event_rules WHERE rule=? ORDER BY at DESC`, rule).toArray();
  }
  isEventBanned(id: string) {
    return this.bannedEvents.has(id);
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
    return this.retention.get(RETENTION_ANY) ?? 0;
  }
}

const RETENTION_ANY = -1;

// Kinds the relay itself depends on: who people are (profiles, contact and
// relay lists), what was paid (zap receipts), and who belongs (the roster and
// its deltas). Never expired, never purged, only deleted one at a time.
export const PROTECTED_KINDS = new Set([0, 3, 10002, 9735, 13534, 8000, 8001]);
export function isProtected(kind: number): boolean {
  return PROTECTED_KINDS.has(kind);
}
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000);
}
