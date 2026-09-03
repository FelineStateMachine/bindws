// The "learned from Buzz" set: HTTP bridge, invites, NIP-05, relay identity
// and NIP-43 roster, members-only reads and eviction, Blossom media, rate
// limits, and the NIP-56 moderation queue.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Relay } from "../src/relay.ts";
import { bytesToHex } from "../src/negentropy.ts";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) => finalizeEvent({ kind, content, tags, created_at }, sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

// post signs a NIP-98 request to any path with a raw JSON body.
async function post(host: string, sk: Uint8Array | null, path: string, body: unknown) {
  const url = `http://${host}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sk) headers.authorization = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, body as Record<string, unknown>);
  const resp = await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, body: text ? JSON.parse(text) : null };
}

class WS {
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  challenge = "";
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
  static async connect(host: string) {
    const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket" } });
    const c = new WS(resp.webSocket!);
    c.challenge = (await c.expect("AUTH"))[1];
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
  async auth(sk: Uint8Array, host: string) {
    this.send("AUTH", ev(sk, 22242, "", [["relay", "ws://" + host], ["challenge", this.challenge]]));
    const m = await this.expect("OK");
    expect(m[2], m[3]).toBe(true);
  }
  // live opens a subscription that stays open, draining stored results first.
  async live(filter: unknown, id: string) {
    this.send("REQ", id, filter);
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EOSE" && m[1] === id) return;
      if (m[0] !== "EVENT") throw new Error(JSON.stringify(m));
    }
  }

  private n = 0;
  // req is a one-shot query: unique id, closed after EOSE so it never leaks
  // live pushes into a later query.
  async req(filter: unknown, id = "q" + ++this.n) {
    this.send("REQ", id, filter);
    const events: Event[] = [];
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EVENT" && m[1] === id) events.push(m[2]);
      else if (m[0] === "EOSE" && m[1] === id) {
        this.send("CLOSE", id);
        return { events, closed: "" };
      } else if (m[0] === "CLOSED" && m[1] === id) return { events, closed: m[2] as string };
      else if (m[0] === "EVENT" || m[0] === "CLOSED") this.queue.push(m);
      else throw new Error(JSON.stringify(m));
    }
  }
}

describe("HTTP bridge", () => {
  it("accepts events, answers queries and counts with NIP-98, applying the same gates", async () => {
    const host = "bridge.bind.ws";
    const owner = generateSecretKey();
    const other = generateSecretKey();
    await rpc(host, owner, "claim");
    const e = ev(owner, 1, "over http");
    let r = await post(host, owner, "/events", e);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ event_id: e.id, accepted: true, message: "" });
    r = await post(host, owner, "/events", e);
    expect(r.body.accepted).toBe(true);
    expect(r.body.message).toMatch(/^duplicate:/);

    r = await post(host, other, "/query", [{ kinds: [1], authors: [getPublicKey(owner)] }]);
    expect(r.status).toBe(200);
    expect(r.body.map((x: Event) => x.id)).toEqual([e.id]);
    r = await post(host, other, "/count", [{ kinds: [1] }]);
    expect(r.body.count).toBe(1);

    // Unsigned, wrong-URL, and non-JSON requests are refused cleanly.
    expect((await post(host, null, "/query", [{}])).status).toBe(401);
    const badUrlToken = await getToken("http://elsewhere.bind.ws/query", "POST", (x) => finalizeEvent(x, other), true, [{}] as any);
    const bad = await SELF.fetch(`http://${host}/query`, { method: "POST", headers: { authorization: badUrlToken }, body: "[{}]" });
    expect(bad.status).toBe(401);

    // A subscriber on the socket sees bridge writes live.
    const c = await WS.connect(host);
    await c.live({ kinds: [1] }, "live");
    const e2 = ev(owner, 1, "pushed");
    await post(host, owner, "/events", e2);
    expect((await c.expect("EVENT"))[2].id).toBe(e2.id);

    // Private kinds via the bridge follow the recipient rule; the signer counts as authenticated.
    const recipient = generateSecretKey();
    const wrap = ev(generateSecretKey(), 1059, "dm", [["p", getPublicKey(recipient)]]);
    await post(host, owner, "/events", wrap);
    r = await post(host, other, "/query", [{ kinds: [1059] }]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]); // authenticated but not a party: silently filtered
    expect((await post(host, null, "/query", [{ kinds: [1059] }])).status).toBe(401);
    r = await post(host, recipient, "/query", [{ kinds: [1059] }]);
    expect(r.body.map((x: Event) => x.id)).toEqual([wrap.id]);
  });
});

