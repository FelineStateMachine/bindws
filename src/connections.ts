// Connection shortcuts: the owner's list of apps on the Connect fold. Each
// is a connection template from connection-templates/ (the library, folded
// into gen/connections.ts) with a visibility and the template's inputs
// filled in, kept in settings as the ordered list the fold shows.
//
//   GET /connect.json   the shortcuts the asker may see, links resolved
//
// A template writes its links once, with placeholders: {relay:url},
// {owner:nprofile}, {user:npub}, {input:repo} and so on. The relay fills
// them in here, for whoever is looking, so one good template works on any
// relay and every client sees the same handoff. The door takes an optional
// NIP-98 signature: it decides which shortcuts the asker sees (public,
// signed in, members, owner) and fills the {user:*} placeholders. A link
// that needs a user is left out for a visitor, and the shortcut says so.
import { naddrEncode, npubEncode, nprofileEncode } from "nostr-tools/nip19";
import { CONNECTION_LIBRARY } from "./gen/connections.ts";
import { KIND_GROUP_METADATA } from "./kinds.ts";
import { FEATURE_NAMES, VISIBILITIES, featureOn, type Connection, type Feature, type Settings, type Visibility } from "./settings.ts";
import { whoAsks } from "./auth.ts";
import { QR_MAX_BYTES } from "./card.ts";
import type { Relay } from "./relay.ts";

export const FORMAT = "bind.ws/connection-template/1";
// The console draws these; a template names one (console.js, IC).
export const ICONS = ["notes", "blog", "bookmark", "photo", "site", "git", "chat", "person", "files", "key", "search", "feed", "lock", "app"] as const;
export type Icon = (typeof ICONS)[number];
export const MAX_CONNECTIONS = 24;
const MAX_LINKS = 6;
const MAX_INPUTS = 4;
const MAX_TEXT = 2000;

export interface ConnectionLink {
  label: string;
  href?: string; // a link to open: https://, or nostr: for the viewer's own app
  copy?: string; // text for the clipboard instead
}
export interface ConnectionInput {
  name: string; // fills {input:name}
  label: string;
  placeholder: string;
  default: string; // the value when the owner leaves it blank
}
export interface ConnectionTemplate {
  name: string;
  title: string;
  about: string;
  app: string;
  where: string;
  icon: Icon;
  feature?: Feature; // shown only while this feature is on
  visibility: Visibility; // what a shortcut starts with
  links: ConnectionLink[];
  qr: string; // what the QR carries; "" for none
  inputs: ConnectionInput[];
}

// What a placeholder may name, by source. {input:*} names one of the
// template's own inputs instead.
export const PLACEHOLDER_FIELDS: Record<"relay" | "owner" | "user", string[]> = {
  relay: ["url", "host", "web", "name", "domain", "hex", "npub", "nprofile", "naddr"],
  owner: ["hex", "npub", "nprofile"],
  user: ["hex", "npub", "nprofile"],
};
const PLACEHOLDER = /\{(relay|owner|user|input):([a-z][a-z0-9_-]*)(\|enc)?\}/g;
const INPUT_NAME = /^[a-z][a-z0-9_-]{0,23}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

// placeholders lists what a text names, as source:field pairs.
export function placeholders(text: string): { source: string; field: string }[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => ({ source: m[1], field: m[2] }));
}

// checkPlaceholders is the reason a text names something the relay cannot
// fill, or "" when every placeholder is known.
function checkPlaceholders(text: string, inputs: string[]): string {
  for (const { source, field } of placeholders(text)) {
    if (source === "input") {
      if (!inputs.includes(field)) return `names {input:${field}} but declares no such input`;
    } else if (!PLACEHOLDER_FIELDS[source as keyof typeof PLACEHOLDER_FIELDS].includes(field)) return `names {${source}:${field}}, which is not one of ${PLACEHOLDER_FIELDS[source as keyof typeof PLACEHOLDER_FIELDS].map((f) => source + ":" + f).join(", ")}`;
  }
  return "";
}

