// NIP-AD path discovery shares the relay's page and metadata boundaries.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode, nprofileEncode } from "nostr-tools/nip19";
import { ev, info, nip98, now, pk, post, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

const endpoint = (host: string, path: string) => `http://${host}/.well-known/nostr.json?path=${encodeURIComponent(path)}`;
const lookup = async (host: string, path: string, signer?: Uint8Array) => {
  const url = endpoint(host, path);
  const response = await SELF.fetch(url, { headers: signer ? { authorization: await nip98(signer, url) } : {} });
  return { status: response.status, body: await response.json<Record<string, { filter: Record<string, unknown>; relays: string[] }>>() };
};

describe("NIP-AD web addresses", () => {
  it("maps the homepage to this relay's exact live group, with an explicit relay hint", async () => {
    const host = "ad-group.bind.ws", owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const self = (await info(host)).self;
    const filter = { kinds: [39000], authors: [self], "#d": ["ad-group"], limit: 1 };
    const r = await lookup(host, "/");
    expect(r).toEqual({ status: 200, body: { "/": { filter, relays: [`wss://${host}`] } } });
    const queried = await post(host, owner, "/query", [filter]);
    expect(queried.body).toHaveLength(1);
    expect(queried.body[0]).toMatchObject({ kind: 39000, pubkey: self });
    await runInDurableObject(env.RELAY.getByName("ad-group"), (relay) => {
      const row = relay.sql.exec<{ id: string }>("SELECT id FROM events WHERE kind=39000").one();
      relay.store.hidden.add(row.id);
    });
    expect((await lookup(host, "/")).body).toEqual({});
  });

  it("keeps exact event versions and addressable articles aligned with the browser pages", async () => {
    const host = "ad-pages.bind.ws", owner = generateSecretKey(), author = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const note = ev(owner, 1, "A web address");
    const d = "why / Nostr? #1%";
    const article = ev(owner, 30023, "An article", [["d", d]], now() - 1);
    const other = ev(author, 30023, "Another author", [["d", d]]);
    for (const e of [note, article, other]) expect((await c.ok(e)).ok).toBe(true);
    const cases = [
      { path: `/e/${note.id}`, filter: { ids: [note.id], limit: 1 } },
      { path: `/e/${article.id}`, filter: { ids: [article.id], limit: 1 } },
      ...[`/a/${encodeURIComponent(d)}`, `/a/${pk(owner)}/${encodeURIComponent(d)}`, `/a/${npubEncode(pk(owner))}/${encodeURIComponent(d)}`, `/a/${nprofileEncode({ pubkey: pk(owner) })}/${encodeURIComponent(d)}`]
        .map((path) => ({ path, filter: { kinds: [30023], authors: [pk(owner)], "#d": [d], limit: 1 } })),
      { path: `/a/${pk(author)}/${encodeURIComponent(d)}`, filter: { kinds: [30023], authors: [pk(author)], "#d": [d], limit: 1 } },
    ];
    for (const { path, filter } of cases) {
      expect((await SELF.fetch(`http://${host}${path}`)).status, path).toBe(200);
      expect((await lookup(host, path)).body).toEqual({ [path]: { filter, relays: [`wss://${host}`] } });
    }
    const next = ev(owner, 30023, "New edition", [["d", d]]);
    expect((await c.ok(next)).ok).toBe(true);
    expect((await lookup(host, `/e/${article.id}`)).body).toEqual({});
    const address = (await lookup(host, `/a/${encodeURIComponent(d)}`)).body;
    expect(address[`/a/${encodeURIComponent(d)}`].filter).toEqual(cases[2].filter);
    expect((await post(host, owner, "/query", [cases[2].filter])).body.map((e: { id: string }) => e.id)).toEqual([next.id]);
    c.ws.close();
  });

  it("omits missing, deleted, expired, held and private events and unsupported browser paths", async () => {
    const host = "ad-hidden.bind.ws", owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const deleted = ev(owner, 1, "deleted"), held = ev(owner, 1, "held");
    const expiring = ev(owner, 1, "expires", [["expiration", String(now() + 60)]]);
    const dm = ev(owner, 4, "private", [["p", pk(owner)]]);
    const profile = ev(owner, 0, "{}");
    const article = ev(owner, 30023, "gone", [["d", "gone"]]);
    for (const e of [deleted, held, expiring, dm, profile, article]) expect((await c.ok(e)).ok).toBe(true);
    expect((await c.ok(ev(owner, 5, "", [["e", deleted.id], ["a", `30023:${pk(owner)}:gone`]]))).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName("ad-hidden"), (relay) => {
      relay.store.hidden.add(held.id);
      relay.sql.exec("UPDATE events SET expires=? WHERE id=?", now() - 1, expiring.id);
    });
    for (const path of [deleted, held, expiring, dm, profile].map((e) => `/e/${e.id}`).concat([`/e/${"0".repeat(64)}`, "/a/gone", "/a/missing", "/people", "/feed.xml", "/view/articles", "/card.json", "/e/nope"])) {
      expect((await lookup(host, path)).body, path).toEqual({});
    }
    c.ws.close();
  });

  it("preserves private metadata admission and never opens public pages with authentication", async () => {
    const host = "ad-private.bind.ws", owner = generateSecretKey(), outsider = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host), note = ev(owner, 1, "members only");
    expect((await c.ok(note)).ok).toBe(true);
    await rpc(host, owner, "setpolicy", { reads: "members", directoryPublic: false });
    expect(await lookup(host, "/")).toEqual({ status: 401, body: {} });
    expect(await lookup(host, "/", outsider)).toEqual({ status: 403, body: {} });
    expect((await lookup(host, "/", owner)).body["/"].filter).toMatchObject({ kinds: [39000] });
    for (const signer of [undefined, outsider, owner]) expect((await lookup(host, `/e/${note.id}`, signer)).body).toEqual({});
    await rpc(host, owner, "setpolicy", { reads: "auth" });
    expect((await lookup(host, "/")).status).toBe(401);
    expect((await lookup(host, "/", outsider)).body["/"]).toBeDefined();
    await rpc(host, owner, "setpolicy", { reads: "open" });
    expect((await lookup(host, "/")).body["/"]).toBeDefined();
    c.ws.close();
  });

  it("preserves name lookup and directory semantics independently of path and page discovery", async () => {
    const host = "ad-names.bind.ws", owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(owner), { name: "alice" });
    const wellKnown = `http://${host}/.well-known/nostr.json`;
    const names = { names: { alice: pk(owner) }, relays: { [pk(owner)]: [`wss://${host}`] } };
    expect(await (await SELF.fetch(wellKnown)).json()).toEqual(names);
    expect(await (await SELF.fetch(wellKnown + "?name=alice&path=/")).json()).toEqual(names);
    await rpc(host, owner, "setpolicy", { directoryPublic: false });
    expect(await (await SELF.fetch(wellKnown)).json()).toEqual({ names: {}, relays: {} });
    expect(await (await SELF.fetch(wellKnown + "?name=alice")).json()).toEqual(names);
    const c = await WS.connect(host), note = ev(owner, 1, "public page");
    expect((await c.ok(note)).ok).toBe(true);
    await rpc(host, owner, "setpolicy", { features: { names: false } });
    expect((await SELF.fetch(wellKnown + "?name=alice")).status).toBe(404);
    expect((await SELF.fetch(wellKnown + "?name=alice&path=/")).status).toBe(404);
    expect((await lookup(host, "/")).body["/"]).toBeDefined();
    expect((await lookup(host, `/e/${note.id}`)).body[`/e/${note.id}`]).toBeDefined();
    await rpc(host, owner, "setpolicy", { features: { pages: false, sites: false } });
    expect((await lookup(host, `/e/${note.id}`)).body).toEqual({});
    expect((await lookup(host, "/")).body["/"]).toBeDefined();
    c.ws.close();
  });

  it("answers explicit discovery before content negotiation with CORS, HEAD and narrow preflight", async () => {
    const host = "ad-http.bind.ws", owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const url = endpoint(host, "/");
    const res = await SELF.fetch(url, { headers: { accept: "application/nostr+json" } });
    expect((await res.json<Record<string, unknown>>())["/"]).toBeDefined();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    for (const method of ["HEAD", "OPTIONS"]) {
      const r = await SELF.fetch(url, { method });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("");
      expect(r.headers.get("access-control-allow-headers")).toContain("authorization");
    }
    for (const method of ["POST", "PUT", "DELETE"]) expect((await SELF.fetch(url, { method })).status).toBe(405);
    const bad = await SELF.fetch(url, { headers: { authorization: "Nostr broken" } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({});
  });

  it("rejects malformed, oversized and external path inputs without resolving another URL", async () => {
    const host = "ad-paths.bind.ws", owner = generateSecretKey();
    await rpc(host, owner, "claim");
    for (const path of ["", "a", "https://example.com/a", "//example.com/a", "/a?x=1", "/a#one", "/a/%", "/a/%ff", "/a/../secret", "/a/%2e%2e/secret", "/a\\secret", "/a/%5csecret", "/a/%00", "/a\n", "/" + "a".repeat(4096)]) {
      expect(await lookup(host, path), path).toEqual({ status: 400, body: {} });
    }
    expect((await SELF.fetch(endpoint(host, "/") + "&path=/a/other")).status).toBe(400);
    expect((await SELF.fetch(`http://${host}/a/%`)).status).toBe(404);
  });

  it("uses the routed custom relay host and preserves local WebSocket schemes and ports", async () => {
    const owner = generateSecretKey();
    await rpc("ad-alias.bind.ws", owner, "claim");
    await env.HOSTS.put("relay.ad-example.test", "ad-alias");
    expect((await lookup("relay.ad-example.test", "/")).body["/"].relays).toEqual(["wss://relay.ad-example.test"]);
    await rpc("ad-local.localhost:8787", owner, "claim");
    expect((await lookup("ad-local.localhost:8787", "/")).body["/"].relays).toEqual(["ws://ad-local.localhost:8787"]);
  });

  it("omits unclaimed or expired relays and refuses blocked IP addresses", async () => {
    expect((await lookup("ad-unclaimed.bind.ws", "/")).body).toEqual({});
    const host = "ad-blocked.bind.ws", owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await rpc(host, owner, "blockip", "203.0.113.55", "scraper")).status).toBe(200);
    expect((await SELF.fetch(endpoint(host, "/"), { headers: { "cf-connecting-ip": "203.0.113.55" } })).status).toBe(403);
    await runInDurableObject(env.RELAY.getByName("ad-blocked"), (relay) => {
      relay.settings.update({ owner: "", lease: { until: now() - 1, holder: "" } });
    });
    expect((await lookup(host, "/")).body).toEqual({});
  });
});
