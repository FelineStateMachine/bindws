// Rules an evaluator asked for: the socket message cap per relay, blocked
// words that reach into tags and take a regular expression, and address
// blocks that travel with the exported configuration.
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

const info = async (host: string) => (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();

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
  static async connect(host: string, ip = "198.51.100.7"): Promise<WS | null> {
    const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket", "cf-connecting-ip": ip } });
    if (!resp.webSocket) return null;
    const c = new WS(resp.webSocket);
    await c.expect("AUTH");
    return c;
  }
  send(...m: unknown[]) {
    this.ws.send(JSON.stringify(m));
  }
  raw(s: string) {
    this.ws.send(s);
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

describe("message size", () => {
  it("is the owner's rule, clamped, and NIP-11 says so", async () => {
    const host = "msgsize.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await info(host)).limitation.max_message_length).toBe(128 * 1024);

    // Below the floor and above the ceiling both clamp.
    expect((await rpc(host, owner, "setpolicy", { maxMessageKB: 1 })).result.maxMessageKB).toBe(16);
    expect((await rpc(host, owner, "setpolicy", { maxMessageKB: 5000 })).result.maxMessageKB).toBe(1024);
    expect((await rpc(host, owner, "setpolicy", { maxMessageKB: 16 })).result.maxMessageKB).toBe(16);
    expect((await info(host)).limitation.max_message_length).toBe(16 * 1024);

    const ws = (await WS.connect(host))!;
    // A note of 20 KB is over the 16 KB cap: refused with a NOTICE, not stored.
    const big = ev(owner, 1, "x".repeat(20 * 1024));
    ws.raw(JSON.stringify(["EVENT", big]));
    const notice = await ws.expect("NOTICE");
    expect(notice[1]).toBe("error: message too large");
    // A small one still lands.
    expect((await ws.ok(ev(owner, 1, "small"))).ok).toBe(true);

    // Raising the cap lets the same note through.
    await rpc(host, owner, "setpolicy", { maxMessageKB: 64 });
    expect((await ws.ok(big)).ok).toBe(true);
  });
});

describe("blocked words", () => {
  it("takes /patterns/, refuses a bad one with the reason, and reaches into tags on request", async () => {
    const host = "words.bind.ws";
    const owner = generateSecretKey();
    const guest = generateSecretKey();
    await rpc(host, owner, "claim");

    // A pattern that does not compile fails the call; nothing is saved.
    const bad = await rpc(host, owner, "setblockedwords", ["spam", "/(unclosed/"]);
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/^invalid: /);
    expect((await rpc(host, owner, "getpolicy")).result.blockedWords).toEqual([]);
    const long = await rpc(host, owner, "setblockedwords", ["/" + "a".repeat(200) + "/"]);
    expect(long.status).toBe(400);
    expect(long.error).toMatch(/longer than 200/);

    // Plain words are lowercased; a pattern keeps its case and is compiled case-insensitive.
    const kept = (await rpc(host, owner, "setblockedwords", ["Casino", "/free\\s+money/", "/\\bwin\\d{3,}/"])).result;
    expect(kept).toEqual(["casino", "/free\\s+money/", "/\\bwin\\d{3,}/"]);

    const ws = (await WS.connect(host))!;
    expect((await ws.ok(ev(guest, 1, "FREE   MONEY here"))).msg).toBe("blocked: content contains a blocked word");
    expect((await ws.ok(ev(guest, 1, "you Win1234 now"))).msg).toBe("blocked: content contains a blocked word");
    expect((await ws.ok(ev(guest, 1, "winner takes all"))).ok).toBe(true);
    expect((await ws.ok(ev(guest, 1, "a night at the CASINO"))).ok).toBe(false);
    // The owner says what they like.
    expect((await ws.ok(ev(owner, 1, "free money"))).ok).toBe(true);

    // Tags are not searched until the switch is on.
    expect((await ws.ok(ev(guest, 1, "look", [["t", "casino"]]))).ok).toBe(true);
    expect((await rpc(host, owner, "setpolicy", { blockedWordsInTags: true })).result.blockedWordsInTags).toBe(true);
    const tagged = await ws.ok(ev(guest, 1, "look again", [["t", "Casino"]]));
    expect(tagged.ok).toBe(false);
    expect(tagged.msg).toBe("blocked: a tag contains a blocked word");
    expect((await ws.ok(ev(guest, 1, "pattern in a tag", [["r", "https://x.example/free money"]]))).ok).toBe(false);
    // The tag name itself is not a value.
    expect((await ws.ok(ev(guest, 1, "fine", [["casino", "x"]]))).ok).toBe(true);
    await rpc(host, owner, "setpolicy", { blockedWordsInTags: false });
    expect((await ws.ok(ev(guest, 1, "look once more", [["t", "casino"]]))).ok).toBe(true);
  });
});