// safeHref says whether a resolved link may be shown: the web, or a nostr:
// URI for the viewer's own app. An owner's input cannot smuggle another
// scheme in. Plain http is admitted here and not in a template, since
// {relay:web} resolves to it on a local dev host.
export const safeHref = (href: string) => /^(https?:\/\/|nostr:)/i.test(href);
const templateHref = (href: string) => /^(https:\/\/|nostr:)/i.test(href);

// parseConnectionTemplate reads one library document and returns the
// template, or the reason it is not one. The build check runs the same
// function, so a bad file fails typecheck instead of the fold.
export function parseConnectionTemplate(name: string, raw: unknown): ConnectionTemplate | string {
  const d = raw as Record<string, unknown>;
  if (!d || typeof d !== "object" || Array.isArray(d)) return "not a connection template";
  if (d.format !== FORMAT) return "format must be " + FORMAT;
  const title = str(d.title, 40).trim();
  const about = str(d.about, 200).trim();
  const app = str(d.app, 40).trim();
  if (!title || !about || !app) return "needs a title, an about and an app";
  const icon = d.icon === undefined ? "app" : d.icon;
  if (!(ICONS as readonly unknown[]).includes(icon)) return `icon must be one of ${ICONS.join(", ")}`;
  if (d.feature !== undefined && !(FEATURE_NAMES as readonly unknown[]).includes(d.feature)) return `feature must be one of ${FEATURE_NAMES.join(", ")}`;
  const visibility = d.visibility === undefined ? "public" : d.visibility;
  if (!(VISIBILITIES as readonly unknown[]).includes(visibility)) return `visibility must be one of ${VISIBILITIES.join(", ")}`;
  const inputs: ConnectionInput[] = [];
  if (d.inputs !== undefined) {
    if (!Array.isArray(d.inputs) || d.inputs.length > MAX_INPUTS) return `inputs must be a list of at most ${MAX_INPUTS}`;
    for (const x of d.inputs as unknown[]) {
      const i = (x ?? {}) as Record<string, unknown>;
      const iname = str(i.name, 24);
      if (!INPUT_NAME.test(iname)) return "an input name is lowercase letters, digits, dash and underscore";
      if (inputs.some((o) => o.name === iname)) return `input ${iname} is declared twice`;
      const label = str(i.label, 60).trim();
      if (!label) return `input ${iname} needs a label`;
      inputs.push({ name: iname, label, placeholder: str(i.placeholder, 200), default: str(i.default, 500) });
    }
  }
  const names = inputs.map((i) => i.name);
  if (!Array.isArray(d.links) || d.links.length === 0 || d.links.length > MAX_LINKS) return `links must be a list of 1 to ${MAX_LINKS}`;
  const links: ConnectionLink[] = [];
  for (const x of d.links as unknown[]) {
    const l = (x ?? {}) as Record<string, unknown>;
    const label = str(l.label, 40).trim();
    if (!label) return "a link needs a label";
    const href = typeof l.href === "string" ? l.href.trim() : "";
    const copy = typeof l.copy === "string" ? l.copy : "";
    if ((href === "") === (copy === "")) return `link ${label} needs an href or a copy text, not both`;
    if (href.length > MAX_TEXT || copy.length > MAX_TEXT) return `link ${label} is longer than ${MAX_TEXT} characters`;
    if (href && !templateHref(href)) return `link ${label} must be https:// or nostr:`;
    const bad = checkPlaceholders(href || copy, names);
    if (bad) return `link ${label} ${bad}`;
    links.push(href ? { label, href } : { label, copy });
  }
  const qr = d.qr === undefined ? (links.find((l) => l.href)?.href ?? links[0].copy ?? "") : str(d.qr, MAX_TEXT).trim();
  if (qr) {
    const bad = checkPlaceholders(qr, names);
    if (bad) return `qr ${bad}`;
  }
  const out: ConnectionTemplate = { name, title, about, app, where: str(d.where, 40).trim(), icon: icon as Icon, visibility: visibility as Visibility, links, qr, inputs };
  if (d.feature !== undefined) out.feature = d.feature as Feature;
  return out;
}

