// Temporary leases: a memorable name anyone can use for a while, a claim
// that converts it in place, and an expiry that wipes it.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Relay } from "../src/relay.ts";
import { bytesToHex } from "../src/negentropy.ts";
import { ADJECTIVES, ANIMALS } from "../src/names.ts";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) => finalizeEvent({ kind, content, tags, created_at }, sk);
const APEX = "http://bind.ws";

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

// Each caller gets its own address so the per-address limit is tested on its own.
let callers = 0;
async function lease(sk: Uint8Array | null = null, ip = "10.0.0." + ++callers) {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (sk) headers.authorization = await getToken(APEX + "/lease", "POST", (e) => finalizeEvent(e, sk), true);
  const resp = await SELF.fetch(APEX + "/lease", { method: "POST", headers });
  return { status: resp.status, ...(await resp.json<any>()) };
}

const info = async (host: string) => (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();

class WS {
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
  }
  static async connect(host: string) {
    const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket" } });
    const c = new WS(resp.webSocket!);
    await c.expect("AUTH");
    return c;
  }
  send(...m: unknown[]) {
    this.ws.send(JSON.stringify(m));
  }
  recv(): Promise<any[]> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((res) => this.waiters.push(res));
  }
  async expect(type: string) {
    const m = await this.recv();
    expect(m[0], JSON.stringify(m)).toBe(type);
    return m;
  }
  async ok(e: Event) {
    this.send("EVENT", e);
    const m = await this.expect("OK");
    return { ok: m[2] as boolean, msg: m[3] as string };
  }
  private n = 0;
  async req(filter: unknown) {
    const id = "q" + ++this.n;
    this.send("REQ", id, filter);
    const events: Event[] = [];
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EVENT" && m[1] === id) events.push(m[2]);
      else if (m[0] === "EOSE" && m[1] === id) {
        this.send("CLOSE", id);
        return events;
      } else if (m[0] === "CLOSED" && m[1] === id) throw new Error(m[2]);
    }
  }
}

async function upload(host: string, sk: Uint8Array, text: string) {
  const body = new TextEncoder().encode(text);
  const sha = bytesToHex(sha256(body));
  const token = "Nostr " + btoa(JSON.stringify(ev(sk, 24242, "upload", [["t", "upload"], ["x", sha], ["expiration", String(now() + 300)]])));
  const resp = await SELF.fetch(`http://${host}/upload`, { method: "PUT", headers: { authorization: token, "content-type": "text/plain" }, body });
  return { status: resp.status, sha };
}

