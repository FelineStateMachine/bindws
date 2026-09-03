// Views: folds over what the relay holds, published as records the relay
// signs (kind 30078, d = bind.ws/view/<name>) so a client reads one event
// instead of recomputing from hundreds. Each view names its trigger, which
// is its cost in rows written:
//
//   daily    once a day from the alarm
//   hourly   once an hour from the alarm, only when a fingerprint changed
//   write    when an accepted event touches it, coalesced, plus daily
//   live     never stored: presence, an ephemeral event from memory
//
// A public view is stored and broadcast like the roster. A members-only
// view is never stored, since a stored event is readable by anyone the read
// rule lets in; it is folded and signed on request at GET /view/<name>.
import { bolt11Msats } from "./fuel.ts";
import { now, tag, tagValues, type Event } from "./event.ts";
import type { Relay } from "./relay.ts";

export const KIND_VIEW = 30078;
// Presence is ephemeral: 20000 plus the view kind's 78, so a client that
// knows one can guess the other.
export const KIND_PRESENCE = 20078;
export const PRESENCE_ACTIVE_S = 15 * 60;
export const PRESENCE_THROTTLE_S = 30;
export const viewD = (name: string) => "bind.ws/view/" + name;

export type Trigger = "daily" | "hourly" | "write" | "live";
export type Audience = "public" | "members";
export interface Fold {
  tags: string[][];
  content: string;
}
export interface View {
  name: string;
  trigger: Trigger;
  about: string;
  audience: (relay: Relay) => Audience;
  // fingerprint, for hourly views: republish only when it moved.
  fingerprint?: (relay: Relay) => string;
  fold: (relay: Relay) => Fold | null; // null takes the record down
}
export interface ViewRun {
  at: number;
  rows: number;
}

const addr = (kind: number, pubkey: string, d: string) => `${kind}:${pubkey}:${d}`;
const parse = (raw: string) => JSON.parse(raw) as Event;
const byReads = (relay: Relay): Audience => (relay.settings.policy.reads === "members" ? "members" : "public");
const byDirectory = (relay: Relay): Audience => (relay.settings.policy.directoryPublic ? "public" : "members");

// The pubkeys a view speaks for: the owner first, then members.
function people(relay: Relay): string[] {
  const m = relay.settings.members();
  const owner = relay.settings.policy.owner;
  return [owner, ...m.map((x) => x.pubkey).filter((p) => p !== owner)].filter(Boolean);
}

// newest returns the stored replaceable event of `kind` for each pubkey.
function newest(relay: Relay, kind: number, pubkeys: string[]): Map<string, Event> {
  const out = new Map<string, Event>();
  if (pubkeys.length === 0) return out;
  for (const r of relay.sql.exec<{ pubkey: string; raw: string }>(`SELECT pubkey, raw FROM events WHERE kind=? AND pubkey IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC`, kind, JSON.stringify(pubkeys))) {
    if (!out.has(r.pubkey)) out.set(r.pubkey, parse(r.raw));
  }
  return out;
}

const profiles: View = {
  name: "profiles",
  trigger: "daily",
  about: "every member's newest profile in one record",
  audience: byDirectory,
  fold(relay) {
    const who = people(relay);
    const got = newest(relay, 0, who);
    const host = relay.slug + "." + relay.domain;
    const tags = who.map((pk) => {
      const e = got.get(pk);
      let meta: { name?: string; picture?: string; nip05?: string } = {};
      try {
        meta = e ? JSON.parse(e.content) : {};
      } catch {
        /* a profile that is not JSON */
      }
      const member = relay.settings.member(pk);
      const nip05 = member?.name ? `${member.name}@${host}` : typeof meta.nip05 === "string" ? meta.nip05 : "";
      return ["p", pk, String(meta.name ?? "").slice(0, 200), String(meta.picture ?? "").slice(0, 2000), nip05.slice(0, 200)];
    });
    return { tags, content: "" };
  },
};

