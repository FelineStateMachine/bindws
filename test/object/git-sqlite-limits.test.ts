import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodePack, type GitObject } from "ntig";
import { zlibSync } from "fflate";
import { GitSqliteRepository, GIT_SQLITE_SCHEMA } from "../../src/git-sqlite.ts";
import type { Relay } from "../../src/relay.ts";

const encoder = new TextEncoder();

async function objectId(type: GitObject["type"], data: Uint8Array): Promise<string> {
  const header = encoder.encode(`${type} ${data.length}\0`);
  const input = new Uint8Array(header.length + data.length);
  input.set(header);
  input.set(data, header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", input)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function commitObjects(message: string, parent: string | null, blobData = encoder.encode(`${message}\n`)) {
  const blob = await objectId("blob", blobData);
  const treeData = new Uint8Array(12 + 20);
  treeData.set(encoder.encode("100644 file\0"));
  treeData.set(hexBytes(blob), 12);
  const tree = await objectId("tree", treeData);
  const parentLine = parent ? `parent ${parent}\n` : "";
  const commitData = encoder.encode(`tree ${tree}\n${parentLine}author Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\n${message}\n`);
  const commit = await objectId("commit", commitData);
  const objects: GitObject[] = [
    { oid: blob, type: "blob", data: blobData },
    { oid: tree, type: "tree", data: treeData },
    { oid: commit, type: "commit", data: commitData },
  ];
  return { commit, pack: await encodePack(objects), rawBytes: objects.reduce((size, object) => size + object.data.length, 0), objects };
}

async function malformedGraph(wrongType: boolean) {
  const targetData = new Uint8Array();
  const target = await objectId("tree", targetData);
  const targetObject: GitObject = { oid: target, type: "tree", data: targetData };
  const targetOid = wrongType ? target : "f".repeat(40);
  const treeData = new Uint8Array(12 + 20);
  treeData.set(encoder.encode("100644 file\0"));
  treeData.set(hexBytes(targetOid), 12);
  const tree = await objectId("tree", treeData);
  const commitData = encoder.encode(`tree ${tree}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nmalformed\n`);
  const commit = await objectId("commit", commitData);
  const objects: GitObject[] = [
    ...(wrongType ? [targetObject] : []),
    { oid: tree, type: "tree", data: treeData },
    { oid: commit, type: "commit", data: commitData },
  ];
  return { commit, pack: await encodePack(objects) };
}

function hexBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index++) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

function repo(relay: Relay, name: string, options: Partial<ConstructorParameters<typeof GitSqliteRepository>[0]> = {}) {
  relay.sql.exec(GIT_SQLITE_SCHEMA);
  return new GitSqliteRepository({
    sql: relay.sql,
    repository: name,
    transactionSync: (closure) => relay.storage.transactionSync(closure),
    ...options,
  });
}

