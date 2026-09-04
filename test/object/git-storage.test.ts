// Owner-only inventory reports compare a bounded physical listing with the
// repository root and the durable reservation ledger. They never mutate R2.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { encodePack } from "ntig";
import { KIND_REPO, KIND_REPO_STATE } from "../../src/kinds.ts";
import { gitRepositoryPath } from "../../src/grasp-policy.ts";
import { repository } from "../../src/grasp-state.ts";
import { gitRepository } from "../../src/grasp.ts";
import type { Relay } from "../../src/relay.ts";
import { ev, nip98, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

const encoder = new TextEncoder();
const objectID = async (type: string, bytes: Uint8Array) => {
  const head = encoder.encode(`${type} ${bytes.length}\0`);
  const input = new Uint8Array(head.length + bytes.length);
  input.set(head); input.set(bytes, head.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", input)), (b) => b.toString(16).padStart(2, "0")).join("");
};
async function tinyPack() {
  const blob = encoder.encode("inventory\n");
  const blobID = await objectID("blob", blob);
  const tree = new Uint8Array([...encoder.encode("100644 README\0"), ...Uint8Array.from(blobID.match(/../g)!, (x) => parseInt(x, 16))]);
  const treeID = await objectID("tree", tree);
  const commit = encoder.encode(`tree ${treeID}\nauthor inventory <inventory@example.com> 1 +0000\ncommitter inventory <inventory@example.com> 1 +0000\n\ninitial\n`);
  const commitID = await objectID("commit", commit);
  return { commitID, pack: await encodePack([{ type: "blob", data: blob }, { type: "tree", data: tree }, { type: "commit", data: commit }]) };
}
async function seed(host: string, format = 1) {
  const owner = generateSecretKey();
  const stranger = generateSecretKey();
  const moderator = generateSecretKey();
  const identifier = "inventory";
  await rpc(host, owner, "claim");
  await rpc(host, owner, "applypreset", "grasp");
  await rpc(host, owner, "setmember", pk(moderator), { role: "moderator" });
  const path = gitRepositoryPath(npubEncode(pk(owner)), identifier);
  const c = await WS.connect(host);
  const announcement = ev(owner, KIND_REPO, "", [["d", identifier], ["clone", `https://${host}${path}`], ["relays", `wss://${host}`], ["maintainers", pk(owner)]]);
  expect((await c.ok(announcement)).ok).toBe(true);
  c.ws.close();
  const pack = await tinyPack();
  await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
    const repo = repository(relay, pk(owner), identifier)!;
    await relay.repositoryAccess.run("control", async () => {
      const wal = await gitRepository(relay, repo);
      await wal.commit({ id: "inventory-initial", updates: [{ name: "refs/heads/main", old: null, new: pack.commitID }], pack: pack.pack });
      if (format === 2) await wal.checkpoint();
    }, () => Promise.reject(new Error("repository access unexpectedly refused during fixture setup")));
  });
  return { owner, stranger, moderator, identifier };
}

