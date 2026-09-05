import {
  ConflictError,
  IntegrityError,
  LimitError,
  type CommitRequest,
  type GitRepository,
  type Receipt,
  type RefSnapshot,
  type Snapshot,
  type WalRecord,
} from "ntig";
import { decodePack, objectLinks, type GitObject, type GitObjectType } from "ntig";
import { sha256, validateRefName } from "ntig";
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { zlibSync, unzlibSync } from "fflate";

// The object store keeps one compressed, content-addressed row per Git object.
// Chunks keep every SQLite value below the production BLOB limit, while refs
// and retry receipts remain in the same transaction as publication.
export const GIT_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS git_sqlite_objects (
  repository TEXT NOT NULL,
  oid TEXT NOT NULL,
  type TEXT NOT NULL,
  raw_size INTEGER NOT NULL,
  compressed_size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  PRIMARY KEY (repository, oid)
);
CREATE TABLE IF NOT EXISTS git_sqlite_object_chunks (
  repository TEXT NOT NULL,
  oid TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (repository, oid, chunk),
  FOREIGN KEY (repository, oid) REFERENCES git_sqlite_objects(repository, oid) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS git_sqlite_object_links (
  repository TEXT NOT NULL,
  oid TEXT NOT NULL,
  position INTEGER NOT NULL,
  link_oid TEXT NOT NULL,
  link_type TEXT NOT NULL,
  PRIMARY KEY (repository, oid, position)
);
CREATE TABLE IF NOT EXISTS git_sqlite_refs (
  repository TEXT NOT NULL,
  name TEXT NOT NULL,
  oid TEXT NOT NULL,
  PRIMARY KEY (repository, name)
);
CREATE TABLE IF NOT EXISTS git_sqlite_receipts (
  repository TEXT NOT NULL,
  id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  updates TEXT NOT NULL,
  pack_hash TEXT,
  PRIMARY KEY (repository, id)
);
CREATE TABLE IF NOT EXISTS git_sqlite_meta (
  repository TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  tip TEXT,
  compressed_bytes INTEGER NOT NULL DEFAULT 0,
  raw_bytes INTEGER NOT NULL DEFAULT 0,
  object_count INTEGER NOT NULL DEFAULT 0,
  metadata_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS git_sqlite_receipts_sequence ON git_sqlite_receipts(repository, sequence);
`;

export interface GitSqliteLimits {
  maxPackBytes: number;
  maxObjectBytes: number;
  maxObjects: number;
  maxRawBytes: number;
  maxTransactionRawBytes: number;
  maxCompressedBytes: number;
  maxMetadataBytes: number;
  maxRefs: number;
  maxGraphEdges: number;
  chunkBytes: number;
}

export const DEFAULT_GIT_SQLITE_LIMITS: Readonly<GitSqliteLimits> = Object.freeze({
  maxPackBytes: 4 * 1024 * 1024,
  maxObjectBytes: 4 * 1024 * 1024,
  maxObjects: 4096,
  maxRawBytes: 16 * 1024 * 1024,
  maxTransactionRawBytes: 16 * 1024 * 1024,
  maxCompressedBytes: 16 * 1024 * 1024,
  maxMetadataBytes: 16 * 1024 * 1024,
  maxRefs: 1024,
  maxGraphEdges: 65_536,
  chunkBytes: 512 * 1024,
});

type Sql = SqlStorage;
type Bytes = ArrayBuffer;
const ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
const OID = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);

const asBuffer = (bytes: Uint8Array): Bytes => bytes.slice().buffer;
const asBytes = (value: ArrayBuffer | Uint8Array): Uint8Array =>
  value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);

export interface GitSqliteCommitChange {
  id: string;
  sequence: number;
  refs: Readonly<Record<string, string>>;
  objects: readonly { oid: string; type: GitObjectType; rawSize: number; compressedSize: number }[];
}

export interface GitSqliteOptions {
  sql: Sql;
  repository?: string;
  limits?: Partial<GitSqliteLimits>;
  transactionSync: <T>(closure: () => T) => T;
  meter?: (event: { rowsRead: number; rowsWritten: number; rawBytes: number; compressedBytes: number }) => void;
  quota?: (event: { rawBytes: number; compressedBytes: number; metadataBytes: number }) => void;
  onCommit?: (change: GitSqliteCommitChange) => void;
  afterCommit?: (change: GitSqliteCommitChange) => void;
}

// GitSqliteRepository stores validated Git objects in one relay DO database.
// The class implements ntig's repository contract so the HTTP and GRASP
// adapters can use it once the object-reader seam is available.
export class GitSqliteRepository implements GitRepository {
  readonly prefix: string;
  readonly limits: Readonly<GitSqliteLimits>;
  readonly #sql: Sql;
  readonly #transaction: <T>(closure: () => T) => T;
  readonly #meter?: GitSqliteOptions["meter"];
  readonly #quota?: GitSqliteOptions["quota"];
  readonly #onCommit?: GitSqliteOptions["onCommit"];
  readonly #afterCommit?: GitSqliteOptions["afterCommit"];

  constructor(options: GitSqliteOptions) {
    this.#sql = options.sql;
    this.prefix = options.repository ?? "default";
    if (!/^[a-zA-Z0-9:_-]{1,256}$/.test(this.prefix)) throw new Error("Invalid repository name");
    this.limits = Object.freeze({ ...DEFAULT_GIT_SQLITE_LIMITS, ...options.limits });
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid Git SQLite limit");
    if (this.limits.chunkBytes > 512 * 1024 || this.limits.maxObjectBytes > 4 * 1024 * 1024) throw new Error("Git SQLite limits exceed platform bounds");
    if (!options.transactionSync) throw new Error("transactionSync is required for Git SQLite storage");
    this.#transaction = options.transactionSync;
    this.#meter = options.meter;
    this.#quota = options.quota;
    this.#onCommit = options.onCommit;
    this.#afterCommit = options.afterCommit;

  }

  async withReadSession<T>(operation: (repository: GitSqliteRepository) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async loadRefs(): Promise<RefSnapshot> {
    const meta = this.#meta();
    const refs = this.#refs();
    return { sequence: meta.sequence, tip: meta.tip, version: String(meta.sequence), refs };
  }

  async load(): Promise<Snapshot> {
    const refs = await this.loadRefs();
    const packs: Uint8Array[] = [];
    // Compatibility callers receive a bounded pack. HTTP and reconciliation
    // use indexed reads; backups export the compressed SQL rows directly.
    const meta = this.#meta();
    if (meta.rawBytes > this.limits.maxTransactionRawBytes || meta.objectCount > 4096) throw new LimitError("Git SQLite snapshot exceeds limit");
    const ids = this.#exec<{ oid: string }>("SELECT oid FROM git_sqlite_objects WHERE repository=? ORDER BY oid LIMIT 4097", this.prefix).toArray();
    if (ids.length > 4096) throw new LimitError("Git snapshot object limit exceeded");
    const objects: GitObject[] = [];
    for (const { oid } of ids) objects.push((await this.getObject(oid))!);
    if (objects.length) packs.push(await this.#pack(objects));
    return { ...refs, records: [], packs };
  }

  async getObject(oid: string): Promise<GitObject | null> {
    if (!OID.test(oid)) throw new IntegrityError("Invalid object ID");
    const row = this.#exec<{ type: GitObjectType; raw_size: number }>("SELECT type,raw_size FROM git_sqlite_objects WHERE repository=? AND oid=?", this.prefix, oid).toArray()[0];
    if (!row) return null;
    const data = this.#read(oid, row.raw_size);
    if (bytesToHex(sha1.create().update(new TextEncoder().encode(`${row.type} ${data.length}\0`)).update(data).digest()) !== oid) throw new IntegrityError("Git object hash mismatch");
    return { oid, type: row.type, data };
  }

  async getObjectInfo(oid: string): Promise<{ oid: string; type: GitObjectType; size: number; links: readonly { oid: string; type: GitObjectType }[] } | null> {
    if (!OID.test(oid)) throw new IntegrityError("Invalid object ID");
    const row = this.#exec<{ type: GitObjectType; raw_size: number }>("SELECT type,raw_size FROM git_sqlite_objects WHERE repository=? AND oid=?", this.prefix, oid).toArray()[0];
    if (!row) return null;
    const links = this.#exec<{ link_oid: string; link_type: GitObjectType }>("SELECT link_oid,link_type FROM git_sqlite_object_links WHERE repository=? AND oid=? ORDER BY position LIMIT ?", this.prefix, oid, this.limits.maxGraphEdges + 1).toArray().map((link) => ({ oid: link.link_oid, type: link.link_type }));
    if (!["blob", "tree", "commit", "tag"].includes(row.type) || !Number.isSafeInteger(row.raw_size) || row.raw_size < 0 || row.raw_size > this.limits.maxObjectBytes || links.length > this.limits.maxGraphEdges || links.some(link => !OID.test(link.oid) || !["blob", "tree", "commit", "tag"].includes(link.type))) throw new IntegrityError("Corrupt Git object metadata");
    return { oid, type: row.type, size: row.raw_size, links };
  }

  async lookupRecord(id: string): Promise<WalRecord | null> {
    if (!ID.test(id)) throw new IntegrityError("Invalid request ID");
    const row = this.#exec<{ sequence: number; request_hash: string; updates: string; pack_hash: string | null }>(
      "SELECT sequence,request_hash,updates,pack_hash FROM git_sqlite_receipts WHERE repository=? AND id=?",
      this.prefix,
      id,
    ).toArray()[0];
    if (!row) return null;
    return {
      format: 1,
      sequence: row.sequence,
      parent: row.sequence > 1 ? this.#tipAt(row.sequence - 1) : null,
      id,
      requestHash: row.request_hash,
      pack: row.pack_hash,
      updates: JSON.parse(row.updates) as WalRecord["updates"],
    };
  }

  hasObjectSync(oid: string): boolean {
    return OID.test(oid) && this.#exec("SELECT 1 AS present FROM git_sqlite_objects WHERE repository=? AND oid=?", this.prefix, oid).toArray().length > 0;
  }

  async commit(request: CommitRequest, beforeCommit?: () => void): Promise<Receipt> {
    const id = request.id;
    if (!ID.test(id)) throw new IntegrityError("Invalid request ID");
    if (request.updates.length > this.limits.maxRefs) throw new LimitError("Too many ref updates");
    if (request.updates.length === 0) throw new IntegrityError("Missing ref updates");
    const updates = request.updates.map((update) => ({ ...update })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const update of updates) {
      validateRefName(update.name);
      if (update.old !== null && (!OID.test(update.old) || update.old === ZERO)) throw new IntegrityError("Invalid old ref");
      if (update.new !== null && (!OID.test(update.new) || update.new === ZERO)) throw new IntegrityError("Invalid new ref");
    }
    if (new Set(updates.map((update) => update.name)).size !== updates.length) throw new IntegrityError("Duplicate ref update");
    const pack = request.pack?.slice();
    if (pack && pack.length > this.limits.maxPackBytes) throw new LimitError("pack exceeds limit");
    const packHash = pack ? await sha256(pack) : null;
    const digest = await sha256(new TextEncoder().encode(JSON.stringify({ id, updates, pack: packHash })));
    const prior = this.#exec<{ sequence: number; request_hash: string }>("SELECT sequence,request_hash FROM git_sqlite_receipts WHERE repository=? AND id=?", this.prefix, id).toArray()[0];
    if (prior) {
      if (prior.request_hash !== digest) throw new IntegrityError("Retry ID was reused with different data");
      this.#transaction(() => beforeCommit?.());
      return { id, sequence: prior.sequence, replayed: true };
    }
    const captured = this.#meta();
    const capturedRefs = this.#refs();
    const decoded = pack ? await decodePack(pack, {
      maxPackBytes: this.limits.maxPackBytes,
      maxObjectBytes: this.limits.maxObjectBytes,
      maxObjects: Math.min(4096, this.limits.maxObjects),
      maxTotalObjectBytes: this.limits.maxTransactionRawBytes,
    }, undefined, (oid) => this.getObject(oid)) : [];
    if (decoded.length > this.limits.maxObjects) throw new LimitError("Too many objects");
    const objects = new Map<string, GitObject>(decoded.map((object) => [object.oid, object]));
    for (const object of decoded) {
      const prior = await this.getObject(object.oid);
      if (prior && (prior.type !== object.type || !equal(prior.data, object.data))) throw new IntegrityError("Object ID collision");
    }
    const refs = { ...capturedRefs };
    for (const update of updates) {
      const current = refs[update.name] ?? null;
      if (current !== update.old) throw new ConflictError(`Ref changed: ${update.name}`);
      if (update.new === null) delete refs[update.name];
      else refs[update.name] = update.new;
    }
    if (Object.keys(refs).length > this.limits.maxRefs) throw new LimitError("Too many refs");
    const refNames = new Set(Object.keys(refs));
    for (const name of refNames) {
      const parts = name.split("/");
      for (let index = 2; index < parts.length; index++) if (refNames.has(parts.slice(0, index).join("/"))) throw new IntegrityError("Ref namespace collision");
    }
    await this.#validateGraph(objects, refs);
    const additions: GitObject[] = [];
    const seen = new Set<string>();
    for (const object of decoded) if (!seen.has(object.oid) && !this.hasObjectSync(object.oid)) { seen.add(object.oid); additions.push(object); }
    const stored = additions.map((object) => {
      const compressed = zlibSync(object.data);
      return { object, compressed, rawSize: object.data.length, compressedSize: compressed.length };
    });
    const rawBytes = stored.reduce((sum, item) => sum + item.rawSize, 0);
    const compressedBytes = stored.reduce((sum, item) => sum + item.compressedSize, 0);
    // Payload accounting includes repeated SQL keys and link/ref/receipt values.
    // The physical database meter separately includes pages and indexes.
    const utf8 = (value: string) => new TextEncoder().encode(value).length;
    const objectMetadata = stored.reduce((sum, item) => sum + utf8(this.prefix) + 80 + Math.ceil(item.compressedSize / this.limits.chunkBytes) * (utf8(this.prefix) + 48) + objectLinks(item.object).length * (utf8(this.prefix) + 96), 0);
    const refMetadata = updates.reduce((sum, update) => sum + (update.new === null ? -1 : update.old === null ? 1 : 0) * (utf8(this.prefix) + utf8(update.name) + 40), 0);
    const metadataBytes = objectMetadata + refMetadata + utf8(this.prefix) + utf8(JSON.stringify(updates)) + utf8(id) + 160;
    if (rawBytes > this.limits.maxTransactionRawBytes) throw new LimitError("Transaction raw-byte limit exceeded");
    if (this.#meta().compressedBytes + compressedBytes > this.limits.maxCompressedBytes) throw new LimitError("Repository compressed-byte limit exceeded");
    if (this.#meta().metadataBytes + metadataBytes > this.limits.maxMetadataBytes) throw new LimitError("Repository metadata limit exceeded");
    const parent = captured.tip;
    const recordHash = await sha256(new TextEncoder().encode(JSON.stringify({ sequence: captured.sequence + 1, parent, id: id, digest })));
    const result = this.#transaction(() => this.#commitTransaction(id, updates, packHash, digest, recordHash, refs, capturedRefs, captured.sequence, captured.tip, stored, rawBytes, compressedBytes, metadataBytes, beforeCommit));
    if (!result.replayed) this.#afterCommit?.({ id: result.id, sequence: result.sequence, refs, objects: stored.map((item) => ({ oid: item.object.oid, type: item.object.type, rawSize: item.rawSize, compressedSize: item.compressedSize })) });
    return result;
  }

  #commitTransaction(id: string, updates: WalRecord["updates"], packHash: string | null, digest: string, recordHash: string, refs: Record<string, string>, capturedRefs: Record<string, string>, capturedSequence: number, capturedTip: string | null, stored: readonly { object: GitObject; compressed: Uint8Array; rawSize: number; compressedSize: number }[], rawBytes: number, compressedBytes: number, metadataBytes: number, beforeCommit?: () => void): Receipt {
    const prior = this.#exec<{ sequence: number; request_hash: string }>("SELECT sequence,request_hash FROM git_sqlite_receipts WHERE repository=? AND id=?", this.prefix, id).toArray()[0];
    if (prior) {
      if (prior.request_hash !== digest) throw new IntegrityError("Retry ID was reused with different data");
      beforeCommit?.();
      return { id, sequence: prior.sequence, replayed: true };
    }
    this.#exec("INSERT OR IGNORE INTO git_sqlite_meta(repository,sequence,tip) VALUES(?,0,NULL)", this.prefix);
    const meta = this.#meta();
    const sequence = meta.sequence + 1;
    if (meta.sequence !== capturedSequence || meta.tip !== capturedTip || JSON.stringify(this.#refs()) !== JSON.stringify(capturedRefs)) throw new ConflictError("Repository changed during Git preparation");
    if (meta.objectCount + stored.length > this.limits.maxObjects || meta.rawBytes + rawBytes > this.limits.maxRawBytes || meta.compressedBytes + compressedBytes > this.limits.maxCompressedBytes || meta.metadataBytes + metadataBytes > this.limits.maxMetadataBytes) throw new LimitError("Repository storage limit exceeded");
    const edgeCount = this.#exec<{ count: number }>("SELECT count(*) AS count FROM git_sqlite_object_links WHERE repository=?", this.prefix).toArray()[0].count;
    const addedEdges = stored.reduce((count, item) => count + objectLinks(item.object).length, 0);
    if (edgeCount + addedEdges > this.limits.maxGraphEdges) throw new LimitError("Repository graph edge limit exceeded");
    beforeCommit?.();
    const changeObjects: Array<GitSqliteCommitChange["objects"][number]> = [];
    for (const item of stored) {
      this.#exec("INSERT INTO git_sqlite_objects(repository,oid,type,raw_size,compressed_size,chunks) VALUES(?,?,?,?,?,?)", this.prefix, item.object.oid, item.object.type, item.rawSize, item.compressedSize, Math.ceil(item.compressed.length / this.limits.chunkBytes));
      let chunk = 0;
      for (let position = 0; position < item.compressed.length; position += this.limits.chunkBytes)
        this.#exec("INSERT INTO git_sqlite_object_chunks(repository,oid,chunk,data) VALUES(?,?,?,?)", this.prefix, item.object.oid, chunk++, asBuffer(item.compressed.subarray(position, position + this.limits.chunkBytes)));
      for (const [position, link] of objectLinks(item.object).entries()) this.#exec("INSERT INTO git_sqlite_object_links(repository,oid,position,link_oid,link_type) VALUES(?,?,?,?,?)", this.prefix, item.object.oid, position, link.oid, link.type);
      changeObjects.push({ oid: item.object.oid, type: item.object.type, rawSize: item.rawSize, compressedSize: item.compressedSize });
    }
    for (const update of updates) {
      if (update.new === null) this.#exec("DELETE FROM git_sqlite_refs WHERE repository=? AND name=?", this.prefix, update.name);
      else this.#exec("INSERT INTO git_sqlite_refs(repository,name,oid) VALUES(?,?,?) ON CONFLICT(repository,name) DO UPDATE SET oid=excluded.oid", this.prefix, update.name, update.new);
    }
    this.#exec("INSERT INTO git_sqlite_receipts(repository,id,sequence,request_hash,record_hash,updates,pack_hash) VALUES(?,?,?,?,?,?,?)", this.prefix, id, sequence, digest, recordHash, JSON.stringify(updates), packHash);
    this.#exec("UPDATE git_sqlite_meta SET sequence=?,tip=?,compressed_bytes=compressed_bytes+?,raw_bytes=raw_bytes+?,object_count=object_count+?,metadata_bytes=metadata_bytes+? WHERE repository=?", sequence, recordHash, compressedBytes, rawBytes, stored.length, metadataBytes, this.prefix);
    this.#quota?.({ rawBytes, compressedBytes, metadataBytes });
    this.#onCommit?.({ id, sequence, refs, objects: changeObjects });
    return { id, sequence, replayed: false };
  }

  async #validateGraph(objects: ReadonlyMap<string, GitObject>, refs: Readonly<Record<string, string>>): Promise<void> {
    let edges = 0;
    for (const object of objects.values()) {
      const links = objectLinks(object, this.limits.maxGraphEdges - edges);
      edges += links.length;
      if (edges > this.limits.maxGraphEdges) throw new LimitError("Object graph edge limit exceeded");
      for (const link of links) {
        const target = objects.get(link.oid) ?? await this.getObjectInfo(link.oid);
        if (!target || target.type !== link.type) throw new IntegrityError(`Missing or wrong-type ${link.type}: ${link.oid}`);
      }
    }
    for (const [name, oid] of Object.entries(refs)) {
      validateRefName(name);
      const target = objects.get(oid) ?? await this.getObjectInfo(oid);
      if (!target) throw new IntegrityError(`Missing ref target: ${name}`);
      if (name.startsWith("refs/heads/") && target.type !== "commit") throw new IntegrityError("Branch target must be a commit");
    }
  }

  #exec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
    const cursor = this.#sql.exec<T>(query, ...bindings);
    let rows: T[];
    try { rows = cursor.toArray(); }
    finally { this.#meter?.({ rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten, rawBytes: 0, compressedBytes: 0 }); }
    return { toArray: () => rows };
  }

  #meta() { return this.#exec<{ sequence: number; tip: string | null; compressedBytes: number; rawBytes: number; objectCount: number; metadataBytes: number }>("SELECT sequence,tip,compressed_bytes AS compressedBytes,raw_bytes AS rawBytes,object_count AS objectCount,metadata_bytes AS metadataBytes FROM git_sqlite_meta WHERE repository=?", this.prefix).toArray()[0] ?? { sequence: 0, tip: null, compressedBytes: 0, rawBytes: 0, objectCount: 0, metadataBytes: 0 }; }
  #refs() { return Object.fromEntries(this.#exec<{ name: string; oid: string }>("SELECT name,oid FROM git_sqlite_refs WHERE repository=? ORDER BY name", this.prefix).toArray().map((row) => [row.name, row.oid])); }
  #tipAt(sequence: number) { return this.#exec<{ record_hash: string }>("SELECT record_hash FROM git_sqlite_receipts WHERE repository=? AND sequence=?", this.prefix, sequence).toArray()[0]?.record_hash ?? null; }
  #read(oid: string, rawSize: number): Uint8Array {
    if (rawSize < 0 || rawSize > this.limits.maxObjectBytes) throw new LimitError("Git object exceeds limit");
    const meta = this.#exec<{ compressed_size: number; chunks: number }>("SELECT compressed_size,chunks FROM git_sqlite_objects WHERE repository=? AND oid=?", this.prefix, oid).toArray()[0];
    if (!meta || meta.chunks < 1 || meta.chunks > Math.ceil((this.limits.maxObjectBytes + 65536) / this.limits.chunkBytes) || meta.compressed_size > this.limits.maxObjectBytes + 65536) throw new IntegrityError("Corrupt Git object metadata");
    const rows = this.#exec<{ chunk: number; data: ArrayBuffer }>("SELECT chunk,data FROM git_sqlite_object_chunks WHERE repository=? AND oid=? ORDER BY chunk LIMIT ?", this.prefix, oid, Math.ceil((this.limits.maxObjectBytes + 65536) / this.limits.chunkBytes) + 1).toArray();
    if (rows.length !== meta.chunks || rows.some((row, index) => row.chunk !== index || row.data.byteLength > this.limits.chunkBytes)) throw new IntegrityError("Corrupt Git object chunks");
    const compressed = join(rows.map((row) => asBytes(row.data)));
    if (compressed.length !== meta.compressed_size) throw new IntegrityError("Corrupt Git object size");
    const data = unzlibSync(compressed, { out: new Uint8Array(rawSize + 1) });
    if (data.length !== rawSize) throw new IntegrityError("Corrupt Git object");
    return data;
  }
  async #pack(objects: readonly GitObject[]) { const { encodePack } = await import("ntig"); return encodePack(objects); }
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const join = (parts: readonly Uint8Array[]) => { const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let position = 0; for (const part of parts) { result.set(part, position); position += part.length; } return result; };