describe("invites", () => {
  it("lets the owner mint links that non-members can claim, with expiry and use limits", async () => {
    const host = "invite.bind.ws";
    const owner = generateSecretKey();
    const guest = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist", joinTerms: "Be kind." });
    expect((await rpc(host, guest, "createinvite")).status).toBe(403);
    const inv = (await rpc(host, owner, "createinvite", 3600, 1, "for guest")).result;
    expect(inv.code).toMatch(/^[0-9a-f]{32}$/);
    expect(inv.max_uses).toBe(1);

    // The page renders the terms for a valid code and a problem for a bad one.
    let page = await (await SELF.fetch(`http://${host}/invite/${inv.code}`)).text();
    expect(page).toContain("Be kind.");
    expect(page).toContain("Join with extension");
    page = await (await SELF.fetch(`http://${host}/invite/nope`)).text();
    expect(page).toContain("isn't valid");

    // Before joining: writes refused. After: accepted, and the roster changed.
    const c = await WS.connect(host);
    expect((await c.ok(ev(guest, 1, "hi"))).msg).toMatch(/^restricted:/);
    let r = await post(host, guest, "/api/invites/claim", { code: inv.code });
    expect(r.body).toEqual({ status: "joined", role: "member" });
    expect((await c.ok(ev(guest, 1, "hi again"))).ok).toBe(true);
    r = await post(host, guest, "/api/invites/claim", { code: inv.code });
    expect(r.body.status).toBe("already_member");
    r = await post(host, generateSecretKey(), "/api/invites/claim", { code: inv.code });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("invite_exhausted");
    expect((await post(host, generateSecretKey(), "/api/invites/claim", { code: "bogus" })).body.error).toBe("invite_invalid");
    const list = (await rpc(host, owner, "listinvites")).result;
    expect(list[0].uses).toBe(1);
    expect((await rpc(host, owner, "revokeinvite", inv.code)).result).toBe(true);
    expect((await rpc(host, owner, "listinvites")).result).toEqual([]);
    const members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.find((m: any) => m.pubkey === getPublicKey(guest)).via).toMatch(/^invite /);
  });
});

