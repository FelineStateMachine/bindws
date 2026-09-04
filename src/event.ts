// Event validation and helpers, mirroring event.go.
import { verifyEvent, type Event } from "nostr-tools/pure";

export type { Event };

export const isEphemeral = (k: number) => k >= 20000 && k < 30000;
export const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
export const isAddressable = (k: number) => k >= 30000 && k < 40000;
// Only served to the parties involved: NIP-04 DMs and NIP-59 gift wraps per
// NIP-17, and NIP-46 signer traffic, which is ephemeral and addressed by p.
export const isPrivate = (k: number) => k === 4 || k === 1059 || k === 21059 || k === 24133;

export const now = () => Math.floor(Date.now() / 1000);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

// validate returns "" when the event is well formed and signed, else the
// NIP-01 reason ("invalid: ...").
export function validate(e: unknown): string {
  const ev = e as Event;
  if (!ev || typeof ev !== "object") return "invalid: not an object";
  if (typeof ev.id !== "string" || !HEX64.test(ev.id)) return "invalid: bad id";
  if (typeof ev.pubkey !== "string" || !HEX64.test(ev.pubkey)) return "invalid: bad pubkey";
  if (typeof ev.sig !== "string" || !HEX128.test(ev.sig)) return "invalid: bad sig";
  if (!Number.isInteger(ev.kind) || ev.kind < 0 || ev.kind > 65535) return "invalid: kind out of range";
  if (!Number.isInteger(ev.created_at) || ev.created_at < 0) return "invalid: bad created_at";
  if (typeof ev.content !== "string") return "invalid: content must be a string";
  if (!Array.isArray(ev.tags)) return "invalid: tags must be a list";
  for (const t of ev.tags) {
    if (!Array.isArray(t) || t.length === 0 || t.some((x) => typeof x !== "string")) return "invalid: bad tag";
  }
  if (!verifyEvent(ev)) return "invalid: id or signature does not match content";
  return "";
}

// canonical re-serializes an event with a fixed key order and nothing else,
// so storage and fan-out use one exact form.
export function canonical(e: Event): string {
  return JSON.stringify({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
}

export function tag(e: Event, name: string): string {
  for (const t of e.tags) if (t[0] === name) return t[1] ?? "";
  return "";
}

export function hasTag(e: Event, name: string): boolean {
  return e.tags.some((t) => t[0] === name);
}

export function tagValues(e: Event, name: string): string[] {
  return e.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1]);
}

// expiration is the NIP-40 timestamp, or 0.
export function expiration(e: Event): number {
  const n = parseInt(tag(e, "expiration"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// difficulty is the NIP-13 leading zero bits of the id; target is the
// committed difficulty from the nonce tag (0 if absent).
export function difficulty(e: Event): { difficulty: number; target: number } {
  let bits = 0;
  for (const ch of e.id) {
    const n = parseInt(ch, 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(n) - 28;
    break;
  }
  let target = 0;
  for (const t of e.tags) {
    if (t[0] === "nonce" && t.length > 2) {
      target = parseInt(t[2], 10) || 0;
      break;
    }
  }
  return { difficulty: bits, target };
}
