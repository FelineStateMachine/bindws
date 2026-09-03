// Pages, the feed, and relay-signed notifications.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { unwrapEvent } from "nostr-tools/nip59";
import * as nip19 from "nostr-tools/nip19";
import type { Relay } from "../src/relay.ts";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) => finalizeEvent({ kind, content, tags, created_at }, sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

const get = async (host: string, path: string) => {
  const r = await SELF.fetch(`http://${host}${path}`);
  return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() };
};
const info = async (host: string) => (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();

class WS {
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  challenge = "";
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
    const m = await c.expect("AUTH");
    c.challenge = m[1];
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
  // recvOr resolves null when nothing arrives within ms.
  recvOr(ms: number): Promise<any[] | null> {
    return Promise.race([this.recv(), new Promise<null>((res) => setTimeout(() => res(null), ms))]);
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
  async auth(sk: Uint8Array, host: string) {
    this.send("AUTH", ev(sk, 22242, "", [["relay", "ws://" + host], ["challenge", this.challenge]]));
    const m = await this.expect("OK");
    expect(m[2], m[3]).toBe(true);
  }
  async live(filter: unknown, id: string) {
    this.send("REQ", id, filter);
    const got: Event[] = [];
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EOSE" && m[1] === id) return got;
      if (m[0] === "EVENT") got.push(m[2]);
      else throw new Error(JSON.stringify(m));
    }
  }
}

describe("pages and feed", () => {
  it("renders notes and articles with open graph tags, hides what must stay hidden", async () => {
    const host = "site.bind.ws";
    const owner = generateSecretKey();
    const pk = getPublicKey(owner);
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { name: "Alice's place" });
    const c = await WS.connect(host);
    expect((await c.ok(ev(owner, 0, JSON.stringify({ name: "alice", display_name: "Alice" })))).ok).toBe(true);
    const note = ev(owner, 1, "Hello from my own relay\nWith a picture https://pics.example/cat.png and a link https://example.com/page.");
    expect((await c.ok(note)).ok).toBe(true);
    const article = ev(owner, 30023, "First paragraph of the essay.\n\nSecond paragraph, longer, with some thought in it.", [["d", "why-relays"], ["title", "Why relays"], ["summary", "A short case for owning one."], ["image", "https://pics.example/hero.jpg"]]);
    expect((await c.ok(article)).ok).toBe(true);
    const gone = ev(owner, 1, "to be deleted");
    expect((await c.ok(gone)).ok).toBe(true);
    expect((await c.ok(ev(owner, 5, "", [["e", gone.id]]))).ok).toBe(true);
    const dm = ev(owner, 4, "secret", [["p", getPublicKey(generateSecretKey())]]);
    expect((await c.ok(dm)).ok).toBe(true);

    let r = await get(host, `/e/${note.id}`);
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/text\/html/);
    expect(r.text).toContain('<meta property="og:title" content="Hello from my own relay">');
    expect(r.text).toContain('<meta property="og:image" content="https://pics.example/cat.png">');
    expect(r.text).toContain('<meta name="twitter:card" content="summary_large_image">');
    // The host is under the service domain, so the page addresses itself over https.
    expect(r.text).toContain(`<link rel="canonical" href="https://${host}/e/${note.id}">`);
    expect(r.text).toContain('<link rel="alternate" type="application/atom+xml"');
    expect(r.text).toContain("<b>Alice</b>");
    expect(r.text).toContain('<img src="https://pics.example/cat.png"');
    expect(r.text).toContain('<a href="https://example.com/page" rel="noopener nofollow">');
    expect(r.text).toContain("nostr:nevent1");
    expect(r.text).not.toContain("<script");

    r = await get(host, "/a/why-relays");
    expect(r.status).toBe(200);
    expect(r.text).toContain("<h1>Why relays</h1>");
    expect(r.text).toContain('<meta property="og:description" content="A short case for owning one.">');
    expect(r.text).toContain('<img class="hero" src="https://pics.example/hero.jpg"');
    expect(r.text).toContain("<p>Second paragraph, longer, with some thought in it.</p>");
    expect(r.text).toContain("nostr:naddr1");
    r = await get(host, `/a/${nip19.npubEncode(pk)}/why-relays`);
    expect(r.status).toBe(200);

    expect((await get(host, `/e/${"0".repeat(64)}`)).status).toBe(404);
    expect((await get(host, `/e/${gone.id}`)).status).toBe(404);
    expect((await get(host, `/e/${dm.id}`)).status).toBe(404);
    expect((await get(host, "/a/nope")).status).toBe(404);

    // A note that references the article links to it here.
    const ref = ev(owner, 1, "Read this: nostr:" + nip19.naddrEncode({ kind: 30023, pubkey: pk, identifier: "why-relays" }) + " by nostr:" + nip19.npubEncode(pk));
    expect((await c.ok(ref)).ok).toBe(true);
    r = await get(host, `/e/${ref.id}`);
    expect(r.text).toContain('<a href="/a/why-relays">Why relays</a>');
    expect(r.text).toContain("@Alice");

    // The feed lists both, newest first, and filters by kind.
    r = await get(host, "/feed.xml");
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/application\/atom\+xml/);
    expect(r.text.match(/<entry>/g)?.length).toBe(3);
    expect(r.text).toContain("<title>Why relays</title>");
    expect(r.text).toContain(`<link href="https://${host}/a/why-relays"/>`);
    expect(r.text).toContain("<name>Alice</name>");
    r = await get(host, "/feed.xml?kinds=30023");
    expect(r.text.match(/<entry>/g)?.length).toBe(1);
    r = await get(host, `/feed.xml?author=${"1".repeat(64)}`);
    expect(r.text).not.toContain("<entry>");

    // Members-only reads: nothing renders.
    await rpc(host, owner, "setpolicy", { reads: "members" });
    expect((await get(host, `/e/${note.id}`)).status).toBe(404);
    expect((await get(host, "/a/why-relays")).status).toBe(404);
    expect((await get(host, "/feed.xml")).status).toBe(404);
  });

  it("renders nothing on an unclaimed relay", async () => {
    expect((await get("nobody.bind.ws", "/feed.xml")).status).toBe(404);
    expect((await get("nobody.bind.ws", `/e/${"a".repeat(64)}`)).status).toBe(404);
  });
});

