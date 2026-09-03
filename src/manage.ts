// NIP-86 relay management over HTTP, authenticated with NIP-98. The owner is
// whoever claimed the relay; "claim" is the one method anyone may call, and
// only while the relay is unclaimed.
import { sha256 } from "@noble/hashes/sha2.js";
import { now, tagValues, validate, type Event } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";
import type { Relay } from "./relay.ts";
import { listInvites, mintInvite, revokeInvite } from "./invites.ts";
import { descriptor, type Blob } from "./blossom.ts";
import { isReplaceable, isProtected } from "./settings.ts";

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

const METHODS = [
  "supportedmethods", "claim", "stats", "getpolicy", "setpolicy",
  "banpubkey", "allowpubkey", "unrulepubkey", "listbannedpubkeys", "listallowedpubkeys",
  "setmember", "removemember", "listpeople",
  "banevent", "allowevent", "listbannedevents", "deleteevent", "listrecentevents",
  "allowkind", "disallowkind", "unrulekind", "listallowedkinds", "listblockedkinds",
  "changerelayname", "changerelaydescription", "changerelayicon",
  "createinvite", "listinvites", "revokeinvite", "listmembers",
  "listreports", "resolvereport",
  "listblobs", "deleteblob",
  "storagestats", "setretention", "listretention", "purgekind",
  "deleterelay", "exportconfig", "importconfig", "resetrules",
];

