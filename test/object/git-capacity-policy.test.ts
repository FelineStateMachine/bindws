import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { DEFAULT_GIT_LIMITS, GiB, MiB } from "../../src/git-limits.ts";
import { Settings } from "../../src/settings.ts";
import { rpc } from "../helpers/relay.ts";

describe("per-relay Git capacity", () => {
  it("preserves partial changes through storage and config export while advertising the effective limits", async () => {
    const host = "git-capacity.bind.ws", other = "git-capacity-other.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(other, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true }, git: { maxRepositories: 256, maxRelayBytes: 6 * GiB } });
    const changed = await rpc(host, owner, "setpolicy", { git: { maxObjectBytes: 64 * MiB } });
    expect(changed.status).toBe(200);
    expect(changed.result.git).toEqual({ ...DEFAULT_GIT_LIMITS, maxRepositories: 256, maxRelayBytes: 6 * GiB, maxObjectBytes: 64 * MiB });
    expect((await rpc(other, owner, "getpolicy")).result.git).toEqual(DEFAULT_GIT_LIMITS);
    const doc = await (await SELF.fetch(`https://${host}/`, { headers: { accept: "application/nostr+json" } })).json<Record<string, unknown>>();
    expect(doc.git_limits).toEqual(changed.result.git);
    expect(doc.repo_acceptance_criteria).toContain("256 repositories");
    expect(doc.repo_acceptance_criteria).toContain("64 MiB per new object");
    const exported = (await rpc(host, owner, "exportconfig")).result;
    expect((await rpc(other, owner, "importconfig", exported)).status).toBe(200);
    expect((await rpc(other, owner, "getpolicy")).result.git).toEqual(changed.result.git);
    await runInDurableObject(env.RELAY.getByName("git-capacity"), async (instance) => {
      const settings = new Settings((instance as Relay).sql);
      settings.load();
      expect(settings.policy.git).toEqual(changed.result.git);
    });
  });

  it("refuses unauthorized and malformed settings without applying part of the patch", async () => {
    const host = "git-capacity-invalid.bind.ws", owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await rpc(host, generateSecretKey(), "setpolicy", { git: { maxRepositories: 512 } })).status).toBe(403);
    for (const git of [{ maxRepositories: -1 }, { maxPackBytes: 0 }, { maxRelayBytes: 10 * GiB }, { maxObjects: 1.5 }, { maxObjectBytes: "64" }, { maxRepositories: 256, typo: 1 }]) {
      expect((await rpc(host, owner, "setpolicy", { name: "should not change", git })).status).toBe(400);
    }
    const policy = (await rpc(host, owner, "getpolicy")).result;
    expect(policy.git).toEqual(DEFAULT_GIT_LIMITS);
    expect(policy.name).not.toBe("should not change");
    const plan = (await rpc(host, owner, "importconfig", { format: "bind.ws/relay-config/2", policy: { git: { maxObjects: 0 } } }, { dryRun: true })).result;
    expect(plan.warnings).toContain("policy.git: value not accepted");
    expect(plan.changes.policy).toEqual([]);
  });

  it("loads older saved policies with the new defaults and keeps valid overrides", async () => {
    await runInDurableObject(env.RELAY.getByName("git-capacity-upgrade"), async (instance) => {
      const relay = instance as Relay;
      relay.sql.exec("INSERT INTO settings(key,value) VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ name: "Older relay" }));
      const settings = new Settings(relay.sql);
      settings.load();
      expect(settings.policy.git).toEqual(DEFAULT_GIT_LIMITS);
      expect(settings.policy.name).toBe("Older relay");
      settings.update({ git: { ...settings.policy.git, maxRepositories: 300 } });
      const reloaded = new Settings(relay.sql);
      reloaded.load();
      expect(reloaded.policy.git.maxRepositories).toBe(300);
    });
  });
});
