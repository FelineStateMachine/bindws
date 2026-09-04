// NIP-86 relay management over HTTP, authenticated with NIP-98. The owner is
// whoever claimed the relay; "claim" is the one method anyone may call, and
// only while the relay is unclaimed.
//
// One table, METHODS, holds every method: the action it needs (roles.ts),
// whether it changes nothing (then it is not logged), and what it does.
// supportedmethods, the permission check and the moderation log all read
// the table, so a method is registered in one place.
import { now } from "./event.ts";
import type { Relay } from "./relay.ts";
import { inviteCreator, listInvites, memberInviteGate, mintInvite, revokeInvite } from "./invites.ts";
import { descriptor, type Blob } from "./blossom.ts";
import { badBlockedWord, blockedWords, gateFields, isWriteRule, limitFields, viewFields, type Policy, type Settings } from "./settings.ts";
import { isReplaceable, isProtected, publicFields, dumpFields, validIP } from "./settings.ts";
import { checkPullURL } from "./pull.ts";
import { VIEWS, publishView, viewsSummary } from "./views.ts";
import { MAX_PINS } from "./groups.ts";
import { relaysFromList } from "./jobs.ts";
import { notify, notifySettings } from "./notify.ts";
import { DUMP_NAME_RE, deleteDump, dumpBytes, listDumps, writeDump } from "./dumps.ts";
import { can, type Action, type Role } from "./roles.ts";
import { detailOf } from "./audit.ts";
import { PRESETS, applyPreset, findPreset } from "./presets.ts";
import { addDomain, checkDomain, listDomains, removeDomain } from "./domains.ts";
import { verifyNIP98 } from "./auth.ts";

// A call: the relay and the request, who is calling and as what, the
// parameters with their readers, and how to answer.
export interface Call {
  relay: Relay;
  req: Request;
  s: Settings;
  p: Policy;
  t: number;
  caller: string;
  role: Role | null;
  method: string;
  params: unknown[];
  str: (i: number) => string;
  num: (i: number) => number;
  hex64: (v: string) => boolean;
  reply: (body: unknown, status?: number) => Response;
  // outranks says the caller may not touch this pubkey: a moderator keeps
  // their hands off the owner and other moderators.
  outranks: (pk: string) => boolean;
}

interface Method {
  // The action the caller's role must allow (roles.ts); "open" for the two
  // methods anyone may call.
  action: Action | "open";
  // Changes nothing, so it is not written to the moderation log.
  reads?: true;
  run: (c: Call) => Response | Promise<Response>;
}

// putMember answers allowpubkey and setmember.
const putMember = async ({ relay, s, role, method, params, str, hex64, reply, outranks }: Call) => {
  // NIP-86 allowpubkey(pubkey, reason) and the richer setmember(pubkey, {name, note}).
  const pk = str(0);
  if (!hex64(pk)) return reply({ error: "invalid: pubkey must be 64 hex chars" }, 400);
  const patch = method === "allowpubkey" ? { note: str(1) } : (params[1] && typeof params[1] === "object" ? (params[1] as { name?: string | null; note?: string; role?: string; keepDays?: unknown; maxBytes?: unknown }) : {});
  if (outranks(pk)) return reply({ error: "restricted: moderators cannot edit the owner or other moderators" }, 403);
  // Per-member keep-for and cap: the owner's call, and never on the owner.
  const keepDays = Number.isInteger(patch.keepDays) && (patch.keepDays as number) >= 0 ? (patch.keepDays as number) : undefined;
  const maxBytes = Number.isInteger(patch.maxBytes) && (patch.maxBytes as number) >= 0 ? (patch.maxBytes as number) : undefined;
  if ((keepDays !== undefined || maxBytes !== undefined) && role !== "owner") return reply({ error: "restricted: only the owner sets limits" }, 403);
  const wantsRole = patch.role === "moderator" || patch.role === "member" ? patch.role : undefined;
  if (wantsRole && role !== "owner") return reply({ error: "restricted: only the owner sets roles" }, 403);
  if (wantsRole && s.isOwner(pk)) return reply({ error: "invalid: the owner's role changes by transferowner" }, 400);
  if (s.isBanned(pk)) s.setBan(pk, false);
  const err = await relay.setMember(pk, { name: patch.name, note: typeof patch.note === "string" ? patch.note : undefined, ...(s.isOwner(pk) ? {} : { keepDays, maxBytes }) }, true);
  if (err) return reply({ error: err }, 400);
  if (wantsRole && s.roleOf(pk) !== wantsRole) {
    s.setRole(pk, wantsRole);
    await relay.publishMembership({ pubkey: pk });
  }
  return reply({ result: s.member(pk) });
};