describe("NIP-05", () => {
  it("serves members' names for the relay's own host, claimed via kind 0 or assigned by the owner", async () => {
    const host = "names.bind.ws";
    const owner = generateSecretKey();
    const alice = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "allowpubkey", getPublicKey(alice));
    const c = await WS.connect(host);
    await c.ok(ev(alice, 0, JSON.stringify({ name: "alice", nip05: "Alice@names.bind.ws" })));
    await c.ok(ev(stranger, 0, JSON.stringify({ name: "mallory", nip05: "alice@names.bind.ws" }))); // not a member: ignored
    await c.ok(ev(owner, 0, JSON.stringify({ nip05: "owner@elsewhere.example" }))); // other domain: ignored
    let doc: any = await (await SELF.fetch(`http://${host}/.well-known/nostr.json?name=alice`)).json();
    expect(doc.names).toEqual({ alice: getPublicKey(alice) });
    expect(doc.relays[getPublicKey(alice)]).toEqual(["wss://" + host]);
    doc = await (await SELF.fetch(`http://${host}/.well-known/nostr.json?name=nobody`)).json();
    expect(doc.names).toEqual({});
    // Owner assigns and removes names; a taken name can't be claimed by another member.
    expect((await rpc(host, owner, "setmember", getPublicKey(owner), { name: "_" })).result.name).toBe("_");
    expect((await rpc(host, owner, "setmember", getPublicKey(owner), { name: "bad name!" })).status).toBe(400);
    doc = await (await SELF.fetch(`http://${host}/.well-known/nostr.json`)).json();
    expect(Object.keys(doc.names).sort()).toEqual(["_", "alice"]);
    // Assigning a taken name to someone else moves it; clearing frees it.
    expect((await rpc(host, owner, "setmember", getPublicKey(stranger), { name: "alice" })).result.name).toBe("alice");
    expect((await rpc(host, owner, "listmembers")).result.members.find((m: any) => m.pubkey === getPublicKey(alice)).name).toBeNull();
    expect((await rpc(host, owner, "setmember", getPublicKey(stranger), { name: "" })).result.name).toBeNull();
    // The public directory lists people with their names; the owner can hide it.
    let people: any = await (await SELF.fetch(`http://${host}/people`)).json();
    expect(people.people.map((m: any) => m.role)).toEqual(["owner", "member", "member"]);
    expect(people.people[0].name).toBe("_");
    await rpc(host, owner, "setpolicy", { directoryPublic: false });
    people = await (await SELF.fetch(`http://${host}/people`)).json();
    expect(people.people).toEqual([]);
  });
});

describe("relay identity and NIP-43 roster", () => {
  it("signs a roster after claiming and deltas on membership changes, advertised as self", async () => {
    const host = "roster.bind.ws";
    const owner = generateSecretKey();
    const bob = generateSecretKey();
    let info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.self).toBeUndefined();
    await rpc(host, owner, "claim");
    info = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.self).toMatch(/^[0-9a-f]{64}$/);
    expect(info.supported_nips).toContain(43);
    const c = await WS.connect(host);
    c.send("REQ", "live", { kinds: [8000, 8001] });
    await c.expect("EOSE");
    let r = await c.req({ kinds: [13534] });
    expect(r.events.length).toBe(1);
    expect(r.events[0].pubkey).toBe(info.self);
    expect(r.events[0].tags).toEqual([["-"], ["member", getPublicKey(owner), "owner"]]);

    await rpc(host, owner, "allowpubkey", getPublicKey(bob), "friend");
    const added = await c.expect("EVENT");
    expect(added[2].kind).toBe(8000);
    expect(added[2].tags).toContainEqual(["p", getPublicKey(bob)]);
    r = await c.req({ kinds: [13534] });
    expect(r.events[0].tags).toContainEqual(["member", getPublicKey(bob), "member"]);
    await rpc(host, owner, "unrulepubkey", getPublicKey(bob));
    expect((await c.expect("EVENT"))[2].kind).toBe(8001);
    // Nobody can forge relay-signed kinds: a client-signed 13534 is just another replaceable event by another author.
    const forged = await c.ok(ev(bob, 13534, "", [["member", getPublicKey(bob), "owner"]]));
    expect(forged.ok).toBe(true);
    r = await c.req({ kinds: [13534], authors: [info.self] });
    expect(r.events.map((x) => [x.pubkey, x.tags]), JSON.stringify(r.events)).toEqual([[info.self, [["-"], ["member", getPublicKey(owner), "owner"]]]]);
  });
});

