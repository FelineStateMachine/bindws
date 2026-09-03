// Shared client for the black-box conformance suite. It speaks plain
// NIP-01 over a websocket to whatever relay RELAY_URL names.
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrEvent, type EventTemplate } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import { Negentropy, hexToBytes, type SyncItem } from "../../src/negentropy.ts";

export const RELAY_URL = process.env.RELAY_URL ?? "ws://127.0.0.1:7447";
export const HTTP_URL = RELAY_URL.replace(/^ws/, "http");
export const now = () => Math.floor(Date.now() / 1000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Key = Uint8Array;
export const newKey = (): Key => generateSecretKey();
export const pub = (sk: Key) => getPublicKey(sk);

export function newEvent(sk: Key, kind: number, content: string, tags: string[][] = [], created_at = now()): NostrEvent {
  return finalizeEvent({ kind, content, tags, created_at }, sk);
}

export function difficulty(id: string): number {
  let bits = 0;
  for (const ch of id) {
    const n = parseInt(ch, 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(n) - 28;
    break;
  }
  return bits;
}

export function mine(sk: Key, t: EventTemplate, bits: number): NostrEvent {
  for (let n = 0; ; n++) {
    const e = finalizeEvent({ ...t, tags: [["nonce", String(n), String(bits)]] }, sk);
    if (difficulty(e.id) >= bits) return e;
  }
}

export class Client {
  private ws!: WebSocket;
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  challenge = "";
  closed = false;

  static async connect(url = RELAY_URL): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(url);
    // Listen before open: the relay's AUTH challenge can arrive in the same tick.
    c.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const w = c.waiters.shift();
      if (w) w(msg);
      else c.queue.push(msg);
    });
    c.ws.on("close", () => {
      c.closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once("open", () => resolve());
      c.ws.once("error", reject);
    });
    // NIP-42: every connection opens with a challenge.
    const first = await c.recv();
    if (first[0] !== "AUTH") throw new Error(`expected AUTH challenge, got ${JSON.stringify(first)}`);
    c.challenge = first[1];
    return c;
  }

  send(...msg: any[]) {
    this.ws.send(JSON.stringify(msg));
  }

  recv(timeoutMs = 15_000): Promise<any[]> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const waiter = (msg: any[]) => {
        clearTimeout(t);
        resolve(msg);
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("timed out waiting for a message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async expect(type: string): Promise<any[]> {
    const m = await this.recv();
    if (m[0] !== type) throw new Error(`expected ${type}, got ${JSON.stringify(m)}`);
    return m;
  }

  async expectOK(id: string, ok: boolean): Promise<string> {
    const m = await this.expect("OK");
    if (m[1] !== id || m[2] !== ok) throw new Error(`OK mismatch: want (${id},${ok}) got ${JSON.stringify(m)}`);
    return m[3];
  }

  async expectClosed(prefix: string): Promise<void> {
    const m = await this.expect("CLOSED");
    if (!String(m[2]).startsWith(prefix)) throw new Error(`expected CLOSED ${prefix}..., got ${JSON.stringify(m)}`);
  }

  // drain reads until EOSE, returning the events seen and the EOSE hints.
  async drain(): Promise<{ events: NostrEvent[]; hints: string[] }> {
    const events: NostrEvent[] = [];
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EVENT") events.push(m[2]);
      else if (m[0] === "EOSE") return { events, hints: Array.isArray(m[2]) ? m[2] : [] };
      else throw new Error(`unexpected ${JSON.stringify(m)}`);
    }
  }

  async req(filter: Record<string, unknown>, id = "q" + Math.random().toString(36).slice(2, 8)) {
    this.send("REQ", id, filter);
    const r = await this.drain();
    this.send("CLOSE", id);
    return r;
  }

  async publish(e: NostrEvent): Promise<string> {
    this.send("EVENT", e);
    return this.expectOK(e.id, true);
  }

  async expectNothing(ms = 400) {
    try {
      const m = await this.recv(ms);
      throw new Error(`expected silence, got ${JSON.stringify(m)}`);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("timed out")) throw err;
    }
  }

  async auth(sk: Key, relay = RELAY_URL) {
    const e = newEvent(sk, 22242, "", [["relay", relay], ["challenge", this.challenge]]);
    this.send("AUTH", e);
    await this.expectOK(e.id, true);
  }

  // sync runs a full NIP-77 exchange for the filter and returns have/need.
  async sync(items: SyncItem[], filter: Record<string, unknown>, id = "s1"): Promise<{ have: string[]; need: string[] }> {
    const neg = new Negentropy(items, sha256);
    let msg: Uint8Array | null = neg.initiate();
    this.send("NEG-OPEN", id, filter, hex(msg));
    const have: string[] = [];
    const need: string[] = [];
    for (;;) {
      const m = await this.recv();
      if (m[0] === "NEG-ERR") throw new Error(`NEG-ERR ${m[2]}`);
      if (m[0] !== "NEG-MSG") throw new Error(`unexpected ${JSON.stringify(m)}`);
      const r = neg.reconcile(hexToBytes(m[2]));
      have.push(...r.have);
      need.push(...r.need);
      if (!r.reply) {
        this.send("NEG-CLOSE", id);
        return { have: have.sort(), need: need.sort() };
      }
      this.send("NEG-MSG", id, hex(r.reply));
    }
  }

  close() {
    this.ws.close();
  }
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function item(e: NostrEvent): SyncItem {
  return { timestamp: e.created_at, id: hexToBytes(e.id) };
}

export function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

// randHex returns n random lowercase hex characters.
export function randHex(n = 64): string {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
