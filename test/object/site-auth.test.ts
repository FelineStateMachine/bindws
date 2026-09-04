import { SELF, runInDurableObject, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import { ev, rpc, nip98, pk, now } from "../helpers/relay.ts";
import { upload } from "../helpers/media.ts";
import { WS } from "../helpers/ws.ts";
import { siteLabel } from "../../src/sites.ts";
import { siteIdentity, SITE_AUTH_PATH } from "../../src/site-auth.ts";
import type { Relay } from "../../src/relay.ts";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const token = (sk: Uint8Array, url: string, body: string) => {
  const e = finalizeEvent({ kind: 27235, content: "", tags: [["u", url], ["method", "POST"], ["payload", hex(sha256(new TextEncoder().encode(body)))]], created_at: Math.floor(Date.now() / 1000) }, sk);
  return "Nostr " + btoa(JSON.stringify(e));
};

describe("hosted site sign-in", () => {
  it("issues a relay-signed cookie, consumes challenges once, and checks the cookie", async () => {
    const stub = env.RELAY.getByName("site-auth-direct");
    const user = generateSecretKey();
    const url = "https://site-auth.bind.ws/private/index.html";
    const response = await runInDurableObject(stub, async (relay: Relay) => {
      relay.settings.update({ reads: "auth" });
      const page = await siteIdentity(relay, new Request(url, { headers: { accept: "text/html" } }), "site");
      expect(page).toBeInstanceOf(Response);
      const html = await (page as Response).text();
      const nonce = /const challenge="([^"]+)"/.exec(html)?.[1];
      expect(nonce).toBeTruthy();
      const challenge = finalizeEvent({ kind: 22242, content: "bind.ws site sign-in", tags: [["relay", "https://site-auth.bind.ws"], ["challenge", nonce!]], created_at: Math.floor(Date.now() / 1000) }, user);
      const body = JSON.stringify({ event: challenge });
      return siteIdentity(relay, new Request("https://site-auth.bind.ws/.well-known/nsite/auth", { method: "POST", headers: { origin: "https://site-auth.bind.ws", authorization: token(user, "https://site-auth.bind.ws/.well-known/nsite/auth", body), "content-type": "application/json" }, body }), "site");
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(204);
    const setCookie = (response as Response).headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-nsite=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).not.toMatch(/Domain=/i);
    await runInDurableObject(stub, async (relay: Relay) => {
      const value = setCookie.split(";", 1)[0];
      const who = await siteIdentity(relay, new Request(url, { headers: { cookie: value } }), "site");
      expect(who).toEqual({ pubkeys: [getPublicKey(user)] });
    });
  });
});


async function protectedSite(name: string) {
  const host = name + ".bind.ws", owner = generateSecretKey(), member = generateSecretKey();
  await rpc(host, owner, "claim");
  await rpc(host, owner, "allowpubkey", pk(member));
  const file = await upload(host, owner, "private site bytes");
  const e = ev(owner, 15128, "", [["path", "/index.html", file.sha]]);
  const c = await WS.connect(host); expect((await c.ok(e)).ok).toBe(true); c.ws.close();
  await runInDurableObject(env.RELAY.getByName(name), (r) => r.syncSites());
  await rpc(host, owner, "setpolicy", { reads: "members" });
  return { name, host, owner, member, origin: "https://" + siteLabel(e) + ".bind.ws", label: siteLabel(e) };
}

async function signInRequest(origin: string, member: Uint8Array, path = "/") {
  const page = await SELF.fetch(origin + path, { headers: { accept: "text/html" } });
  expect(page.status).toBe(401);
  expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
  const html = await page.text();
  expect(html).not.toContain("private site bytes");
  const nonce = /const challenge="([^"]+)"/.exec(html)?.[1];
  expect(nonce).toBeTruthy();
  const challenge = ev(member, 22242, "bind.ws site sign-in", [["relay", origin], ["challenge", nonce!]]);
  const body = JSON.stringify({ event: challenge });
  return { nonce, html, body, request: new Request(origin + SITE_AUTH_PATH, { method: "POST", headers: { origin, authorization: token(member, origin + SITE_AUTH_PATH, body), "content-type": "application/json" }, body }) };
}

