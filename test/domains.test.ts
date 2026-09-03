// Custom domains: a hostname the owner controls, mapped to the relay through
// KV and registered with Cloudflare for SaaS. The Cloudflare API is a fake
// fetch here; routing goes through the real worker and the KV binding.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../src/relay.ts";
import { Hostnames, checkHostname, MAX_CUSTOM_HOSTS } from "../src/domains.ts";

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

const info = async (host: string) => (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();

// fakeCloudflare answers the custom hostnames API and records every call.
function fakeCloudflare(opts: { active?: boolean; refuse?: boolean } = {}) {
  const calls: { method: string; url: string; body: any }[] = [];
  let n = 0;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    if (!url.startsWith("https://api.cloudflare.com/client/v4/zones/zone-1/custom_hostnames")) return json({ success: false, errors: [{ code: 7003, message: "no such route" }] }, 404);
    if ((init?.headers as Record<string, string>)?.authorization !== "Bearer token") return json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403);
    if (opts.refuse) return json({ success: false, errors: [{ code: 1406, message: "Invalid custom hostname" }] }, 400);
    if (method === "POST") {
      n++;
      return json({
        success: true,
        result: {
          id: "ch-" + n,
          hostname: body.hostname,
          status: "pending",
          ssl: { status: "pending_validation", method: body.ssl.method, type: body.ssl.type, validation_records: [{ http_url: `http://${body.hostname}/.well-known/pki-validation/x.txt`, http_body: "dcv-token" }] },
          ownership_verification: { type: "txt", name: "_cf-custom-hostname." + body.hostname, value: "ov-" + n },
        },
      });
    }
    const id = url.split("/").pop();
    if (method === "GET") {
      return json({ success: true, result: { id, hostname: "x", status: opts.active ? "active" : "pending", ssl: { status: opts.active ? "active" : "pending_validation" }, ownership_verification: { type: "txt", name: "_cf-custom-hostname.x", value: "ov" } } });
    }
    if (method === "DELETE") return json({ success: true, result: { id } });
    return json({ success: false, errors: [{ message: "unexpected" }] }, 400);
  };
  return { calls, fetcher, opts };
}

// enable gives a relay the Cloudflare client, backed by the fake.
async function enable(name: string, fake: ReturnType<typeof fakeCloudflare>) {
  await runInDurableObject(env.RELAY.getByName(name), async (r: Relay) => {
    r.hostnames = new Hostnames("token", "zone-1", fake.fetcher);
  });
}

