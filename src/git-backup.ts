// Portable SQLite Git snapshots retain compressed objects and retry receipts.
// Preparation verifies identities, hashes, graphs and limits before restore
// enters the relay transaction; only validated rows reach publication.
import { sha256 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unzlibSync } from "fflate";
import { objectLinks, validateRefName, repositoryStoragePrefix, repositoryAddress, type GitObjectType, type RefUpdate } from "ntig";
import { npubEncode } from "nostr-tools/nip19";
import { DEFAULT_GIT_SQLITE_LIMITS as LIMITS, type GitSqliteLimits } from "./git-sqlite.ts";
import { gitSql } from "./git-catalog.ts";
import type { Relay } from "./relay.ts";

const enc = new TextEncoder();
const hex = /^[0-9a-f]{40}$/;
const hash = /^[0-9a-f]{64}$/;
const digest = (value: unknown) => bytesToHex(sha256(enc.encode(JSON.stringify(value))));
const size = (value: string) => enc.encode(value).length;
const base64 = (bytes: Uint8Array) => { let value = ""; for (let at = 0; at < bytes.length; at += 32768) value += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(value); };
const decoded = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

type ObjectRow = { oid: string; type: GitObjectType; size: number; chunks: string[] };
type RecordRow = { id: string; sequence: number; requestHash: string; recordHash: string; packHash: string | null; updates: RefUpdate[] };
type Repository = { key: string; owner: string; identifier: string; alternative: boolean; objects: ObjectRow[]; refs: Record<string, string>; receipts: RecordRow[] };
export type GitBackup = { format: "bind.ws/git-sqlite/1"; repositories: Repository[] };
export type PreparedGit = { repo: Repository; objects: { row: ObjectRow; chunks: Uint8Array[]; links: ReturnType<typeof objectLinks> }[]; raw: number; compressed: number; metadata: number; tip: string | null };

// exportGitBackup reserves archive memory before reading payloads from SQLite.
export function exportGitBackup(relay: Relay, reserve: (bytes: number, entries?: number) => boolean, limits: Readonly<GitSqliteLimits> = LIMITS, maxEntries = 12000): GitBackup | string {
  const result: GitBackup = { format: "bind.ws/git-sqlite/1", repositories: [] };
  for (const row of gitSql<{ repository: string; compressed_bytes: number; metadata_bytes: number; object_count: number }>(relay, "SELECT repository,compressed_bytes,metadata_bytes,object_count FROM git_sqlite_meta ORDER BY repository LIMIT ?", maxEntries + 1).toArray()) {
    if (!reserve(row.compressed_bytes + row.metadata_bytes, row.object_count + 1)) return "restricted: Git backup exceeds its bounded size or object limit";
    const identity = gitSql<{ owner: string; identifier: string; alternative: number }>(relay, "SELECT owner,identifier,alternative FROM git_sqlite_catalog WHERE repository=?", row.repository).toArray()[0];
    if (!identity) return "error: Git repository identity is missing";
    const repo: Repository = { key: row.repository, owner: identity.owner, identifier: identity.identifier, alternative: !!identity.alternative, objects: [], refs: {}, receipts: [] };
    for (const object of gitSql<{ oid: string; type: GitObjectType; size: number }>(relay, "SELECT oid,type,raw_size AS size FROM git_sqlite_objects WHERE repository=? ORDER BY oid LIMIT ?", row.repository, limits.maxObjects + 1).toArray()) {
      const chunks = gitSql<{ data: ArrayBuffer }>(relay, "SELECT data FROM git_sqlite_object_chunks WHERE repository=? AND oid=? ORDER BY chunk LIMIT ?", row.repository, object.oid, Math.ceil((limits.maxObjectBytes + 65536) / limits.chunkBytes) + 1).toArray().map(chunk => base64(new Uint8Array(chunk.data)));
      if (!reserve(0, chunks.length)) return "restricted: Git backup object limit reached";
      repo.objects.push({ ...object, chunks });
    }
    const refs = gitSql<{ name: string; oid: string }>(relay, "SELECT name,oid FROM git_sqlite_refs WHERE repository=? ORDER BY name LIMIT ?", row.repository, limits.maxRefs + 1).toArray();
    repo.refs = Object.fromEntries(refs.map(ref => [ref.name, ref.oid]));
    repo.receipts = gitSql<{ id: string; sequence: number; requestHash: string; recordHash: string; packHash: string | null; updates: string }>(relay, "SELECT id,sequence,request_hash AS requestHash,record_hash AS recordHash,pack_hash AS packHash,updates FROM git_sqlite_receipts WHERE repository=? ORDER BY sequence LIMIT ?", row.repository, maxEntries + 1).toArray().map(receipt => ({ ...receipt, updates: JSON.parse(receipt.updates) as RefUpdate[] }));
    if (!reserve(0, refs.length + repo.receipts.length)) return "restricted: Git backup object limit reached";
    result.repositories.push(repo);
  }
  return result;
}