const relays: View = {
  name: "relays",
  trigger: "daily",
  about: "where the members are: the union of their relay lists",
  audience: byDirectory,
  fold(relay) {
    const counts = new Map<string, number>();
    for (const e of newest(relay, 10002, people(relay)).values()) {
      const seen = new Set<string>();
      for (const t of e.tags) {
        if (t[0] !== "r" || typeof t[1] !== "string") continue;
        let u = "";
        try {
          const x = new URL(t[1].trim());
          if (x.protocol !== "wss:" && x.protocol !== "ws:") continue;
          u = (x.host + x.pathname).replace(/\/+$/, "").toLowerCase();
          u = x.protocol + "//" + u;
        } catch {
          continue;
        }
        if (seen.has(u)) continue;
        seen.add(u);
        counts.set(u, (counts.get(u) ?? 0) + 1);
      }
    }
    const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 100).map(([u, n]) => ["r", u, String(n)]);
    return { tags, content: "" };
  },
};

// A NIP-52 start: a date for kind 31922, a unix time for 31923.
function startOf(e: Event): number {
  const s = tag(e, "start");
  if (e.kind === 31922) {
    const t = Date.parse(s + "T00:00:00Z");
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  }
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

const calendar: View = {
  name: "calendar",
  trigger: "hourly",
  about: "what is on: calendar events starting in the next 30 days, with RSVPs counted",
  audience: byReads,
  fingerprint(relay) {
    const r = relay.sql.exec<{ n: number; m: number | null }>(`SELECT count(*) AS n, max(created_at) AS m FROM events WHERE kind IN (31922,31923,31925)`).one();
    return `${r.n}:${r.m ?? 0}:${Math.floor(now() / 86400)}`;
  },
  fold(relay) {
    const t = now();
    const upcoming: { a: string; start: number; title: string }[] = [];
    for (const r of relay.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE kind IN (31922,31923) ORDER BY created_at DESC LIMIT 1000`)) {
      const e = parse(r.raw);
      const start = startOf(e);
      if (start < t - 86400 || start > t + 30 * 86400) continue;
      upcoming.push({ a: addr(e.kind, e.pubkey, tag(e, "d")), start, title: tag(e, "title").slice(0, 200) });
    }
    upcoming.sort((a, b) => a.start - b.start);
    const top = upcoming.slice(0, 50);
    const rsvps = new Map<string, Set<string>>();
    if (top.length) {
      for (const r of relay.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE kind=31925 ORDER BY created_at DESC LIMIT 5000`)) {
        const e = parse(r.raw);
        if (tag(e, "status") !== "accepted") continue;
        for (const a of tagValues(e, "a")) {
          if (!rsvps.has(a)) rsvps.set(a, new Set());
          rsvps.get(a)!.add(e.pubkey);
        }
      }
    }
    const tags = top.map((u) => {
      const n = rsvps.get(u.a)?.size ?? 0;
      return n ? ["a", u.a, String(u.start), u.title, String(n)] : ["a", u.a, String(u.start), u.title];
    });
    return { tags, content: "" };
  },
};

const moderation: View = {
  name: "moderation",
  trigger: "daily",
  about: "this month's moderation counts, no ids",
  audience: () => "public",
  fold(relay) {
    const d = new Date(now() * 1000);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    const one = (q: string, ...args: unknown[]) => relay.sql.exec<{ n: number | null }>(q, ...args).one().n ?? 0;
    const counts = {
      month: d.toISOString().slice(0, 7),
      bans: one(`SELECT count(*) AS n FROM pubkey_rules WHERE rule='ban' AND at>=?`, monthStart),
      reports: one(`SELECT count(*) AS n FROM reports WHERE at>=?`, monthStart),
      resolved: one(`SELECT count(*) AS n FROM reports WHERE resolved_at>=?`, monthStart),
      hidden: one(`SELECT count(*) AS n FROM event_rules WHERE rule='hide' AND at>=?`, monthStart),
      deleted: one(`SELECT count(*) AS n FROM event_rules WHERE rule='ban' AND at>=?`, monthStart),
      blocked_addresses: one(`SELECT count(*) AS n FROM ip_rules WHERE at>=?`, monthStart),
    };
    return { tags: [["month", counts.month]], content: JSON.stringify(counts) };
  },
};

