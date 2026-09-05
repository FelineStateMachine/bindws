// A relay's configuration as one document: what exportconfig writes,
// importconfig reads, a template in relay-templates/ declares and a file in
// an operator's repository holds. parseConfig checks the shape and says
// what it dropped; planConfig says what applying it would change; applyConfig
// does. A section that is absent is left alone, so a template carries the
// rules and nothing about people. The connections section is the Connect
// fold's app shortcuts, so a template can set the rules and the shortcuts
// that go with them in one click.
import { DEFAULT_POLICY, policyPatch, validIP, type Connection, type Policy, type Settings } from "./settings.ts";
import { parseConnections } from "./connections.ts";

export const FORMAT = "bind.ws/relay-config/2";
const FORMATS = new Set(["bind.ws/relay-config/1", FORMAT]);
export const SECTIONS = ["policy", "members", "bans", "addresses", "banned_events", "kinds", "retention", "connections"] as const;
export type Section = (typeof SECTIONS)[number];
// What an export leaves out: the owner's own, and the platform's.
const NOT_IN_A_FILE = new Set(["owner", "lease", "succession", "customHosts"]);
const POLICY_KEYS = new Set(Object.keys(DEFAULT_POLICY).filter((k) => !NOT_IN_A_FILE.has(k)));

export interface ConfigMember {
  pubkey: string;
  name: string | null;
  note: string;
  role: "member" | "moderator";
  keepDays?: number;
  maxBytes?: number;
}
export interface Template {
  title: string;
  about: string;
  source?: "required" | "optional"; // a replica needs a source relay to pull from
  every?: number; // hours between pulls
}
export interface Config {
  name: string;
  template?: Template;
  sections: Section[];
  policy: Partial<Policy>;
  members: ConfigMember[];
  bans: { pubkey: string; reason: string }[];
  addresses: { ip: string; reason: string }[];
  banned_events: { id: string; reason: string }[];
  kinds: { allow: number[]; block: number[] };
  retention: { kind: number | null; days: number }[];
  // The Connect fold's app shortcuts (connections.ts), in order.
  connections: Connection[];
  // Entries the document had that no relay would take, one line each.
  warnings: string[];
}

const hex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const kindOK = (k: unknown): k is number => Number.isInteger(k) && (k as number) >= 0 && (k as number) <= 65535;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