// dropMember answers unrulepubkey and removemember.
const dropMember = async ({ relay, s, str, hex64, reply, outranks }: Call) => {
  // Removes a ban or a membership, whichever the pubkey has; never the owner.
  const pk = str(0);
  if (!hex64(pk)) return reply({ error: "invalid: pubkey must be 64 hex chars" }, 400);
  if (outranks(pk)) return reply({ error: "restricted: moderators cannot remove the owner or other moderators" }, 403);
  if (s.isBanned(pk)) s.setBan(pk, false);
  await relay.removeMember(pk);
  return reply({ result: true });
};

// listMembers answers listmembers and listpeople.
const listMembers = ({ relay, s, t, reply }: Call) => {
  // Each member carries how many live invites they hold, for the tree.
  const minted = new Map<string, number>();
  for (const r of relay.sql.exec<{ created_by: string; n: number }>(`SELECT created_by, count(*) AS n FROM invites WHERE expires_at>=? AND (max_uses=0 OR uses<max_uses) GROUP BY created_by`, t)) minted.set(r.created_by, r.n);
  return reply({ result: { self: relay.identity.pubkey, members: s.members().map((m) => ({ ...m, invites: minted.get(m.pubkey) ?? 0 })) } });
};

// pin answers pinevent and unpinevent.
const pin = async ({ relay, s, method, str, hex64, reply }: Call) => {
  // (id or address): the group's pin list, at most MAX_PINS, in order.
  const ref = str(0).trim().toLowerCase();
  const tag = hex64(ref) ? ["e", ref] : /^\d{1,5}:[0-9a-f]{64}:/.test(ref) ? ["a", ref] : null;
  if (!tag) return reply({ error: "invalid: give an event id or an address kind:pubkey:d" }, 400);
  const cur = s.pins().filter((x) => x[1] !== ref);
  const next = method === "pinevent" ? [...cur, tag] : cur;
  if (next.length > MAX_PINS) return reply({ error: `invalid: at most ${MAX_PINS} pins` }, 400);
  s.setPins(next);
  await relay.publishPins();
  return reply({ result: next });
};

// ruleKind answers allowkind, disallowkind and unrulekind.
const ruleKind = async ({ relay, s, method, num, reply }: Call) => {
  const k = num(0);
  if (!Number.isInteger(k) || k < 0 || k > 65535) return reply({ error: "invalid: kind out of range" }, 400);
  s.setKind(k, method === "allowkind" ? "allow" : method === "disallowkind" ? "block" : null);
  await relay.publishDiscovery();
  return reply({ result: true });
};