describe("members-only reads and eviction", () => {
  it("serves only members when reads=members, and closes the door on bans and removals", async () => {
    const host = "closed.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "allowpubkey", getPublicKey(member));
    await rpc(host, owner, "setpolicy", { reads: "members" });
    const s = await WS.connect(host);
    expect((await s.req({ kinds: [1] })).closed).toMatch(/^auth-required:/);
    await s.auth(stranger, host);
    expect((await s.req({ kinds: [1] })).closed).toMatch(/^restricted: .*members/);
    const m = await WS.connect(host);
    await m.auth(member, host);
    expect((await m.req({ kinds: [1] })).closed).toBe("");
    m.send("REQ", "live", { kinds: [1] });
    await m.expect("EOSE");

    // Removal ends every subscription with a reason; the socket stays.
    await rpc(host, owner, "unrulepubkey", getPublicKey(member));
    const closed = await m.expect("CLOSED");
    expect(closed[1]).toBe("live");
    expect(closed[2]).toMatch(/^restricted:/);
    expect(m.closed).toBeNull();

    // A ban closes the socket outright.
    const b = await WS.connect(host);
    await b.auth(stranger, host);
    await rpc(host, owner, "banpubkey", getPublicKey(stranger), "bye");
    for (let i = 0; i < 20 && !b.closed; i++) await new Promise((r) => setTimeout(r, 50));
    expect(b.closed?.code).toBe(4403);
  });
});

describe("rate limits", () => {
  it("throttles a chatty connection with a retry hint", async () => {
    const host = "limits.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { eventsPerMinute: 2, reqsPerMinute: 2 });
    const c = await WS.connect(host);
    expect((await c.ok(ev(owner, 1, "a"))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "b"))).ok).toBe(true);
    const third = await c.ok(ev(owner, 1, "c"));
    expect(third.ok).toBe(false);
    expect(third.msg).toMatch(/^rate-limited: quota exceeded; retry in \d+s$/);
    await c.req({ kinds: [1] }, "r1");
    await c.req({ kinds: [1] }, "r2");
    expect((await c.req({ kinds: [1] }, "r3")).closed).toMatch(/^rate-limited:/);
  });
});

describe("moderation queue", () => {
  it("files NIP-56 reports for the owner and resolves them with ban, delete or dismiss", async () => {
    const host = "mods.bind.ws";
    const owner = generateSecretKey();
    const troll = generateSecretKey();
    const reporter = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const bad = ev(troll, 1, "something awful");
    await c.ok(bad);
    const report = ev(reporter, 1984, "please look", [["e", bad.id, "spam"], ["p", getPublicKey(troll)]]);
    expect((await c.ok(report)).msg).toBe("info: report received");
    expect((await c.req({ kinds: [1984] })).events).toEqual([]); // never served
    let q = (await rpc(host, owner, "listreports")).result;
    expect(q.length).toBe(1);
    expect(q[0]).toMatchObject({ id: report.id, target_event: bad.id, target_pubkey: getPublicKey(troll), type: "spam", status: "open" });
    expect((await rpc(host, owner, "resolvereport", report.id, "ban")).result).toBe(true);
    expect((await c.req({ ids: [bad.id] })).events).toEqual([]);
    expect((await c.ok(ev(troll, 1, "back"))).msg).toMatch(/^blocked:/);
    expect((await rpc(host, owner, "listreports")).result).toEqual([]);
    expect((await rpc(host, owner, "listreports", "resolved")).result[0].action).toBe("ban");
  });
});

