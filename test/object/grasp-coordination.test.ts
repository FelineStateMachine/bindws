// Real HTTP and alarm reads pause at R2 to expose the live instance's
// admission fences. These tests establish no crash-safe collection lease.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { KIND_REPO, KIND_REPO_STATE } from "../../src/kinds.ts";
import { gitRepositoryPath } from "../../src/grasp-policy.ts";
import { ev, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("GRASP coordination", () => {
  it.each([
    { mode: "http", outcome: "success" }, { mode: "http", outcome: "failure" },
    { mode: "alarm", outcome: "success" }, { mode: "alarm", outcome: "failure" },
  ])("a paused $mode read holds admission until $outcome", async ({ mode, outcome }) => {
    const host = `grasp-coordination-${mode}-${outcome}.bind.ws`;
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "applypreset", "grasp");
    const path = gitRepositoryPath(npubEncode(pk(owner)), "coordination");
    const announcement = ev(owner, KIND_REPO, "", [
      ["d", "coordination"], ["clone", `https://${host}${path}`],
      ["relays", `wss://${host}`], ["maintainers", pk(owner)],
    ]);
    const connection = await WS.connect(host);
    expect((await connection.ok(announcement)).ok).toBe(true);
    connection.ws.close();
    const state = ev(owner, KIND_REPO_STATE, "", [["d", "coordination"], ["refs/heads/main", "a".repeat(40)]]);
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
      const bucket = relay.media;
      let entered!: () => void;
      let release!: () => void;
      const atRead = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let gets = 0;
      let otherOperations = 0;
      let held = false;
      const observed = new Proxy(bucket, { get(target, name) {
        if (name === "get") return async (key: string, options?: R2GetOptions) => {
          gets++;
          if (!held && key.endsWith("/root.json")) {
            held = true;
            entered();
            await gate;
            if (outcome === "failure") throw new Error("injected R2 read failure");
          }
          return target.get(key, options);
        };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? (...args: unknown[]) => {
          otherOperations++;
          return Reflect.apply(value, target, args);
        } : value;
      } });
      Object.defineProperty(relay, "media", { value: observed, configurable: true });
      const request = () => new Request(`http://${host}${path}/info/refs?service=git-upload-pack`);
      const active = mode === "http" ? relay.fetch(request()) : relay.alarm();
      try {
        await atRead;
        expect(relay.repositoryAccess.busy).toBe(true);
        expect(relay.repositoryAccess.kind).toBe(mode === "http" ? "git" : "alarm");
        const before = gets;
        const otherBefore = otherOperations;
        const refused = await relay.fetch(request());
        expect(refused.status).toBe(429);
        await refused.arrayBuffer();
        expect(gets).toBe(before);
        const admission = await relay.acceptAny(state, relay.virtualConn(host, pk(owner)));
        expect(gets).toBe(before);
        expect(otherOperations).toBe(otherBefore);
        expect(admission.ok).toBe(false);
        expect(admission.msg).toContain("relay operation in progress");
        const management = await relay.fetch(new Request(`http://${host}/`, { method: "POST", body: "{}" }));
        expect(management.status).toBe(429);
        await management.arrayBuffer();
        if (mode === "http") await relay.alarm();
        expect(gets).toBe(before);
        expect(relay.repositoryAccess.busy).toBe(true);
        expect(relay.repositoryAccess.kind).toBe(mode === "http" ? "git" : "alarm");
        release();
        const response = await active;
        expect(relay.repositoryAccess.busy).toBe(false);
        const completedGets = gets;
        if (response) {
          expect(response.status).toBe(outcome === "failure" ? 503 : 200);
          await response.arrayBuffer();
          expect(gets).toBe(completedGets);
        }
      } finally {
        release();
        await active;
        Reflect.deleteProperty(relay, "media");
      }
    });
  });
});
