// The NIP-11 information document: what the relay says about itself to a
// client that asks with accept: application/nostr+json. The rules, the
// limits, the policy links and lists the owner set, retention, fuel, the
// lease, succession, and the views, from the settings and the relay's state.
import type { Relay } from "./relay.ts";
import { now } from "./event.ts";
import { SUCCESSION_WARN_DAYS, featureOn, FEATURE_NAMES, type Feature } from "./settings.ts";
import { SITE_KINDS } from "./sites.ts";
import { KIND_REPO } from "./kinds.ts";
import { nip11Views } from "./views.ts";

// The less obvious numbers: 43 is added once the relay has an identity; 62
// is request-to-vanish (store.vanish); 67 is the EOSE hint array at the end
// of the subscription handler; 70 is the "-" tag check in the write gate
// (gates.ts); 66 is the discovery record the relay signs about itself
// (publishDiscovery); 77 is negentropy sync (handleSync).
export const SUPPORTED_NIPS = [1, 5, 9, 11, 13, 17, 29, 40, 42, 45, 46, 50, 56, 59, 62, 66, 67, 70, 77, 86, 98];
// The numbers a switched-off feature takes with it (settings.ts, features).
export const FEATURE_NIPS: Record<Feature, number[]> = { search: [50], sync: [77], count: [45], discovery: [66], names: [5], files: [], pages: [], signer: [46], sites: [], marmot: [], grasp: [], push: [] };

// Lettered identifiers retain their protocol spelling, never decimal values.
// New draft capabilities belong here only alongside their implementation.
export const LETTERED_NIPS: { id: string; enabled: (relay: Relay) => boolean }[] = [
  { id: "AD", enabled: () => true },
  { id: "5A", enabled: (relay) => featureOn(relay.settings.policy, "sites") },
  { id: "9a", enabled: (relay) => featureOn(relay.settings.policy, "push") },
];
export type NipIdentifier = number | string;

// supportedNips is the list as it stands with the features that are on.
export function supportedNips(relay: Relay): NipIdentifier[] {
  const off = new Set(FEATURE_NAMES.filter((f) => !featureOn(relay.settings.policy, f)).flatMap((f) => FEATURE_NIPS[f]));
  const numeric = SUPPORTED_NIPS.filter((n) => !off.has(n));
  const mixed = relay.settings.policy.letteredNips || featureOn(relay.settings.policy, "push");
  return mixed ? [...numeric, ...LETTERED_NIPS.filter((n) => n.enabled(relay)).map((n) => n.id)] : numeric;
}
export const SOFTWARE = "https://bind.ws";
export const VERSION = "0.1.0";

export function nip11(relay: Relay, host: string) {
  const p = relay.settings.policy;
  const doc: Record<string, unknown> = {
    name: p.name || relay.slug,
    description: p.description,
    supported_nips: supportedNips(relay),
    software: SOFTWARE,
    version: VERSION,
    limitation: {
      max_message_length: relay.maxMessage(),
      max_subscriptions: p.maxSubs,
      max_limit: p.maxLimit,
      default_limit: p.maxLimit,
      max_subid_length: 64,
      // True whenever a fresh socket cannot REQ: reads for the authenticated or for members.
      auth_required: p.reads !== "open",
      payment_required: false,
      restricted_writes: p.writes !== "open" || relay.settings.isUnclaimed(),
      created_at_upper_limit: p.maxFuture || undefined,
      min_pow_difficulty: p.minPow || undefined,
    },
  };
  if (p.icon) doc.icon = p.icon;
  if (p.banner) doc.banner = p.banner;
  if (p.joinTerms && host) doc.terms_of_service = relay.webURL(host) + "/terms";
  if (p.postingPolicy) doc.posting_policy = p.postingPolicy;
  if (p.privacyPolicy) doc.privacy_policy = p.privacyPolicy;
  if (p.tags.length) doc.tags = p.tags;
  if (p.languageTags.length) doc.language_tags = p.languageTags;
  if (p.relayCountries.length) doc.relay_countries = p.relayCountries;
  if (p.contact) doc.contact = p.contact;
  const retention = relay.settings.listRetention().map((r) => (r.kind === null ? { time: r.days * 86400 } : { kinds: [r.kind], time: r.days * 86400 }));
  if (retention.length) doc.retention = retention;
  if (relay.fuel.cfg.lightningAddress && relay.fuel.cfg.servicePubkey && host) {
    const f = relay.fuel.status(now(), relay.eventBytes(), relay.mediaBytes());
    (doc.limitation as Record<string, unknown>).payment_required = f.outOfFuel;
    doc.payments_url = "https://" + host + "/";
  }
  if (p.owner) doc.pubkey = p.owner;
  if (p.succession && relay.succession.warn) doc.succession_pending = new Date((relay.succession.warn.since + SUCCESSION_WARN_DAYS * 86400) * 1000).toISOString().slice(0, 10);
  if (relay.settings.isLeased() && p.lease) doc.lease = { expires_at: p.lease.until, holder: p.lease.holder || undefined, claim_url: host ? "https://" + host + "/" : undefined };
  if (featureOn(p, "grasp") && p.reads === "open") {
    doc.supported_grasps = ["GRASP-01"];
    const access = {
      open: "Anyone may announce a repository.",
      allowlist: "Allowlist hosting: only the relay owner and members may announce repositories.",
      owner: "Curated hosting: only the relay owner may announce repositories.",
      wot: "Curated hosting: the relay owner, members and people they follow may announce repositories.",
    };
    const eligibility = relay.settings.isUnclaimed() ? "Repository hosting is unavailable until this relay is claimed."
      : relay.settings.leaseExpired(now()) ? "Repository hosting is unavailable because this relay's lease has expired."
      : !relay.settings.kindAllowed(KIND_REPO) ? "Curated hosting: kind 30617 is restricted; only the relay owner's repository announcements pass the kind rule."
      : p.writes !== "open" && p.openKinds.includes(KIND_REPO) ? "Anyone may announce a repository through the guest exception for kind 30617."
      : access[p.writes];
    const guests = p.writes !== "open" && p.openKinds.length ? ` Guest write exceptions apply to kinds ${p.openKinds.join(", ")}.` : "";
    doc.repo_acceptance_criteria = `${eligibility} Repository announcements name this service in clone and relays. State and collaboration events follow the relay write rule (${p.writes}) and kind rules; bans, proof of work and fuel apply.${guests} At most 16 repositories, 4 MiB per pack, 16 MiB packed history and 128 Git transactions per unmigrated format-1 repository. Explicitly migrated format-2 repositories retain at most 128 unique packs.`;
    if (p.writes !== "open" || p.blockedWords.length) doc.curation = "The relay's configured write rule and blocked topics apply to Nostr repository and collaboration events.";
  }
  if (featureOn(p, "sites")) doc.nsites = {
    host: relay.domain,
    kinds: SITE_KINDS,
    root: "https://<npub>." + relay.domain,
    named: "https://<pubkeyB36><dTag>." + relay.domain,
    snapshot: "https://v<snapshotIdB36>." + relay.domain,
  };
  if (host) doc.self_url = relay.relayURL(host);
  if (relay.identity.pubkey) {
    doc.self = relay.identity.pubkey;
    doc.supported_nips = [...supportedNips(relay), 43];
    doc.views = nip11Views(relay);
  }
  return doc;
}