describe("Blossom media", () => {
  const blossomToken = (sk: Uint8Array, action: string, sha: string) =>
    "Nostr " + btoa(JSON.stringify(ev(sk, 24242, action, [["t", action], ["x", sha], ["expiration", String(now() + 300)]])));

  it("stores, serves, lists and deletes blobs under the relay's write policy, counting them as storage", async () => {
    const host = "media.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist", maxBlobMB: 1 });
    await rpc(host, owner, "allowpubkey", getPublicKey(member));
    const body = new TextEncoder().encode("hello blossom " + host);
    const sha = bytesToHex(sha256(body));

    const put = (sk: Uint8Array, data: Uint8Array, shaTag = sha, type = "text/plain") =>
      SELF.fetch(`http://${host}/upload`, { method: "PUT", headers: { authorization: blossomToken(sk, "upload", shaTag), "content-type": type }, body: data });
    expect((await put(stranger, body)).status).toBe(403);
    expect((await SELF.fetch(`http://${host}/upload`, { method: "PUT", body })).status).toBe(401);
    expect((await put(member, body, "00".repeat(32))).status).toBe(400);
    let resp = await put(member, body);
    expect(resp.status).toBe(200);
    const desc: any = await resp.json();
    expect(desc).toMatchObject({ sha256: sha, size: body.length, type: "text/plain", url: `https://${host}/${sha}.txt` });
    expect((await put(member, new Uint8Array(1024 * 1024 + 1), "ff".repeat(32))).status).toBe(413);

    resp = await SELF.fetch(`http://${host}/${sha}.txt`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/plain");
    expect(await resp.text()).toBe("hello blossom " + host);
    resp = await SELF.fetch(`http://${host}/${sha}`, { method: "HEAD" });
    expect(resp.headers.get("content-length")).toBe(String(body.length));
    resp = await SELF.fetch(`http://${host}/${sha}`, { headers: { range: "bytes=0-4" } });
    expect(resp.status).toBe(206);
    expect(await resp.text()).toBe("hello");
    expect((await SELF.fetch(`http://${host}/${"ab".repeat(32)}`)).status).toBe(404);

    const list: any = await (await SELF.fetch(`http://${host}/list/${getPublicKey(member)}`)).json();
    expect(list.map((b: any) => b.sha256)).toEqual([sha]);
    const stub = env.RELAY.getByName("media");
    await runInDurableObject(stub, async (r: Relay) => expect(r.mediaBytes()).toBeGreaterThan(0));

    const del = (sk: Uint8Array) => SELF.fetch(`http://${host}/${sha}`, { method: "DELETE", headers: { authorization: blossomToken(sk, "delete", sha) } });
    expect((await del(stranger)).status).toBe(403);
    expect((await del(member)).status).toBe(204);
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(404);
    expect((await rpc(host, owner, "listblobs")).result).toEqual([]);
  });
});

describe("members migration", () => {
  it("folds the earlier allow list and names table into members on load", async () => {
    const stub = env.RELAY.getByName("legacy");
    const owner = generateSecretKey();
    const a = getPublicKey(generateSecretKey());
    const b = getPublicKey(generateSecretKey());
    await runInDurableObject(stub, async (r: Relay) => {
      r.settings.update({ owner: getPublicKey(owner) });
      r.sql.exec(`INSERT INTO pubkey_rules(pubkey,rule,reason,at) VALUES(?,'allow','old friend',1000)`, a);
      r.sql.exec(`INSERT INTO nip05(name,pubkey,at) VALUES('bob',?,2000)`, b);
      r.sql.exec(`INSERT INTO nip05(name,pubkey,at) VALUES('alice',?,3000)`, a);
      r.settings.load();
      const m = r.settings.members();
      expect(m.map((x) => [x.role, x.name, x.via])).toEqual([["owner", null, "claimed"], ["member", "alice", "added"], ["member", "bob", "profile"]]);
      expect(r.settings.isAllowed(a) && r.settings.isAllowed(b)).toBe(true);
      expect(r.sql.exec(`SELECT count(*) AS n FROM pubkey_rules`).one().n).toBe(0);
      r.settings.load(); // idempotent
      expect(r.settings.members().length).toBe(3);
    });
  });
});

