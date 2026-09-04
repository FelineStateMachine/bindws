import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { aggregate, base36, checkSite, parseSite, siteKey, siteLabel, unbase36 } from "../../src/sites.ts";
import { upload } from "../helpers/media.ts";
import { ev, pk, rpc, now, nip98, info } from "../helpers/relay.ts";
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
  it("serves all hostname forms, directories, fallback pages and verified metadata", async () => {
    const name = "sites-serve", host = name + ".bind.ws", sk = generateSecretKey();
    await rpc(host, sk, "claim");
    const file = await upload(host, sk, "hello site"), missing = await upload(host, sk, "custom missing");
    const tags = [["path", "/index.html", file.sha], ["path", "/blog/index.html", file.sha], ["path", "/404.html", missing.sha]];
    const c = await WS.connect(host);
    const events = [ev(sk, 15128, "", tags), ev(sk, 35128, "", [...tags, ["d", "blog"]]), ev(sk, 5128, "", [...tags, ["a", `15128:${pk(sk)}:`], ["x", aggregate({ tags }), "aggregate"]])];
    for (const e of events) expect((await c.ok(e)).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName(name), (r) => r.syncSites());
    for (const e of events) {
      const url = "http://" + siteLabel(e) + ".bind.ws";
      const res = await SELF.fetch(url + "/");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello site");
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(res.headers.get("content-length")).toBe("10");
      expect(res.headers.get("etag")).toBe('"' + file.sha + '"');
      const head = await SELF.fetch(url + "/", { method: "HEAD" });
      expect(head.status).toBe(200); expect(await head.text()).toBe("");
      expect((await SELF.fetch(url + "/", { headers: { "if-none-match": res.headers.get("etag")! } })).status).toBe(304);
      expect((await SELF.fetch(url + "/blog", { redirect: "manual" })).headers.get("location")).toBe(url + "/blog/");
      expect(await (await SELF.fetch(url + "/blog/")).text()).toBe("hello site");
      const no = await SELF.fetch(url + "/absent.html"); expect(no.status).toBe(404); expect(await no.text()).toBe("custom missing");
      // Content negotiation and relay paths cannot escape the site door.
      expect(await (await SELF.fetch(url + "/", { headers: { accept: "application/nostr+json" } })).text()).toBe("hello site");
      expect((await SELF.fetch(url + "/", { method: "POST", headers: { "content-type": "application/nostr+json+rpc" }, body: '{"method":"claim"}' })).status).toBe(405);
      expect((await SELF.fetch(url + "/", { headers: { upgrade: "websocket" } })).status).toBe(405);
    }
    const url = "http://" + siteLabel(events[0]) + ".bind.ws/";
    await rpc(host, sk, "setpolicy", { reads: "members" });
    expect((await SELF.fetch(url)).status).toBe(401);
    expect((await SELF.fetch(url, { headers: { authorization: await nip98(generateSecretKey(), url) } })).status).toBe(403);
    const member = await SELF.fetch(url, { headers: { authorization: await nip98(sk, url) } });
    expect(member.status).toBe(200); expect(member.headers.get("cache-control")).toContain("no-store");
    await rpc(host, sk, "setpolicy", { reads: "open", features: { sites: false } });
    expect((await SELF.fetch(url)).status).toBe(404); expect((await info(host)).nsites).toBeUndefined();
    await rpc(host, sk, "setpolicy", { features: { sites: true } });
    expect((await info(host)).nsites.host).toBe("bind.ws");
    await env.MEDIA.put(name + "/" + file.sha, "corrupt");
    expect((await SELF.fetch(url)).status).toBe(404);
    c.ws.close();
  });

  it("rejects invalid and unknown site labels and ignores a forged routing header", async () => {
    expect((await SELF.fetch("http://" + "z".repeat(55) + ".bind.ws/", { redirect: "manual" })).status).toBe(404);
    const unknown = siteLabel(ev(generateSecretKey(), 15128, "", paths));
    expect((await SELF.fetch("http://" + unknown + ".bind.ws/", { redirect: "manual" })).status).toBe(404);
    const res = await SELF.fetch("http://sites-normal.bind.ws/", { headers: { "x-relay-site": unknown, accept: "application/nostr+json" } });
    expect((await res.json<any>()).name).toBe("sites-normal");
  });

});
