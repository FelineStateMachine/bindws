// Owner-only Git storage reports describe the SQLite repository without
// opening the R2 bucket or granting a maintenance action.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { encodePack } from "ntig";
import { KIND_REPO } from "../../src/kinds.ts";
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
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", input)), (x) => x.toString(16).padStart(2, "0")).join("");
};
async function tinyPack() {
  const blob = encoder.encode("inventory\n"), blobID = await objectID("blob", blob);
  const tree = new Uint8Array([...encoder.encode("100644 README\0"), ...Uint8Array.from(blobID.match(/../g)!, (x) => parseInt(x, 16))]);
  const treeID = await objectID("tree", tree);
  const commit = encoder.encode(`tree ${treeID}\nauthor inventory <inventory@example.com> 1 +0000\ncommitter inventory <inventory@example.com> 1 +0000\n\ninitial\n`);
  return { commitID: await objectID("commit", commit), pack: await encodePack([{ type: "blob", data: blob }, { type: "tree", data: tree }, { type: "commit", data: commit }]) };
}
async function seed(host: string) {
  const owner = generateSecretKey(), stranger = generateSecretKey(), moderator = generateSecretKey(), identifier = "inventory";
  await rpc(host, owner, "claim");
  await rpc(host, owner, "applypreset", "grasp");
  await rpc(host, owner, "setmember", pk(moderator), { role: "moderator" });
  const path = gitRepositoryPath(npubEncode(pk(owner)), identifier), c = await WS.connect(host);
  const announcement = ev(owner, KIND_REPO, "", [["d", identifier], ["clone", `https://${host}${path}`], ["relays", `wss://${host}`], ["maintainers", pk(owner)]]);
  expect((await c.ok(announcement)).ok).toBe(true); c.ws.close();
  const pack = await tinyPack();
  await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
    const repo = repository(relay, pk(owner), identifier)!;
    await relay.repositoryAccess.run("control", async () => {
      const git = await gitRepository(relay, repo);
      await git.commit({ id: "inventory-initial", updates: [{ name: "refs/heads/main", old: null, new: pack.commitID }], pack: pack.pack });
    }, () => Promise.reject(new Error("repository access unexpectedly refused during fixture setup")));
  });
  return { owner, stranger, moderator, identifier };
}
async function scan(relay: Relay, host: string, owner: Uint8Array, identifier: string) {
  const url = `http://${host}/`, payload = { method: "gitstorage", params: [pk(owner), identifier] };
  const authorization = await nip98(owner, url, "POST", payload);
  return relay.fetch(new Request(url, { method: "POST", headers: { authorization, "content-type": "application/nostr+json+rpc" }, body: JSON.stringify(payload) }));
}

describe("Git storage inventory management", () => {
  it("returns the SQLite object, ref and receipt totals only to the owner", async () => {
    const host = "git-storage-sql-owner.bind.ws", f = await seed(host);
    const report = await rpc(host, f.owner, "gitstorage", pk(f.owner), f.identifier);
    expect(report.status, JSON.stringify(report)).toBe(200);
    expect(report.result.backend).toBe("sqlite");
    expect(report.result.objects.count).toBeGreaterThanOrEqual(3);
    expect(report.result.objects.rawBytes).toBeGreaterThan(0);
    expect(report.result.objects.compressedBytes).toBeGreaterThan(0);
    expect(report.result.objects.metadataBytes).toBeGreaterThan(0);
    expect(report.result.refs).toBe(1);
    expect(report.result.receipts).toBe(1);
    expect(report.result.operations).toEqual({ gets: 0, lists: 0 });
    expect(report.result.physicalDatabaseBytes).toBeGreaterThan(0);
    expect(report.result.cooldownSeconds).toBe(60);
    expect((await rpc(host, null, "gitstorage", pk(f.owner), f.identifier)).status).toBe(401);
    expect((await rpc(host, f.stranger, "gitstorage", pk(f.owner), f.identifier)).status).toBe(403);
    expect((await rpc(host, f.moderator, "gitstorage", pk(f.owner), f.identifier)).status).toBe(403);
    expect((await rpc(host, f.owner, "gitstorage", "not-a-pubkey", f.identifier)).status).toBe(400);
    expect((await rpc(host, f.owner, "gitstorage", pk(f.owner), "")).status).toBe(400);
    expect((await rpc(host, f.owner, "gitstorage", pk(f.owner), "../data")).status).toBe(404);
    expect((await rpc(host, f.owner, "gitstorage", pk(f.owner), f.identifier)).status).toBe(429);
  });

  it("does not use R2 for a successful SQLite report and releases its control scope", async () => {
    const host = "git-storage-sql-methods.bind.ws", f = await seed(host);
    const result = await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
      const original = relay.media;
      Object.defineProperty(relay, "media", { value: new Proxy(original, { get() { throw new Error("SQLite inventory must not touch R2"); } }), configurable: true });
      try {
        const response = await scan(relay, host, f.owner, f.identifier);
        expect(response.status).toBe(200);
        const body = await response.json<any>();
        expect(body.result.operations).toEqual({ gets: 0, lists: 0 });
        expect(relay.repositoryAccess.busy).toBe(false);
        return body.result;
      } finally { Object.defineProperty(relay, "media", { value: original, configurable: true }); }
    });
    expect(result.backend).toBe("sqlite");
  });
});