// parseConfig reads a document against the current policy (the merged maps
// need it) and returns what a relay would apply, or the reason it is not a
// configuration at all.
export function parseConfig(raw: unknown, cur: Policy = DEFAULT_POLICY): Config | string {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== "object" || Array.isArray(c)) return "invalid: not a bind.ws relay configuration";
  if (!FORMATS.has(c.format as string)) return "invalid: format must be " + FORMAT;
  const warnings: string[] = [];
  const out: Config = { name: str(c.name, 64), sections: [], policy: {}, members: [], bans: [], addresses: [], banned_events: [], kinds: { allow: [], block: [] }, retention: [], connections: [], warnings };
  if (c.template && typeof c.template === "object") {
    const t = c.template as Record<string, unknown>;
    const template: Template = { title: str(t.title, 80), about: str(t.about, 400) };
    if (t.source === "required" || t.source === "optional") template.source = t.source;
    if (Number.isInteger(t.every) && (t.every as number) > 0) template.every = t.every as number;
    out.template = template;
  }
  if (c.policy !== undefined) {
    if (!c.policy || typeof c.policy !== "object") return "invalid: policy must be an object";
    const given = c.policy as Record<string, unknown>;
    out.policy = policyPatch(given, cur);
    for (const k of Object.keys(given)) {
      if (NOT_IN_A_FILE.has(k)) warnings.push(`policy.${k}: not carried by a configuration`);
      else if (!POLICY_KEYS.has(k)) warnings.push(`policy.${k}: not a setting`);
      else if (!(k in out.policy)) warnings.push(`policy.${k}: value not accepted`);
    }
    out.sections.push("policy");
  }
  const list = (key: Section): unknown[] | null => {
    if (c[key] === undefined) return null;
    if (!Array.isArray(c[key])) {
      warnings.push(`${key}: not a list`);
      return null;
    }
    out.sections.push(key);
    return c[key] as unknown[];
  };
  for (const [i, m] of (list("members") ?? []).entries()) {
    const r = (m ?? {}) as Record<string, unknown>;
    if (!hex64(r.pubkey)) {
      warnings.push(`members[${i}]: pubkey must be 64 hex chars`);
      continue;
    }
    const member: ConfigMember = { pubkey: r.pubkey, name: typeof r.name === "string" ? r.name : null, note: str(r.note, 2000), role: r.role === "moderator" ? "moderator" : "member" };
    if (Number.isInteger(r.keepDays) && (r.keepDays as number) > 0) member.keepDays = r.keepDays as number;
    if (Number.isInteger(r.maxBytes) && (r.maxBytes as number) > 0) member.maxBytes = r.maxBytes as number;
    out.members.push(member);
  }
  for (const [i, b] of (list("bans") ?? []).entries()) {
    const r = (b ?? {}) as Record<string, unknown>;
    if (hex64(r.pubkey)) out.bans.push({ pubkey: r.pubkey, reason: str(r.reason, 200) });
    else warnings.push(`bans[${i}]: pubkey must be 64 hex chars`);
  }
  for (const [i, a] of (list("addresses") ?? []).entries()) {
    const r = (a ?? {}) as Record<string, unknown>;
    const ip = typeof r.ip === "string" ? r.ip.trim().toLowerCase() : "";
    if (validIP(ip)) out.addresses.push({ ip, reason: str(r.reason, 200) });
    else warnings.push(`addresses[${i}]: not an IP address`);
  }
  for (const [i, e] of (list("banned_events") ?? []).entries()) {
    const r = (e ?? {}) as Record<string, unknown>;
    if (hex64(r.id)) out.banned_events.push({ id: r.id, reason: str(r.reason, 200) });
    else warnings.push(`banned_events[${i}]: id must be 64 hex chars`);
  }
  if (c.kinds !== undefined) {
    if (!c.kinds || typeof c.kinds !== "object") return "invalid: kinds must be an object with allow and block lists";
    const k = c.kinds as Record<string, unknown>;
    for (const rule of ["allow", "block"] as const) {
      for (const [i, n] of (Array.isArray(k[rule]) ? (k[rule] as unknown[]) : []).entries()) {
        if (kindOK(n)) out.kinds[rule].push(n);
        else warnings.push(`kinds.${rule}[${i}]: kind out of range`);
      }
      out.kinds[rule] = [...new Set(out.kinds[rule])].sort((a, b) => a - b);
    }
    out.sections.push("kinds");
  }
  for (const [i, r] of (list("retention") ?? []).entries()) {
    const x = (r ?? {}) as Record<string, unknown>;
    const kind = x.kind === null ? null : x.kind;
    if ((kind === null || kindOK(kind)) && Number.isInteger(x.days) && (x.days as number) > 0 && (x.days as number) <= 36500) out.retention.push({ kind: kind as number | null, days: x.days as number });
    else warnings.push(`retention[${i}]: needs a kind (or null) and days from 1 to 36500`);
  }
  if (c.connections !== undefined) {
    const parsed = parseConnections(c.connections);
    if (typeof parsed === "string") return parsed;
    out.connections = parsed.list;
    warnings.push(...parsed.warnings);
    out.sections.push("connections");
  }
  return out;
}

export interface Changes {
  policy: { field: string; from: unknown; to: unknown }[];
  members: { add: ConfigMember[]; remove: { pubkey: string; name: string | null }[]; change: { pubkey: string; from: ConfigMember; to: ConfigMember }[] };
  bans: { add: string[]; remove: string[] };
  addresses: { add: string[]; remove: string[] };
  banned_events: { add: string[]; remove: string[] };
  kinds: { allow: { add: number[]; remove: number[] }; block: { add: number[]; remove: number[] } };
  retention: { add: { kind: number | null; days: number }[]; remove: { kind: number | null; days: number }[] };
  connections: { add: Connection[]; remove: Connection[]; reordered: boolean };
  // One line per change, for a person; empty when applying would change nothing.
  summary: string[];
}