export const CONNECTION_TEMPLATES: ConnectionTemplate[] = CONNECTION_LIBRARY.map(({ name, document }) => {
  const t = parseConnectionTemplate(name, document);
  if (typeof t === "string") throw new Error(`connection template ${name}: ${t}`);
  return t;
});

export function findConnectionTemplate(name: string): ConnectionTemplate | undefined {
  return CONNECTION_TEMPLATES.find((t) => t.name === name);
}

// parseConnections reads an owner's list, from setconnections or a
// configuration document: each entry names a template, and may set a
// visibility, a title, an about and the template's inputs. What no relay
// would take is dropped, one warning each. Not a list at all is the reason.
export function parseConnections(raw: unknown, label = "connections"): { list: Connection[]; warnings: string[] } | string {
  if (!Array.isArray(raw)) return `invalid: ${label} must be a list`;
  const warnings: string[] = [];
  const list: Connection[] = [];
  for (const [i, x] of raw.entries()) {
    const c = (x ?? {}) as Record<string, unknown>;
    const t = typeof c.template === "string" ? findConnectionTemplate(c.template) : undefined;
    if (!t) {
      warnings.push(`${label}[${i}]: no connection template named ${typeof c.template === "string" ? c.template : "(none)"}`);
      continue;
    }
    if (list.length === MAX_CONNECTIONS) {
      warnings.push(`${label}[${i}]: at most ${MAX_CONNECTIONS} connections`);
      break;
    }
    const out: Connection = { template: t.name, visibility: t.visibility };
    if (c.visibility !== undefined) {
      if ((VISIBILITIES as readonly unknown[]).includes(c.visibility)) out.visibility = c.visibility as Visibility;
      else warnings.push(`${label}[${i}].visibility: must be one of ${VISIBILITIES.join(", ")}`);
    }
    const title = str(c.title, 40).trim();
    if (title) out.title = title;
    const about = str(c.about, 200).trim();
    if (about) out.about = about;
    if (c.inputs !== undefined) {
      if (!c.inputs || typeof c.inputs !== "object" || Array.isArray(c.inputs)) warnings.push(`${label}[${i}].inputs: must be an object of input name to value`);
      else {
        const inputs: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.inputs as Record<string, unknown>)) {
          if (!t.inputs.some((d) => d.name === k)) warnings.push(`${label}[${i}].inputs.${k}: ${t.name} has no such input`);
          else if (typeof v !== "string") warnings.push(`${label}[${i}].inputs.${k}: must be a string`);
          else if (v.trim() !== "") inputs[k] = v.trim().slice(0, 500);
        }
        if (Object.keys(inputs).length) out.inputs = inputs;
      }
    }
    list.push(out);
  }
  return { list, warnings };
}

// The values a placeholder may take, by source; user is null for a visitor.
export interface Values {
  relay: Record<string, string>;
  owner: Record<string, string>;
  user: Record<string, string> | null;
}

// connectionValues is what this relay fills in for a given Host header and
// viewer. A value the relay does not have yet (no identity, no owner) is
// "", and a link that names it is left out rather than shown broken.
export function connectionValues(relay: Relay, host: string, user: string | null): Values {
  const p = relay.settings.policy;
  const url = relay.relayURL(host);
  const self = relay.identity.pubkey;
  const profile = (pk: string) => (pk ? nprofileEncode({ pubkey: pk, relays: [url] }) : "");
  const npub = (pk: string) => (pk ? npubEncode(pk) : "");
  return {
    relay: { url, host, web: relay.webURL(host), name: relay.slug, domain: relay.domain, hex: self, npub: npub(self), nprofile: profile(self), naddr: self ? naddrEncode({ kind: KIND_GROUP_METADATA, pubkey: self, identifier: relay.slug, relays: [url] }) : "" },
    owner: { hex: p.owner, npub: npub(p.owner), nprofile: profile(p.owner) },
    user: user ? { hex: user, npub: npub(user), nprofile: profile(user) } : null,
  };
}