describe("relay-signed notifications", () => {
  it("wraps a report for the owner, who alone can read it", async () => {
    const host = "inbox.bind.ws";
    const owner = generateSecretKey();
    const ownerPk = getPublicKey(owner);
    const member = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", getPublicKey(member), {});
    expect((await rpc(host, owner, "getpolicy")).result.notify).toEqual({ reports: false, fuel: false, jobs: false, succession: false, digest: false });

    // Off by default: a report stores nothing.
    const s = await WS.connect(host);
    expect((await s.ok(ev(stranger, 1984, "spam", [["p", getPublicKey(member), "spam"]]))).ok).toBe(true);
    const o = await WS.connect(host);
    await o.auth(owner, host);
    expect(await o.live({ kinds: [1059], "#p": [ownerPk] }, "inbox")).toEqual([]);

    const set = await rpc(host, owner, "setpolicy", { notify: { reports: true } });
    expect(set.result.notify).toEqual({ reports: true, fuel: false, jobs: false, succession: false, digest: false });
    const m = await WS.connect(host);
    await m.auth(member, host);
    expect(await m.live({ kinds: [1059] }, "mine")).toEqual([]);

    expect((await s.ok(ev(stranger, 1984, "still spam", [["p", getPublicKey(member), "spam"]]))).ok).toBe(true);
    const got = await o.expect("EVENT");
    const wrap = got[2] as Event;
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toContainEqual(["p", ownerPk]);
    const rumor = unwrapEvent(wrap, owner);
    expect(rumor.kind).toBe(14);
    expect(rumor.pubkey).toBe((await info(host)).self);
    expect(rumor.content).toMatch(/report/i);
    expect(rumor.content).toContain("still spam");
    expect(rumor.tags).toContainEqual(["subject", "a report on inbox"]);
    expect(await m.recvOr(300)).toBeNull();

    // Stored: the owner can fetch it later; nobody else can see it.
    const o2 = await WS.connect(host);
    await o2.auth(owner, host);
    expect((await o2.live({ kinds: [1059] }, "again")).map((e) => e.id)).toEqual([wrap.id]);
    const anon = await WS.connect(host);
    anon.send("REQ", "anon", { kinds: [1059] });
    const closed = await anon.expect("CLOSED");
    expect(closed[2]).toMatch(/^auth-required/);

    // The test button always sends; a member may not press it.
    expect((await rpc(host, owner, "notifytest")).result).toEqual({ sent: true });
    expect((await rpc(host, member, "notifytest")).status).toBe(403);
    expect(unwrapEvent((await o.expect("EVENT"))[2] as Event, owner).content).toMatch(/test/i);

    // The catch-all keep-for rule leaves the inbox alone.
    await rpc(host, owner, "setretention", null, 1);
    await runInDurableObject(env.RELAY.getByName("inbox"), async (r: Relay) => {
      expect(r.settings.retentionDays(1059)).toBe(0);
      expect(r.settings.retentionDays(1)).toBe(1);
    });
  });

  it("says fuel is low once, then not again the same day", async () => {
    const host = "lowfuel.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { notify: { fuel: true } });
    const stub = env.RELAY.getByName("lowfuel");
    const wraps = (r: Relay) => r.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM events WHERE kind=1059`).one().n;
    await runInDurableObject(stub, async (r: Relay) => {
      await r.alarm();
      expect(wraps(r)).toBe(0);
      r.fuel.record(now(), { rowsWritten: 1_200_000 });
      expect(r.fuelStatus().outOfFuel).toBe(true);
      await r.alarm();
      expect(wraps(r)).toBe(1);
      await r.alarm();
      expect(wraps(r)).toBe(1);
    });
    const o = await WS.connect(host);
    await o.auth(owner, host);
    const [wrap] = await o.live({ kinds: [1059] }, "fuel");
    expect(unwrapEvent(wrap, owner).content).toMatch(/out of fuel/);
  });
});
