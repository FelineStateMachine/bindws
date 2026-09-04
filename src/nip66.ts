// NIP-66 relay discovery. Monitors publish kind 30166 records about the
// relays they probe; a relay may say the same things about itself, signed
// with its own key, so a directory finds it without a probe. The d tag is
// the relay's primary URL, the tags restate what NIP-11 says, and the
// content is the NIP-11 document. Nothing here is measured, so there are
// no rtt or geohash tags: those are a monitor's to add.
import type { Relay } from "./relay.ts";
import { nip11 } from "./nip11.ts";

export interface Discovery {
  url: string;
  tags: string[][];
  content: string;
}

// relayTypes names the relay in the vocabulary of nostr-protocol/nips#1282,
// from the read and write rules. Every relay here is one NIP-29 group, so
// one that is not open on both sides is a community manager. Every relay
// has NIP-50 search.
export function relayTypes(writes: string, reads: string): string[] {
  const out: string[] = [];
  if (writes === "open" && reads === "open") out.push("PublicInbox");
  else if (writes === "owner" && reads === "open") out.push("PublicOutbox");
  else if (writes === "owner" && reads === "members") out.push("PrivateStorage");
  else out.push("CommunityManagerRelays");
  out.push("SearchRelays");
  return out;
}

// discovery builds the record's tags and content for the relay at `host`.
export function discovery(relay: Relay, host: string): Discovery {
  const p = relay.settings.policy;
  const doc = nip11(relay, host);
  const lim = (doc.limitation ?? {}) as Record<string, unknown>;
  const url = new URL(relay.relayURL(host)).toString();
  const tags: string[][] = [["-"], ["d", url], ["n", "clearnet"]];
  for (const t of relayTypes(p.writes, p.reads)) tags.push(["T", t]);
  for (const n of doc.supported_nips as number[]) tags.push(["N", String(n)]);
  const req = (key: string, on: boolean) => tags.push(["R", (on ? "" : "!") + key]);
  req("auth", lim.auth_required === true);
  req("writes", lim.restricted_writes === true);
  req("pow", typeof lim.min_pow_difficulty === "number" && lim.min_pow_difficulty > 0);
  req("payment", lim.payment_required === true);
  for (const t of p.tags) tags.push(["t", t]);
  const langs = new Set<string>();
  for (const l of p.languageTags) {
    const primary = l.split("-")[0].toLowerCase();
    if (primary.length === 2) langs.add(primary);
  }
  for (const l of langs) tags.push(["l", l, "ISO-639-1"]);
  for (const k of relay.settings.listKinds("allow")) tags.push(["k", String(k)]);
  for (const k of relay.settings.listKinds("block")) tags.push(["k", "!" + k]);
  return { url, tags, content: JSON.stringify(doc) };
}
