// NIP-86 gaps: the moderation list over the reports queue, address blocks
// from the connecting address, and the per-address rate limit that stops a
// swarm of sockets from multiplying a connection's allowance.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";

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

// post signs a NIP-98 request to a bridge path from a given address.
async function post(host: string, sk: Uint8Array, path: string, body: unknown, ip: string) {
  const url = `http://${host}${path}`;
  const authorization = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, body as Record<string, unknown>);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization, "cf-connecting-ip": ip }, body: JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, body: text ? JSON.parse(text) : null };
}

class WS {
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
    });
  }
  // connect opens a socket from an address; null when the relay refused the upgrade.
  static async connect(host: string, ip: string): Promise<WS | null> {
    const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket", "cf-connecting-ip": ip } });
    if (!resp.webSocket) return null;
    const c = new WS(resp.webSocket);
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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("listeventsneedingmoderation", () => {
  it("lists open reports by reported thing, deduplicated, for owner and moderator only", async () => {
    const host = "modqueue.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    const author = generateSecretKey();
    const reporter = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(member), {});
    const c = (await WS.connect(host, "10.9.0.1"))!;
    const note = ev(author, 1, "buy my coin");
    expect((await c.ok(note)).ok).toBe(true);
    // Two reports on the note, one on the author alone.
    expect((await c.ok(ev(reporter, 1984, "junk", [["e", note.id, "spam"], ["p", pk(author)]]))).ok).toBe(true);
    expect((await c.ok(ev(member, 1984, "", [["e", note.id, "spam"], ["p", pk(author)]]))).ok).toBe(true);
    expect((await c.ok(ev(reporter, 1984, "bot", [["p", pk(author), "impersonation"]]))).ok).toBe(true);

    const list = await rpc(host, owner, "listeventsneedingmoderation");
    expect(list.status).toBe(200);
    expect(list.result).toEqual([{ id: note.id, reason: "spam: junk" }]);
    expect((await rpc(host, mod, "listeventsneedingmoderation")).result).toEqual([{ id: note.id, reason: "spam: junk" }]);
    expect((await rpc(host, member, "listeventsneedingmoderation")).status).toBe(403);
    expect((await rpc(host, owner, "supportedmethods")).result).toEqual(expect.arrayContaining(["listeventsneedingmoderation", "blockip", "unblockip", "listblockedips"]));

    // Resolving the reports empties the list.
    const reports = (await rpc(host, owner, "listreports")).result as { id: string }[];
    for (const r of reports) await rpc(host, owner, "resolvereport", r.id, "dismiss");
    expect((await rpc(host, owner, "listeventsneedingmoderation")).result).toEqual([]);
  });
});

describe("address blocks", () => {
  it("refuses the socket and the doors, drops open sockets, and can be undone", async () => {
    const host = "blocks.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    const bad = "203.0.113.5";
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(member), {});

    const open = (await WS.connect(host, bad))!;
    expect((await open.ok(ev(member, 1, "before"))).ok).toBe(true);
    expect((await rpc(host, member, "blockip", bad, "scraper")).status).toBe(403);
    expect((await rpc(host, mod, "blockip", "not an address", "x")).status).toBe(400);
    expect((await rpc(host, mod, "blockip", bad, "scraper")).result).toBe(true);
    expect((await rpc(host, owner, "listblockedips")).result).toEqual([{ ip: bad, reason: "scraper" }]);

    for (let i = 0; i < 40 && !open.closed; i++) await sleep(25);
    expect(open.closed?.code).toBe(4403);
    expect(await WS.connect(host, bad)).toBeNull();
    const refused = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket", "cf-connecting-ip": bad } });
    expect(refused.status).toBe(403);
    const door = await post(host, member, "/events", ev(member, 1, "still here?"), bad);
    expect(door.status).toBe(403);
    expect(door.body.error).toMatch(/^blocked: this address/);
    expect((await post(host, member, "/count", [{ kinds: [1] }], bad)).status).toBe(403);
    // Another address is unaffected, and so is management from the blocked one.
    expect((await post(host, member, "/events", ev(member, 1, "elsewhere"), "203.0.113.6")).status).toBe(200);
    expect(await WS.connect(host, "203.0.113.6")).not.toBeNull();
    expect((await rpc(host, owner, "stats")).status).toBe(200);
    // Blocks are not part of the portable configuration.
    expect((await rpc(host, owner, "exportconfig")).result.blocked_ips).toBeUndefined();

    expect((await rpc(host, owner, "unblockip", bad)).result).toBe(true);
    expect((await rpc(host, owner, "listblockedips")).result).toEqual([]);
    const again = await WS.connect(host, bad);
    expect(again).not.toBeNull();
    expect((await again!.ok(ev(member, 1, "back"))).ok).toBe(true);
  });

  it("accepts IPv6 and rejects ranges and names", async () => {
    const host = "blocks6.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await rpc(host, owner, "blockip", "2001:DB8::1", "")).result).toBe(true);
    expect((await rpc(host, owner, "listblockedips")).result).toEqual([{ ip: "2001:db8::1", reason: "" }]);
    expect(await WS.connect(host, "2001:db8::1")).toBeNull();
    for (const bad of ["10.0.0.0/8", "relay.example", "1.2.3", "::::", "999.1.1.1"]) expect((await rpc(host, owner, "blockip", bad, "")).status).toBe(400);
  });
});

describe("per-address rate limit", () => {
  it("caps all sockets from one address at four times a connection's allowance", async () => {
    const host = "swarm.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { eventsPerMinute: 5 });
    const ip = "198.51.100.7";
    const socks: WS[] = [];
    for (let i = 0; i < 6; i++) socks.push((await WS.connect(host, ip))!);
    // Four per socket stays under the per-connection five; the address
    // allowance is twenty, so the twenty-first event across them is refused.
    let accepted = 0;
    let refused = "";
    for (const c of socks) {
      for (let j = 0; j < 4 && !refused; j++) {
        const r = await c.ok(ev(owner, 1, `n${accepted}`));
        if (r.ok) accepted++;
        else refused = r.msg;
      }
    }
    expect(accepted).toBe(20);
    expect(refused).toMatch(/^rate-limited:/);
    // A lone socket from elsewhere is only bound by its own bucket.
    const alone = (await WS.connect(host, "198.51.100.8"))!;
    for (let j = 0; j < 4; j++) expect((await alone.ok(ev(owner, 1, `alone${j}`))).ok).toBe(true);
  });

  it("is the bridge's rate limit too", async () => {
    const host = "bridgelimit.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { reqsPerMinute: 1 });
    const ip = "198.51.100.9";
    for (let i = 0; i < 4; i++) expect((await post(host, owner, "/count", [{ kinds: [1] }], ip)).status).toBe(200);
    const fifth = await post(host, owner, "/count", [{ kinds: [1] }], ip);
    expect(fifth.status).toBe(429);
    expect(fifth.body.error).toMatch(/^rate-limited:/);
    expect((await post(host, owner, "/count", [{ kinds: [1] }], "198.51.100.10")).status).toBe(200);
  });
});