// fill resolves a text's placeholders and lists the ones it could not, as
// source:field, so the caller can tell a visitor's missing user from a
// relay that has no owner yet.
export function fill(text: string, values: Values, inputs: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(PLACEHOLDER, (_, source: string, field: string, enc: string | undefined) => {
    const v = source === "input" ? (inputs[field] ?? "") : source === "user" ? (values.user?.[field] ?? "") : (values[source as "relay" | "owner"][field] ?? "");
    if (v === "") {
      missing.push(source + ":" + field);
      return "";
    }
    return enc ? encodeURIComponent(v) : v;
  });
  return { text: out, missing };
}

// visibleTo applies a shortcut's visibility to the pubkeys the asker proved.
export function visibleTo(v: Visibility, s: Settings, pubkeys: string[]): boolean {
  switch (v) {
    case "public":
      return true;
    case "auth":
      return pubkeys.length > 0;
    case "members":
      return pubkeys.some((pk) => s.isAllowed(pk));
    case "owner":
      return pubkeys.some((pk) => s.isOwner(pk));
  }
}

// A shortcut as the fold shows it: the template's words unless the owner
// changed them, and the links that resolved for this viewer.
export interface ResolvedConnection {
  template: string;
  title: string;
  about: string;
  app: string;
  where: string;
  icon: Icon;
  visibility: Visibility;
  links: ConnectionLink[];
  qr: string; // "" when nothing fits in a QR
  needsUser: boolean; // a link was left out because nobody is signed in
}

// resolveConnections is the owner's list as this viewer sees it: what
// their visibility admits, what the features on allow, links filled in.
export function resolveConnections(relay: Relay, host: string, pubkeys: string[]): ResolvedConnection[] {
  const s = relay.settings;
  const values = connectionValues(relay, host, pubkeys[0] ?? null);
  const out: ResolvedConnection[] = [];
  for (const c of s.connections()) {
    const t = findConnectionTemplate(c.template);
    if (!t) continue;
    if (t.feature && !featureOn(s.policy, t.feature)) continue;
    if (!visibleTo(c.visibility, s, pubkeys)) continue;
    const inputs: Record<string, string> = {};
    for (const i of t.inputs) inputs[i.name] = c.inputs?.[i.name] || i.default;
    let needsUser = false;
    const links: ConnectionLink[] = [];
    for (const l of t.links) {
      const r = fill(l.href ?? l.copy ?? "", values, inputs);
      if (r.missing.length) {
        if (r.missing.some((m) => m.startsWith("user:"))) needsUser = true;
        continue;
      }
      if (l.href) {
        if (safeHref(r.text)) links.push({ label: l.label, href: r.text });
      } else links.push({ label: l.label, copy: r.text });
    }
    if (links.length === 0 && !needsUser) continue;
    const qr = t.qr ? fill(t.qr, values, inputs) : { text: "", missing: [] };
    const qrText = qr.missing.length === 0 && new TextEncoder().encode(qr.text).length <= QR_MAX_BYTES ? qr.text : "";
    out.push({ template: t.name, title: c.title || t.title, about: c.about || t.about, app: t.app, where: t.where, icon: t.icon, visibility: c.visibility, links, qr: qrText, needsUser });
  }
  return out;
}

// connectDoor answers GET /connect.json for whoever asks.
export function connectDoor(relay: Relay, req: Request, url: URL): Response {
  const who = whoAsks(req, "", null);
  const cors = { "access-control-allow-origin": "*" };
  if (typeof who === "string") return Response.json({ error: who }, { status: 401, headers: cors });
  const values = connectionValues(relay, url.host, null);
  const signed = who.pubkeys.length > 0;
  return Response.json(
    { relay: { url: values.relay.url, host: values.relay.host, web: values.relay.web, name: values.relay.name }, viewer: who.pubkeys[0] ?? null, connections: resolveConnections(relay, url.host, who.pubkeys) },
    { headers: { ...cors, "cache-control": signed ? "no-store" : "public, max-age=60" } },
  );
}
