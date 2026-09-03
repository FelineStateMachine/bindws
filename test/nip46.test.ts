// NIP-46 transport: kind 24133 passes the ownership and write gates and a
// subscription to it alone passes the read gate, so the relay can carry a
// remote signer's session for anyone, including someone about to claim it.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = []) => finalizeEvent({ kind, content, tags, created_at: now() }, sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
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
  // open subscribes and returns "" on EOSE or the CLOSED reason.
  async open(id: string, ...filters: unknown[]): Promise<string> {
    this.send("REQ", id, ...filters);
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EOSE" && m[1] === id) return "";
      if (m[0] === "CLOSED" && m[1] === id) return m[2];
      if (m[0] !== "EVENT") throw new Error(JSON.stringify(m));
    }
  }
}

describe("NIP-46 transport", () => {
  it("carries kind 24133 on an unclaimed relay, live only, never stored", async () => {
    const host = "phone.bind.ws";
    const signerKey = generateSecretKey();
    const client = generateSecretKey();
    const listener = await WS.connect(host);
    expect(await listener.open("nc", { kinds: [24133], "#p": [getPublicKey(signerKey)] })).toBe("");

    const sender = await WS.connect(host);
    const req = ev(client, 24133, "ciphertext", [["p", getPublicKey(signerKey)]]);
    expect(await sender.ok(req)).toEqual({ ok: true, msg: "" });
    const got = await listener.expect("EVENT");
    expect(got[1]).toBe("nc");
    expect(got[2].id).toBe(req.id);
    // Anything else is still refused while unclaimed, and the request left no trace.
    expect((await sender.ok(ev(client, 1, "hello"))).msg).toMatch(/unclaimed/);
    const later = await WS.connect(host);
    expect(await later.open("q", { kinds: [24133] })).toBe("");
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.pubkey).toBeUndefined();
  });

  it("passes the write policy but not bans", async () => {
    const host = "locked.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "owner" });
    const stranger = generateSecretKey();
    const c = await WS.connect(host);
    expect((await c.ok(ev(stranger, 1, "no"))).msg).toMatch(/only the relay owner/);
    expect((await c.ok(ev(stranger, 24133, "x", [["p", getPublicKey(owner)]]))).ok).toBe(true);
    await rpc(host, owner, "banpubkey", getPublicKey(stranger), "spam");
    const d = await WS.connect(host);
    expect((await d.ok(ev(stranger, 24133, "x", [["p", getPublicKey(owner)]]))).msg).toMatch(/banned/);
    expect((await rpc(host, owner, "stats")).result.kinds.map((k: { kind: number }) => k.kind)).not.toContain(24133);
  });

  it("serves a subscription to 24133 alone under members-only reads, and nothing wider", async () => {
    const host = "private.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { reads: "members" });
    const c = await WS.connect(host);
    expect(await c.open("a", { kinds: [24133] })).toBe("");
    expect(await c.open("b", { kinds: [24133], "#p": ["ab".repeat(32)] }, { kinds: [24133] })).toBe("");
    expect(await c.open("c", { kinds: [24133, 1] })).toMatch(/^auth-required/);
    expect(await c.open("d", { kinds: [24133] }, { kinds: [1] })).toMatch(/^auth-required/);
    expect(await c.open("e", {})).toMatch(/^auth-required/);
  });

});