describe("site sign-in at the public door", () => {
  it("opens a member's site with a host-only cookie and consumes a challenge only once", async () => {
    const f = await protectedSite("auth-public");
    const proof = await signInRequest(f.origin, f.member);
    const replies = await Promise.all([SELF.fetch(proof.request.clone()), SELF.fetch(proof.request.clone())]);
    expect(replies.map((r) => r.status).sort()).toEqual([204, 401]);
    const cookie = replies.find((r) => r.status === 204)!.headers.get("set-cookie")!;
    expect(cookie).toContain("Secure"); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Lax"); expect(cookie).not.toContain("Domain=");
    const value = cookie.split(";")[0];
    const page = await SELF.fetch(f.origin + "/", { headers: { cookie: value } });
    expect(page.status).toBe(200); expect(await page.text()).toBe("private site bytes");
    expect(page.headers.get("cache-control")).toContain("no-store");
    const altered = value.slice(0, -5) + "zzzzz";
    expect((await SELF.fetch(f.origin + "/", { headers: { cookie: altered } })).status).toBe(401);
    // A cookie for this site does not authenticate at the relay door.
    expect((await SELF.fetch("https://" + f.host + "/query", { method: "POST", headers: { cookie: value }, body: "[]" })).status).toBe(401);
    await rpc(f.host, f.owner, "removemember", pk(f.member));
    expect((await SELF.fetch(f.origin + "/", { headers: { cookie: value } })).status).toBe(403);
  });

  it("rejects cross-origin proofs, expired challenges and malformed exchanges", async () => {
    const f = await protectedSite("auth-reject");
    const proof = await signInRequest(f.origin, f.member, "/index.html?x=1");
    expect(proof.html).toContain('returnUrl="' + f.origin + '/index.html?x=1"');
    const wrongHeaders = new Headers(proof.request.headers);
    wrongHeaders.set("origin", "https://other.test");
    const wrong = new Request(proof.request.url, { method: "POST", headers: wrongHeaders, body: proof.body });
    expect((await SELF.fetch(wrong)).status).toBe(401);
    await runInDurableObject(env.RELAY.getByName(f.name), (r) => { r.sql.exec(`UPDATE nsite_auth_challenges SET expires=? WHERE nonce=?`, now() - 1, proof.nonce); });
    expect((await SELF.fetch(proof.request)).status).toBe(401);
    const nullBody = "null";
    expect((await SELF.fetch(f.origin + SITE_AUTH_PATH, { method: "POST", headers: { origin: f.origin, authorization: token(f.member, f.origin + SITE_AUTH_PATH, nullBody) }, body: nullBody })).status).toBe(401);
    const head = await SELF.fetch(f.origin + "/", { method: "HEAD", headers: { accept: "text/html" } });
    expect(head.status).toBe(401); expect(await head.text()).toBe("");
    const huge = await SELF.fetch(f.origin + SITE_AUTH_PATH, { method: "POST", headers: { origin: f.origin }, body: "x".repeat(33 * 1024) });
    expect(huge.status).toBe(413);
    const outsider = await signInRequest(f.origin, generateSecretKey());
    expect((await SELF.fetch(outsider.request)).status).toBe(403);
  });

  it("requires exact NIP-98 URLs and binds signed cookies to origin, site and lifetime", async () => {
    const f = await protectedSite("auth-binding");
    const url = f.origin + "/";
    const good = await nip98(f.member, url);
    expect((await SELF.fetch(url, { headers: { authorization: good } })).status).toBe(200);
    expect((await SELF.fetch(url + "?different=1", { headers: { authorization: good } })).status).toBe(401);
    expect((await SELF.fetch(url.replace("https:", "http:"), { headers: { authorization: good } })).status).toBe(401);
    const cookies = await runInDurableObject(env.RELAY.getByName(f.name), (r) => {
      const make = (label: string, origin: string, expires: number) => {
        const signed = r.identity.sign(22242, [["site", label], ["origin", origin], ["pubkey", pk(f.member)], ["expiration", String(expires)], ["purpose", "nsite-cookie"]]);
        return "__Host-nsite=" + btoa(JSON.stringify(signed)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      };
      return [make("wrong-site", f.origin, now() + 60), make(f.label, "https://elsewhere.test", now() + 60), make(f.label, f.origin, now() - 1)];
    });
    for (const cookie of cookies) expect((await SELF.fetch(url, { headers: { cookie } })).status).toBe(401);
  });
});
