// Checkpoint migration is exercised through bindws' repository store. The
// fixture is isolated to one Durable Object and never touches a production key.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { encodePack, type WalRecord } from "ntig";
import { KIND_REPO } from "../../src/kinds.ts";
import { repository } from "../../src/grasp-state.ts";
import { gitRepository } from "../../src/grasp.ts";
import type { RepositoryAnnouncement } from "../../src/grasp-policy.ts";
import { ev, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

const encoder = new TextEncoder();
const oid = async (type: string, data: Uint8Array) => {
  const header = encoder.encode(`${type} ${data.length}\0`);
  const input = new Uint8Array(header.length + data.length);
  input.set(header); input.set(data, header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", input)), (b) => b.toString(16).padStart(2, "0")).join("");
};

async function fixturePack() {
  const blob = encoder.encode("checkpoint fixture\n");
  const blobID = await oid("blob", blob);
  const tree = new Uint8Array([...encoder.encode("100644 README\0"), ...Uint8Array.from(blobID.match(/../g)!, (part) => parseInt(part, 16))]);
  const treeID = await oid("tree", tree);
  const commit = encoder.encode(`tree ${treeID}\nauthor ntig <ntig@example.com> 1 +0000\ncommitter ntig <ntig@example.com> 1 +0000\n\ncheckpoint\n`);
  const commitID = await oid("commit", commit);
  return { commitID, pack: await encodePack([{ type: "blob", data: blob }, { type: "tree", data: tree }, { type: "commit", data: commit }]) };
}

const announcement = (sk: Uint8Array, host: string, identifier: string) => ev(sk, KIND_REPO, "", [
  ["d", identifier],
  ["clone", `https://${host}/${npubEncode(pk(sk))}/${identifier}.git`],
  ["relays", `wss://${host}`],
  ["maintainers", pk(sk)],
]);

describe("GRASP checkpoint integration", () => {
  it("migrates an isolated legacy repository and retains indexed receipts", async () => {
    const host = "grasp-checkpoint.bind.ws";
    const owner = generateSecretKey();
    const identifier = "checkpoint";
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { features: { grasp: true } });
    const connection = await WS.connect(host);
    const event = announcement(owner, host, identifier);
    expect((await connection.ok(event)).ok).toBe(true);
    connection.ws.close();

    const fixture = await fixturePack();
    const measurements = await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
      const repo = repository(relay, pk(owner), identifier) as RepositoryAnnouncement | null;
      expect(repo).not.toBeNull();
      const wal = await gitRepository(relay, repo!);
      const first = await wal.commit({ id: "checkpoint-initial", updates: [{ name: "refs/heads/main", old: null, new: fixture.commitID }], pack: fixture.pack });
      const legacy: WalRecord[] = [];
      legacy.push((await wal.lookupRecord!(first.id))!);
      let prior = fixture.commitID;
      for (let i = 1; i < 128; i++) {
        const receipt = await wal.commit({ id: `checkpoint-legacy-${i}`, updates: [{ name: `refs/tags/legacy-${i}`, old: null, new: prior }] });
        legacy.push((await wal.lookupRecord!(receipt.id))!);
      }
      expect((await wal.load()).sequence).toBe(128);
      const before = relay.sql.exec<{ n: number; bytes: number }>("SELECT count(*) AS n, coalesce(sum(size),0) AS bytes FROM grasp_objects WHERE owner=?", pk(owner)).one();

      const migration = await wal.checkpoint();
      expect(migration).toEqual({ sequence: 128, changed: true });
      expect(await wal.checkpoint()).toEqual({ sequence: 128, changed: false });
      const migrated = await wal.load();
      expect(migrated.checkpoint?.manifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(migrated.records).toHaveLength(1);
      expect(migrated.refs["refs/heads/main"]).toBe(fixture.commitID);
      expect(await wal.lookupRecord!(legacy[0]!.id)).toMatchObject({ id: legacy[0]!.id, sequence: 1 });

      // Format 2 allows more than the legacy 128-record ceiling. Ref-only
      // commits exercise manifest/index growth without creating more packs.
      for (let i = 128; i < 260; i++) {
        await wal.commit({ id: `checkpoint-v2-${i}`, updates: [{ name: `refs/tags/v2-${i}`, old: null, new: prior }] });
      }
      const replay = await wal.commit({ id: first.id, updates: [{ name: "refs/heads/main", old: null, new: fixture.commitID }], pack: fixture.pack });
      expect(replay).toMatchObject({ id: first.id, sequence: 1, replayed: true });
      const rebuilt = await gitRepository(relay, repo!);
      const cold = await rebuilt.load();
      expect(cold.sequence).toBe(260);
      expect(cold.refs["refs/tags/v2-259"]).toBe(fixture.commitID);
      const advertised = await rebuilt.loadRefs!();
      expect(advertised.sequence).toBe(260);
      expect(advertised.refs["refs/heads/main"]).toBe(fixture.commitID);
      expect(await rebuilt.lookupRecord!("checkpoint-legacy-127")).toMatchObject({ sequence: 128 });
      expect(await rebuilt.lookupRecord!("missing-checkpoint-receipt")).toBeNull();

      const after = relay.sql.exec<{ n: number; bytes: number }>("SELECT count(*) AS n, coalesce(sum(size),0) AS bytes FROM grasp_objects WHERE owner=?", pk(owner)).one();
      const keys = relay.sql.exec<{ key: string; size: number }>("SELECT key, size FROM grasp_objects WHERE owner=? ORDER BY key", pk(owner)).toArray();
      const categories = keys.reduce<Record<string, number>>((counts, { key }) => {
        const category = key.split("/").at(-2) ?? key;
        counts[category] = (counts[category] ?? 0) + 1;
        return counts;
      }, {});
      return { before, after, keyCount: keys.length, categories, sequence: cold.sequence };
    });

    console.info("checkpoint storage measurement", {
      beforeObjects: measurements.before.n,
      afterObjects: measurements.after.n,
      beforeBytes: measurements.before.bytes,
      afterBytes: measurements.after.bytes,
      retainedKeys: measurements.keyCount,
      sequence: measurements.sequence,
    });
    // The accounting adapter retains every immutable manifest/index/receipt
    // write. This is intentionally observational: no successful PUT sum is
    // treated as net storage, and the test records the retained SQL totals.
    expect(measurements.after.n).toBeGreaterThan(measurements.before.n);
    expect(measurements.after.bytes).toBeGreaterThan(measurements.before.bytes);
    expect(measurements.keyCount).toBeGreaterThan(128);
    expect(measurements.sequence).toBe(260);
  });

  it("retains a reservation when an immutable checkpoint write is ambiguous", async () => {
    const host = "grasp-checkpoint-ambiguous.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const fixture = await fixturePack();
    await runInDurableObject(env.RELAY.getByName(host.split(".")[0]), async (relay) => {
      const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
      const operations = { get: 0, getBytes: 0, put: 0, putBytes: 0, putAck: 0, head: 0, headBytes: 0 };
      let writes = 0;
      let throwManifest = false;
      let failedManifestKey = "";
      let failedManifestBytes = 0;
      const previous = { ...operations };
      const measure = (phase: string) => {
        const delta = Object.fromEntries(Object.keys(operations).map((key) => [key, operations[key as keyof typeof operations] - previous[key as keyof typeof operations]]));
        Object.assign(previous, operations);
        console.info("checkpoint R2 operation measurement", { phase, ...delta });
      };
      const bucket = {
        get: async (key: string) => {
          operations.get++;
          const item = objects.get(key);
          if (item) operations.getBytes += item.bytes.length;
          return item ? { size: item.bytes.length, etag: item.etag, arrayBuffer: async () => item.bytes.slice().buffer } : null;
        },
        put: async (key: string, value: ArrayBufferView, options: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
          operations.put++;
          operations.putBytes += value.byteLength;
          const current = objects.get(key);
          if (options.onlyIf.etagDoesNotMatch === "*" && current) return null;
          if (options.onlyIf.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
          const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
          const item = { bytes, etag: `fake-${++writes}` };
          objects.set(key, item);
          if (throwManifest && key.includes("/manifests/")) {
            failedManifestKey = key;
            failedManifestBytes = bytes.length;
            throw new Error("lost manifest acknowledgement");
          }
          operations.putAck++;
          return { etag: item.etag };
        },
        head: async (key: string) => {
          operations.head++;
          const item = objects.get(key);
          if (item) operations.headBytes += item.bytes.length;
          return item ? { size: item.bytes.length } : null;
        },
      };
      const fakeRelay = {
        slug: "checkpoint-ambiguous",
        media: bucket,
        sql: relay.sql,
        fuelStatus: () => ({ outOfFuel: false }),
        settings: { limitsOf: () => ({ cap: 0 }) },
        store: { authorBytes: () => 0 },
      } as unknown as typeof relay;
      const repo = { id: "a".repeat(64), owner: pk(owner), identifier: "ambiguous", clone: [], relays: [], maintainers: [pk(owner)], private: false };
      const wal = await gitRepository(fakeRelay, repo);
      await wal.commit({ id: "ambiguous-initial", updates: [{ name: "refs/heads/main", old: null, new: fixture.commitID }], pack: fixture.pack });
      measure("legacy commit");
      await wal.checkpoint();
      measure("format1 to format2 checkpoint migration");
      await wal.commit({ id: "measured-v2-ref", updates: [{ name: "refs/tags/measured", old: null, new: fixture.commitID }] });
      measure("format2 ref-only commit");
      await wal.loadRefs();
      measure("format2 loadRefs");
      await wal.load();
      measure("format2 full load");
      await wal.lookupRecord("ambiguous-initial");
      measure("format2 old receipt lookup");
      throwManifest = true;
      await expect(wal.commit({ id: "ambiguous-next", updates: [{ name: "refs/tags/ambiguous", old: null, new: fixture.commitID }] })).rejects.toThrow();
      measure("ambiguous manifest PUT");
      expect(failedManifestKey).toContain("/manifests/");
      const retained = relay.sql.exec<{ size: number }>("SELECT size FROM grasp_objects WHERE key=?", failedManifestKey).one();
      expect(retained.size).toBe(failedManifestBytes);
      expect((await wal.load()).refs["refs/tags/ambiguous"]).toBeUndefined();
      throwManifest = false;
      await expect(wal.commit({ id: "ambiguous-next", updates: [{ name: "refs/tags/ambiguous", old: null, new: fixture.commitID }] })).resolves.toMatchObject({ replayed: false });
      expect((await wal.load()).refs["refs/tags/ambiguous"]).toBe(fixture.commitID);
      const reserved = relay.sql.exec<{ n: number; bytes: number }>("SELECT count(*) AS n, coalesce(sum(size),0) AS bytes FROM grasp_objects WHERE owner=? AND key LIKE '%/manifests/%'", pk(owner)).one();
      console.info("ambiguous checkpoint reservation", reserved);
      expect(reserved.n).toBeGreaterThan(0);
      expect(reserved.bytes).toBeGreaterThan(0);
    });
  });
});