describe("teardown", () => {
  it("requires the typed name, then wipes everything and returns the name to unclaimed", async () => {
    const host = "gone.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", getPublicKey(member), { name: "bob" });
    const c = await WS.connect(host);
    await c.ok(ev(owner, 1, "to be deleted"));
    await c.live({ kinds: [1] }, "live");
    const body = new TextEncoder().encode("bytes");
    const sha = bytesToHex(sha256(body));
    const token = "Nostr " + btoa(JSON.stringify(ev(owner, 24242, "upload", [["t", "upload"], ["x", sha], ["expiration", String(now() + 300)]])));
    expect((await SELF.fetch(`http://${host}/upload`, { method: "PUT", headers: { authorization: token, "content-type": "text/plain" }, body })).status).toBe(200);

    expect((await rpc(host, member, "deleterelay", "gone")).status).toBe(403);
    const wrong = await rpc(host, owner, "deleterelay", "typo");
    expect(wrong.status).toBe(400);
    expect((await rpc(host, owner, "stats")).result.events).toBeGreaterThan(0);

    expect((await rpc(host, owner, "deleterelay", "gone")).result).toEqual({ deleted: true, name: "gone" });
    for (let i = 0; i < 20 && !c.closed; i++) await new Promise((r) => setTimeout(r, 50));
    expect(c.closed?.code).toBe(4410);
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.pubkey).toBeUndefined();
    expect(info.self).toBeUndefined();
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(404);
    expect((await env.MEDIA.list({ prefix: "gone/" })).objects).toEqual([]);
    const fresh = await WS.connect(host);
    expect((await fresh.req({ kinds: [1] })).events).toEqual([]);
    expect((await fresh.ok(ev(owner, 1, "again"))).msg).toMatch(/unclaimed/);
    const doc: any = await (await SELF.fetch(`http://${host}/.well-known/nostr.json?name=bob`)).json();
    expect(doc.names).toEqual({});
    // Anyone can claim the name again, including someone else.
    const other = generateSecretKey();
    expect((await rpc(host, other, "claim")).result.claimed).toBe(true);
  });
});

describe("configuration export and import", () => {
  it("round-trips policy, members, bans and kinds between relays without touching data or owner", async () => {
    const a = "cfg-a.bind.ws", b = "cfg-b.bind.ws";
    const ownerA = generateSecretKey(), ownerB = generateSecretKey();
    const m1 = getPublicKey(generateSecretKey()), bad = getPublicKey(generateSecretKey());
    await rpc(a, ownerA, "claim");
    await rpc(a, ownerA, "setpolicy", { writes: "allowlist", reads: "members", name: "Club", joinTerms: "be kind", minPow: 3, directoryPublic: false });
    await rpc(a, ownerA, "setmember", m1, { name: "alice", note: "friend" });
    await rpc(a, ownerA, "banpubkey", bad, "spam");
    await rpc(a, ownerA, "allowkind", 1);
    await rpc(a, ownerA, "disallowkind", 7);
    const cfg = (await rpc(a, ownerA, "exportconfig")).result;
    expect(cfg.format).toBe("bind.ws/relay-config/1");
    expect(cfg.policy.owner).toBeUndefined();
    expect(cfg.members).toEqual([{ pubkey: m1, name: "alice", note: "friend" }]);
    expect(cfg.bans).toEqual([{ pubkey: bad, reason: "spam" }]);
    expect(cfg.kinds).toEqual({ allow: [1], block: [7] });

    await rpc(b, ownerB, "claim");
    const c = await WS.connect(b);
    await c.ok(ev(ownerB, 1, "keep me"));
    expect((await rpc(b, ownerB, "importconfig", { format: "nope" })).status).toBe(400);
    const after = (await rpc(b, ownerB, "importconfig", cfg)).result;
    expect(after.members).toEqual(cfg.members);
    expect(after.bans).toEqual(cfg.bans);
    expect(after.kinds).toEqual(cfg.kinds);
    const p = (await rpc(b, ownerB, "getpolicy")).result;
    expect([p.writes, p.reads, p.name, p.joinTerms, p.minPow, p.directoryPublic, p.owner]).toEqual(["allowlist", "members", "Club", "be kind", 3, false, getPublicKey(ownerB)]);
    expect((await rpc(b, ownerB, "stats")).result.events).toBeGreaterThan(0);
    const doc: any = await (await SELF.fetch(`http://${b}/.well-known/nostr.json?name=alice`)).json();
    expect(doc.names).toEqual({ alice: m1 });
    // The roster on b now carries the imported member.
    const rc = await WS.connect(b);
    await rc.auth(ownerB, b);
    const r = await rc.req({ kinds: [13534] });
    expect(r.events[0].tags).toContainEqual(["member", m1, "member"]);
  });
});