describe("custom domains", () => {
  it("routes a custom hostname to its relay through KV and prints URLs with it", async () => {
    const owner = generateSecretKey();
    await rpc("alice.bind.ws", owner, "claim");
    await env.HOSTS.put("relay.alice.test", "alice");
    const doc = await info("relay.alice.test");
    expect(doc.name).toBe("alice");
    expect(doc.self_url).toBe("wss://relay.alice.test");
    expect(doc.pubkey).toBe((await info("alice.bind.ws")).pubkey);
    // An unknown host falls back to the dev relay, as before.
    expect((await info("nowhere.test")).name).toBe("dev");
  });

  it("checks hostnames strictly", () => {
    expect(checkHostname(" Relay.Example.com. ", "bind.ws")).toEqual({ host: "relay.example.com" });
    for (const bad of ["bind.ws", "x.bind.ws", "localhost", "a.localhost", "printer.local", "1.2.3.4", "::1", "single", "a..b", "-bad.example.com", "bad-.example.com", "a.123", "x".repeat(64) + ".com", ""]) {
      expect("error" in checkHostname(bad, "bind.ws"), bad).toBe(true);
    }
  });

  it("is off without the token", async () => {
    const owner = generateSecretKey();
    await rpc("plain.bind.ws", owner, "claim");
    const r = await rpc("plain.bind.ws", owner, "adddomain", "relay.plain.test");
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/^unsupported:/);
    expect((await rpc("plain.bind.ws", owner, "listdomains")).error).toMatch(/^unsupported:/);
    expect(await env.HOSTS.get("relay.plain.test")).toBeNull();
  });

  it("adds, checks and removes a domain, mapping it only after Cloudflare accepted", async () => {
    const host = "bob.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const fake = fakeCloudflare();
    await enable("bob", fake);

    // Refusals before any API call: bad names, a name another relay holds.
    expect((await rpc(host, owner, "adddomain", "x.bind.ws")).error).toMatch(/^invalid:/);
    await env.HOSTS.put("relay.carol.test", "carol");
    expect((await rpc(host, owner, "adddomain", "relay.carol.test")).error).toMatch(/another relay/);
    expect(fake.calls.length).toBe(0);
    // A member may not.
    expect((await rpc(host, generateSecretKey(), "adddomain", "relay.bob.test")).status).toBe(403);

    const added = await rpc(host, owner, "adddomain", "Relay.Bob.Test");
    expect(added.status, JSON.stringify(added)).toBe(200);
    expect(added.result.host).toBe("relay.bob.test");
    expect(added.result.ready).toBe(false);
    expect(added.result.records[0]).toMatchObject({ type: "CNAME", name: "relay.bob.test", value: "customers.bind.ws" });
    expect(added.result.records[1]).toMatchObject({ type: "TXT", name: "_cf-custom-hostname.relay.bob.test", value: "ov-1" });
    expect(fake.calls[0]).toMatchObject({ method: "POST", body: { hostname: "relay.bob.test", ssl: { method: "http", type: "dv" } } });
    expect(await env.HOSTS.get("relay.bob.test")).toBe("bob");
    expect((await rpc(host, owner, "adddomain", "relay.bob.test")).error).toMatch(/^duplicate:/);

    const list = (await rpc(host, owner, "listdomains")).result;
    expect(list.map((d: any) => d.host)).toEqual(["relay.bob.test"]);
    // The export never carries domains: they belong to this relay instance.
    expect((await rpc(host, owner, "exportconfig")).result.policy.customHosts).toBeUndefined();

    fake.opts.active = true;
    const checked = await rpc(host, owner, "checkdomain", "relay.bob.test");
    expect(checked.result.ready).toBe(true);
    expect(checked.result.records.length).toBe(1);
    expect(fake.calls.at(-1)).toMatchObject({ method: "GET", url: expect.stringMatching(/\/custom_hostnames\/ch-1$/) });
    expect((await rpc(host, owner, "listdomains")).result[0].status).toBe("active");

    for (let i = 1; i < MAX_CUSTOM_HOSTS; i++) expect((await rpc(host, owner, "adddomain", `r${i}.bob.test`)).status).toBe(200);
    expect((await rpc(host, owner, "adddomain", "one-too-many.bob.test")).error).toMatch(/^restricted: at most/);

    expect((await rpc(host, owner, "removedomain", "relay.bob.test")).result).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringMatching(/\/custom_hostnames\/ch-1$/) });
    expect(await env.HOSTS.get("relay.bob.test")).toBeNull();
    expect((await rpc(host, owner, "listdomains")).result.length).toBe(MAX_CUSTOM_HOSTS - 1);
    expect((await rpc(host, owner, "removedomain", "relay.bob.test")).error).toMatch(/^invalid:/);
    // The other relay's mapping was never touched.
    expect(await env.HOSTS.get("relay.carol.test")).toBe("carol");
  });

  it("writes nothing when Cloudflare refuses", async () => {
    const host = "dan.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await enable("dan", fakeCloudflare({ refuse: true }));
    const r = await rpc(host, owner, "adddomain", "relay.dan.test");
    expect(r.status).toBe(502);
    expect(r.error).toMatch(/^error: Cloudflare: Invalid custom hostname/);
    expect(await env.HOSTS.get("relay.dan.test")).toBeNull();
    expect((await rpc(host, owner, "listdomains")).result).toEqual([]);
  });

  it("teardown removes the domains from Cloudflare and KV", async () => {
    const host = "gonehost.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const fake = fakeCloudflare();
    await enable("gonehost", fake);
    expect((await rpc(host, owner, "adddomain", "relay.gone.test")).status).toBe(200);
    expect(await env.HOSTS.get("relay.gone.test")).toBe("gonehost");
    expect((await rpc(host, owner, "deleterelay", "gonehost")).result).toEqual({ deleted: true, name: "gonehost" });
    expect(fake.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/ch-1"))).toBe(true);
    expect(await env.HOSTS.get("relay.gone.test")).toBeNull();
  });
});