async function scan(relay: Relay, host: string, owner: Uint8Array, identifier: string) {
  const url = `http://${host}/`;
  const payload = { method: "gitstorage", params: [pk(owner), identifier] };
  const authorization = await nip98(owner, url, "POST", payload);
  return relay.fetch(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/nostr+json+rpc" }, body: JSON.stringify(payload) }));
}

function proxyBucket(relay: Relay, overrides: Record<string, unknown>) {
  const original = relay.media;
  const calls: string[] = [];
  const observed = new Proxy(original, { get(target, name) {
    calls.push(String(name));
    if (name in overrides) return overrides[name as string];
    if (name !== "get" && name !== "list") throw new Error(`unexpected R2 method ${String(name)}`);
    const value = Reflect.get(target, name, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  Object.defineProperty(relay, "media", { value: observed, configurable: true });
  return { calls, restore: () => Object.defineProperty(relay, "media", { value: original, configurable: true }) };
}

describe("Git storage inventory management", () => {
  it.each([1, 2])("returns a complete format-%i report only to the owner", async (format) => {
    const host = `git-storage-owner-${format}.bind.ws`;
    const f = await seed(host, format);
    const report = await rpc(host, f.owner, "gitstorage", pk(f.owner), f.identifier);
    expect(report.status, JSON.stringify(report)).toBe(200);
    expect(report.result.inventory.format).toBe(format);
    expect(report.result.inventory.sequence).toBe(1);
    expect(report.result.inventory.listed.keys).toBeGreaterThanOrEqual(3);
    expect(report.result.inventory.listed.bytes).toBeGreaterThan(0);
    expect(report.result.inventory.live.keys).toBe(report.result.inventory.listed.keys);
    expect(report.result.reservations.keys).toBe(report.result.inventory.listed.keys);
    expect(report.result.reservationMinusListedBytes).toBe(0);
    expect(report.result.operations.gets).toBeGreaterThan(0);
    expect(report.result.operations.lists).toBeGreaterThan(0);

    expect((await rpc(host, null, "gitstorage", pk(f.owner), f.identifier)).status).toBe(401);
    expect((await rpc(host, f.stranger, "gitstorage", pk(f.owner), f.identifier)).status).toBe(403);
    expect((await rpc(host, f.moderator, "gitstorage", pk(f.owner), f.identifier)).status).toBe(403);
    expect((await rpc(host, f.owner, "gitstorage", "not-a-pubkey", f.identifier)).status).toBe(400);
    expect((await rpc(host, f.owner, "gitstorage", pk(f.owner), "")).status).toBe(400);
    expect((await rpc(host, f.owner, "gitstorage", pk(f.owner), "../data")).status).toBe(404);
    expect((await rpc(host, f.owner, "gitstorage", pk(f.owner), f.identifier)).status).toBe(429);
  });

  it("uses only R2 get and list for a successful owner scan and releases its control scope", async () => {
    const host = "git-storage-methods.bind.ws";
    const f = await seed(host);
    const result = await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
      const bucket = proxyBucket(relay, {});
      try {
        const response = await scan(relay, host, f.owner, f.identifier);
        expect(response.status).toBe(200);
        const report = await response.json<any>();
        expect(report.result.reservations.bytes).toBe(report.result.inventory.listed.bytes);
        expect(report.result.inventory.authority).toBe(false);
        expect(report.result.inventory.gcCandidate).toBe(false);
        const before = bucket.calls.length;
        expect((await scan(relay, host, f.owner, f.identifier)).status).toBe(429);
        expect(bucket.calls).toHaveLength(before);
        return { calls: bucket.calls, busy: relay.repositoryAccess.busy };
      } finally { bucket.restore(); }
    });
    expect(result.calls.filter((name: string) => name === "get" || name === "list").length).toBe(result.calls.length);
    expect(result.calls).toContain("get");
    expect(result.calls).toContain("list");
    expect(result.busy).toBe(false);
  });

  it("returns 503 without a report when R2 fails and releases the control scope", async () => {
    const host = "git-storage-failure.bind.ws";
    const f = await seed(host);
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
      const bucket = proxyBucket(relay, { get: async () => { throw new Error("provider failure"); } });
      try {
        const response = await scan(relay, host, f.owner, f.identifier);
        expect(response.status).toBe(503);
        expect(await response.json<any>()).toEqual({ error: "error: Git inventory unavailable; no complete report" });
        expect(relay.repositoryAccess.busy).toBe(false);
      } finally { bucket.restore(); }
    });
  });

  it("returns 413 for an oversized listing page without leaving a lease", async () => {
    const host = "git-storage-budget.bind.ws";
    const f = await seed(host);
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
      const bucket = proxyBucket(relay, { list: async () => ({ objects: Array.from({ length: 10001 }, (_, i) => ({ key: `${relay.slug}/git/data/${i}`, size: 1 })), truncated: false, cursor: undefined }) });
      try {
        const response = await scan(relay, host, f.owner, f.identifier);
        expect(response.status).toBe(413);
        expect(await response.json<any>()).toEqual({ error: "restricted: Git inventory limit reached; no complete report" });
        expect(relay.repositoryAccess.busy).toBe(false);
      } finally { bucket.restore(); }
    });
  });

  it("holds control admission across the first R2 read and refuses Git, event and control work", async () => {
    const host = "git-storage-coordination.bind.ws";
    const f = await seed(host);
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const original = relay.media;
      const bucket = proxyBucket(relay, { get: async (key: string, options?: R2GetOptions) => {
        if (key.endsWith("/root.json")) { entered(); await blocked; }
        return original.get(key, options);
      } });
      const active = scan(relay, host, f.owner, f.identifier);
      try {
        await ready;
        expect(relay.repositoryAccess.busy).toBe(true);
        expect(relay.repositoryAccess.kind).toBe("control");
        const path = gitRepositoryPath(npubEncode(pk(f.owner)), f.identifier);
        const git = await relay.fetch(new Request(`http://${host}${path}/info/refs?service=git-upload-pack`));
        expect(git.status).toBe(429);
        const event = ev(f.owner, KIND_REPO_STATE, "", [["d", f.identifier], ["refs/heads/main", "a".repeat(40)]]);
        const admitted = await relay.acceptAny(event, relay.virtualConn(host, pk(f.owner)));
        expect(admitted.ok).toBe(false);
        expect(admitted.msg).toContain("relay operation in progress");
        const control = await scan(relay, host, f.owner, f.identifier);
        expect(control.status).toBe(429);
        release();
        const response = await active;
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      } finally {
        release();
        await active;
        bucket.restore();
      }
      expect(relay.repositoryAccess.busy).toBe(false);
    });
  });
});