describe("temporary leases", () => {
  it("hands out a memorable name that anyone can write to, and a claim converts it in place", async () => {
    const l = await lease();
    expect(l.status).toBe(201);
    const [adj, animal] = l.name.split("-");
    if (animal) expect(ADJECTIVES.includes(adj) && ANIMALS.includes(animal)).toBe(true);
    else expect(/^[a-z]+\d\d$/.test(l.name) && ANIMALS.includes(l.name.slice(0, -2))).toBe(true);
    expect(l.url).toBe(`wss://${l.name}.bind.ws`);
    expect(l.holder).toBeUndefined();
    expect(l.expires_at).toBeGreaterThan(now() + 13 * 86400);
    const host = `${l.name}.bind.ws`;

    let doc = await info(host);
    expect(doc.lease.expires_at).toBe(l.expires_at);
    expect(doc.lease.claim_url).toBe(`https://${host}/`);
    expect(doc.limitation.restricted_writes).toBe(false);
    expect(doc.pubkey).toBeUndefined();
    expect(doc.description).toMatch(/Temporary relay/);
    expect(doc.retention).toEqual([{ time: 14 * 86400 }]);

    const stranger = generateSecretKey();
    const c = await WS.connect(host);
    expect((await c.ok(ev(stranger, 1, "hello from a lease"))).ok).toBe(true);
    const denied = await rpc(host, stranger, "stats");
    expect(denied.status).toBe(403);
    expect(denied.error).toMatch(/temporary relay/);

    const owner = generateSecretKey();
    const claimed = await rpc(host, owner, "claim");
    expect(claimed.result).toEqual({ owner: getPublicKey(owner), claimed: true, converted: true });
    doc = await info(host);
    expect(doc.lease).toBeUndefined();
    expect(doc.pubkey).toBe(getPublicKey(owner));
    expect(doc.description).toBe("");
    expect(doc.self).toBeDefined();
    // The events stay; the lease's keep-for rule stays until the owner resets.
    expect((await c.req({ kinds: [1] })).length).toBe(1);
    expect((await rpc(host, owner, "listretention")).result).toEqual([{ kind: null, days: 14 }]);
    const reset = await rpc(host, owner, "resetrules");
    expect(reset.result.writes).toBe("open");
    expect((await rpc(host, owner, "listretention")).result).toEqual([]);
    expect((await rpc(host, owner, "claim")).result.converted).toBeUndefined();
  });

  it("a signed lease is reserved for its key", async () => {
    const holder = generateSecretKey();
    const l = await lease(holder);
    expect(l.status).toBe(201);
    expect(l.holder).toBe(getPublicKey(holder));
    const host = `${l.name}.bind.ws`;
    expect((await info(host)).lease.holder).toBe(getPublicKey(holder));
    const other = generateSecretKey();
    const denied = await rpc(host, other, "claim");
    expect(denied.status).toBe(403);
    expect(denied.error).toMatch(/reserved/);
    expect((await rpc(host, holder, "claim")).result.claimed).toBe(true);
  });

  it("caps leases per address", async () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < 5; i++) expect((await lease(null, ip)).status).toBe(201);
    const sixth = await lease(null, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.error).toMatch(/^rate-limited/);
    expect((await lease(null, "203.0.113.8")).status).toBe(201);
  });

  it("refuses a bad signature on the lease request", async () => {
    const sk = generateSecretKey();
    const token = await getToken("http://elsewhere.bind.ws/lease", "POST", (e) => finalizeEvent(e, sk), true);
    const resp = await SELF.fetch(APEX + "/lease", { method: "POST", headers: { authorization: token, "cf-connecting-ip": "10.1.1.1" } });
    expect(resp.status).toBe(401);
  });

  it("expires: the alarm wipes everything and frees the name", async () => {
    const l = await lease();
    const host = `${l.name}.bind.ws`;
    const sk = generateSecretKey();
    const c = await WS.connect(host);
    expect((await c.ok(ev(sk, 1, "soon gone"))).ok).toBe(true);
    expect((await upload(host, sk, "a file on a lease")).status).toBe(200);
    const stub = env.RELAY.getByName(l.name);
    await runInDurableObject(stub, async (r: Relay, state) => {
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(l.expires_at * 1000);
      r.settings.update({ lease: { until: now() - 1, holder: "" } });
      await r.alarm();
    });
    const doc = await info(host);
    expect(doc.lease).toBeUndefined();
    expect(doc.pubkey).toBeUndefined();
    expect(doc.limitation.restricted_writes).toBe(true);
    expect((await env.MEDIA.list({ prefix: `${l.name}/` })).objects).toEqual([]);
    const fresh = await WS.connect(host);
    expect(await fresh.req({ kinds: [1] })).toEqual([]);
    expect((await fresh.ok(ev(sk, 1, "again"))).msg).toMatch(/unclaimed/);
    // The freed name can be leased again.
    await runInDurableObject(stub, async (r: Relay) => expect(await r.lease(l.name, host, now() + 60, "")).toBe(""));
    expect((await info(host)).lease).toBeDefined();
  });

  it("an expired lease refuses writes even before the alarm runs", async () => {
    const l = await lease();
    const host = `${l.name}.bind.ws`;
    await runInDurableObject(env.RELAY.getByName(l.name), async (r: Relay) => r.settings.update({ lease: { until: now() - 1, holder: "" } }));
    const c = await WS.connect(host);
    expect((await c.ok(ev(generateSecretKey(), 1, "too late"))).msg).toMatch(/expired/);
    expect((await rpc(host, generateSecretKey(), "claim")).status).toBe(403);
  });
});

