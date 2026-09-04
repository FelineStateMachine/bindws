import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../../src/relay.ts";
import { difficulty } from "../../src/event.ts";
import { now, ev, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("claiming", () => {
  it("starts unclaimed: reads work, writes are refused, management needs a claim", async () => {
    const host = "alpha.bind.ws";
    const sk = generateSecretKey();
    const c = await WS.connect(host);
    expect(await c.req({ kinds: [1] })).toEqual([]);
    const r = await c.ok(ev(sk, 1, "hi"));
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/^restricted: .*unclaimed/);

    const info = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();
    expect(info.name).toBe("alpha");
    expect(info.limitation.restricted_writes).toBe(true);
    expect(info.supported_nips).toContain(86);

    expect((await rpc(host, sk, "stats")).status).toBe(403);
    expect((await rpc(host, null, "claim")).status).toBe(401);
    const claim = await rpc(host, sk, "claim");
    expect(claim.result).toEqual({ owner: getPublicKey(sk), claimed: true });
    const other = generateSecretKey();
    expect((await rpc(host, other, "claim")).status).toBe(403);
    expect((await rpc(host, sk, "claim")).result.claimed).toBe(true);

    expect((await c.ok(ev(sk, 1, "hi"))).ok).toBe(true);
    expect((await rpc(host, sk, "stats")).result.events).toBe(10); // the note, the relay-signed roster, profile, discovery record, two role definitions and the four NIP-29 state events
    const info2 = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();
    expect(info2.pubkey).toBe(getPublicKey(sk));
    expect(info2.limitation.restricted_writes).toBe(false);
  });

  it("rejects NIP-98 tokens for the wrong URL, method, or body", async () => {
    const host = "beta.bind.ws";
    const sk = generateSecretKey();
    const url = `http://${host}/`;
    const body = JSON.stringify({ method: "claim", params: [] });
    const post = (authorization: string) =>
      SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization }, body });
    const bad = await getToken("http://elsewhere.bind.ws/", "POST", (e) => finalizeEvent(e, sk), true, { method: "claim", params: [] });
    expect((await post(bad)).status).toBe(401);
    const wrongBody = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, { method: "stats", params: [] });
    expect((await post(wrongBody)).status).toBe(401);
    expect((await post("Nostr notbase64")).status).toBe(401);
    const good = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, { method: "claim", params: [] });
    expect((await post(good)).status).toBe(200);
  });
});

