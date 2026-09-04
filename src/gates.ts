// The two gates every client passes. The write gate is what a published
// event must clear whoever sends it: shape, bans, blocked words, the
// relay's state, fuel, the one-group rule. The read gate is what a
// subscription's filters must clear for the socket that opened it: the
// read rule, and the private kinds only their parties may see. Both answer
// "" to let through, or the reason in NIP-01's prefix: form.
import type { Relay, ConnState } from "./relay.ts";
import { expiration, hasTag, isPrivate, tagValues, type Event } from "./event.ts";
import type { Filter } from "./filter.ts";
import { KIND_AUTH, KIND_NOSTR_CONNECT } from "./kinds.ts";
import { isGroupState } from "./groups.ts";
import { featureOn } from "./settings.ts";

// writeGate is what every write must pass, whoever sends it: shape, bans, the
// relay's state, fuel, and the one-group rule. "" lets it through.
export function writeGate(relay: Relay, e: Event, conn: ConnState | null, t: number): string {
  const p = relay.settings.policy;
  if (e.kind === KIND_AUTH) return "blocked: kind 22242 is only accepted inside an AUTH message";
  if (p.maxFuture > 0 && e.created_at > t + p.maxFuture) return "invalid: event creation date is too far off from the current time";
  const exp = expiration(e);
  if (exp > 0 && exp <= t) return "invalid: event has already expired";
  if (relay.settings.isBanned(e.pubkey)) return "blocked: this pubkey is banned from this relay";
  if (relay.settings.isEventBanned(e.id)) return "blocked: this event is banned from this relay";
  // Blocked words: the owner and moderators may say anything, nobody else may say these.
  const where = relay.settings.hasBlockedWord(e.content, e.tags);
  if (where) {
    const role = relay.settings.roleOf(e.pubkey);
    if (role !== "owner" && role !== "moderator") return where === "tags" ? "blocked: a tag contains a blocked word" : "blocked: content contains a blocked word";
  }
  // NIP-46 traffic passes the ownership, fuel and write gates: it is
  // ephemeral, never stored, and readable only by its two parties, and
  // letting it through means this relay can carry a remote signer's
  // session, even for the person about to claim it from a phone. Bans
  // and the per-connection rate limit still apply.
  if (e.kind === KIND_NOSTR_CONNECT && featureOn(p, "signer")) return "";
  const h = tagValues(e, "h")[0];
  if (h !== undefined && h !== relay.slug) return "blocked: this relay hosts one group: " + relay.slug;
  if (conn) {
    if (isGroupState(e.kind)) return "blocked: group metadata is written by the relay";
    if (relay.settings.isUnclaimed()) return "restricted: this relay is unclaimed; open https://" + conn.host + "/ to claim it";
    if (relay.settings.leaseExpired(t)) return "restricted: this temporary relay has expired";
    const f = relay.fuelStatus();
    if (f.outOfFuel) {
      return f.enabled ? "restricted: this relay is out of fuel; zap it at https://" + conn.host + "/ to top up" : "restricted: this relay has reached its storage or traffic limit";
    }
    if (hasTag(e, "-") && !conn.authed.includes(e.pubkey)) return "auth-required: this event may only be published by its author";
  }
  return "";
}

// guestPass lets a stranger through a limited write rule: a kind the owner
// opened to anyone, or, when replies are open, a note or comment that
// answers something a member or the owner wrote here.
export function guestPass(relay: Relay, e: Event): boolean {
  const p = relay.settings.policy;
  if (p.openKinds.includes(e.kind)) return true;
  if (!p.guestReplies || (e.kind !== 1 && e.kind !== 1111)) return false;
  const parents = [...tagValues(e, "e"), ...tagValues(e, "E")].filter((id) => /^[0-9a-f]{64}$/.test(id)).slice(0, 5);
  for (const id of parents) {
    const row = relay.sql.exec<{ pubkey: string }>(`SELECT pubkey FROM events WHERE id=?`, id).toArray()[0];
    if (row && relay.settings.isAllowed(row.pubkey)) return true;
  }
  return false;
}

// readGate returns a CLOSED reason, or "" plus whether an EOSE "auth"
// hint applies because private kinds were silently filtered out.
export function readGate(relay: Relay, s: ConnState, filters: Filter[]): { reason: string; authHint: boolean } {
  // A subscription to NIP-46 traffic alone may be opened under any read
  // policy, with or without AUTH; the traffic itself is a private kind,
  // delivered only to its parties (canSee).
  const p = relay.settings.policy;
  if (!featureOn(p, "search") && filters.some((f) => f.search !== undefined)) return { reason: "unsupported: search is switched off on this relay", authHint: false };
  if (featureOn(p, "signer") && filters.length > 0 && filters.every((f) => f.kinds?.length === 1 && f.kinds[0] === KIND_NOSTR_CONNECT)) return { reason: "", authHint: false };
  const authed = s.authed.length > 0;
  const gate = relay.settings.mayRead(s.authed);
  if (gate) return { reason: gate, authHint: false };
  if (authed) return { reason: "", authHint: false };
  let authHint = false;
  for (const f of filters) {
    if (!f.kinds || f.kinds.length === 0) {
      authHint = true;
      continue;
    }
    const priv = f.kinds.filter(isPrivate).length;
    if (priv === f.kinds.length) return { reason: "auth-required: private kinds are only served to their recipients", authHint: false };
    if (priv > 0) authHint = true;
  }
  return { reason: "", authHint };
}
