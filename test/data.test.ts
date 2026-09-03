// Dumps to R2.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../src/relay.ts";
import { writeDump } from "../src/dumps.ts";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) => finalizeEvent({ kind, content, tags, created_at }, sk);
const pk = (sk: Uint8Array) => getPublicKey(sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

async function get(host: string, sk: Uint8Array | null, path: string) {
  const url = `http://${host}${path}`;
  const headers: Record<string, string> = {};
  if (sk) headers.authorization = await getToken(url, "GET", (e) => finalizeEvent(e, sk), true);
  return SELF.fetch(url, { headers });
}

async function post(host: string, sk: Uint8Array, path: string, body: unknown) {
  const url = `http://${host}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json", authorization: await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, body as Record<string, unknown>) };
  const resp = await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

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

describe("dumps", () => {
  it("writes a JSONL of every event to R2, lists it, serves it to a signature, rotates and counts as media", async () => {
    const host = "dumpy.bind.ws";
    const owner = generateSecretKey();
    const writer = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    for (let i = 0; i < 3; i++) expect((await c.ok(ev(writer, 1, "note " + i))).ok).toBe(true);
    expect((await rpc(host, owner, "setpolicy", { dumps: "daily", dumpsKeep: 2 })).result.dumps).toBe("daily");

    const d = (await rpc(host, owner, "dumpnow")).result;
    expect(d.name).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const total = (await rpc(host, owner, "stats")).result.events;
    expect(d.events).toBe(total);
    expect(total).toBeGreaterThanOrEqual(3);
    const obj = await env.MEDIA.get(`dumpy/dumps/${d.name}`);
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(d.events);
    for (const l of lines) expect(JSON.parse(l).id).toMatch(/^[0-9a-f]{64}$/);
    expect(d.bytes).toBe(text.length);

    const list = (await rpc(host, owner, "listdumps")).result;
    expect(list.map((x: any) => x.name)).toEqual([d.name]);
    expect(list[0].url).toBe("/dumps/" + d.name);

    // Download needs a signature from someone with the storage action.
    const signed = await get(host, owner, "/dumps/" + d.name);
    expect(signed.status).toBe(200);
    expect(signed.headers.get("content-disposition")).toContain(d.name);
    expect(await signed.text()).toBe(text);
    expect((await get(host, null, "/dumps/" + d.name)).status).toBe(401);
    expect((await get(host, writer, "/dumps/" + d.name)).status).toBe(403);
    expect((await get(host, owner, "/dumps/nope.jsonl")).status).toBe(400);
    expect((await get(host, owner, "/dumps/1999-01-01.jsonl")).status).toBe(404);

    const stub = env.RELAY.getByName("dumpy");
    await runInDurableObject(stub, async (r: Relay) => {
      expect(r.mediaBytes()).toBe(d.bytes);
      // Two older dumps and a keep of two: the oldest goes.
      await writeDump(r, now() - 2 * 86400);
      await writeDump(r, now() - 86400);
    });
    const after = (await rpc(host, owner, "listdumps")).result.map((x: any) => x.name);
    expect(after.length).toBe(2);
    expect(after[0]).toBe(d.name);
    expect((await env.MEDIA.list({ prefix: "dumpy/dumps/" })).objects.length).toBe(2);
    expect((await rpc(host, owner, "storagestats")).result.dumps).toBe(2);

    expect((await rpc(host, owner, "deletedump", after[1])).result).toBe(true);
    expect((await env.MEDIA.list({ prefix: "dumpy/dumps/" })).objects.length).toBe(1);
    expect((await rpc(host, writer, "listdumps")).status).toBe(403);
  });

  it("the alarm writes a scheduled dump once a day, not twice", async () => {
    const host = "dumpz.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const stub = env.RELAY.getByName("dumpz");
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(0);
    await rpc(host, owner, "setpolicy", { dumps: "daily" });
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(1);
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(1);
  });
});

