// A relay has its own nostr identity: a keypair kept in the object's storage,
// advertised as NIP-11 "self", used to sign facts only the relay can vouch
// for. Today that is the NIP-43 membership roster (kind 13534) and its
// added/removed deltas (kinds 8000/8001), all NIP-70 protected.
import { finalizeEvent, getPublicKey, generateSecretKey, type Event } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "./negentropy.ts";

export const KIND_MEMBER_ADDED = 8000;
export const KIND_MEMBER_REMOVED = 8001;
export const KIND_ROSTER = 13534;

export class Identity {
  private sk: Uint8Array | null = null;
  private lastRoster = 0;

  constructor(private storage: DurableObjectStorage) {}

  async load() {
    const hex = await this.storage.get<string>("relay-key");
    if (hex) this.sk = hexToBytes(hex);
    this.lastRoster = (await this.storage.get<number>("relay-roster-at")) ?? 0;
  }

  // ensure creates the key on first use, so unclaimed relays have none.
  async ensure(): Promise<string> {
    if (!this.sk) {
      this.sk = generateSecretKey();
      await this.storage.put("relay-key", bytesToHex(this.sk));
    }
    return this.pubkey;
  }

  get pubkey(): string {
    return this.sk ? getPublicKey(this.sk) : "";
  }

  sign(kind: number, tags: string[][], content = "", created_at = Math.floor(Date.now() / 1000)): Event {
    if (!this.sk) throw new Error("relay has no identity yet");
    return finalizeEvent({ kind, tags, content, created_at }, this.sk);
  }

  // roster timestamps are strictly increasing: two snapshots in one second
  // would tie on created_at and NIP-01's lowest-id tie-break could keep the
  // stale one.
  roster(members: { pubkey: string; role: string }[], now = Math.floor(Date.now() / 1000)): Event {
    const at = Math.max(now, this.lastRoster + 1);
    this.lastRoster = at;
    this.storage.put("relay-roster-at", at);
    return this.sign(KIND_ROSTER, [["-"], ...members.map((m) => ["member", m.pubkey, m.role])], "", at);
  }

  delta(added: boolean, pubkey: string): Event {
    return this.sign(added ? KIND_MEMBER_ADDED : KIND_MEMBER_REMOVED, [["-"], ["p", pubkey]]);
  }
}
