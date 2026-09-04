// Quiescent test fixtures reconcile the quota ledger against R2 and classify
// current-format dependencies. This walk is not an online deletion policy.
import { expect } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { repositoryAddress, repositoryStoragePrefix, type WalRepository } from "ntig";
import type { Relay } from "../../src/relay.ts";
import type { RepositoryAnnouncement } from "../../src/grasp-policy.ts";

const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

// inventory reconciles an isolated repository after its writer has stopped.
export async function inventory(relay: Relay, repo: RepositoryAnnouncement, wal: WalRepository) {
  const prefix = `${relay.slug}/git/${await repositoryStoragePrefix(repositoryAddress(npubEncode(repo.owner), repo.identifier))}data/`;
  const root = await relay.media.get(`${prefix}root.json`);
  const rootText = root ? await root.text() : null;
  const snapshot = await wal.load();
  const physical = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await relay.media.list({ prefix, cursor, limit: 100 });
    for (const item of page.objects) physical.set(item.key, item.size);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const ledger = relay.sql.exec<{ key: string; size: number }>("SELECT key, size FROM grasp_objects WHERE owner=?", repo.owner).toArray().filter(({ key }) => key.startsWith(prefix));
  expect(new Map(ledger.map(({ key, size }) => [key, size]))).toEqual(physical);
  const live = new Set<string>();
  const records = new Map<string, string>();
  const sequences = new Set<number>();
  const read = async (family: string, hash: string) => {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const key = `${prefix}${family}/${hash}`;
    const item = await relay.media.get(key);
    expect(item).not.toBeNull();
    const bytes = new Uint8Array(await item!.arrayBuffer());
    expect(bytes.length).toBe(physical.get(key));
    expect(await digest(bytes)).toBe(hash);
    live.add(key);
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  if (root) live.add(root.key);
  if (snapshot.checkpoint) {
    await read("manifests", snapshot.checkpoint.manifestHash);
    for (const id of snapshot.checkpoint.packIds) live.add(`${prefix}packs/${id}`);
    const walk = async (hash: string, route = ""): Promise<void> => {
      expect(route.length).toBeLessThanOrEqual(64);
      expect(live.has(`${prefix}receipt-index/${hash}`)).toBe(false);
      const node = await read("receipt-index", hash);
      expect(node.v).toBe(1);
      if (node.t === "l") {
        for (const [key, recordHash] of node.e as [string, string][]) {
          expect(key.startsWith(route)).toBe(true);
          const record = await read("records", recordHash);
          expect(await digest(new TextEncoder().encode(record.id))).toBe(key);
          expect(records.has(record.id)).toBe(false);
          records.set(record.id, recordHash);
          sequences.add(record.sequence);
          expect(await wal.lookupRecord(record.id)).toEqual(record);
        }
      } else {
        expect(node.t).toBe("b");
        expect(node.c).toHaveLength(16);
        for (const [i, child] of (node.c as (string | null)[]).entries()) {
          if (child !== null) await walk(child, route + i.toString(16));
        }
      }
    };
    if (snapshot.checkpoint.receiptRoot) await walk(snapshot.checkpoint.receiptRoot);
    expect(records.size).toBe(snapshot.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(Array.from({ length: snapshot.sequence }, (_, i) => i + 1));
  } else {
    let tip = snapshot.tip;
    while (tip) {
      expect(live.has(`${prefix}records/${tip}`)).toBe(false);
      const record = await read("records", tip);
      if (record.pack) live.add(`${prefix}packs/${record.pack}`);
      tip = record.parent;
    }
  }
  for (const key of live) expect(physical.has(key)).toBe(true);
  const categories: Record<string, { objects: number; bytes: number }> = {};
  for (const [key, bytes] of physical) {
    const family = key.slice(prefix.length).split("/")[0];
    const category = `${live.has(key) ? "current" : "unreferenced"}/${family}`;
    const row = categories[category] ??= { objects: 0, bytes: 0 };
    row.objects++; row.bytes += bytes;
  }
  const after = await relay.media.get(`${prefix}root.json`);
  expect(after?.etag).toBe(root?.etag);
  expect(after ? await after.text() : null).toBe(rootText);
  return {
    sequence: snapshot.sequence, refs: Object.keys(snapshot.refs).length,
    physicalBytes: [...physical.values()].reduce((a, b) => a + b, 0),
    reservedBytes: ledger.reduce((n, row) => n + row.size, 0),
    currentBytes: [...live].reduce((n, key) => n + physical.get(key)!, 0),
    objects: physical.size, categories,
  };
}
