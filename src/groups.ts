// NIP-29, one group per relay. The group id is the relay's name; events that
// carry an h tag for any other id are out of context and refused. The group's
// rules are the relay's rules: private is reads set to members, restricted
// and closed are writes not open. Membership and roles are the member list;
// the relay signs the group's metadata, admins, members and roles itself.
//
// Joins, leaves and moderation events are gated by role (roles.ts), not by
// the write policy: a join request comes from a stranger by definition, and
// a moderator moderates whatever the write rule says.
import { now, tagValues, type Event } from "./event.ts";
import { claimInvite, inviteCreator, memberInviteGate, mintInvite } from "./invites.ts";
import { type GroupFacts } from "./identity.ts";
import { can, ROLES, type Action } from "./roles.ts";
import type { Relay } from "./relay.ts";
import { KIND_PROFILE, KIND_PUT_USER, KIND_REMOVE_USER, KIND_EDIT_METADATA, KIND_DELETE_EVENT, KIND_CREATE_GROUP, KIND_DELETE_GROUP, KIND_CREATE_INVITE, KIND_PINS, KIND_JOIN, KIND_LEAVE, KIND_NIP43_JOIN, KIND_NIP43_LEAVE } from "./kinds.ts";

export const isModeration = (kind: number) => kind >= 9000 && kind <= 9020;
export const isNIP43Request = (kind: number) => kind === KIND_NIP43_JOIN || kind === KIND_NIP43_LEAVE;
export const isGroupManagement = (kind: number) => isModeration(kind) || kind === KIND_JOIN || kind === KIND_LEAVE || isNIP43Request(kind);
// The addressable state kinds only the relay writes.
export const isGroupState = (kind: number) => kind >= 39000 && kind <= 39005;

const HEX64 = /^[0-9a-f]{64}$/;