describe("policy", () => {
  it("enforces writes, reads, pow, bans, and kind rules set by the owner", async () => {
    const host = "gamma.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);

    // owner-only writes
    expect((await rpc(host, owner, "setpolicy", { writes: "owner" })).result.writes).toBe("owner");
    expect((await c.ok(ev(stranger, 1, "x"))).msg).toMatch(/^restricted:/);
    expect((await c.ok(ev(owner, 1, "x"))).ok).toBe(true);

    // allowlist
    await rpc(host, owner, "setpolicy", { writes: "allowlist" });
    expect((await c.ok(ev(member, 1, "y"))).msg).toMatch(/^restricted:/);
    await rpc(host, owner, "allowpubkey", getPublicKey(member), "friend");
    expect((await c.ok(ev(member, 1, "y"))).ok).toBe(true);
    expect((await rpc(host, owner, "listallowedpubkeys")).result).toEqual([{ pubkey: getPublicKey(member), reason: "friend" }]);
    expect((await rpc(host, owner, "listmembers")).result.members.map((m: any) => m.role)).toEqual(["owner", "member"]);
    await rpc(host, owner, "setpolicy", { writes: "open" });

    // bans win over everything, and the owner cannot ban themselves
    await rpc(host, owner, "banpubkey", getPublicKey(stranger), "spam");
    expect((await c.ok(ev(stranger, 1, "z"))).msg).toMatch(/^blocked:/);
    expect((await rpc(host, owner, "banpubkey", getPublicKey(owner))).status).toBe(400);
    await rpc(host, owner, "unrulepubkey", getPublicKey(stranger));
    expect((await c.ok(ev(stranger, 1, "z"))).ok).toBe(true);

    // ban an event: deleted now and refused later
    const e = ev(stranger, 1, "offensive");
    expect((await c.ok(e)).ok).toBe(true);
    await rpc(host, owner, "banevent", e.id, "nope");
    // Left open on purpose: the read rule below has to close it.
    expect((await c.open("q", { ids: [e.id] })).events).toEqual([]);
    expect((await c.ok(e)).msg).toMatch(/^blocked:/);
    expect((await rpc(host, owner, "listbannedevents")).result).toEqual([{ id: e.id, reason: "nope" }]);

    // kind rules
    await rpc(host, owner, "disallowkind", 7);
    expect((await c.ok(ev(stranger, 7, "+"))).msg).toMatch(/kind 7/);
    await rpc(host, owner, "allowkind", 1);
    expect((await c.ok(ev(stranger, 30023, "a", [["d", "x"]]))).msg).toMatch(/kind 30023/);
    expect((await c.ok(ev(stranger, 1, "still fine"))).ok).toBe(true);
    expect((await rpc(host, owner, "listallowedkinds")).result).toEqual([1]);
    await rpc(host, owner, "unrulekind", 1);
    await rpc(host, owner, "unrulekind", 7);

    // proof of work
    await rpc(host, owner, "setpolicy", { minPow: 4 });
    // One random id in sixteen starts with a zero nibble and would pass; pick one that does not.
    let weak = ev(stranger, 1, "weak");
    while (difficulty(weak).difficulty >= 4) weak = ev(stranger, 1, "weak " + Math.random());
    expect((await c.ok(weak)).msg).toMatch(/^pow:/);
    await rpc(host, owner, "setpolicy", { minPow: 0 });

    // reads need auth: tightening the rule closes the subscription still open
    await rpc(host, owner, "setpolicy", { reads: "auth" });
    expect((await c.expect("CLOSED"))[2]).toMatch(/^auth-required:/);
    expect((await c.query({ kinds: [1] })).closed).toMatch(/^auth-required:/);
    await c.auth(stranger, host);
    expect((await c.req({ kinds: [1] })).length).toBeGreaterThan(0);

    // NIP-11 reflects it all
    await rpc(host, owner, "changerelayname", "Gamma Club");
    await rpc(host, owner, "changerelaydescription", "members only");
    const info = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();
    expect(info.name).toBe("Gamma Club");
    expect(info.limitation.auth_required).toBe(true);
    expect(info.limitation.restricted_writes).toBe(false);
  });

  it("only the owner may manage", async () => {
    const host = "delta.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const r = await rpc(host, generateSecretKey(), "setpolicy", { writes: "owner" });
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/^restricted:/);
    expect((await rpc(host, generateSecretKey(), "supportedmethods")).result).toContain("claim");
  });
});

describe("expiry alarm", () => {
  it("sweeps expired events from storage", async () => {
    const stub = env.RELAY.getByName("epsilon");
    const sk = generateSecretKey();
    const t = now();
    await runInDurableObject(stub, async (instance: Relay) => {
      instance.settings.update({ owner: getPublicKey(sk) });
      const e = ev(sk, 1, "temporary", [["expiration", String(t + 5)]], t);
      expect(instance.accept(e, null).ok).toBe(true);
      expect(instance.store.stats().events).toBe(1);
      expect(instance.store.sweepExpired(t + 1)).toBe(t + 5);
      expect(instance.store.stats().events).toBe(1);
      expect(instance.store.sweepExpired(t + 6)).toBe(0);
      expect(instance.store.stats().events).toBe(0);
    });
  });
});

describe("worker routing", () => {
  it("serves the apex, rejects bad names, and isolates relays by name", async () => {
    const apex = await SELF.fetch("http://bind.ws/");
    expect(apex.status).toBe(200);
    expect(await apex.text()).toContain("Relay on demand. Sign once, and it's yours.");
    const bad = await SELF.fetch("http://x.bind.ws/", { redirect: "manual" });
    expect(bad.status).toBe(302);
    const sk = generateSecretKey();
    await rpc("one.bind.ws", sk, "claim");
    const a = await WS.connect("one.bind.ws");
    expect((await a.ok(ev(sk, 1, "only here"))).ok).toBe(true);
    const b = await WS.connect("two.bind.ws");
    expect(await b.req({ kinds: [1] })).toEqual([]);
    const page = await SELF.fetch("http://one.bind.ws/");
    expect(page.headers.get("content-type")).toContain("text/html");
  });
});
