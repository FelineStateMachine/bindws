// Marmot's relay-facing events: exact transport shapes that a relay can
// check without understanding MLS, and the admission identity for opaque
// group envelopes.
import type { ConnState, Relay } from "./relay.ts";
import { KIND_MARMOT_GROUP, KIND_MARMOT_KEY_PACKAGE } from "./kinds.ts";
import { featureOn } from "./settings.ts";
import type { Event } from "./event.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^0x[0-9a-f]{4}$/;
const LIST_TAGS = ["mls_ciphersuite", "mls_extensions", "mls_proposals", "app_components"];

const singleton = (e: Event, name: string, test: (v: string) => boolean): boolean => {
  const tags = e.tags.filter((t) => t[0] === name);
  return tags.length === 1 && tags[0].length === 2 && test(tags[0][1]);
};

const idList = (e: Event, name: string): boolean => {
  const tags = e.tags.filter((t) => t[0] === name);
  if (tags.length !== 1 || tags[0].length < 2) return false;
  const values = tags[0].slice(1);
  return values.every((v) => ID.test(v)) && new Set(values).size === values.length;
};

const base64 = (value: string): boolean => {
  if (value === "" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  try {
    return atob(value).length > 0;
  } catch {
    return false;
  }
};

const decodedBytes = (value: string): number => {
  try {
    return atob(value).length;
  } catch {
    return 0;
  }
};

// marmotShape checks only the signed envelope and transport tags. MLS bytes
// stay opaque here, so clients remain responsible for decoding and verifying
// the KeyPackage or group message inside the base64 content.
export const marmotShape = (e: Event): string => {
  if (e.kind === KIND_MARMOT_GROUP) {
    if (!singleton(e, "h", (v) => HEX64.test(v))) return "invalid: kind 445 needs one lowercase 32-byte h tag";
    if (!base64(e.content) || decodedBytes(e.content) < 28) return "invalid: kind 445 content must be base64 containing a nonce and authentication tag";
    if (e.tags.some((t) => t[0] !== "h" && !(t[0] === "expiration" && t.length === 2 && /^\d+$/.test(t[1])))) return "invalid: kind 445 has an unsupported tag";
    if (e.tags.filter((t) => t[0] === "expiration").length > 1) return "invalid: kind 445 has repeated expiration";
    return "";
  }
  if (e.kind !== KIND_MARMOT_KEY_PACKAGE) return "";
  if (!singleton(e, "d", (v) => HEX64.test(v)) || !singleton(e, "mls_protocol_version", (v) => v === "1.0") || !singleton(e, "i", (v) => /^[0-9a-f]+$/.test(v))) return "invalid: kind 30443 has a malformed singleton tag";
  if (LIST_TAGS.some((name) => !idList(e, name))) return "invalid: kind 30443 has a malformed id-list tag";
  if (!e.tags.some((t) => t[0] === "app_components" && t.slice(1).includes("0x8009"))) return "invalid: kind 30443 must advertise account identity proof";
  if (!base64(e.content)) return "invalid: kind 30443 content must be padded base64";
  const allowed = new Set(["d", "mls_protocol_version", "i", ...LIST_TAGS]);
  if (e.tags.some((t) => !allowed.has(t[0]))) return "invalid: kind 30443 has an unsupported tag";
  return "";
};

// marmotPrincipal returns the authenticated account whose policy and member
// limits apply to an opaque group envelope. An open relay may accept one
// without a principal, because the ephemeral author cannot identify an account.
export const marmotPrincipal = (relay: Relay, e: Event, conn: ConnState | null): string => {
  if (e.kind !== KIND_MARMOT_GROUP) return e.pubkey;
  if (relay.settings.policy.writes === "open") return conn?.authed[0] ?? e.pubkey;
  return conn?.authed.find((pk) => relay.settings.mayWrite(pk) === "") ?? "";
};

export const isMarmotEvent = (e: Event): boolean => e.kind === KIND_MARMOT_GROUP || e.kind === KIND_MARMOT_KEY_PACKAGE;

export const marmotEnabled = (relay: Relay): boolean => featureOn(relay.settings.policy, "marmot");