export const METHODS: Record<string, Method> = {
  // claim: the one method anyone may call, while the relay is unclaimed.
  claim: {
    action: "open", reads: true,
    run: async ({ relay, s, p, t, caller, reply }) => {
      if (p.owner === "") {
        // A leased relay converts in place, keeping its events and files. A
        // lease taken with a signature is reserved for that key.
        const lease = p.lease;
        if (lease && lease.holder && lease.holder !== caller) return reply({ error: "restricted: this temporary relay is reserved for another key" }, 403);
        if (lease && lease.until <= t) return reply({ error: "restricted: this temporary relay has expired" }, 403);
        s.update(lease ? { owner: caller, lease: null, name: "", description: "" } : { owner: caller });
        s.upsertMember(caller, { via: "claimed" }, t);
        await relay.succession.seenNow();
        await relay.publishMembership();
        return reply({ result: { owner: caller, claimed: true, ...(lease ? { converted: true } : {}) } });
      }
      return reply({ result: { owner: p.owner, claimed: s.isOwner(caller) } }, s.isOwner(caller) ? 200 : 403);
    },
  },
  supportedmethods: { action: "open", reads: true, run: ({ reply }) => reply({ result: Object.keys(METHODS) }) },
  listaudit: {
    action: "read", reads: true,
    run: ({ relay, num, reply }) => {
      // (before): rows older than that seq, newest first; 0 or nothing for the newest page.
      return reply({ result: relay.audit.list(Math.max(num(0) || 0, 0)) });
    },
  },
  stats: {
    action: "read", reads: true,
    run: ({ relay, p, reply }) => {
      const d = new Date(now() * 1000);
      const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
      return reply({ result: { ...relay.store.stats(), kinds: relay.store.kinds(monthStart), connections: relay.connections(), name: relay.slug, owner: p.owner, fuel: relay.fuelStatus(), credits: relay.fuel.recentCredits() } });
    },
  },
  getpolicy: { action: "read", reads: true, run: ({ p, reply }) => reply({ result: p }) },
  setpolicy: {
    action: "rules",
    run: async ({ relay, s, p, params, reply }) => {
      const patch = params[0] && typeof params[0] === "object" ? (params[0] as Record<string, unknown>) : {};
      const clean: Record<string, unknown> = {};
      for (const k of ["name", "description", "icon", "contact"]) if (typeof patch[k] === "string") clean[k] = (patch[k] as string).slice(0, 2000);
      Object.assign(clean, publicFields(patch), dumpFields(patch), gateFields(patch), viewFields(patch, p.views));
      if (isWriteRule(patch.writes)) clean.writes = patch.writes;
      if (patch.reads === "open" || patch.reads === "auth" || patch.reads === "members") clean.reads = patch.reads;
      if (typeof patch.joinTerms === "string") clean.joinTerms = patch.joinTerms.slice(0, 20000);
      if (typeof patch.directoryPublic === "boolean") clean.directoryPublic = patch.directoryPublic;
      const notifyPatch = notifySettings(patch.notify, p.notify);
      if (notifyPatch) clean.notify = notifyPatch;
      Object.assign(clean, limitFields(patch));
      s.update(clean);
      // A read rule that tightened ends the subscriptions it no longer admits.
      relay.enforceReads();
      await relay.publishMembership();
      // A view switched off is taken down now; one switched on is published
      // now, and every view is republished when the rules changed, since
      // the read rule and the directory decide each one's audience.
      const names = patch.views && typeof patch.views === "object" ? Object.keys(patch.views as object) : [];
      if (clean.reads !== undefined || clean.directoryPublic !== undefined) for (const v of VIEWS) if (!names.includes(v.name)) names.push(v.name);
      for (const name of names) await publishView(relay, name);
      return reply({ result: s.policy });
    },
  },
  listviews: { action: "read", reads: true, run: async ({ relay, reply }) => reply({ result: await viewsSummary(relay) }) },
  banpubkey: {
    action: "ban",
    run: async ({ relay, s, params, str, hex64, reply, outranks }) => {
      const pk = str(0);
      if (!hex64(pk)) return reply({ error: "invalid: pubkey must be 64 hex chars" }, 400);
      if (s.isOwner(pk)) return reply({ error: "invalid: cannot ban the owner" }, 400);
      if (outranks(pk)) return reply({ error: "restricted: moderators cannot ban other moderators" }, 403);
      // (pubkey, reason, erase): erase deletes everything they wrote and uploaded.
      await relay.ban(pk, str(1), params[2] === true);
      return reply({ result: true });
    },
  },
  setblockedwords: {
    action: "ban",
    run: ({ s, params, reply }) => {
      // (words[]): content containing one is refused; the owner and moderators
      // are exempt. A /pattern/ that does not compile fails the whole call, so
      // the mistake is seen rather than dropped.
      if (!Array.isArray(params[0])) return reply({ error: "invalid: give a list of words" }, 400);
      for (const x of params[0]) {
        const why = badBlockedWord(x);
        if (why) return reply({ error: why }, 400);
      }
      const words = blockedWords(params[0])!;
      s.update({ blockedWords: words });
      return reply({ result: words });
    },
  },
  allowpubkey: { action: "members", run: putMember },
  setmember: { action: "members", run: putMember },
  unrulepubkey: { action: "members", run: dropMember },
  removemember: { action: "members", run: dropMember },
  listbannedpubkeys: { action: "read", reads: true, run: ({ s, reply }) => reply({ result: s.listBans() }) },
  listallowedpubkeys: {
    action: "read", reads: true,
    run: ({ s, reply }) => {
      return reply({ result: s.members().filter((m) => m.role !== "owner").map((m) => ({ pubkey: m.pubkey, reason: m.note })) });
    },
  },
  listmembers: { action: "read", reads: true, run: listMembers },
  listpeople: { action: "read", reads: true, run: listMembers },
  createinvite: {
    action: "invites",
    run: ({ relay, s, t, caller, role, str, num, reply }) => {
      if (role === "member") {
        const gate = memberInviteGate(s, relay.sql, caller, t);
        if (gate) return reply({ error: gate }, 403);
      }
      const inv = mintInvite(relay.sql, caller, num(0) || 0, num(1) || 0, str(2), t);
      return typeof inv === "string" ? reply({ error: inv }, 400) : reply({ result: inv });
    },
  },
  listinvites: {
    action: "read", reads: true,
    run: ({ relay, t, caller, role, reply }) => {
      const all = listInvites(relay.sql, t);
      return reply({ result: role === "member" ? all.filter((i) => i.created_by === caller) : all });
    },
  },
  revokeinvite: {
    action: "invites",
    run: ({ relay, caller, role, str, reply }) => {
      if (role === "member" && inviteCreator(relay.sql, str(0)) !== caller) return reply({ error: "restricted: not your invite" }, 403);
      return reply({ result: revokeInvite(relay.sql, str(0)) });
    },
  },
  removesubtree: {
    action: "members",
    run: async ({ relay, s, str, hex64, reply, outranks }) => {
      // (pubkey): the member and everyone they invited, plain members only.
      const pk = str(0);
      if (!hex64(pk)) return reply({ error: "invalid: pubkey must be 64 hex chars" }, 400);
      if (s.isOwner(pk)) return reply({ error: "invalid: cannot remove the owner" }, 400);
      if (outranks(pk)) return reply({ error: "restricted: moderators cannot remove the owner or other moderators" }, 403);
      const removed = await relay.removeSubtree(pk);
      return reply({ result: { removed } });
    },
  },
  banevent: {
    action: "ban",
    run: ({ relay, s, t, str, hex64, reply }) => {
      const id = str(0);
      if (!hex64(id)) return reply({ error: "invalid: id must be 64 hex chars" }, 400);
      s.setEvent(id, "ban", str(1), t);
      relay.store.deleteEvent(id);
      return reply({ result: true });
    },
  },
  allowevent: {
    action: "ban",
    run: ({ s, str, reply }) => {
      s.setEvent(str(0), null);
      return reply({ result: true });
    },
  },
  listeventsneedingmoderation: {
    action: "reports", reads: true,
    run: ({ relay, s, reply }) => {
      // NIP-86's view of the reports queue: one entry per reported thing,
      // event id or blob hash, with the report's type and words as the reason.
      const seen = new Set<string>();
      const out: { id: string; reason: string }[] = [];
      for (const r of relay.sql.exec<{ target_event: string; type: string; content: string }>(`SELECT target_event, type, content FROM reports WHERE status='open' AND target_event<>'' ORDER BY at DESC LIMIT 500`)) {
        if (seen.has(r.target_event)) continue;
        seen.add(r.target_event);
        out.push({ id: r.target_event, reason: [r.type, r.content.slice(0, 200)].filter(Boolean).join(": ") });
      }
      return reply({ result: out });
    },
  },
  blockip: {
    action: "ban",
    run: ({ relay, str, reply }) => {
      const ip = str(0).trim().toLowerCase();
      if (!validIP(ip)) return reply({ error: "invalid: not an IP address" }, 400);
      relay.blockIP(ip, str(1).slice(0, 200));
      return reply({ result: true });
    },
  },
  unblockip: {
    action: "ban",
    run: ({ s, str, reply }) => {
      const ip = str(0).trim().toLowerCase();
      if (!validIP(ip)) return reply({ error: "invalid: not an IP address" }, 400);
      s.setIPBlock(ip, false);
      return reply({ result: true });
    },
  },
  listblockedips: { action: "read", reads: true, run: ({ s, reply }) => reply({ result: s.listIPBlocks() }) },
  listreports: {
    action: "read", reads: true,
    run: ({ relay, str, reply }) => {
      const status = str(0) || "open";
      // blob says whether target_event is a file this relay still holds (BUD-09).
      return reply({ result: relay.sql.exec(`SELECT r.*, EXISTS(SELECT 1 FROM blobs b WHERE b.sha256=r.target_event) AS blob, EXISTS(SELECT 1 FROM event_rules e WHERE e.id=r.target_event AND e.rule='hide') AS hidden FROM reports r WHERE status=? ORDER BY at DESC LIMIT 200`, status).toArray() });
    },
  },
  resolvereport: {
    action: "reports",
    run: async ({ relay, s, t, caller, params, str, reply, outranks }) => {
      const id = str(0);
      const action = str(1);
      const row = relay.sql.exec<{ id: string; target_pubkey: string; target_event: string; status: string }>(`SELECT id, target_pubkey, target_event, status FROM reports WHERE id=?`, id).toArray()[0];
      if (!row) return reply({ error: "invalid: no such report" }, 400);
      if (!["ban", "delete", "dismiss"].includes(action)) return reply({ error: "invalid: action must be ban, delete or dismiss" }, 400);
      // target_event is an event id or, for a blob report (BUD-09), a sha256.
      // Either way the id goes on the banned list, so the thing cannot return.
      const remove = async () => {
        if (!row.target_event) return;
        s.setEvent(row.target_event, "ban", "report " + id.slice(0, 8), t);
        relay.store.deleteEvent(row.target_event);
        if (relay.sql.exec(`SELECT 1 FROM blobs WHERE sha256=?`, row.target_event).toArray().length) await relay.deleteBlob(row.target_event);
      };
      if (action === "ban") {
        if (s.isOwner(row.target_pubkey)) return reply({ error: "invalid: cannot ban the owner" }, 400);
        if (outranks(row.target_pubkey)) return reply({ error: "restricted: moderators cannot ban other moderators" }, 403);
        await relay.ban(row.target_pubkey, "report " + id.slice(0, 8), params[2] === true);
        await remove();
      } else if (action === "delete") await remove();
      relay.sql.exec(`UPDATE reports SET status='resolved', resolved_by=?, resolved_at=?, action=? WHERE id=?`, caller, t, action, id);
      // A dismissal that clears the last open report lifts the hold.
      if (action === "dismiss" && row.target_event && s.isEventHidden(row.target_event) && relay.sql.exec(`SELECT 1 FROM reports WHERE target_event=? AND status='open'`, row.target_event).toArray().length === 0) s.setEvent(row.target_event, null);
      return reply({ result: true });
    },
  },
  exportconfig: { action: "config", reads: true, run: ({ relay, s, reply }) => reply({ result: s.exportConfig(relay.slug) }) },
  importconfig: {
    action: "config",
    run: async ({ relay, s, t, role, params, reply }) => {
      // The import replaces the member list wholesale; the records say who
      // came, who went and who changed role, one delta each.
      const before = new Map(s.members().map((x) => [x.pubkey, x.role]));
      const err = s.importConfig(params[0], t);
      if (err) return reply({ error: err }, 400);
      // Imported address blocks drop the sockets they now refuse.
      for (const b of s.listIPBlocks()) relay.blockIP(b.ip, b.reason);
      const after = new Map(s.members().map((x) => [x.pubkey, x.role]));
      const changes: { pubkey: string; added?: boolean }[] = [];
      for (const [pk, role] of after) {
        if (!before.has(pk)) changes.push({ pubkey: pk, added: true });
        else if (before.get(pk) !== role) changes.push({ pubkey: pk });
      }
      for (const pk of before.keys()) if (!after.has(pk)) changes.push({ pubkey: pk, added: false });
      await relay.publishMembership(...changes);
      return reply({ result: s.exportConfig(relay.slug) });
    },
  },
  deleterelay: {
    action: "deleteRelay",
    run: async ({ relay, s, str, reply }) => {
      // The confirmation is the relay's name, typed by hand, GitHub-style.
      if (str(0) !== relay.slug) return reply({ error: "invalid: type the relay name to confirm" }, 400);
      await relay.teardown();
      return reply({ result: { deleted: true, name: relay.slug } });
    },
  },
  listblobs: {
    action: "read", reads: true,
    run: ({ relay, req, num, reply }) => {
      const host = new URL(req.url).host;
      const rows = relay.sql.exec<Blob>(`SELECT * FROM blobs ORDER BY uploaded DESC LIMIT ?`, Math.min(Math.max(num(0) || 100, 1), 500)).toArray();
      return reply({ result: rows.map((b) => ({ ...descriptor(host, b), uploader: b.uploader })) });
    },
  },
  deleteblob: {
    action: "storage",
    run: async ({ relay, str, hex64, reply }) => {
      const sha = str(0);
      if (!hex64(sha)) return reply({ error: "invalid: sha256 must be 64 hex chars" }, 400);
      await relay.deleteBlob(sha);
      return reply({ result: true });
    },
  },
  listbannedevents: { action: "read", reads: true, run: ({ s, reply }) => reply({ result: s.listEvents("ban") }) },
  deleteevent: { action: "deleteEvent", run: ({ relay, str, reply }) => reply({ result: relay.store.deleteEvent(str(0)) }) },
  listrecentevents: {
    action: "read", reads: true,
    run: ({ relay, t, num, reply }) => {
      return reply({ result: relay.store.recent(Math.min(Math.max(num(0) || 50, 1), 500), t).map((r) => JSON.parse(r)) });
    },
  },
  searchevents: {
    action: "read", reads: true,
    run: ({ relay, t, str, num, reply }) => {
      // (query, limit): the NIP-50 index, in the shape of listrecentevents.
      const q = str(0).trim().slice(0, 200);
      const limit = Math.min(Math.max(num(1) || 50, 1), 200);
      if (!q) return reply({ result: relay.store.recent(limit, t).map((r) => JSON.parse(r)) });
      return reply({ result: relay.store.query({ tags: {}, search: q, limit }, { pubkeys: [], all: true }, limit, t).rows.map((r) => JSON.parse(r)) });
    },
  },
  pinevent: { action: "deleteEvent", run: pin },
  unpinevent: { action: "deleteEvent", run: pin },
  listpins: { action: "read", reads: true, run: ({ s, reply }) => reply({ result: s.pins() }) },
  allowkind: { action: "rules", run: ruleKind },
  disallowkind: { action: "rules", run: ruleKind },
  unrulekind: { action: "rules", run: ruleKind },
  storagestats: {
    action: "storage", reads: true,
    run: ({ relay, s, reply }) => {
      const kinds = relay.store.kindStats().map((k) => ({ ...k, days: s.retentionDays(k.kind), replaceable: isReplaceable(k.kind), protected: isProtected(k.kind) }));
      const blobs = relay.sql.exec<{ n: number | null; bytes: number | null }>(`SELECT count(*) AS n, sum(size) AS bytes FROM blobs`).one();
      return reply({ result: { kinds, events: kinds.reduce((a, k) => a + k.n, 0), eventBytes: kinds.reduce((a, k) => a + k.bytes, 0), databaseBytes: relay.eventBytes(), blobs: blobs.n ?? 0, mediaBytes: blobs.bytes ?? 0, dumps: listDumps(relay.sql).length, dumpBytes: dumpBytes(relay.sql), retention: s.listRetention() } });
    },
  },
  setretention: {
    action: "rules",
    run: ({ s, params, num, reply }) => {
      // (kind | null, days): days 0 removes the rule.
      const kind = params[0] === null ? null : num(0);
      const days = num(1);
      if (kind !== null && (!Number.isInteger(kind) || kind < 0 || kind > 65535)) return reply({ error: "invalid: kind out of range" }, 400);
      if (!Number.isInteger(days) || days < 0 || days > 36500) return reply({ error: "invalid: days out of range" }, 400);
      const err = s.setRetention(kind, days);
      if (err) return reply({ error: err }, 400);
      return reply({ result: s.listRetention() });
    },
  },
  listretention: { action: "read", reads: true, run: ({ s, reply }) => reply({ result: s.listRetention() }) },
  purgekind: {
    action: "rules",
    run: ({ relay, t, params, num, reply }) => {
      // (kind | null, olderThanDays): 0 days means everything of that kind.
      const kind = params[0] === null ? null : num(0);
      const days = num(1) || 0;
      if (kind !== null && (!Number.isInteger(kind) || kind < 0 || kind > 65535)) return reply({ error: "invalid: kind out of range" }, 400);
      if (!Number.isInteger(days) || days < 0) return reply({ error: "invalid: days out of range" }, 400);
      if (kind !== null && isProtected(kind)) return reply({ error: `invalid: kind ${kind} is part of how the relay works and cannot be purged` }, 400);
      const before = days > 0 ? t - days * 86400 : Number.MAX_SAFE_INTEGER;
      const gone = kind === null ? relay.store.purge(null, before, relay.store.kindStats().map((k) => k.kind).filter((k) => isReplaceable(k) || isProtected(k)), relay.identity.pubkey) : relay.store.purge(kind, before, [], relay.identity.pubkey);
      return reply({ result: { deleted: gone } });
    },
  },
  listallowedkinds: { action: "read", reads: true, run: ({ s, reply }) => reply({ result: s.listKinds("allow") }) },
  listblockedkinds: { action: "read", reads: true, run: ({ s, reply }) => reply({ result: s.listKinds("block") }) },
  notifytest: {
    action: "identity", reads: true,
    run: async ({ relay, reply }) => {
      const sent = await notify(relay, "test", `This is a test from ${relay.slug}. Notifications work: you will hear from the relay here about the things you switched on.`, "a test from " + relay.slug);
      return reply({ result: { sent } });
    },
  },
  resetrules: {
    action: "rules",
    run: async ({ relay, s, reply }) => {
      s.resetRules();
      await relay.publishMembership();
      return reply({ result: s.policy });
    },
  },
  listpresets: {
    action: "read", reads: true,
    run: ({ reply }) => {
      return reply({ result: PRESETS.map((x) => ({ name: x.name, title: x.title, about: x.about, source: x.source, every: x.every })) });
    },
  },
  applypreset: {
    action: "rules",
    run: async ({ relay, s, params, str, reply }) => {
      // (name, {source?}): writes, reads, directory, kind rules and keep-for
      // rules in one go. A replica preset also gets a standing pull of its
      // kinds from the source; an earlier replica job is replaced.
      const preset = findPreset(str(0));
      if (!preset) return reply({ error: "invalid: no preset named " + str(0) }, 400);
      const opts = params[1] && typeof params[1] === "object" ? (params[1] as { source?: unknown }) : {};
      const source = typeof opts.source === "string" ? opts.source.trim() : "";
      if (preset.source === "required" && !source) return reply({ error: "invalid: this preset needs a source relay to mirror" }, 400);
      if (source && !preset.source) return reply({ error: "invalid: this preset does not mirror a source" }, 400);
      if (source) {
        const bad = checkPullURL(source, relay.slug, relay.domain);
        if (bad) return reply({ error: bad }, 400);
      }
      const err = applyPreset(s, preset.name);
      if (err) return reply({ error: err }, 400);
      relay.enforceReads();
      for (const j of await relay.jobs()) if (j.label === "replica") await relay.removeJob(j.id);
      let job = null;
      if (source) {
        const r = await relay.addJob({ kind: "pull", label: "replica", relays: [source], filter: { kinds: preset.allow }, every: preset.every ?? 24 });
        if (typeof r === "string") return reply({ error: r }, r.startsWith("invalid") ? 400 : 409);
        job = r;
      }
      await relay.publishMembership();
      // The read rule and the directory moved, so every view's audience may have.
      for (const v of VIEWS) await publishView(relay, v.name);
      return reply({ result: { ...s.policy, job } });
    },
  },
  forkrelay: {
    action: "fork",
    run: async ({ relay, req, caller, params, hex64, reply }) => {
      // ({name?, holder?, filter?, people?}): lease a new name reserved for
      // holder (the caller by default), copy this relay into it, hand over.
      const o = params[0] && typeof params[0] === "object" ? (params[0] as Record<string, unknown>) : {};
      const name = typeof o.name === "string" ? o.name.trim().toLowerCase() : "";
      const holder = typeof o.holder === "string" && o.holder !== "" ? o.holder : caller;
      if (!hex64(holder)) return reply({ error: "invalid: holder must be a 64 hex pubkey" }, 400);
      const f = o.filter && typeof o.filter === "object" ? (o.filter as Record<string, unknown>) : {};
      const filter: { authors?: string[]; kinds?: number[] } = {};
      if (Array.isArray(f.authors) && f.authors.length) {
        if (!f.authors.every((a) => hex64(String(a))) || f.authors.length > 50) return reply({ error: "invalid: authors must be up to fifty hex pubkeys" }, 400);
        filter.authors = [...new Set(f.authors as string[])];
      }
      if (Array.isArray(f.kinds) && f.kinds.length) {
        if (!f.kinds.every((k) => Number.isInteger(k) && (k as number) >= 0 && (k as number) <= 65535) || f.kinds.length > 50) return reply({ error: "invalid: kinds must be up to fifty integers" }, 400);
        filter.kinds = [...new Set(f.kinds as number[])];
      }
      const r = await relay.forkRelay(new URL(req.url).host, { name: name || undefined, holder, filter, people: o.people === true });
      if (typeof r === "string") return reply({ error: r }, r.startsWith("invalid") ? 400 : r.startsWith("error") ? 503 : 409);
      return reply({ result: { ...r, handover: `Your relay is ready at ${r.console}. Open it and claim it with your key before it expires; the events are copying over now.` } });
    },
  },
  pullfrom: {
    action: "jobs",
    run: async ({ relay, str, reply }) => {
      // (url): copy what another relay has that this one lacks. Runs in
      // the background; pullstatus reports on it.
      const url = str(0).trim();
      const bad = checkPullURL(url, relay.slug, relay.domain);
      if (bad) return reply({ error: bad }, 400);
      const err = await relay.pullStart(url);
      if (err) return reply({ error: err }, 409);
      return reply({ result: { started: true, url } });
    },
  },
  pullstatus: { action: "jobs", reads: true, run: async ({ relay, reply }) => reply({ result: await relay.pullStatus() }) },
  listjobs: { action: "jobs", reads: true, run: async ({ relay, reply }) => reply({ result: await relay.jobs() }) },
  addjob: {
    action: "jobs",
    run: async ({ relay, params, reply }) => {
      // ({kind, relays, filter?, every?, label?}): a pull or push, once or standing.
      const r = await relay.addJob(params[0]);
      if (typeof r === "string") return reply({ error: r }, r.startsWith("invalid") ? 400 : 409);
      return reply({ result: r });
    },
  },
  removejob: { action: "jobs", run: async ({ relay, str, reply }) => reply({ result: await relay.removeJob(str(0)) }) },
  runjob: { action: "jobs", run: async ({ relay, str, reply }) => reply({ result: await relay.runJob(str(0)) }) },
  backfill: {
    action: "jobs",
    run: async ({ relay, s, p, params, reply }) => {
      // (relays?): fetch the owner's own history from the relays in their
      // kind 10002 stored here, or from the given list.
      const given = Array.isArray(params[0]) ? (params[0] as unknown[]).filter((u): u is string => typeof u === "string" && u.trim() !== "") : [];
      const relays = given.length ? given : relaysFromList(relay, p.owner);
      if (relays.length === 0) return reply({ error: "invalid: no relay list (kind 10002) is stored here; give relays to fetch from" }, 400);
      const r = await relay.addJob({ kind: "pull", label: "backfill", relays, filter: { authors: [p.owner] }, every: 0 });
      if (typeof r === "string") return reply({ error: r }, r.startsWith("invalid") ? 400 : 409);
      return reply({ result: r });
    },
  },
  transferowner: {
    action: "transfer",
    run: async ({ relay, s, caller, str, hex64, reply }) => {
      // (pubkey): hands the relay to a member; the old owner stays as a moderator.
      const pk = str(0);
      if (!hex64(pk)) return reply({ error: "invalid: pubkey must be 64 hex chars" }, 400);
      const err = s.transferOwner(pk);
      if (err) return reply({ error: err }, 400);
      await relay.succession.seenNow();
      await relay.publishMembership({ pubkey: pk }, { pubkey: caller });
      return reply({ result: { owner: pk, previous: caller } });
    },
  },
  listdumps: { action: "storage", reads: true, run: ({ relay, reply }) => reply({ result: listDumps(relay.sql).map((d) => ({ ...d, url: "/dumps/" + d.name })) }) },
  deletedump: {
    action: "storage",
    run: async ({ relay, str, reply }) => {
      const name = str(0);
      if (!DUMP_NAME_RE.test(name)) return reply({ error: "invalid: not a dump name" }, 400);
      return reply({ result: await deleteDump(relay, name) });
    },
  },
  dumpnow: { action: "storage", run: async ({ relay, t, reply }) => reply({ result: await writeDump(relay, t) }) },
  setsuccession: {
    action: "transfer",
    run: async ({ relay, s, params, str, num, hex64, reply }) => {
      // ({heir, afterDays}) or (heir, afterDays): the heir must be a member.
      const o = params[0] && typeof params[0] === "object" ? (params[0] as Record<string, unknown>) : { heir: str(0), afterDays: num(1) };
      const heir = typeof o.heir === "string" ? o.heir : "";
      if (!hex64(heir)) return reply({ error: "invalid: heir must be a 64 hex pubkey" }, 400);
      const err = s.setSuccession(heir, Number(o.afterDays));
      if (err) return reply({ error: err }, 400);
      await relay.succession.seenNow();
      return reply({ result: await relay.succession.status() });
    },
  },
  clearsuccession: {
    action: "transfer",
    run: async ({ relay, s, reply }) => {
      s.update({ succession: null });
      await relay.succession.seenNow();
      return reply({ result: true });
    },
  },
  successionstatus: {
    action: "read", reads: true,
    run: async ({ relay, role, reply }) => {
      if (role !== "owner") return reply({ error: "restricted: only the owner and the heir may see this" }, 403);
      return reply({ result: await relay.succession.status() });
    },
  },
  changerelayname: {
    action: "identity",
    run: async ({ relay, s, str, reply }) => {
      s.update({ name: str(0).slice(0, 200) });
      await relay.publishMembership();
      return reply({ result: true });
    },
  },
  changerelaydescription: {
    action: "identity",
    run: async ({ relay, s, str, reply }) => {
      s.update({ description: str(0).slice(0, 2000) });
      await relay.publishMembership();
      return reply({ result: true });
    },
  },
  changerelayicon: {
    action: "identity",
    run: async ({ relay, s, str, reply }) => {
      s.update({ icon: str(0).slice(0, 2000) });
      await relay.publishMembership();
      return reply({ result: true });
    },
  },
  // Custom domains: the relay under a hostname the owner controls.
  adddomain: {
    action: "identity",
    run: async ({ relay, str, reply }) => {
      const r = await addDomain(relay, str(0));
      if (typeof r === "string") return reply({ error: r }, r.startsWith("error:") ? 502 : 400);
      return reply({ result: r });
    },
  },
  checkdomain: {
    action: "identity", reads: true,
    run: async ({ relay, str, reply }) => {
      const r = await checkDomain(relay, str(0));
      if (typeof r === "string") return reply({ error: r }, r.startsWith("error:") ? 502 : 400);
      return reply({ result: r });
    },
  },
  removedomain: {
    action: "identity",
    run: async ({ relay, str, reply }) => {
      const err = await removeDomain(relay, str(0));
      if (err) return reply({ error: err }, err.startsWith("error:") ? 502 : 400);
      return reply({ result: true });
    },
  },
  listdomains: {
    action: "identity", reads: true,
    run: ({ relay, reply }) => {
      const r = listDomains(relay);
      if (typeof r === "string") return reply({ error: r }, 400);
      return reply({ result: r });
    },
  },
};

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
  const m = METHODS[method];
  if (!m) return reply({ error: "unsupported: unknown method " + method }, 400);

  const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, bodyText);
  if (typeof auth === "string") return reply({ error: auth }, 401);
  const s = relay.settings;
  const p = s.policy;
  const t = now();
  const caller = auth.pubkey;

  const role = s.roleOf(caller);
  const outranks = (pk: string) => role !== "owner" && (s.isOwner(pk) || s.roleOf(pk) === "moderator");
  const str = (i: number) => (typeof params[i] === "string" ? (params[i] as string) : "");
  const num = (i: number) => (Number.isInteger(params[i]) ? (params[i] as number) : parseInt(str(i), 10));
  const hex64 = (v: string) => /^[0-9a-f]{64}$/.test(v);
  const call: Call = { relay, req, s, p, t, caller, role, method, params, str, num, hex64, reply, outranks };
  if (m.action === "open") return m.run(call);
  // The heir may read the succession status: a member, with no console otherwise.
  if (method === "successionstatus" && p.succession && p.succession.heir === caller) return reply({ result: await relay.succession.status() });
  // A plain member reaches their own invites when the owner opened the
  // invite tree (memberInvites); the invite methods keep them to their own.
  const ownInvites = role === "member" && p.memberInvites.depth > 0 && (method === "createinvite" || method === "listinvites" || method === "revokeinvite");
  if (role === "owner") void relay.succession.seen(caller);
  if (!ownInvites && !can(role, m.action)) {
    const why = role === "moderator" ? "restricted: moderators cannot do that" : p.owner !== "" ? "restricted: not the relay owner" : s.isLeased() ? "restricted: this is a temporary relay; claim it first" : "restricted: this relay is unclaimed";
    return reply({ error: why }, 403);
  }
  // Every method that changed something and answered 200 goes in the
  // moderation log with who called it (audit.ts). deleterelay took the
  // table with it.
  const resp = await m.run(call);
  if (resp.status === 200 && !m.reads && method !== "deleterelay") {
    const { target, detail } = detailOf(method, params);
    relay.audit.record(t, caller, method, target, detail);
  }
  return resp;
}
