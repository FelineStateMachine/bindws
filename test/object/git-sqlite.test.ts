import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodePack, type GitObject } from "ntig";
import { GitSqliteRepository } from "../../src/git-sqlite.ts";
import { GIT_SQLITE_SCHEMA } from "../../src/git-sqlite.ts";
import type { Relay } from "../../src/relay.ts";

const oid = async (type: string, data: Uint8Array) => {
  const header = new TextEncoder().encode(`${type} ${data.length}\0`);
  const bytes = new Uint8Array(header.length + data.length);
  bytes.set(header);
  bytes.set(data, header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
};

async function fixture(): Promise<{ pack: Uint8Array; commit: string }> {
  const blobData = new TextEncoder().encode("hello\n");
  const blob = await oid("blob", blobData);
  const treeData = new Uint8Array(6 + 5 + 1 + 20);
  treeData.set(new TextEncoder().encode("100644 file\0"));
  treeData.set(new Uint8Array(await hexBytes(blob)), 12);
  const tree = await oid("tree", treeData);
  const commitData = new TextEncoder().encode(`tree ${tree}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nfirst\n`);
  const commit = await oid("commit", commitData);
  const objects: GitObject[] = [
    { oid: blob, type: "blob", data: blobData },
    { oid: tree, type: "tree", data: treeData },
    { oid: commit, type: "commit", data: commitData },
  ];
  return { pack: await encodePack(objects), commit };
}

async function hexBytes(value: string): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

function repository(relay: Relay, name: string, options: Partial<ConstructorParameters<typeof GitSqliteRepository>[0]> = {}) {
  relay.sql.exec(GIT_SQLITE_SCHEMA);
  return new GitSqliteRepository({ sql: relay.sql, repository: name, transactionSync: (closure) => relay.storage.transactionSync(closure), ...options });
}

describe("GitSqliteRepository", () => {
  it("publishes compressed objects, refs and receipts in one DO transaction", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-basic"), async (relay: Relay) => {
      const repo = repository(relay, "basic");
      const fixtureData = await fixture();
      const receipt = await repo.commit({ id: "first", updates: [{ name: "refs/heads/main", old: null, new: fixtureData.commit }], pack: fixtureData.pack });
      expect(receipt).toEqual({ id: "first", sequence: 1, replayed: false });
      expect((await repo.loadRefs()).refs).toEqual({ "refs/heads/main": fixtureData.commit });
      expect(await repo.commit({ id: "first", updates: [{ name: "refs/heads/main", old: null, new: fixtureData.commit }], pack: fixtureData.pack })).toEqual({ id: "first", sequence: 1, replayed: true });
      expect(repo.hasObjectSync(fixtureData.commit)).toBe(true);
      expect(relay.sql.exec<{ compressed_bytes: number }>("SELECT compressed_bytes FROM git_sqlite_meta WHERE repository=?", "basic").one().compressed_bytes).toBeGreaterThan(0);
    });
  });

  it("keeps accepting commits after the legacy 128 record boundary", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-many"), async (relay: Relay) => {
      const repo = repository(relay, "many");
      const fixtureData = await fixture();
      await repo.commit({ id: "seed", updates: [{ name: "refs/heads/main", old: null, new: fixtureData.commit }], pack: fixtureData.pack });
      let old = fixtureData.commit;
      for (let sequence = 1; sequence <= 130; sequence++) {
        const name = `refs/tags/t${sequence}`;
        await repo.commit({ id: `r${sequence}`, updates: [{ name, old: null, new: old }] });
      }
      expect((await repo.loadRefs()).sequence).toBe(131);
    });
  });

  it("rolls back objects, refs and receipts when quota admission rejects", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-quota"), async (relay: Relay) => {
      const repo = repository(relay, "quota", { quota: () => { throw new Error("quota rejected"); } });
      const fixtureData = await fixture();
      await expect(repo.commit({ id: "rejected", updates: [{ name: "refs/heads/main", old: null, new: fixtureData.commit }], pack: fixtureData.pack })).rejects.toThrow("quota rejected");
      expect((await repo.loadRefs()).sequence).toBe(0);
      expect(repo.hasObjectSync(fixtureData.commit)).toBe(false);
      expect(relay.sql.exec("SELECT 1 AS present FROM git_sqlite_receipts WHERE repository=?", "quota").toArray()).toHaveLength(0);
    });
  });

  it("reports indexed links without reading an object body and detects stored corruption", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-corruption"), async (relay: Relay) => {
      const meter: Array<{ rowsRead: number; rowsWritten: number }> = [];
      const repo = repository(relay, "corruption", { meter: (event) => meter.push(event) });
      const fixtureData = await fixture();
      await repo.commit({ id: "stored", updates: [{ name: "refs/heads/main", old: null, new: fixtureData.commit }], pack: fixtureData.pack });
      const info = await repo.getObjectInfo(fixtureData.commit);
      expect(info?.type).toBe("commit");
      expect(info?.links[0]?.type).toBe("tree");
      expect(meter.length).toBeGreaterThan(0);
      relay.sql.exec("UPDATE git_sqlite_object_chunks SET data=? WHERE repository=? AND oid=? AND chunk=0", new ArrayBuffer(1), "corruption", fixtureData.commit);
      await expect(repo.getObject(fixtureData.commit)).rejects.toThrow(/Corrupt Git object/);
    });
  });
});