export async function manage(relay: Relay, req: Request): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
  const bodyText = await req.text();
  let body: { method?: unknown; params?: unknown };
  try {
    body = JSON.parse(bodyText);
  } catch {
    return reply({ error: "invalid: body is not JSON" }, 400);
  }
  const method = typeof body.method === "string" ? body.method : "";
  const params = Array.isArray(body.params) ? body.params : [];
  if (!METHODS.includes(method)) return reply({ error: "unsupported: unknown method " + method }, 400);

  const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, bodyText);
  if (typeof auth === "string") return reply({ error: auth }, 401);
  const s = relay.settings;
  const p = s.policy;
  const t = now();
  const caller = auth.pubkey;

  if (method === "claim") {
    if (p.owner === "") {
      // A leased relay converts in place, keeping its events and files. A
      // lease taken with a signature is reserved for that key.
      const lease = p.lease;
      if (lease && lease.holder && lease.holder !== caller) return reply({ error: "restricted: this temporary relay is reserved for another key" }, 403);
      if (lease && lease.until <= t) return reply({ error: "restricted: this temporary relay has expired" }, 403);
      s.update(lease ? { owner: caller, lease: null, name: "", description: "" } : { owner: caller });
      s.upsertMember(caller, { via: "claimed" }, t);
      await relay.publishRoster();
      return reply({ result: { owner: caller, claimed: true, ...(lease ? { converted: true } : {}) } });
    }
    return reply({ result: { owner: p.owner, claimed: s.isOwner(caller) } }, s.isOwner(caller) ? 200 : 403);
  }
  if (method === "supportedmethods") return reply({ result: METHODS });
  if (!s.isOwner(caller)) {
    const why = p.owner !== "" ? "restricted: not the relay owner" : s.isLeased() ? "restricted: this is a temporary relay; claim it first" : "restricted: this relay is unclaimed";
    return reply({ error: why }, 403);
  }

  const str = (i: number) => (typeof params[i] === "string" ? (params[i] as string) : "");
  const num = (i: number) => (Number.isInteger(params[i]) ? (params[i] as number) : parseInt(str(i), 10));
  const hex64 = (v: string) => /^[0-9a-f]{64}$/.test(v);

  switch (method) {
    case "stats": {
      const d = new Date(now() * 1000);
      const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
      return reply({ result: { ...relay.store.stats(), kinds: relay.store.kinds(monthStart), connections: relay.connections(), name: relay.slug, owner: p.owner, fuel: relay.fuelStatus() } });
    }
    case "getpolicy":
      return reply({ result: p });
    case "setpolicy": {
      const patch = params[0] && typeof params[0] === "object" ? (params[0] as Record<string, unknown>) : {};
      const clean: Record<string, unknown> = {};
      for (const k of ["name", "description", "icon", "contact"]) if (typeof patch[k] === "string") clean[k] = (patch[k] as string).slice(0, 2000);
      if (patch.writes === "open" || patch.writes === "allowlist" || patch.writes === "owner") clean.writes = patch.writes;
      if (patch.reads === "open" || patch.reads === "auth" || patch.reads === "members") clean.reads = patch.reads;
      if (typeof patch.joinTerms === "string") clean.joinTerms = patch.joinTerms.slice(0, 20000);
      if (typeof patch.directoryPublic === "boolean") clean.directoryPublic = patch.directoryPublic;
      for (const k of ["minPow", "maxFuture", "maxLimit", "maxSubs", "maxBlobMB", "eventsPerMinute", "reqsPerMinute"]) if (Number.isInteger(patch[k]) && (patch[k] as number) >= 0) clean[k] = patch[k];
      if (typeof clean.maxBlobMB === "number") clean.maxBlobMB = Math.min(Math.max(clean.maxBlobMB as number, 1), 95);
      if (typeof clean.eventsPerMinute === "number") clean.eventsPerMinute = Math.max(clean.eventsPerMinute as number, 1);
      if (typeof clean.reqsPerMinute === "number") clean.reqsPerMinute = Math.max(clean.reqsPerMinute as number, 1);
      if (typeof clean.maxLimit === "number") clean.maxLimit = Math.min(Math.max(clean.maxLimit as number, 1), 5000);
      if (typeof clean.maxSubs === "number") clean.maxSubs = Math.min(Math.max(clean.maxSubs as number, 1), 200);
      s.update(clean);
      return reply({ result: s.policy });
    }
    case "banpubkey": {
      const pk = str(0);
      if (!hex64(pk)) return reply({ error: "invalid: pubkey must be 64 hex chars" }, 400);
      if (s.isOwner(pk)) return reply({ error: "invalid: cannot ban the owner" }, 400);
      await relay.ban(pk, str(1));
      return reply({ result: true });
    }
    case "allowpubkey":
    case "setmember": {
      // NIP-86 allowpubkey(pubkey, reason) and the richer setmember(pubkey, {name, note}).
      const pk = str(0);
      if (!hex64(pk)) return reply({ error: "invalid: pubkey must be 64 hex chars" }, 400);
      const patch = method === "allowpubkey" ? { note: str(1) } : (params[1] && typeof params[1] === "object" ? (params[1] as { name?: string | null; note?: string }) : {});
      if (s.isBanned(pk)) s.setBan(pk, false);
      const err = await relay.setMember(pk, { name: patch.name, note: typeof patch.note === "string" ? patch.note : undefined }, true);
      return err ? reply({ error: err }, 400) : reply({ result: s.member(pk) });
    }
    case "unrulepubkey":
    case "removemember": {
      // Removes a ban or a membership, whichever the pubkey has; never the owner.
      const pk = str(0);
      if (!hex64(pk)) return reply({ error: "invalid: pubkey must be 64 hex chars" }, 400);
      if (s.isBanned(pk)) s.setBan(pk, false);
      await relay.removeMember(pk);
      return reply({ result: true });
    }
    case "listbannedpubkeys":
      return reply({ result: s.listBans() });
    case "listallowedpubkeys":
      return reply({ result: s.members().filter((m) => m.role !== "owner").map((m) => ({ pubkey: m.pubkey, reason: m.note })) });
    case "listmembers":
    case "listpeople":
      return reply({ result: { self: relay.identity.pubkey, members: s.members() } });
    case "createinvite":
      return reply({ result: mintInvite(relay.sql, caller, num(0) || 0, num(1) || 0, str(2), t) });
    case "listinvites":
      return reply({ result: listInvites(relay.sql, t) });
    case "revokeinvite":
      return reply({ result: revokeInvite(relay.sql, str(0)) });
    case "banevent": {
      const id = str(0);
      if (!hex64(id)) return reply({ error: "invalid: id must be 64 hex chars" }, 400);
      s.setEvent(id, "ban", str(1), t);
      relay.store.deleteEvent(id);
      return reply({ result: true });
    }
    case "allowevent":
      s.setEvent(str(0), null);
      return reply({ result: true });
    case "listreports": {
      const status = str(0) || "open";
      return reply({ result: relay.sql.exec(`SELECT * FROM reports WHERE status=? ORDER BY at DESC LIMIT 200`, status).toArray() });
    }
    case "resolvereport": {
      const id = str(0);
      const action = str(1);
      const row = relay.sql.exec<{ id: string; target_pubkey: string; target_event: string; status: string }>(`SELECT id, target_pubkey, target_event, status FROM reports WHERE id=?`, id).toArray()[0];
      if (!row) return reply({ error: "invalid: no such report" }, 400);
      if (!["ban", "delete", "dismiss"].includes(action)) return reply({ error: "invalid: action must be ban, delete or dismiss" }, 400);
      if (action === "ban") {
        if (s.isOwner(row.target_pubkey)) return reply({ error: "invalid: cannot ban the owner" }, 400);
        await relay.ban(row.target_pubkey, "report " + id.slice(0, 8));
        if (row.target_event) {
          s.setEvent(row.target_event, "ban", "report " + id.slice(0, 8), t);
          relay.store.deleteEvent(row.target_event);
        }
      } else if (action === "delete" && row.target_event) {
        s.setEvent(row.target_event, "ban", "report " + id.slice(0, 8), t);
        relay.store.deleteEvent(row.target_event);
      }
      relay.sql.exec(`UPDATE reports SET status='resolved', resolved_by=?, resolved_at=?, action=? WHERE id=?`, caller, t, action, id);
      return reply({ result: true });
    }
    case "exportconfig":
      return reply({ result: s.exportConfig(relay.slug) });
    case "importconfig": {
      const err = s.importConfig(params[0], t);
      if (err) return reply({ error: err }, 400);
      await relay.publishRoster();
      return reply({ result: s.exportConfig(relay.slug) });
    }
    case "deleterelay": {
      // The confirmation is the relay's name, typed by hand, GitHub-style.
      if (str(0) !== relay.slug) return reply({ error: "invalid: type the relay name to confirm" }, 400);
      await relay.teardown();
      return reply({ result: { deleted: true, name: relay.slug } });
    }
    case "listblobs": {
      const host = new URL(req.url).host;
      const rows = relay.sql.exec<Blob>(`SELECT * FROM blobs ORDER BY uploaded DESC LIMIT ?`, Math.min(Math.max(num(0) || 100, 1), 500)).toArray();
      return reply({ result: rows.map((b) => ({ ...descriptor(host, b), uploader: b.uploader })) });
    }
    case "deleteblob": {
      const sha = str(0);
      if (!hex64(sha)) return reply({ error: "invalid: sha256 must be 64 hex chars" }, 400);
      await relay.deleteBlob(sha);
      return reply({ result: true });
    }
    case "listbannedevents":
      return reply({ result: s.listEvents("ban") });
    case "deleteevent":
      return reply({ result: relay.store.deleteEvent(str(0)) });
    case "listrecentevents":
      return reply({ result: relay.store.recent(Math.min(Math.max(num(0) || 50, 1), 500), t).map((r) => JSON.parse(r)) });
    case "allowkind":
    case "disallowkind":
    case "unrulekind": {
      const k = num(0);
      if (!Number.isInteger(k) || k < 0 || k > 65535) return reply({ error: "invalid: kind out of range" }, 400);
      s.setKind(k, method === "allowkind" ? "allow" : method === "disallowkind" ? "block" : null);
      return reply({ result: true });
    }
    case "storagestats": {
      const kinds = relay.store.kindStats().map((k) => ({ ...k, days: s.retentionDays(k.kind), replaceable: isReplaceable(k.kind), protected: isProtected(k.kind) }));
      const blobs = relay.sql.exec<{ n: number | null; bytes: number | null }>(`SELECT count(*) AS n, sum(size) AS bytes FROM blobs`).one();
      return reply({ result: { kinds, events: kinds.reduce((a, k) => a + k.n, 0), eventBytes: kinds.reduce((a, k) => a + k.bytes, 0), databaseBytes: relay.eventBytes(), blobs: blobs.n ?? 0, mediaBytes: blobs.bytes ?? 0, retention: s.listRetention() } });
    }
    case "setretention": {
      // (kind | null, days): days 0 removes the rule.
      const kind = params[0] === null ? null : num(0);
      const days = num(1);
      if (kind !== null && (!Number.isInteger(kind) || kind < 0 || kind > 65535)) return reply({ error: "invalid: kind out of range" }, 400);
      if (!Number.isInteger(days) || days < 0 || days > 36500) return reply({ error: "invalid: days out of range" }, 400);
      const err = s.setRetention(kind, days);
      if (err) return reply({ error: err }, 400);
      return reply({ result: s.listRetention() });
    }
    case "listretention":
      return reply({ result: s.listRetention() });
    case "purgekind": {
      // (kind | null, olderThanDays): 0 days means everything of that kind.
      const kind = params[0] === null ? null : num(0);
      const days = num(1) || 0;
      if (kind !== null && (!Number.isInteger(kind) || kind < 0 || kind > 65535)) return reply({ error: "invalid: kind out of range" }, 400);
      if (!Number.isInteger(days) || days < 0) return reply({ error: "invalid: days out of range" }, 400);
      if (kind !== null && isProtected(kind)) return reply({ error: `invalid: kind ${kind} is part of how the relay works and cannot be purged` }, 400);
      const before = days > 0 ? t - days * 86400 : Number.MAX_SAFE_INTEGER;
      const gone = kind === null ? relay.store.purge(null, before, relay.store.kindStats().map((k) => k.kind).filter((k) => isReplaceable(k) || isProtected(k))) : relay.store.purge(kind, before);
      return reply({ result: { deleted: gone } });
    }
    case "listallowedkinds":
      return reply({ result: s.listKinds("allow") });
    case "listblockedkinds":
      return reply({ result: s.listKinds("block") });
    case "resetrules":
      s.resetRules();
      return reply({ result: s.policy });
    case "changerelayname":
      s.update({ name: str(0).slice(0, 200) });
      return reply({ result: true });
    case "changerelaydescription":
      s.update({ description: str(0).slice(0, 2000) });
      return reply({ result: true });
    case "changerelayicon":
      s.update({ icon: str(0).slice(0, 2000) });
      return reply({ result: true });
  }
  return reply({ error: "unsupported: " + method }, 400);
}