const currentMembers = (s: Settings): ConfigMember[] =>
  s.members().filter((m) => m.role !== "owner").map((m) => ({ pubkey: m.pubkey, name: m.name, note: m.note, role: m.role === "moderator" ? "moderator" : "member", ...(m.keep_days ? { keepDays: m.keep_days } : {}), ...(m.max_bytes ? { maxBytes: m.max_bytes } : {}) }));

function diff<T>(before: T[], after: T[], key: (x: T) => string): { add: T[]; remove: T[] } {
  const b = new Map(before.map((x) => [key(x), x]));
  const a = new Map(after.map((x) => [key(x), x]));
  return { add: [...a.values()].filter((x) => !b.has(key(x))), remove: [...b.values()].filter((x) => !a.has(key(x))) };
}
const short = (pk: string) => pk.slice(0, 8);
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
};

// planConfig compares the document with the relay as it is. Only the
// sections the document has are compared.
export function planConfig(s: Settings, cfg: Config): Changes {
  const has = (k: Section) => cfg.sections.includes(k);
  const ch: Changes = { policy: [], members: { add: [], remove: [], change: [] }, bans: { add: [], remove: [] }, addresses: { add: [], remove: [] }, banned_events: { add: [], remove: [] }, kinds: { allow: { add: [], remove: [] }, block: { add: [], remove: [] } }, retention: { add: [], remove: [] }, connections: { add: [], remove: [], reordered: false }, summary: [] };
  if (has("policy")) {
    for (const [k, to] of Object.entries(cfg.policy)) {
      const from = (s.policy as unknown as Record<string, unknown>)[k];
      if (JSON.stringify(from) !== JSON.stringify(to)) ch.policy.push({ field: k, from, to });
    }
    for (const c of ch.policy) ch.summary.push(`${c.field}: ${show(c.from)} to ${show(c.to)}`);
  }
  if (has("members")) {
    const cur = currentMembers(s);
    const d = diff(cur, cfg.members, (m) => m.pubkey);
    ch.members.add = d.add;
    ch.members.remove = d.remove.map((m) => ({ pubkey: m.pubkey, name: m.name }));
    const next = new Map(cfg.members.map((m) => [m.pubkey, m]));
    for (const m of cur) {
      const to = next.get(m.pubkey);
      if (to && JSON.stringify(m) !== JSON.stringify(to)) ch.members.change.push({ pubkey: m.pubkey, from: m, to });
    }
    const m = ch.members;
    if (m.add.length || m.remove.length || m.change.length) ch.summary.push(`members: ${m.add.length} added (${m.add.map((x) => x.name || short(x.pubkey)).join(", ") || "none"}), ${m.remove.length} removed (${m.remove.map((x) => x.name || short(x.pubkey)).join(", ") || "none"}), ${m.change.length} changed`);
  }
  const lists: [Section, keyof Pick<Changes, "bans" | "addresses" | "banned_events">, string[], string[]][] = [
    ["bans", "bans", s.listBans().map((b) => b.pubkey), cfg.bans.map((b) => b.pubkey)],
    ["addresses", "addresses", s.listIPBlocks().map((b) => b.ip), cfg.addresses.map((a) => a.ip)],
    ["banned_events", "banned_events", s.listEvents("ban").map((e) => e.id), cfg.banned_events.map((e) => e.id)],
  ];
  for (const [section, field, before, after] of lists) {
    if (!has(section)) continue;
    const d = diff(before, after, (x) => x);
    ch[field] = d;
    if (d.add.length || d.remove.length) ch.summary.push(`${section.replace("_", " ")}: ${d.add.length} added, ${d.remove.length} removed`);
  }
  if (has("kinds")) {
    for (const rule of ["allow", "block"] as const) {
      const d = diff(s.listKinds(rule), cfg.kinds[rule], String);
      ch.kinds[rule] = d;
      if (d.add.length || d.remove.length) ch.summary.push(`kinds ${rule === "allow" ? "allowed" : "blocked"}: ${d.add.length ? "+" + d.add.join(", ") : ""}${d.add.length && d.remove.length ? " " : ""}${d.remove.length ? "-" + d.remove.join(", ") : ""}`);
    }
  }
  if (has("retention")) {
    const d = diff(s.listRetention(), cfg.retention, (r) => `${r.kind}:${r.days}`);
    ch.retention = d;
    const say = (r: { kind: number | null; days: number }) => `${r.kind === null ? "everything" : "kind " + r.kind} ${r.days} days`;
    if (d.add.length || d.remove.length) ch.summary.push(`retention: ${[...d.add.map((r) => "+" + say(r)), ...d.remove.map((r) => "-" + say(r))].join(", ")}`);
  }
  if (has("connections")) {
    // A shortcut is the whole of its entry: the same template with another
    // visibility or input is one removed and one added.
    const cur = s.connections();
    const d = diff(cur, cfg.connections, (c) => JSON.stringify(c));
    ch.connections = { ...d, reordered: d.add.length === 0 && d.remove.length === 0 && JSON.stringify(cur) !== JSON.stringify(cfg.connections) };
    const say = (c: Connection) => c.template + (c.visibility === "public" ? "" : " (" + c.visibility + ")");
    if (d.add.length || d.remove.length) ch.summary.push(`connections: ${[...d.add.map((c) => "+" + say(c)), ...d.remove.map((c) => "-" + say(c))].join(", ")}`);
    else if (ch.connections.reordered) ch.summary.push("connections: reordered");
  }
  return ch;
}