const articles: View = {
  name: "articles",
  trigger: "write",
  about: "the newest hundred articles, by address",
  audience: byReads,
  fold(relay) {
    const tags: string[][] = [];
    for (const r of relay.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE kind=30023 ORDER BY created_at DESC LIMIT 100`)) {
      const e = parse(r.raw);
      const published = tag(e, "published_at");
      tags.push(["a", addr(e.kind, e.pubkey, tag(e, "d")), tag(e, "title").slice(0, 200), /^\d+$/.test(published) ? published : String(e.created_at)]);
    }
    return { tags, content: "" };
  },
};

const zaps: View = {
  name: "zaps",
  trigger: "hourly",
  about: "zap totals for the top notes and authors here",
  audience: () => "public",
  fingerprint(relay) {
    const r = relay.sql.exec<{ n: number; m: number | null }>(`SELECT count(*) AS n, max(created_at) AS m FROM events WHERE kind=9735`).one();
    return `${r.n}:${r.m ?? 0}`;
  },
  fold(relay) {
    const byEvent = new Map<string, number>();
    const byAuthor = new Map<string, number>();
    const here = new Set(people(relay));
    const self = relay.identity.pubkey;
    const service = relay.fuel.cfg.servicePubkey;
    for (const r of relay.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE kind=9735 ORDER BY created_at DESC LIMIT 5000`)) {
      const receipt = parse(r.raw);
      let req: Event;
      try {
        req = JSON.parse(tag(receipt, "description"));
      } catch {
        continue;
      }
      if (!req || req.kind !== 9734 || !Array.isArray(req.tags)) continue;
      const msats = bolt11Msats(tag(receipt, "bolt11"));
      if (msats <= 0) continue;
      let to = tag(req, "p");
      if (service && to === service && self) to = self;
      if (to && (here.has(to) || to === self)) byAuthor.set(to, (byAuthor.get(to) ?? 0) + msats);
      const eid = tag(req, "e");
      if (/^[0-9a-f]{64}$/.test(eid) && relay.sql.exec(`SELECT 1 FROM events WHERE id=?`, eid).toArray().length) byEvent.set(eid, (byEvent.get(eid) ?? 0) + msats);
    }
    const top = (m: Map<string, number>, key: string) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, v]) => [key, k, String(v)]);
    return { tags: [...top(byEvent, "e"), ...top(byAuthor, "p")], content: "" };
  },
};

const presence: View = {
  name: "presence",
  trigger: "live",
  about: "who is connected now and who wrote in the last 15 minutes",
  audience: byReads,
  fold(relay) {
    return { tags: presenceTags(relay), content: "" };
  },
};

export const VIEWS: View[] = [profiles, relays, calendar, moderation, articles, zaps, presence];
export const viewByName = (name: string): View | undefined => VIEWS.find((v) => v.name === name);
export const viewOn = (relay: Relay, name: string): boolean => relay.settings.policy.views[name] !== false;
export const viewStored = (relay: Relay, v: View): boolean => v.trigger !== "live" && v.audience(relay) === "public";

// presenceTags folds the socket list and the recent writers: online beats active.
export function presenceTags(relay: Relay): string[][] {
  const t = now();
  const online = new Set(relay.authedNow());
  const tags: string[][] = [];
  for (const pk of online) tags.push(["p", pk, "online"]);
  for (const [pk, at] of relay.presenceActive) {
    if (t - at > PRESENCE_ACTIVE_S) relay.presenceActive.delete(pk);
    else if (!online.has(pk)) tags.push(["p", pk, "active"]);
  }
  return tags;
}

