// A relay has its own nostr identity: a keypair kept in the object's storage,
// advertised as NIP-11 "self", used to sign facts only the relay can vouch
// for: the NIP-43 membership roster (kind 13534) and its added/removed
// deltas (kinds 8000/8001), the NIP-29 put-user and remove-user records
// (9000/9001) and the group's metadata, admins, members and roles
// (39000-39003). All NIP-70 protected.
import { finalizeEvent, getPublicKey, generateSecretKey, type Event } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "./negentropy.ts";

export const KIND_MEMBER_ADDED = 8000;
export const KIND_MEMBER_REMOVED = 8001;
export const KIND_ROSTER = 13534;
export const KIND_PUT_USER = 9000;
export const KIND_REMOVE_USER = 9001;
export const KIND_GROUP_METADATA = 39000;
export const KIND_GROUP_ADMINS = 39001;
export const KIND_GROUP_MEMBERS = 39002;
export const KIND_GROUP_ROLES = 39003;

export interface GroupFacts {
  id: string;
  name: string;
  about: string;
  picture: string;
  private: boolean; // members-only reads
  restricted: boolean; // members-only writes
  closed: boolean; // join requests need an invite
  admins: { pubkey: string; role: string }[];
  members: string[] | null; // null: not published
  roles: { role: string; about: string }[];
}

export class Identity {
  private sk: Uint8Array | null = null;
  private lastRoster = 0;
  private lastGroup = 0;

  constructor(private storage: DurableObjectStorage) {}

  async load() {
    const hex = await this.storage.get<string>("relay-key");
    if (hex) this.sk = hexToBytes(hex);
    this.lastRoster = (await this.storage.get<number>("relay-roster-at")) ?? 0;
    this.lastGroup = (await this.storage.get<number>("relay-group-at")) ?? 0;
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

  // NIP-29 records of a membership change, signed by the relay as the
  // group's authority. roles are the ones the person holds now.
  putUser(group: string, pubkey: string, roles: string[]): Event {
    return this.sign(KIND_PUT_USER, [["-"], ["h", group], ["p", pubkey, ...roles]]);
  }
  removeUser(group: string, pubkey: string): Event {
    return this.sign(KIND_REMOVE_USER, [["-"], ["h", group], ["p", pubkey]]);
  }

  // group signs the addressable NIP-29 state: metadata, admins, members
  // (when published) and roles. Same strictly increasing clock as the roster,
  // so a newer set always replaces an older one.
  group(f: GroupFacts, now = Math.floor(Date.now() / 1000)): Event[] {
    const at = Math.max(now, this.lastGroup + 1);
    this.lastGroup = at;
    this.storage.put("relay-group-at", at);
    const d = ["d", f.id];
    const meta: string[][] = [["-"], d, ["name", f.name], ["about", f.about]];
    if (f.picture) meta.push(["picture", f.picture]);
    if (f.private) meta.push(["private"]);
    if (f.restricted) meta.push(["restricted"]);
    if (f.closed) meta.push(["closed"]);
    const out = [
      this.sign(KIND_GROUP_METADATA, meta, "", at),
      this.sign(KIND_GROUP_ADMINS, [["-"], d, ...f.admins.map((a) => ["p", a.pubkey, a.role])], "", at),
      this.sign(KIND_GROUP_ROLES, [["-"], d, ...f.roles.map((r) => ["role", r.role, r.about])], "", at),
    ];
    if (f.members) out.push(this.sign(KIND_GROUP_MEMBERS, [["-"], d, ...f.members.map((p) => ["p", p])], "", at));
    return out;
  }
}
