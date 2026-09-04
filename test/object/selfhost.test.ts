// A host without Cloudflare's edge (docs/16-hosting-without-cloudflare.md):
// a proxy can ask which hostnames are ours before it fetches certificates
// for them. The address and lease pieces are test/unit/edge.test.ts.
import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { hostnameKnown } from "../../src/edge.ts";

describe("which hostnames are ours", () => {
  it("knows the apex, valid and reserved names under it and mapped custom hostnames, and nothing else", async () => {
    const e = { DOMAIN: "bind.ws", HOSTS: env.HOSTS };
    await env.HOSTS.put("relay.example.org", "kitchen");
    expect(await hostnameKnown(e, "bind.ws")).toBe(true);
    expect(await hostnameKnown(e, "www.bind.ws")).toBe(true);
    expect(await hostnameKnown(e, "Kitchen.bind.ws.")).toBe(true);
    expect(await hostnameKnown(e, "api.bind.ws")).toBe(true);
    expect(await hostnameKnown(e, "relay.example.org")).toBe(true);
    expect(await hostnameKnown(e, "a.b.bind.ws")).toBe(false);
    expect(await hostnameKnown(e, "-bad.bind.ws")).toBe(false);
    expect(await hostnameKnown(e, "other.example.org")).toBe(false);
    expect(await hostnameKnown(e, "")).toBe(false);
  });

  it("answers a proxy's question on any host with a status and no body", async () => {
    const ask = async (domain: string) => (await SELF.fetch(`http://bind.ws/.well-known/bindws/hostname?domain=${encodeURIComponent(domain)}`)).status;
    expect(await ask("kitchen.bind.ws")).toBe(200);
    expect(await ask("bind.ws")).toBe(200);
    expect(await ask("nope.example.org")).toBe(404);
    const r = await SELF.fetch("http://anything.example/.well-known/bindws/hostname?domain=kitchen.bind.ws");
    expect([r.status, await r.text()]).toEqual([200, ""]);
  });
});
