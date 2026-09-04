import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { aggregate, siteLabel } from "../../src/sites.ts";
import { upload } from "../helpers/media.ts";
import { ev, nip98, now, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("site web addresses", () => {
  it("maps the root and browser directory paths to manifest events", async () => {
    const name = "site-addresses", host = `${name}.bind.ws`, sk = generateSecretKey();
    await rpc(host, sk, "claim");
    const file = await upload(host, sk, "site address");
    const c = await WS.connect(host);
    const site = ev(sk, 15128, "", [["path", "/index.html", file.sha], ["path", "/docs/index.html", file.sha], ["path", "/404.html", file.sha]]);
    const named = ev(sk, 35128, "", [["d", "docs"], ["path", "/index.html", file.sha]]);
    const snapshot = ev(sk, 5128, "", [["path", "/index.html", file.sha], ["a", `15128:${site.pubkey}:`], ["x", aggregate({ tags: [["path", "/index.html", file.sha], ["a", `15128:${site.pubkey}:`]] }), "aggregate"]]);
    expect(await c.ok(site)).toMatchObject({ ok: true });
    expect(await c.ok(named)).toMatchObject({ ok: true });
    expect(await c.ok(snapshot)).toMatchObject({ ok: true });
    await runInDurableObject(env.RELAY.getByName(name), (relay) => relay.syncSites());
    const address = `http://${siteLabel(site)}.bind.ws/.well-known/nostr.json`;
    const root = await SELF.fetch(address + "?path=%2F");
    expect(root.status).toBe(200);
    expect(root.headers.get("access-control-allow-origin")).toBe("*");
    expect(root.headers.get("cache-control")).toContain("no-store");
    expect(await root.json()).toEqual({ "/": { filter: { authors: [site.pubkey], kinds: [15128], limit: 1 }, relays: [`wss://${name}.bind.ws`] } });
    expect(await (await SELF.fetch(address + "?path=%2Fdocs")).json()).toEqual({ "/docs": { filter: { authors: [site.pubkey], kinds: [15128], limit: 1 }, relays: [`wss://${name}.bind.ws`] } });
    expect(await (await SELF.fetch(address + "?path=%2Fmissing.html")).json()).toEqual({});
    const namedURL = `http://${siteLabel(named)}.bind.ws/.well-known/nostr.json?path=%2F`;
    expect(await (await SELF.fetch(namedURL)).json()).toEqual({ "/": { filter: { authors: [named.pubkey], kinds: [35128], "#d": ["docs"], limit: 1 }, relays: [`wss://${name}.bind.ws`] } });
    const snapshotURL = `http://${siteLabel(snapshot)}.bind.ws/.well-known/nostr.json?path=%2F`;
    expect(await (await SELF.fetch(snapshotURL)).json()).toEqual({ "/": { filter: { ids: [snapshot.id], limit: 1 }, relays: [`wss://${name}.bind.ws`] } });
    const head = await SELF.fetch(address + "?path=%2F", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await SELF.fetch(address + "?path=%2F", { method: "POST" })).status).toBe(405);
    expect((await SELF.fetch(address + "?path=%2F&path=%2Fdocs")).status).toBe(400);
    expect((await SELF.fetch(address + "?path=%2F%2e%2e%2Fx")).status).toBe(400);
    c.ws.close();
  });

  it("keeps NIP-05 names and read authentication separate from path discovery", async () => {
    const name = "site-address-auth", host = `${name}.bind.ws`, sk = generateSecretKey();
    await rpc(host, sk, "claim");
    const c = await WS.connect(host);
    const site = ev(sk, 35128, "", [["d", "docs"], ["path", "/index.html", "ab".repeat(32)]]);
    expect((await c.ok(site)).ok).toBe(true);
    await rpc(host, sk, "setpolicy", { reads: "members" });
    const address = `http://${siteLabel(site)}.bind.ws/.well-known/nostr.json`;
    expect((await SELF.fetch(address + "?name=nobodyq7")).status).toBe(401);
    expect((await SELF.fetch(address + "?path=%2F")).status).toBe(401);
    const options = await SELF.fetch(address + "?path=%2F", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
    c.ws.close();
  });

  it("requires an exact NIP-98 URL and applies the site read rule", async () => {
    const name = "site-address-proof", host = `${name}.bind.ws`, owner = generateSecretKey(), outsider = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const site = ev(owner, 15128, "", [["path", "/index.html", "ab".repeat(32)]]);
    expect((await c.ok(site)).ok).toBe(true); c.ws.close();
    await rpc(host, owner, "setpolicy", { reads: "members" });
    const url = `http://${siteLabel(site)}.bind.ws/.well-known/nostr.json?path=%2F`;
    const bad = await SELF.fetch(url, { headers: { authorization: await nip98(outsider, url + "x") } });
    expect(bad.status).toBe(401);
    const denied = await SELF.fetch(url, { headers: { authorization: await nip98(outsider, url) } });
    expect(denied.status).toBe(403);
    const allowed = await SELF.fetch(url, { headers: { authorization: await nip98(owner, url) } });
    expect(allowed.status).toBe(200);
  });

  it("keeps encoded filenames ahead of their decoded spelling and resolves encoded directories", async () => {
    const name = "site-address-escaped", host = `${name}.bind.ws`, sk = generateSecretKey();
    await rpc(host, sk, "claim");
    const file = await upload(host, sk, "escaped"), blocked = await upload(host, sk, "blocked escaped");
    const c = await WS.connect(host);
    const site = ev(sk, 15128, "", [["path", "/hello world.html", file.sha], ["path", "/hello%20world.html", blocked.sha], ["path", "/docs space/index.html", file.sha], ["path", "/only%20escaped/index.html", file.sha], ["path", "/100%.html", file.sha]]);
    expect((await c.ok(site)).ok).toBe(true); c.ws.close();
    const url = `http://${siteLabel(site)}.bind.ws/.well-known/nostr.json`;
    const encoded = await SELF.fetch(url + "?path=%2Fhello%2520world.html");
    expect(encoded.status).toBe(200);
    expect(Object.keys(await encoded.json())).toEqual(["/hello%20world.html"]);
    const directory = await SELF.fetch(url + "?path=%2Fdocs%2520space%2F");
    expect(directory.status).toBe(200);
    expect(Object.keys(await directory.json())).toEqual(["/docs%20space/"]);
    expect(await (await SELF.fetch(`http://${siteLabel(site)}.bind.ws/docs%20space/`)).text()).toBe("escaped");
    expect(await (await SELF.fetch(url + "?path=%2Fonly%2520escaped%2F")).json()).toEqual({});
    expect(Object.keys(await (await SELF.fetch(url + "?path=%2F100%2525.html")).json())).toEqual(["/100%25.html"]);
    // The encoded filename wins even when the decoded tag comes first.
    await runInDurableObject(env.RELAY.getByName(name), (relay) => { relay.settings.setEvent(blocked.sha, "ban", "moderated"); });
    expect(await (await SELF.fetch(url + "?path=%2Fhello%2520world.html")).json()).toEqual({});
    expect((await SELF.fetch(`http://${siteLabel(site)}.bind.ws/hello%20world.html`)).status).toBe(404);
  });

  it("preserves custom site targets, canonical relay hints and stale-edge isolation", async () => {
    const name = "site-address-custom", host = `${name}.bind.ws`, sk = generateSecretKey();
    const custom = "site.ad-custom.test";
    await rpc(host, sk, "claim");
    const file = await upload(host, sk, "custom site");
    const c = await WS.connect(host), site = ev(sk, 15128, "", [["path", "/index.html", file.sha]]);
    expect(await c.ok(site)).toMatchObject({ ok: true }); c.ws.close();
    const label = siteLabel(site);
    // The edge still has its old relay-only mapping when the local target changes.
    await env.HOSTS.put(custom, name);
    await runInDurableObject(env.RELAY.getByName(name), (relay) => {
      relay.settings.update({ customHosts: [{ host: custom, id: "custom-1", site: label, at: now(), status: "active", sslStatus: "active" }] });
    });
    const url = `http://${custom}/.well-known/nostr.json?path=%2F`;
    const expected = { "/": { filter: { kinds: [15128], authors: [pk(sk)], limit: 1 }, relays: [`wss://${host}`] } };
    expect(await (await SELF.fetch(url, { headers: { accept: "application/nostr+json" } })).json()).toEqual(expected);
    for (const path of ["/people", "/e/" + site.id, "/.well-known/nostr.json?name=alice"]) expect((await SELF.fetch(`http://${custom}${path}`)).status).toBe(404);
    expect((await SELF.fetch(`http://${custom}/`, { headers: { upgrade: "websocket" } })).status).toBe(405);
    const localURL = `http://${label}.localhost:8787/.well-known/nostr.json?path=%2F`;
    expect(await (await SELF.fetch(localURL)).json()).toEqual({ "/": { ...expected["/"], relays: [`ws://${name}.localhost:8787`] } });
    // A stale site edge mapping must not reopen either a removed site or the relay.
    const stale = "stale.ad-custom.test";
    await env.HOSTS.put(stale, JSON.stringify({ name, site: label }));
    expect((await SELF.fetch(`http://${stale}/.well-known/nostr.json?path=%2F`)).status).toBe(404);
  });

  it("keeps hosted nostr.json bytes for name lookups without exposing the relay directory", async () => {
    const name = "site-address-names", host = `${name}.bind.ws`, sk = generateSecretKey();
    await rpc(host, sk, "claim");
    await rpc(host, sk, "setmember", pk(sk), { name: "relay-owner" });
    const bytes = JSON.stringify({ names: { website: "ab".repeat(32) } });
    const file = await upload(host, sk, bytes);
    const c = await WS.connect(host);
    const site = ev(sk, 15128, "", [["path", "/index.html", file.sha], ["path", "/.well-known/nostr.json", file.sha]]);
    expect(await c.ok(site)).toMatchObject({ ok: true }); c.ws.close();
    const url = `http://${siteLabel(site)}.bind.ws/.well-known/nostr.json`;
    for (const query of ["", "?name=website", "?name=relay-owner&path=%2F"]) expect(await (await SELF.fetch(url + query)).text()).toBe(bytes);
    const mapping = await (await SELF.fetch(url + "?path=%2F")).json<Record<string, unknown>>();
    expect(Object.keys(mapping)).toEqual(["/"]);
    expect(JSON.stringify(mapping)).not.toContain("relay-owner");
  });

  it("hides unavailable manifests and switched-off sites even with a cached host route", async () => {
    const name = "site-address-hidden", host = `${name}.bind.ws`, sk = generateSecretKey();
    await rpc(host, sk, "claim");
    const file = await upload(host, sk, "live site");
    const c = await WS.connect(host), site = ev(sk, 15128, "", [["path", "/index.html", file.sha]]);
    expect(await c.ok(site)).toMatchObject({ ok: true }); c.ws.close();
    const label = siteLabel(site), url = `http://${label}.bind.ws/.well-known/nostr.json?path=%2F`;
    expect((await SELF.fetch(url)).status).toBe(200);
    await rpc(host, sk, "setpolicy", { features: { sites: false } });
    expect((await SELF.fetch(url)).status).toBe(404);
    await rpc(host, sk, "setpolicy", { features: { sites: true } });
    await runInDurableObject(env.RELAY.getByName(name), (relay) => { relay.store.hidden.add(site.id); });
    expect((await SELF.fetch(url)).status).toBe(404);
    await runInDurableObject(env.RELAY.getByName(name), (relay) => {
      relay.store.hidden.delete(site.id);
      relay.sql.exec("UPDATE events SET expires=? WHERE id=?", now() - 1, site.id);
    });
    expect((await SELF.fetch(url)).status).toBe(404);
    await runInDurableObject(env.RELAY.getByName(name), (relay) => {
      relay.sql.exec("UPDATE events SET expires=0 WHERE id=?", site.id);
      relay.settings.update({ owner: "", lease: { holder: "", until: now() - 1 } });
    });
    expect((await SELF.fetch(url)).status).toBe(404);
    await runInDurableObject(env.RELAY.getByName(name), (relay) => {
      relay.settings.update({ owner: pk(sk), lease: null });
      relay.sql.exec("DELETE FROM events WHERE id=?", site.id);
    });
    expect((await SELF.fetch(url)).status).toBe(404);
  });
});
