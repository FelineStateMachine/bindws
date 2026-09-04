// The relay itself: claiming a name over NIP-86 with NIP-98 tokens, the
// expiry alarm, and the Worker's routing by hostname.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../../src/relay.ts";
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
