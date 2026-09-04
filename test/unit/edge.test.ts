// The edge without Cloudflare (docs/16-hosting-without-cloudflare.md): the
// client's address comes from the proxy's header or not at all, and the
// lease door keeps its own count when there are no rate limit bindings.
import { describe, it, expect } from "vitest";
import { clientIP, leaseAllowed, LEASES_PER_IP_MINUTE } from "../../src/edge.ts";

const req = (headers: Record<string, string>) => new Request("http://x/", { headers });

describe("the client's address", () => {
  it("is cf-connecting-ip by default, the named header's last entry elsewhere, and unknown when the header is empty", () => {
    expect(clientIP(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }), {})).toBe("1.2.3.4");
    expect(clientIP(req({}), {})).toBe("unknown");
    expect(clientIP(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.7" }), { CLIENT_IP_HEADER: "x-forwarded-for" })).toBe("10.0.0.7");
    expect(clientIP(req({ "x-real-ip": "2001:db8::1" }), { CLIENT_IP_HEADER: "x-real-ip" })).toBe("2001:db8::1");
    expect(clientIP(req({ "x-forwarded-for": "" }), { CLIENT_IP_HEADER: "x-forwarded-for" })).toBe("unknown");
    // Empty: nothing a client sends counts as an address.
    expect(clientIP(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }), { CLIENT_IP_HEADER: "" })).toBe("unknown");
  });
});

describe("the lease door without rate limit bindings", () => {
  it("allows a few per address per minute and then refuses, per address", async () => {
    const none = {};
    for (let i = 0; i < LEASES_PER_IP_MINUTE; i++) expect(await leaseAllowed(none, "203.0.113.1")).toBe(true);
    expect(await leaseAllowed(none, "203.0.113.1")).toBe(false);
    expect(await leaseAllowed(none, "203.0.113.2")).toBe(true);
  });

  it("uses the bindings when both exist", async () => {
    const calls: string[] = [];
    const binding = (ok: boolean): RateLimit => ({ limit: async ({ key }) => (calls.push(key), { success: ok }) });
    expect(await leaseAllowed({ LEASE_LIMIT_IP: binding(true), LEASE_LIMIT_ALL: binding(true) }, "203.0.113.9")).toBe(true);
    expect(await leaseAllowed({ LEASE_LIMIT_IP: binding(true), LEASE_LIMIT_ALL: binding(false) }, "203.0.113.9")).toBe(false);
    expect(calls).toEqual(["203.0.113.9", "all", "203.0.113.9", "all"]);
  });
});
