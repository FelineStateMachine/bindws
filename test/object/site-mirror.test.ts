import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "../../src/negentropy.ts";
import { siteLabel } from "../../src/sites.ts";
import { queueMirrors, remoteSiteBlob } from "../../src/site-mirror.ts";
import { ev, pk, rpc, now, drive } from "../helpers/relay.ts";
import { upload } from "../helpers/media.ts";
import { WS } from "../helpers/ws.ts";

const text = "<!doctype html><h1>from Blossom</h1>";
const hash = bytesToHex(sha256(new TextEncoder().encode(text)));

describe("site mirrors", () => {
  it("proxies missing files using manifest servers then BUD-03, verifying hashes and forwarding metadata", async () => {
    const name = "site-proxy", host = name + ".bind.ws", sk = generateSecretKey();
    await rpc(host, sk, "claim");
    await rpc(host, sk, "setpolicy", { features: { sites: { mirror: false } } });
    const calls: string[] = [];
    await runInDurableObject(env.RELAY.getByName(name), (r) => {
      r.fetcher = async (url) => {
        calls.push(url);
        return url.startsWith("https://bad.test") ? new Response("wrong bytes") : new Response(text, { headers: { "content-type": "text/html; charset=utf-8", "content-length": String(text.length) } });
      };
    });
    const e = ev(sk, 15128, "", [["path", "/index.html", hash], ["server", "https://bad.test"]]);
    const c = await WS.connect(host);
    expect((await c.ok(ev(sk, 10063, "", [["server", "https://good.test"]]))).ok).toBe(true);
    expect((await c.ok(e)).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName(name), (r) => r.syncSites());
    const url = "http://" + siteLabel(e) + ".bind.ws/";
    const response = await SELF.fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-length")).toBe(String(text.length));
    expect(calls.slice(-2)).toEqual(["https://bad.test/" + hash, "https://good.test/" + hash]);
    expect((await rpc(host, sk, "listblobs")).result).toEqual([]);
    await drive(host, sk);
    expect((await rpc(host, sk, "listjobs")).result).toEqual([]);
    c.ws.close();
  });

  it("mirrors each unique file once as the manifest author, including sibling relays", async () => {
    const name = "site-mirror", host = name + ".bind.ws", sk = generateSecretKey();
    const origin = "site-origin.bind.ws";
    await rpc(host, sk, "claim"); await rpc(origin, sk, "claim");
    const file = await upload(origin, sk, text);
    const e = ev(sk, 35128, "", [["d", "blog"], ["path", "/index.html", file.sha], ["path", "/alias.html", file.sha], ["server", "https://" + origin]]);
    const c = await WS.connect(host); expect((await c.ok(e)).ok).toBe(true);
    const jobs = await drive(host, sk);
    expect(jobs.find((j) => j.kind === "mirror")?.last).toMatchObject({ blobs: 1, error: "" });
    const blobs = (await rpc(host, sk, "listblobs")).result;
    expect(blobs).toHaveLength(1); expect(blobs[0]).toMatchObject({ sha256: file.sha, uploader: pk(sk), size: text.length });
    await rpc(origin, sk, "setpolicy", { reads: "members" });
    const response = await SELF.fetch("http://" + siteLabel(e) + ".bind.ws/");
    expect(response.status).toBe(200); expect(await response.text()).toBe(text);
    c.ws.close();
  });

  it("does not resurrect a deleted manifest or a moderator-blocked blob", async () => {
    const name = "site-deleted", host = name + ".bind.ws", sk = generateSecretKey();
    await rpc(host, sk, "claim");
    const e = ev(sk, 15128, "", [["path", "/index.html", hash], ["server", "https://good.test"]]);
    await runInDurableObject(env.RELAY.getByName(name), async (r) => {
      r.accept(e, null);
      await queueMirrors(r);
      r.store.deleteEvent(e.id);
      r.fetcher = async () => { throw new Error("must not fetch deleted site"); };
    });
    const jobs = await drive(host, sk);
    expect(jobs.find((j) => j.kind === "mirror")?.last?.blobs).toBe(0);
    await runInDurableObject(env.RELAY.getByName(name), async (r) => {
      r.settings.setEvent(hash, "ban", "removed", now());
      expect(await remoteSiteBlob(r, e, e.tags[0])).toBeNull();
    });
    expect((await rpc(host, sk, "listblobs")).result).toEqual([]);
  });

  it("rejects private-address redirects, oversize bodies and hash mismatches, and infers type only without both headers", async () => {
    const name = "site-origins", host = name + ".bind.ws", sk = generateSecretKey();
    await rpc(host, sk, "claim");
    const e = ev(sk, 15128, "", [["path", "/index.html", hash], ["server", "https://good.test"]]);
    await runInDurableObject(env.RELAY.getByName(name), async (r) => {
      let calls = 0;
      r.fetcher = async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } }); };
      expect(await remoteSiteBlob(r, e, e.tags[0])).toBeNull(); expect(calls).toBe(1);
      r.fetcher = async () => new Response(text, { headers: { "content-length": String(100 * 1024 * 1024) } });
      expect(await remoteSiteBlob(r, e, e.tags[0])).toBeNull();
      r.fetcher = async () => new Response("corrupted");
      expect(await remoteSiteBlob(r, e, e.tags[0])).toBeNull();
      r.fetcher = async () => new Response(new TextEncoder().encode(text));
      expect((await remoteSiteBlob(r, e, e.tags[0]))?.type).toBe("text/html; charset=utf-8");
    });
  });
});