// prepareGitBackup derives links from verified bodies and replays the receipt
// chain so neither forged metadata nor a different namespace survives restore.
export async function prepareGitBackup(input: unknown, maxEntries = 12000, limits: Readonly<GitSqliteLimits> = LIMITS): Promise<PreparedGit[] | string> {
  if (input === undefined) return [];
  try {
    const backup = input as GitBackup;
    if (!backup || backup.format !== "bind.ws/git-sqlite/1" || !Array.isArray(backup.repositories) || backup.repositories.length > maxEntries) throw new Error();
    const result: PreparedGit[] = [], keys = new Set<string>();
    let entries = 0;
    for (const repo of backup.repositories) {
      if (!repo || !hash.test(repo.key) || keys.has(repo.key) || !hash.test(repo.owner) || typeof repo.identifier !== "string" || typeof repo.alternative !== "boolean" || !Array.isArray(repo.objects) || repo.objects.length > limits.maxObjects || !Array.isArray(repo.receipts) || !repo.refs || typeof repo.refs !== "object" || Array.isArray(repo.refs)) throw new Error();
      const prefix = await repositoryStoragePrefix(repositoryAddress(npubEncode(repo.owner), repo.identifier), repo.alternative);
      if (prefix.split("/").filter(Boolean).at(-1) !== repo.key) throw new Error("namespace");
      keys.add(repo.key);
      entries += 1 + repo.objects.length + Object.keys(repo.refs).length + repo.receipts.length;
      if (entries > maxEntries || Object.keys(repo.refs).length > limits.maxRefs) throw new Error("limit");
      const prepared: PreparedGit = { repo, objects: [], raw: 0, compressed: 0, metadata: 0, tip: null };
      const objects = new Map<string, { type: GitObjectType; links: ReturnType<typeof objectLinks> }>();
      let edges = 0;
      for (const row of repo.objects) {
        if (!row || !hex.test(row.oid) || objects.has(row.oid) || !["blob", "tree", "commit", "tag"].includes(row.type) || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > limits.maxObjectBytes || !Array.isArray(row.chunks) || !row.chunks.length || row.chunks.length > Math.ceil((limits.maxObjectBytes + 65536) / limits.chunkBytes)) throw new Error();
        prepared.raw += row.size; entries += row.chunks.length;
        if (prepared.raw > limits.maxRawBytes || entries > maxEntries) throw new Error("limit");
        const chunks = row.chunks.map(value => {
          if (typeof value !== "string" || value.length > Math.ceil(limits.chunkBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error();
          const bytes = decoded(value);
          if (!bytes.length || bytes.length > limits.chunkBytes) throw new Error();
          return bytes;
        });
        const compressedSize = chunks.reduce((total, chunk) => total + chunk.length, 0);
        if (compressedSize > limits.maxObjectBytes + 65536) throw new Error("limit");
        prepared.compressed += compressedSize;
        if (prepared.compressed > limits.maxCompressedBytes) throw new Error("limit");
        const compressed = new Uint8Array(compressedSize); let at = 0;
        for (const chunk of chunks) { compressed.set(chunk, at); at += chunk.length; }
        const data = unzlibSync(compressed, { out: new Uint8Array(row.size + 1) });
        if (data.length !== row.size || bytesToHex(sha1.create().update(enc.encode(`${row.type} ${data.length}\0`)).update(data).digest()) !== row.oid) throw new Error("hash");
        const links = objectLinks({ oid: row.oid, type: row.type, data }, limits.maxGraphEdges - edges);
        edges += links.length;
        if (edges > limits.maxGraphEdges) throw new Error("limit");
        objects.set(row.oid, { type: row.type, links });
        prepared.objects.push({ row, chunks, links });
        prepared.metadata += size(repo.key) + 80 + chunks.length * (size(repo.key) + 48) + links.length * (size(repo.key) + 96);
      }
      for (const object of objects.values()) for (const link of object.links) if (objects.get(link.oid)?.type !== link.type) throw new Error("graph");
      const refs = new Map<string, string>(), ids = new Set<string>();
      for (const [index, receipt] of repo.receipts.entries()) {
        if (!receipt || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(receipt.id) || ids.has(receipt.id) || receipt.sequence !== index + 1 || !hash.test(receipt.requestHash) || !hash.test(receipt.recordHash) || (receipt.packHash !== null && !hash.test(receipt.packHash)) || !Array.isArray(receipt.updates) || !receipt.updates.length || receipt.updates.length > limits.maxRefs) throw new Error("receipt");
        ids.add(receipt.id);
        const names = new Set<string>();
        let previous = "";
        for (const update of receipt.updates) {
          validateRefName(update.name);
          if (names.has(update.name) || update.name < previous || (update.old !== null && (!hex.test(update.old) || !objects.has(update.old))) || (update.new !== null && (!hex.test(update.new) || !objects.has(update.new))) || (refs.get(update.name) ?? null) !== update.old) throw new Error("receipt refs");
          previous = update.name; names.add(update.name);
          if (update.new === null) refs.delete(update.name); else refs.set(update.name, update.new);
        }
        if (digest({ id: receipt.id, updates: receipt.updates, pack: receipt.packHash }) !== receipt.requestHash || digest({ sequence: receipt.sequence, parent: prepared.tip, id: receipt.id, digest: receipt.requestHash }) !== receipt.recordHash) throw new Error("receipt hash");
        prepared.tip = receipt.recordHash;
        prepared.metadata += size(repo.key) + size(JSON.stringify(receipt.updates)) + size(receipt.id) + 160;
      }
      if (!repo.receipts.length || refs.size !== Object.keys(repo.refs).length) throw new Error("refs");
      for (const [name, oid] of Object.entries(repo.refs)) {
        validateRefName(name);
        if (refs.get(name) !== oid || !objects.has(oid) || (name.startsWith("refs/heads/") && objects.get(oid)?.type !== "commit")) throw new Error("refs");
        const parts = name.split("/");
        for (let index = 2; index < parts.length; index++) if (refs.has(parts.slice(0, index).join("/"))) throw new Error("refs");
        prepared.metadata += size(repo.key) + size(name) + 40;
      }
      if (prepared.metadata > limits.maxMetadataBytes) throw new Error("limit");
      result.push(prepared);
    }
    return result;
  } catch { return "invalid: SQLite Git backup identity, objects, receipts or limits failed validation"; }
}

// restoreGitBackup runs inside the caller's transaction after preparation.
export function restoreGitBackup(relay: Relay, prepared: PreparedGit[]) {
  if (gitSql(relay, "SELECT 1 FROM git_sqlite_meta UNION ALL SELECT 1 FROM git_sqlite_objects UNION ALL SELECT 1 FROM git_sqlite_catalog LIMIT 1").toArray().length) throw new Error("error: Git restore requires an empty target");
  for (const { repo, objects, raw, compressed, metadata, tip } of prepared) {
    gitSql(relay, "INSERT INTO git_sqlite_catalog(repository,owner,identifier,alternative) VALUES(?,?,?,?)", repo.key, repo.owner, repo.identifier, repo.alternative ? 1 : 0);
    for (const { row, chunks, links } of objects) {
      gitSql(relay, "INSERT INTO git_sqlite_objects(repository,oid,type,raw_size,compressed_size,chunks) VALUES(?,?,?,?,?,?)", repo.key, row.oid, row.type, row.size, chunks.reduce((total, chunk) => total + chunk.length, 0), chunks.length);
      for (const [index, chunk] of chunks.entries()) gitSql(relay, "INSERT INTO git_sqlite_object_chunks(repository,oid,chunk,data) VALUES(?,?,?,?)", repo.key, row.oid, index, chunk.slice().buffer);
      for (const [index, link] of links.entries()) gitSql(relay, "INSERT INTO git_sqlite_object_links(repository,oid,position,link_oid,link_type) VALUES(?,?,?,?,?)", repo.key, row.oid, index, link.oid, link.type);
    }
    for (const [name, oid] of Object.entries(repo.refs)) gitSql(relay, "INSERT INTO git_sqlite_refs(repository,name,oid) VALUES(?,?,?)", repo.key, name, oid);
    for (const receipt of repo.receipts) gitSql(relay, "INSERT INTO git_sqlite_receipts(repository,id,sequence,request_hash,record_hash,updates,pack_hash) VALUES(?,?,?,?,?,?,?)", repo.key, receipt.id, receipt.sequence, receipt.requestHash, receipt.recordHash, JSON.stringify(receipt.updates), receipt.packHash);
    gitSql(relay, "INSERT INTO git_sqlite_meta(repository,sequence,tip,compressed_bytes,raw_bytes,object_count,metadata_bytes) VALUES(?,?,?,?,?,?,?)", repo.key, repo.receipts.length, tip, compressed, raw, objects.length, metadata);
  }
}