describe("storage: retention and purge", () => {
  it("refuses events past a keep-for rule, sheds old ones daily, spares replaceable kinds from the catch-all, and purges on demand", async () => {
    const host = "keep.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const day = 86400;
    // Before any rule: an old reaction, an old note, an old profile all land.
    expect((await c.ok(ev(owner, 7, "+", [], now() - 40 * day))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "old note", [], now() - 40 * day))).ok).toBe(true);
    expect((await c.ok(ev(owner, 0, '{"name":"old me"}', [], now() - 400 * day))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "fresh note"))).ok).toBe(true);

    // Reactions kept 30 days, everything else 100 days.
    expect((await rpc(host, owner, "setretention", 7, 30)).result).toEqual([{ kind: 7, days: 30 }]);
    await rpc(host, owner, "setretention", null, 100);
    expect((await c.ok(ev(owner, 7, "+", [], now() - 31 * day))).msg).toMatch(/^blocked: this relay keeps kind 7 for 30 days/);
    expect((await c.ok(ev(owner, 7, "+", [], now() - 29 * day))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "too old", [], now() - 101 * day))).msg).toMatch(/keeps kind 1 for 100 days/);
    // The catch-all spares replaceable kinds: a very old profile still lands.
    expect((await c.ok(ev(owner, 0, '{"name":"newer old me"}', [], now() - 300 * day))).ok).toBe(true);
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.retention).toEqual([{ kinds: [7], time: 30 * day }, { time: 100 * day }]);

    // The daily sweep sheds the 40-day-old reaction and keeps the 40-day-old note (under 100).
    const stub = env.RELAY.getByName("keep");
    await runInDurableObject(stub, async (r: Relay) => expect(r.sweepRetention(now())).toBe(1));
    let st = (await rpc(host, owner, "storagestats")).result;
    const byKind = Object.fromEntries(st.kinds.map((k: any) => [k.kind, k.n]));
    expect(byKind).toEqual({ 1: 2, 7: 1, 0: 1, 13534: 1, 39000: 1, 39001: 1, 39002: 1, 39003: 1 }); // the roster and group state are the relay's own
    expect(st.events).toBe(9);
    expect(st.eventBytes).toBeGreaterThan(0);
    expect(st.retention).toEqual([{ kind: 7, days: 30 }, { kind: null, days: 100 }]);

    // Purge notes older than 10 days, then everything of kind 7.
    expect((await rpc(host, owner, "purgekind", 1, 10)).result).toEqual({ deleted: 1 });
    expect((await rpc(host, owner, "purgekind", 7, 0)).result).toEqual({ deleted: 1 });
    st = (await rpc(host, owner, "storagestats")).result;
    expect(st.events).toBe(7);

    // Rules travel with the configuration; removing one is days 0.
    const cfg = (await rpc(host, owner, "exportconfig")).result;
    expect(cfg.retention).toEqual([{ kind: 7, days: 30 }, { kind: null, days: 100 }]);
    await rpc(host, owner, "setretention", null, 0);
    expect((await rpc(host, owner, "listretention")).result).toEqual([{ kind: 7, days: 30 }]);
    expect((await rpc(host, owner, "setretention", 70000, 5)).status).toBe(400);
    // Load-bearing kinds can be neither expired nor purged, and the catch-all skips them.
    expect((await rpc(host, owner, "setretention", 0, 5)).status).toBe(400);
    expect((await rpc(host, owner, "purgekind", 13534, 0)).status).toBe(400);
    await rpc(host, owner, "setretention", null, 1);
    expect((await rpc(host, owner, "purgekind", null, 0)).result.deleted).toBe(1); // the fresh note; profile, roster and group state stay
    expect((await rpc(host, owner, "storagestats")).result.kinds.map((k: any) => k.kind).sort((a: number, b: number) => a - b)).toEqual([0, 13534, 39000, 39001, 39002, 39003]);
  });
});