// viewEvent signs a fold as the view's record. Stored views use the group
// clock so a newer record always replaces the older one.
export function viewEvent(relay: Relay, v: View, fold: Fold, stored: boolean): Event {
  const tags = [["d", viewD(v.name)], ["trigger", v.trigger], ...fold.tags];
  if (stored) return relay.identity.view(tags, fold.content);
  return relay.identity.sign(KIND_VIEW, tags, fold.content);
}

// latestStored reads the record the relay last published for a view.
export function latestStored(relay: Relay, name: string): string | null {
  const self = relay.identity.pubkey;
  if (!self) return null;
  const row = relay.sql.exec<{ raw: string }>(`SELECT e.raw FROM events e JOIN tags t ON t.event_id=e.id WHERE e.kind=? AND e.pubkey=? AND t.name='d' AND t.value=? ORDER BY e.created_at DESC LIMIT 1`, KIND_VIEW, self, viewD(name)).toArray()[0];
  return row ? row.raw : null;
}

// nip11Views describes the views a relay keeps, for the information document.
export function nip11Views(relay: Relay) {
  return VIEWS.filter((v) => viewOn(relay, v.name)).map((v) => ({ name: v.name, kind: v.trigger === "live" ? KIND_PRESENCE : KIND_VIEW, d: viewD(v.name), trigger: v.trigger, audience: v.audience(relay) }));
}

// GET /view/<name>: the stored record, or a members-only fold signed on the
// spot for a member who proves it with NIP-98, or presence from memory.
// verify is the relay's NIP-98 check, passed in so this module does not import the management door.
export async function serveView(relay: Relay, req: Request, verify: (header: string, url: string, method: string, body: string) => Event | string): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" } });
  const name = new URL(req.url).pathname.slice("/view/".length);
  const v = viewByName(name);
  if (!v || !viewOn(relay, name)) return json({ error: "not found" }, 404);
  if (relay.settings.policy.owner === "" || !relay.identity.pubkey) return json({ error: "not found" }, 404);
  if (v.audience(relay) === "members") {
    const header = req.headers.get("authorization");
    const auth = header ? verify(header, req.url, req.method, "") : "auth-required: this view is for members; sign the request";
    if (typeof auth === "string") return json({ error: auth }, 401);
    if (!relay.settings.isAllowed(auth.pubkey)) return json({ error: "restricted: this view is for members" }, 403);
  }
  if (v.trigger === "live") return json(relay.identity.sign(KIND_PRESENCE, [["d", viewD(v.name)], ...presenceTags(relay)], ""));
  if (viewStored(relay, v)) {
    const raw = latestStored(relay, name);
    return raw ? new Response(raw, { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=60" } }) : json({ error: "not yet" }, 404);
  }
  const fold = v.fold(relay);
  return fold ? json(viewEvent(relay, v, fold, false)) : json({ error: "not yet" }, 404);
}

// viewsSummary lists every view with its state, for the console and NIP-86.
export async function viewsSummary(relay: Relay) {
  const out = [];
  for (const v of VIEWS) {
    const runs = await relay.viewRuns(v.name);
    const last = runs[runs.length - 1] ?? null;
    out.push({ name: v.name, about: v.about, trigger: v.trigger, audience: v.audience(relay), on: viewOn(relay, v.name), stored: viewStored(relay, v), last, path: "/view/" + v.name });
  }
  return out;
}

// viewRowsSince sums the rows the views wrote in a window, for the digest.
export async function viewRowsSince(relay: Relay, since: number): Promise<number> {
  let rows = 0;
  for (const v of VIEWS) for (const r of await relay.viewRuns(v.name)) if (r.at >= since) rows += r.rows;
  return rows;
}
