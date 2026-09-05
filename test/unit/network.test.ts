import { describe, it, expect, vi } from "vitest";
const { manifest, validateManifest, cleanup, usageDelta } = await import(new URL("../../scripts/ops/network.mjs", import.meta.url).href);

describe("network cleanup", () => {
  it("rejects a recovery manifest that points outside its run before making a request", async () => {
    const m = manifest();
    m.nodes[0].state = "claimed";
    m.nodes[0].url = "https://someone-else.bind.ws/";
    const call = vi.fn();
    await expect(cleanup(m, vi.fn(), call)).rejects.toThrow("manifest target");
    expect(call).not.toHaveBeenCalled();
  });

  it("recovers a lost claim reply and persists each deletion independently", async () => {
    const m = manifest();
    m.nodes[0].state = "claiming";
    m.nodes[1].state = "claimed";
    const saved: string[][] = [];
    const call = vi.fn(async (n: { owner: string; slug: string }, _key: unknown, method: string, slug?: string) => {
      if (method === "getpolicy") return { owner: m.actors[n.owner].pubkey };
      expect(method).toBe("deleterelay");
      expect(slug).toBe(n.slug);
      return { deleted: true, name: slug };
    });
    const results = await cleanup(m, async () => saved.push(m.nodes.map((n: { state: string }) => n.state)), call);
    expect(results).toHaveLength(2);
    expect(results.every((r: { deleted: boolean }) => r.deleted)).toBe(true);
    expect(saved).toHaveLength(2);
    expect(saved[0][0]).toBe("claiming");
    expect(saved[1][0]).toBe("deleted");
    expect(call).toHaveBeenCalledTimes(4);
  });

  it("continues after a failed deletion and never deletes a mismatched owner", async () => {
    const m = manifest();
    m.nodes[0].state = "claimed";
    m.nodes[1].state = "claimed";
    const call = vi.fn(async (n: { role: string; owner: string; slug: string }, _key: unknown, method: string) => {
      if (method === "getpolicy") return { owner: n.role === "peer-b" ? "ff".repeat(32) : m.actors[n.owner].pubkey };
      return { deleted: true, name: n.slug };
    });
    const r = await cleanup(m, vi.fn(), call);
    expect(r[0].deleted).toBe(false);
    expect(r[1].deleted).toBe(true);
    expect(call.mock.calls.filter((c) => c[2] === "deleterelay")).toHaveLength(1);
    expect(m.nodes[1].state).toBe("claimed");
  });

  it("treats only the authenticated unclaimed response as an already completed deletion", async () => {
    const m = manifest();
    m.nodes[0].state = "claiming";
    const call = vi.fn(async () => { throw Object.assign(new Error("restricted: this relay is unclaimed"), { status: 403 }); });
    expect((await cleanup(m, vi.fn(), call))[0].deleted).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    m.nodes[0].state = "claiming";
    call.mockImplementation(async () => { throw Object.assign(new Error("restricted: not the relay owner"), { status: 403 }); });
    expect((await cleanup(m, vi.fn(), call))[0].deleted).toBe(false);
    expect(m.nodes[0].state).toBe("claiming");
  });

  it("keeps malformed successful ownership responses pending for recovery", async () => {
    for (const policy of [null, undefined, false, {}, { owner: "" }]) {
      const m = manifest();
      m.nodes[0].state = "claimed";
      const call = vi.fn(async () => policy);
      const results = await cleanup(m, vi.fn(), call);
      expect(results[0].deleted).toBe(false);
      expect(m.nodes[0].state).toBe("claimed");
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects duplicate nodes and a secret that does not match the recorded owner", () => {
    const m = manifest();
    m.nodes[1] = { ...m.nodes[0] };
    expect(() => validateManifest(m)).toThrow("manifest target");
    const second = manifest();
    second.actors.alice.pubkey = second.actors.bob.pubkey;
    expect(() => validateManifest(second)).toThrow("manifest owner");
  });
});

it("reports counter deltas without confusing flags or absent samples with zero usage", () => {
  expect(usageDelta({ activeMs: 2, outOfFuel: false }, { activeMs: 9, outOfFuel: true, rowsRead: 10 })).toEqual({ activeMs: 7 });
});
