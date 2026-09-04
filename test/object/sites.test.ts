import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { aggregate, base36, checkSite, parseSite, siteKey, siteLabel, unbase36 } from "../../src/sites.ts";
import { ev, pk, rpc, now } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

const paths = [["path", "/index.html", "ab".repeat(32)]];
describe("sites", () => {
  it("validates manifests, names, aggregates and snapshot references", () => {
    const sk = generateSecretKey();
    const root = ev(sk, 15128, "", paths);
    expect(checkSite(root)).toBe("");
    expect(checkSite(ev(sk, 15128, "", [...paths, ["d", "no"]]))).toMatch(/^invalid:/);
    for (const d of ["", "a-", "UPPER", "a".repeat(14)]) expect(checkSite(ev(sk, 35128, "", [...paths, ["d", d]]))).toMatch(/^invalid:/);
    for (const path of ["index.html", "/dir/", "/../a.html", "//a.html", "/a.html?x", "/a\nb.html"]) expect(checkSite(ev(sk, 15128, "", [["path", path, paths[0][2]]]))).toMatch(/^invalid:/);
    expect(checkSite(ev(sk, 15128, "", [...paths, ...paths]))).toMatch(/duplicate/);
    const hash = aggregate(root);
    expect(aggregate({ tags: [["title", "ignored"], ...paths].reverse() })).toBe(hash);
    expect(checkSite(ev(sk, 5128, "", [...paths, ["x", hash, "aggregate"], ["a", `15128:${pk(sk)}:`]]))).toBe("");
    expect(checkSite(ev(sk, 5128, "", paths))).toMatch(/aggregate/);
    expect(checkSite(ev(sk, 15128, "", [...paths, ["x", "00".repeat(32), "aggregate"]]))).toMatch(/aggregate/);
  });

  it("round trips all label forms, leading zeros and the full 256-bit boundary", () => {
    const sk = generateSecretKey();
    for (const e of [ev(sk, 15128, "", paths), ev(sk, 35128, "", [...paths, ["d", "blog"]]), ev(sk, 5128, "", paths)]) {
      expect(parseSite(siteLabel(e))).toMatchObject(e.kind === 5128 ? { kind: e.kind, id: e.id } : { kind: e.kind, pubkey: e.pubkey });
    }
    for (const hex of ["00".repeat(32), "00".repeat(31) + "01", "ff".repeat(32)]) expect(unbase36(base36(hex))).toBe(hex);
    expect(unbase36("z".repeat(50))).toBeNull();
    for (const label of ["bad", "v" + "z".repeat(50), base36(pk(sk)) + "blog-", "npub1" + "q".repeat(58)]) expect(parseSite(label)).toBeNull();
  });

  it("indexes accepted versions and clears routes after deletion and expiry", async () => {
    const name = "sites-index";
    const host = name + ".bind.ws";
    const sk = generateSecretKey();
    await rpc(host, sk, "claim");
    const c = await WS.connect(host);
    const first = ev(sk, 15128, "", paths, now() - 1);
    expect((await c.ok(first)).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName(name), (r) => r.syncSites());
    const key = siteKey(siteLabel(first));
    expect(JSON.parse((await env.HOSTS.get(key))!)).toEqual({ name, event: first.id });
    const next = ev(sk, 15128, "new", paths);
    expect((await c.ok(next)).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName(name), (r) => r.syncSites());
    expect(JSON.parse((await env.HOSTS.get(key))!).event).toBe(next.id);
    expect((await c.ok(ev(sk, 5, "", [["e", next.id]]))).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName(name), (r) => r.syncSites());
    expect(await env.HOSTS.get(key)).toBeNull();
    const expires = ev(sk, 35128, "", [...paths, ["d", "temp"], ["expiration", String(now() + 60)]]);
    expect((await c.ok(expires)).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName(name), async (r) => {
      await r.syncSites();
      r.store.sweepExpired(now() + 61);
      await r.syncSites();
    });
    expect(await env.HOSTS.get(siteKey(siteLabel(expires)))).toBeNull();
    c.ws.close();
  });
});