// applyConfig writes the document's sections; the owner is never touched.
export function applyConfig(s: Settings, cfg: Config, now: number) {
  const has = (k: Section) => cfg.sections.includes(k);
  if (has("policy")) s.update(cfg.policy);
  if (has("members")) {
    for (const m of s.members()) if (m.role !== "owner") s.removeMember(m.pubkey);
    for (const m of cfg.members) {
      s.upsertMember(m.pubkey, { name: m.name, note: m.note, via: "import", keepDays: m.keepDays, maxBytes: m.maxBytes }, now, true);
      if (m.role === "moderator") s.setRole(m.pubkey, "moderator");
    }
  }
  if (has("bans")) {
    for (const b of s.listBans()) s.setBan(b.pubkey, false);
    for (const b of cfg.bans) if (!s.isOwner(b.pubkey)) s.setBan(b.pubkey, true, b.reason, now);
  }
  if (has("addresses")) {
    for (const b of s.listIPBlocks()) s.setIPBlock(b.ip, false);
    for (const a of cfg.addresses) s.setIPBlock(a.ip, true, a.reason, now);
  }
  if (has("banned_events")) {
    for (const e of s.listEvents("ban")) s.setEvent(e.id, null);
    for (const e of cfg.banned_events) s.setEvent(e.id, "ban", e.reason, now);
  }
  if (has("kinds")) {
    for (const k of [...s.listKinds("allow"), ...s.listKinds("block")]) s.setKind(k, null);
    for (const k of cfg.kinds.allow) s.setKind(k, "allow");
    for (const k of cfg.kinds.block) s.setKind(k, "block");
  }
  if (has("retention")) {
    for (const r of s.listRetention()) s.setRetention(r.kind, 0);
    for (const r of cfg.retention) s.setRetention(r.kind, r.days);
  }
  if (has("connections")) s.setConnections(cfg.connections);
}

// exportConfig writes the relay as a document, every section, lists in a
// fixed order so two exports diff cleanly.
export function exportConfig(s: Settings, name: string) {
  const byKey = <T>(list: T[], key: (x: T) => string) => [...list].sort((a, b) => key(a).localeCompare(key(b)));
  return {
    format: FORMAT,
    exported_at: Math.floor(Date.now() / 1000),
    name,
    policy: { ...s.policy, owner: undefined, lease: undefined, succession: undefined, customHosts: undefined },
    members: byKey(currentMembers(s), (m) => m.pubkey),
    bans: byKey(s.listBans(), (b) => b.pubkey),
    banned_events: byKey(s.listEvents("ban"), (e) => e.id),
    addresses: byKey(s.listIPBlocks(), (a) => a.ip),
    kinds: { allow: [...s.listKinds("allow")].sort((a, b) => a - b), block: [...s.listKinds("block")].sort((a, b) => a - b) },
    retention: s.listRetention(),
    connections: s.connections(),
  };
}