describe("GitSqliteRepository limits and transaction behavior", () => {
  it("keeps a distinct-object history beyond 128 commits and survives reconstruction", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-history-limits"), async (relay: Relay) => {
      let repository = repo(relay, "history");
      let parent: string | null = null;
      for (let index = 0; index < 130; index++) {
        const next = await commitObjects(`commit-${index}`, parent);
        await repository.commit({ id: `commit-${index}`, updates: [{ name: "refs/heads/main", old: parent, new: next.commit }], pack: next.pack });
        parent = next.commit;
      }
      expect((await repository.loadRefs()).sequence).toBe(130);
      const objectCount = relay.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM git_sqlite_objects WHERE repository=?", "history").one().count;
      expect(objectCount).toBe(390);

      repository = repo(relay, "history");
      expect((await repository.loadRefs()).refs["refs/heads/main"]).toBe(parent);
      expect(await repository.getObject(parent!)).not.toBeNull();
      const before = relay.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM git_sqlite_objects WHERE repository=?", "history").one().count;
      await repository.commit({ id: "duplicate-payload", updates: [{ name: "refs/tags/repeated", old: null, new: parent }] });
      expect(relay.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM git_sqlite_objects WHERE repository=?", "history").one().count).toBe(before);
    });
  });

  it("allows only one concurrent compare-and-set publication", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-cas"), async (relay: Relay) => {
      const repository = repo(relay, "cas");
      const seed = await commitObjects("seed", null);
      await repository.commit({ id: "seed", updates: [{ name: "refs/heads/main", old: null, new: seed.commit }], pack: seed.pack });
      const left = await commitObjects("left", seed.commit);
      const right = await commitObjects("right", seed.commit);
      const results = await Promise.allSettled([
        repository.commit({ id: "left", updates: [{ name: "refs/heads/main", old: seed.commit, new: left.commit }], pack: left.pack }),
        repository.commit({ id: "right", updates: [{ name: "refs/heads/main", old: seed.commit, new: right.commit }], pack: right.pack }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected" && /changed|Ref changed/.test(String(result.reason)))).toHaveLength(1);
      expect((await repository.loadRefs()).sequence).toBe(2);
    });
  });

  it("rolls back the complete publication when onCommit fails, while afterCommit runs after commit", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-hooks"), async (relay: Relay) => {
      const failing = repo(relay, "hook-failure", { onCommit: () => { throw new Error("hook failed"); } });
      const first = await commitObjects("hook", null);
      await expect(failing.commit({ id: "hook", updates: [{ name: "refs/heads/main", old: null, new: first.commit }], pack: first.pack })).rejects.toThrow("hook failed");
      expect((await failing.loadRefs()).sequence).toBe(0);
      expect(failing.hasObjectSync(first.commit)).toBe(false);
      expect(relay.sql.exec("SELECT 1 AS present FROM git_sqlite_receipts WHERE repository=?", "hook-failure").toArray()).toHaveLength(0);

      let after = 0;
      const succeeding = repo(relay, "after-hook", { afterCommit: () => { after++; throw new Error("after failed"); } });
      const second = await commitObjects("after", null);
      await expect(succeeding.commit({ id: "after", updates: [{ name: "refs/heads/main", old: null, new: second.commit }], pack: second.pack })).rejects.toThrow("after failed");
      expect(after).toBe(1);
      expect((await succeeding.loadRefs()).sequence).toBe(1);
    });
  });

  it("captures request data before asynchronous hashing", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-request-capture"), async (relay: Relay) => {
      const repository = repo(relay, "capture");
      const next = await commitObjects("captured", null);
      const request = { id: "captured", updates: [{ name: "refs/heads/main", old: null, new: next.commit }], pack: next.pack };
      const pending = repository.commit(request);
      request.id = "mutated";
      request.updates[0].name = "refs/heads/mutated";
      request.pack.fill(0);
      await pending;
      expect((await repository.loadRefs()).refs["refs/heads/main"]).toBe(next.commit);
      expect(await repository.lookupRecord("captured")).not.toBeNull();
    });
  });

  it("deduplicates an identical object pack on a later ref publication", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-dedup-pack"), async (relay: Relay) => {
      const repository = repo(relay, "dedup");
      const next = await commitObjects("dedup", null);
      await repository.commit({ id: "first", updates: [{ name: "refs/heads/main", old: null, new: next.commit }], pack: next.pack });
      const before = relay.sql.exec<{ count: number; compressed: number }>("SELECT object_count AS count, compressed_bytes AS compressed FROM git_sqlite_meta WHERE repository=?", "dedup").one();
      await repository.commit({ id: "second", updates: [{ name: "refs/tags/repeated", old: null, new: next.commit }], pack: next.pack });
      const after = relay.sql.exec<{ count: number; compressed: number }>("SELECT object_count AS count, compressed_bytes AS compressed FROM git_sqlite_meta WHERE repository=?", "dedup").one();
      expect(after).toEqual(before);
      expect((await repository.loadRefs()).refs["refs/tags/repeated"]).toBe(next.commit);
    });
  });

  it("runs authority checks again for an identical retry after access is revoked", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-retry-authority"), async (relay: Relay) => {
      const repository = repo(relay, "retry-authority");
      const next = await commitObjects("retry", null);
      const request = { id: "retry", updates: [{ name: "refs/heads/main", old: null, new: next.commit }], pack: next.pack };
      await repository.commit(request);
      let revoked = false;
      await expect(repository.commit(request, () => { if (revoked) throw new Error("revoked"); })).resolves.toEqual({ id: "retry", sequence: 1, replayed: true });
      revoked = true;
      await expect(repository.commit(request, () => { if (revoked) throw new Error("revoked"); })).rejects.toThrow("revoked");
      expect((await repository.loadRefs()).sequence).toBe(1);
    });
  });

  it("reports the actual rows read and written by SQL cursors", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-metering"), async (relay: Relay) => {
      relay.sql.exec(GIT_SQLITE_SCHEMA);
      let observedRead = 0;
      let observedWritten = 0;
      const sql = {
        exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
          const cursor = relay.sql.exec<T>(query, ...bindings);
          const toArray = cursor.toArray.bind(cursor);
          return {
            toArray() { const rows = toArray(); observedRead += cursor.rowsRead; observedWritten += cursor.rowsWritten; return rows; },
            get rowsRead() { return cursor.rowsRead; },
            get rowsWritten() { return cursor.rowsWritten; },
          };
        },
      } as unknown as SqlStorage;
      let meteredRead = 0;
      let meteredWritten = 0;
      const repository = new GitSqliteRepository({ sql, repository: "metering", transactionSync: (closure) => relay.storage.transactionSync(closure), meter: (event) => { meteredRead += event.rowsRead; meteredWritten += event.rowsWritten; } });
      const next = await commitObjects("meter", null);
      await repository.commit({ id: "meter", updates: [{ name: "refs/heads/main", old: null, new: next.commit }], pack: next.pack });
      await repository.loadRefs();
      expect(meteredRead).toBe(observedRead);
      expect(meteredWritten).toBe(observedWritten);
      expect(meteredWritten).toBeGreaterThan(0);
    });
  });

  it("enforces cumulative raw and object quotas across individually valid pushes", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-cumulative-limits"), async (relay: Relay) => {
      const first = await commitObjects("first", null);
      const second = await commitObjects("second", first.commit);
      const rawLimited = repo(relay, "raw-cumulative", { limits: { maxRawBytes: first.rawBytes + 1 } });
      await rawLimited.commit({ id: "first", updates: [{ name: "refs/heads/main", old: null, new: first.commit }], pack: first.pack });
      await expect(rawLimited.commit({ id: "second", updates: [{ name: "refs/heads/main", old: first.commit, new: second.commit }], pack: second.pack })).rejects.toThrow();
      const objectLimited = repo(relay, "object-cumulative", { limits: { maxObjects: 3 } });
      await objectLimited.commit({ id: "first", updates: [{ name: "refs/heads/main", old: null, new: first.commit }], pack: first.pack });
      await expect(objectLimited.commit({ id: "second", updates: [{ name: "refs/heads/main", old: first.commit, new: second.commit }], pack: second.pack })).rejects.toThrow();
    });
  });

  it("rejects dangling and wrong-type graph links before publication", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-graph-validation"), async (relay: Relay) => {
      for (const [name, wrongType] of [["dangling", false], ["wrong-type", true]] as const) {
        const repository = repo(relay, name);
        const malformed = await malformedGraph(wrongType);
        await expect(repository.commit({ id: name, updates: [{ name: "refs/heads/main", old: null, new: malformed.commit }], pack: malformed.pack })).rejects.toThrow();
        expect((await repository.loadRefs()).sequence).toBe(0);
      }
    });
  });

  it("enforces raw, compressed, object, pack, and metadata budgets", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-budget-limits"), async (relay: Relay) => {
      const next = await commitObjects("budget", null, new Uint8Array(1024));
      const cases: Array<[string, Partial<import("../../src/git-sqlite.ts").GitSqliteLimits>]> = [
        ["raw", { maxTransactionRawBytes: 100 }],
        ["compressed", { maxCompressedBytes: 1 }],
        ["objects", { maxObjects: 2 }],
        ["pack", { maxPackBytes: next.pack.length - 1 }],
        ["metadata", { maxMetadataBytes: 1 }],
      ];
      for (const [name, limits] of cases) {
        const repository = repo(relay, `budget-${name}`, { limits });
        await expect(repository.commit({ id: name, updates: [{ name: "refs/heads/main", old: null, new: next.commit }], pack: next.pack })).rejects.toThrow();
        expect((await repository.loadRefs()).sequence).toBe(0);
      }
    });
  });

  it("keeps retained capacity separate from one-operation decode capacity", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-operation-limits"), async (relay: Relay) => {
      const next = await commitObjects("operation-limits", null);
      const retained = repo(relay, "operation-limits", { limits: { maxTransactionObjects: 8, maxTransactionRawBytes: 1024 * 1024 } });
      await retained.commit({ id: "seed", updates: [{ name: "refs/heads/main", old: null, new: next.commit }], pack: next.pack });
      const bounded = repo(relay, "operation-limits", { limits: { maxTransactionObjects: 2, maxTransactionRawBytes: 1024 * 1024 } });
      const snapshot = await bounded.load();
      expect(snapshot.refs["refs/heads/main"]).toBe(next.commit);
      expect(snapshot.packs).toHaveLength(0);
      expect(await bounded.getObject(next.commit)).not.toBeNull();
    });
  });

  it("round trips a near-4 MiB incompressible blob through multiple chunks", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-large-object"), async (relay: Relay) => {
      const blob = new Uint8Array(4 * 1024 * 1024);
      for (let offset = 0; offset < blob.length; offset += 65536) crypto.getRandomValues(blob.subarray(offset, offset + 65536));
      const next = await commitObjects("large", null, blob);
      const repository = repo(relay, "large", { limits: { maxPackBytes: 8 * 1024 * 1024, maxTransactionRawBytes: 8 * 1024 * 1024, maxRawBytes: 8 * 1024 * 1024, maxCompressedBytes: 8 * 1024 * 1024, chunkBytes: 256 * 1024 } });
      await repository.commit({ id: "large", updates: [{ name: "refs/heads/main", old: null, new: next.commit }], pack: next.pack });
      const stored = await repository.getObject(await objectId("blob", blob));
      expect(stored?.data).toEqual(blob);
      expect(relay.sql.exec<{ chunks: number }>("SELECT chunks FROM git_sqlite_objects WHERE repository=? AND oid=?", "large", stored!.oid).one().chunks).toBeGreaterThan(1);
    });
  });

  it("round trips a 37 MiB object through indexed chunk reads", async () => {
    await runInDurableObject(env.RELAY.getByName("git-sqlite-large-indexed-object"), async (relay: Relay) => {
      const blob = new Uint8Array(37 * 1024 * 1024);
      const repository = repo(relay, "large-indexed", {
        limits: {
          maxPackBytes: 64 * 1024 * 1024,
          maxObjectBytes: 64 * 1024 * 1024,
          maxTransactionRawBytes: 64 * 1024 * 1024,
          maxRawBytes: 64 * 1024 * 1024,
          maxCompressedBytes: 64 * 1024 * 1024,
        },
      });
      const oid = await objectId("blob", blob);
      const compressed = zlibSync(blob);
      const chunkBytes = 512 * 1024;
      relay.sql.exec("INSERT INTO git_sqlite_objects(repository,oid,type,raw_size,compressed_size,chunks) VALUES(?,?,?,?,?,?)", "large-indexed", oid, "blob", blob.length, compressed.length, Math.ceil(compressed.length / chunkBytes));
      for (let position = 0, chunk = 0; position < compressed.length; position += chunkBytes, chunk++) relay.sql.exec("INSERT INTO git_sqlite_object_chunks(repository,oid,chunk,data) VALUES(?,?,?,?)", "large-indexed", oid, chunk, compressed.subarray(position, position + chunkBytes).slice().buffer);
      const stored = await repository.getObject(oid);
      expect(stored?.data.length).toBe(blob.length);
      expect(stored?.data[0]).toBe(0);
      expect(stored?.data[blob.length - 1]).toBe(0);
    });
  }, 30_000);
});