// groupFacts derives the group's NIP-29 state from the relay's settings.
export function groupFacts(relay: Relay): GroupFacts {
  const p = relay.settings.policy;
  const members = relay.settings.members();
  // The relay's profile: re-signed only when what it says would change.
  const profile = JSON.stringify({ name: p.name || relay.slug, about: p.description, ...(p.icon ? { picture: p.icon } : {}) });
  const row = relay.identity.pubkey ? relay.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE kind=? AND pubkey=? ORDER BY created_at DESC LIMIT 1`, KIND_PROFILE, relay.identity.pubkey).toArray()[0] : undefined;
  const current = row ? (JSON.parse(row.raw) as { content: string }).content : undefined;
  return {
    id: relay.slug,
    name: p.name || relay.slug,
    about: p.description,
    picture: p.icon,
    private: p.reads === "members",
    restricted: p.writes !== "open",
    closed: p.writes !== "open",
    admins: members.filter((m) => m.role !== "member").map((m) => ({ pubkey: m.pubkey, role: m.role })),
    members: p.directoryPublic ? members.map((m) => m.pubkey) : null,
    roles: ROLES,
    profile: current === profile ? null : profile,
  };
}

type Result = { ok: boolean; msg: string; stored: boolean };
const OK: Result = { ok: true, msg: "", stored: true };
const no = (msg: string): Result => ({ ok: false, msg, stored: false });

const MODERATION_NAMES: Record<number, string> = { [KIND_PUT_USER]: "put-user", [KIND_REMOVE_USER]: "remove-user", [KIND_EDIT_METADATA]: "edit-metadata", [KIND_DELETE_EVENT]: "delete-event", [KIND_CREATE_INVITE]: "create-invite", [KIND_PINS]: "update-pins" };

// handleGroupEvent applies a join, leave or moderation event that has passed
// the common gate. It does not store the event; stored: true asks the caller
// to keep and broadcast it. A moderation event that took effect goes in the
// moderation log under the kind's NIP-29 name, like the management method
// that does the same thing.
export async function handleGroupEvent(relay: Relay, e: Event): Promise<Result> {
  const r = await applyGroupEvent(relay, e);
  if (r.ok && isModeration(e.kind)) {
    const target = e.tags.find((x) => (x[0] === "p" || x[0] === "e") && HEX64.test(x[1] ?? ""))?.[1] ?? "";
    relay.audit.record(now(), e.pubkey, MODERATION_NAMES[e.kind] ?? "kind " + e.kind, target, e.kind === KIND_EDIT_METADATA || e.kind === KIND_PINS ? JSON.stringify(e.tags.filter((x) => x[0] !== "h")).slice(0, 500) : "");
  }
  return r;
}

async function applyGroupEvent(relay: Relay, e: Event): Promise<Result> {
  const s = relay.settings;
  const t = now();
  const role = s.roleOf(e.pubkey);
  const need = (action: Action) => (can(role, action) ? "" : role === "moderator" ? "restricted: moderators cannot do that" : "restricted: not a group admin");
  const pTag = e.tags.find((x) => x[0] === "p" && HEX64.test(x[1] ?? ""));
  const target = pTag?.[1] ?? "";

  switch (e.kind) {
    case KIND_JOIN: {
      if (s.isAllowed(e.pubkey)) return no("duplicate: already a member");
      const code = tagValues(e, "code")[0] ?? "";
      let via = "";
      let invitedBy = "";
      if (code) {
        const r = claimInvite(relay.sql, code, t);
        if (r === "ok") {
          via = "invite " + code.slice(0, 8);
          invitedBy = inviteCreator(relay.sql, code);
        }
        else if (s.policy.writes !== "open") {
          return no("restricted: " + { invite_invalid: "that invite code is not valid", invite_expired: "that invite has expired", invite_exhausted: "that invite has been used up" }[r]);
        }
      }
      if (!via) {
        if (s.policy.writes !== "open") return no("restricted: this group is closed; join with an invite");
        via = "join";
      }
      const err = await relay.setMember(e.pubkey, { via, invitedBy });
      return err ? no(err) : OK;
    }
    case KIND_LEAVE: {
      if (s.isOwner(e.pubkey)) return no("restricted: the owner cannot leave; transfer ownership first");
      if (!(await relay.removeMember(e.pubkey))) return no("invalid: not a member");
      return OK;
    }
    case KIND_NIP43_JOIN: {
      // Ephemeral, so never stored or fanned out: the answer is the OK.
      if (s.isAllowed(e.pubkey)) return { ok: true, msg: "duplicate: you are already a member of this relay.", stored: false };
      const claim = tagValues(e, "claim")[0] ?? "";
      if (!claim) return no("restricted: a join request needs a claim tag with an invite code.");
      const r = claimInvite(relay.sql, claim, t);
      if (r !== "ok") return no({ invite_invalid: "restricted: that is an invalid invite code.", invite_expired: "restricted: that invite code is expired.", invite_exhausted: "restricted: that invite code has been used up." }[r]);
      const err = await relay.setMember(e.pubkey, { via: "invite " + claim.slice(0, 8), invitedBy: inviteCreator(relay.sql, claim) });
      return err ? no(err) : { ok: true, msg: "info: welcome to " + relay.slug + "!", stored: false };
    }
    case KIND_NIP43_LEAVE: {
      if (s.isOwner(e.pubkey)) return no("restricted: the owner cannot leave; transfer ownership first");
      if (!(await relay.removeMember(e.pubkey))) return { ok: true, msg: "duplicate: you are not a member of this relay.", stored: false };
      return { ok: true, msg: "info: access revoked.", stored: false };
    }
    case KIND_PUT_USER: {
      const gate = need("members");
      if (gate) return no(gate);
      if (!target) return no("invalid: put-user needs a p tag");
      if (s.isOwner(target)) return no("invalid: the owner's role changes by transfer");
      const wantsModerator = (pTag as string[]).slice(2).includes("moderator");
      const cur = s.roleOf(target);
      if (cur === "moderator" && role !== "owner") return no("restricted: only the owner changes moderators");
      if (wantsModerator && role !== "owner") return no("restricted: only the owner appoints moderators");
      if (s.isBanned(target)) s.setBan(target, false);
      const err = await relay.setMember(target, { via: "put-user" });
      if (err) return no(err);
      const next = wantsModerator ? "moderator" : "member";
      if ((cur ?? "member") !== next) {
        s.setRole(target, next);
        await relay.publishMembership({ pubkey: target });
      }
      return OK;
    }
    case KIND_REMOVE_USER: {
      const gate = need("members");
      if (gate) return no(gate);
      if (!target) return no("invalid: remove-user needs a p tag");
      if (s.isOwner(target)) return no("invalid: the owner cannot be removed");
      if (s.roleOf(target) === "moderator" && role !== "owner") return no("restricted: only the owner removes moderators");
      if (!(await relay.removeMember(target))) return no("invalid: not a member");
      return OK;
    }
    case KIND_EDIT_METADATA: {
      const gate = need("identity");
      if (gate) return no(gate);
      const patch: { name?: string; description?: string; icon?: string } = {};
      const name = tagValues(e, "name")[0];
      const about = tagValues(e, "about")[0];
      const picture = tagValues(e, "picture")[0];
      if (name !== undefined) patch.name = name.slice(0, 200);
      if (about !== undefined) patch.description = about.slice(0, 2000);
      if (picture !== undefined) patch.icon = picture.slice(0, 2000);
      s.update(patch);
      await relay.publishMembership();
      return OK;
    }
    case KIND_DELETE_EVENT: {
      const gate = need("deleteEvent");
      if (gate) return no(gate);
      const ids = tagValues(e, "e").filter((id) => HEX64.test(id));
      if (!ids.length) return no("invalid: delete-event needs an e tag");
      for (const id of ids) {
        const row = relay.sql.exec<{ pubkey: string }>(`SELECT pubkey FROM events WHERE id=?`, id).toArray()[0];
        if (row && row.pubkey === relay.identity.pubkey) return no("blocked: the relay's own records cannot be deleted");
      }
      for (const id of ids) relay.store.deleteEvent(id);
      return OK;
    }
    case KIND_CREATE_INVITE: {
      // Plain members may mint too when the owner opened the invite tree.
      const gate = role === "member" ? memberInviteGate(s, relay.sql, e.pubkey, t) : need("invites");
      if (gate) return no(gate);
      const r = mintInvite(relay.sql, e.pubkey, 0, 0, e.content, t, tagValues(e, "code")[0] ?? "");
      return typeof r === "string" ? no(r) : OK;
    }
    case KIND_CREATE_GROUP:
      return no("unsupported: this relay is one group; there is nothing to create");
    case KIND_DELETE_GROUP:
      return no("unsupported: delete the relay from its page");
    case KIND_PINS: {
      // update-pin-list replaces the whole list: e tags and a tags, in order.
      const gate = need("deleteEvent");
      if (gate) return no(gate);
      const tags = pinTags(e.tags);
      if (typeof tags === "string") return no(tags);
      s.setPins(tags);
      await relay.publishPins();
      return OK;
    }
    default:
      return no("unsupported: unknown moderation kind " + e.kind);
  }
}

export const MAX_PINS = 20;
const ADDR = /^\d{1,5}:[0-9a-f]{64}:.*$/;

// pinTags keeps the e and a tags of a pin list, in order, or says why not.
export function pinTags(tags: string[][]): string[][] | string {
  const out: string[][] = [];
  for (const t of tags) {
    if (t[0] === "e" && HEX64.test(t[1] ?? "")) out.push(["e", t[1]]);
    else if (t[0] === "a" && ADDR.test(t[1] ?? "")) out.push(["a", t[1]]);
  }
  const seen = new Set<string>();
  const unique = out.filter((t) => !seen.has(t[1]) && seen.add(t[1]));
  if (unique.length > MAX_PINS) return `invalid: at most ${MAX_PINS} pins`;
  return unique;
}
