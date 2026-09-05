// Portable relay backups: a bounded JSON archive containing the owner's
// configuration, signed events, Blossom blobs and hosted Git objects. The
// archive is sealed by a manifest hash before it is stored or restored.
import { sha256 } from "@noble/hashes/sha2.js";
import { applyConfig, exportConfig, parseConfig } from "./config.ts";
import { bytesToHex } from "./negentropy.ts";
import { verifyNIP98 } from "./auth.ts";
import { can } from "./roles.ts";
import { expiration, now, validate, type Event } from "./event.ts";
import { type Relay } from "./relay.ts";
import { KIND_PUSH_REGISTRATION } from "./kinds.ts";
import { archiveCurrent, isListKind } from "./list-history.ts";
import { Settings } from "./settings.ts";

export const BACKUP_FORMAT = "bind.ws/relay-backup/1";
// JSON parsing, base64 expansion and integrity copies coexist in the Worker
// heap, so the portable form stays well below the platform heap ceiling.
export const BACKUP_MAX_BYTES = 8 * 1024 * 1024;
export const BACKUP_MAX_OBJECTS = 12_000;
export const BACKUP_SCHEMA = `CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL);`;
export const backupBytes = (relay: Relay): number => relay.sql.exec<{ n: number }>(`SELECT coalesce(sum(bytes),0) n FROM backups`).one().n;
export const BACKUP_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

type Payload = { sha256: string; size: number; data: string };
export type BackupArchive = {
  format: typeof BACKUP_FORMAT;
  manifest: { id: string; slug: string; owner: string; relayIdentity: string; createdAt: number; bytes: number; events: number; blobs: number; git: number; archiveSha256: string };
  config: unknown;
  events: string[];
  blobs: (Payload & { sha256: string; type: string; uploader: string; uploaded: number })[];
  git: (Payload & { key: string })[];
  state?: { listHistory: string[]; hidden: string[]; hosted: string[]; pending: { id: string; until: number }[]; prRefs?: { repo: string; ref: string; until: number }[] };
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromB64 = (value: string) => {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};
const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const archiveKey = (relay: Relay, id: string) => `${relay.slug}/backups/${id}.json`;

const bytesOf = (archive: BackupArchive) => enc.encode(JSON.stringify(archive));
const unsignedBytes = (archive: BackupArchive) => {
  const copy = structuredClone(archive);
  copy.manifest.archiveSha256 = "";
  return enc.encode(JSON.stringify(copy));
};

// createBackup snapshots the visible database and every tenant-owned media
// object. The cap makes the bounded in-memory archive explicit.
export async function createBackup(relay: Relay, id: string): Promise<{ manifest: BackupArchive["manifest"]; key: string } | string> {
  if (!BACKUP_ID_RE.test(id)) return "invalid: backup id must be 3 to 64 lowercase letters, digits, dash or underscore";
  if (relay.settings.isUnclaimed() || relay.settings.leaseExpired(now())) return "restricted: relay is not active";
  const owner = relay.settings.policy.owner;
  if (!owner) return "restricted: relay has no owner";
  const events: string[] = [];
  let estimate = 1024;
  let entries = 0;
  const reserve = (bytes: number, count = 1) => {
    // JSON strings and base64 coexist with decoded buffers during sealing.
    const next = estimate + Math.ceil(bytes * 2) + 256;
    if (next > BACKUP_MAX_BYTES || entries + count > BACKUP_MAX_OBJECTS) return false;
    estimate = next;
    entries += count;
    return true;
  };
  let seq = 0;
  for (;;) {
    const page = relay.store.dumpPage(seq, 1);
    if (!page.length) break;
    for (const x of page) {
      try {
        if ((JSON.parse(x.raw) as Event).kind === KIND_PUSH_REGISTRATION) continue;
        if (!reserve(enc.encode(x.raw).length)) return "restricted: backup exceeds its bounded size or object limit";
        events.push(x.raw);
      } catch { return "error: event serialization failed during backup"; }
    }
    seq = page[page.length - 1].seq;
  }
  const blobs: BackupArchive["blobs"] = [];
  const blobRows = relay.sql.exec<{ sha256: string; size: number; type: string; uploader: string; uploaded: number }>(`SELECT * FROM blobs ORDER BY uploaded LIMIT 12001`).toArray();
  for (const b of blobRows) {
    if (!reserve(b.size)) return "restricted: backup exceeds its bounded size or object limit";
    const obj = await relay.media.get(`${relay.slug}/${b.sha256}`);
    if (!obj) return `error: blob ${b.sha256} disappeared during backup`;
    if (obj.size !== b.size) return "error: blob size changed during backup";
    const data = new Uint8Array(await obj.arrayBuffer());
    if (data.length !== b.size) return `error: blob ${b.sha256} changed during backup`;
    if (data.length !== b.size || digest(data) !== b.sha256) return `error: blob ${b.sha256} failed integrity check`;
    blobs.push({ ...b, data: toB64(data), sha256: b.sha256, size: data.length });
  }
  const git: BackupArchive["git"] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await relay.media.list({ prefix: `${relay.slug}/git/`, cursor, limit: 1000 });
    for (const item of listed.objects) {
      if (git.length + blobs.length >= BACKUP_MAX_OBJECTS) return "restricted: backup object limit reached; no complete archive";
      if (item.size > 4 * 1024 * 1024) return "restricted: Git object exceeds the backup object limit";
      if (!reserve(item.size)) return "restricted: backup exceeds its bounded size or object limit";
      const obj = await relay.media.get(item.key);
      if (!obj) return `error: Git object ${item.key} disappeared during backup`;
      const data = new Uint8Array(await obj.arrayBuffer());
      git.push({ key: item.key.slice(relay.slug.length + 1), sha256: digest(data), size: data.length, data: toB64(data) });
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  const config = exportConfig(relay.settings, relay.slug);
  if (!reserve(enc.encode(JSON.stringify(config)).length)) return "restricted: backup exceeds its bounded size or object limit";
  const state = { listHistory: [] as string[], hidden: [...relay.settings.hiddenEvents], hosted: relay.sql.exec<{ id: string }>(`SELECT id FROM grasp_hosted`).toArray().map((r) => r.id), pending: relay.sql.exec<{ id: string; until: number }>(`SELECT id,until FROM grasp_pending`).toArray(), prRefs: relay.sql.exec<{ repo: string; ref: string; until: number }>(`SELECT repo,ref,until FROM grasp_pr_refs`).toArray() };
  for (const row of relay.sql.exec<{ raw: string }>(`SELECT raw FROM list_history WHERE expires=0 OR expires>? ORDER BY saved_at`, now())) {
    if (!reserve(enc.encode(row.raw).length)) return "restricted: backup history exceeds its bounded size";
    state.listHistory.push(row.raw);
  }
  if (!reserve(enc.encode(JSON.stringify({ ...state, listHistory: [] })).length, state.hidden.length + state.hosted.length + state.pending.length + state.prRefs.length)) return "restricted: backup state exceeds its bounded size";
  const archive = { format: BACKUP_FORMAT, manifest: { id, slug: relay.slug, owner, relayIdentity: relay.identity.pubkey, createdAt: now(), bytes: 0, events: events.length, blobs: blobs.length, git: git.length, archiveSha256: "" }, config, events, blobs, git, state } as BackupArchive;
  archive.manifest.archiveSha256 = "0".repeat(64);
  for (let i = 0; i < 4; i++) archive.manifest.bytes = bytesOf(archive).length;
  archive.manifest.archiveSha256 = digest(unsignedBytes(archive));
  const finalBytes = bytesOf(archive);
  if (finalBytes.length > BACKUP_MAX_BYTES) return "restricted: backup exceeds 8 MiB; use smaller retention or separate Git repositories";
  relay.sql.exec(`INSERT OR REPLACE INTO backups(id,bytes) VALUES(?,?)`, id, finalBytes.length);
  await relay.media.put(archiveKey(relay, id), finalBytes, { httpMetadata: { contentType: "application/json" } });
  relay.meterBytes(0, finalBytes.length);
  return { manifest: archive.manifest, key: archiveKey(relay, id) };
}

export async function listBackups(relay: Relay) {
  const listed = await relay.media.list({ prefix: `${relay.slug}/backups/` });
  return listed.objects.filter((x) => x.key.endsWith(".json")).map((x) => ({ id: x.key.slice(`${relay.slug}/backups/`.length, -5), bytes: x.size }));
}

export async function deleteBackup(relay: Relay, id: string) {
  if (!BACKUP_ID_RE.test(id)) return false;
  await relay.media.delete(archiveKey(relay, id));
  relay.sql.exec(`DELETE FROM backups WHERE id=?`, id);
  return true;
}

const checkedArchive = (bytes: Uint8Array): BackupArchive | string => {
  if (bytes.length > BACKUP_MAX_BYTES) return "restricted: backup exceeds 8 MiB";
  let archive: BackupArchive;
  try { archive = JSON.parse(dec.decode(bytes)) as BackupArchive; } catch { return "invalid: backup is not JSON"; }
  if (!archive || archive.format !== BACKUP_FORMAT || !archive.manifest || !Array.isArray(archive.events) || !Array.isArray(archive.blobs) || !Array.isArray(archive.git)) return "invalid: unsupported backup format";
  if (archive.manifest.archiveSha256 !== digest(unsignedBytes(archive))) return "invalid: backup integrity check failed";
  if (archive.events.length + archive.blobs.length + archive.git.length > BACKUP_MAX_OBJECTS) return "restricted: backup object limit reached";
  for (const raw of archive.events) {
    try { if (typeof raw !== "string" || (validate(JSON.parse(raw) as Event) || JSON.parse(raw).kind === KIND_PUSH_REGISTRATION)) return "invalid: backup contains an invalid event"; }
    catch { return "invalid: backup contains malformed event JSON"; }
  }
  for (const b of archive.blobs) { let data: Uint8Array; try { data = fromB64(b.data); } catch { return "invalid: malformed blob data"; } if (data.length !== b.size || digest(data) !== b.sha256) return "invalid: blob integrity check failed"; }
  for (const g of archive.git) { let data: Uint8Array; try { data = fromB64(g.data); } catch { return "invalid: malformed Git data"; } if (data.length !== g.size || digest(data) !== g.sha256 || typeof g.key !== "string" || !g.key.startsWith("git/")) return "invalid: Git integrity check failed"; }
  const state = archive.state;
  if (state) {
    if (!Array.isArray(state.listHistory) || !Array.isArray(state.hidden) || !Array.isArray(state.hosted) || !Array.isArray(state.pending)) return "invalid: backup state malformed";
    if (state.prRefs !== undefined && (!Array.isArray(state.prRefs) || state.prRefs.some(r => !r || typeof r.repo !== "string" || !/^(?:pr|30617):[0-9a-f]{64}:.+$/u.test(r.repo) || new TextEncoder().encode(r.repo).length > 327 || typeof r.ref !== "string" || !/^refs\/nostr\/[0-9a-f]{64}$/u.test(r.ref) || !Number.isSafeInteger(r.until) || r.until < 0))) return "invalid: backup PR deadlines malformed";
    if (archive.events.length + archive.blobs.length + archive.git.length + (state.prRefs?.length ?? 0) + state.listHistory.length + state.hidden.length + state.hosted.length + state.pending.length > BACKUP_MAX_OBJECTS) return "restricted: backup object limit reached";
    const hex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
    if (state.hidden.some((v) => !hex(v)) || state.hosted.some((v) => !hex(v)) || state.pending.some((v) => !v || !hex(v.id) || !Number.isSafeInteger(v.until))) return "invalid: backup state malformed";
    for (const raw of state.listHistory) {
      try { const event = JSON.parse(raw); if (typeof raw !== "string" || validate(event) || !isListKind(event.kind)) return "invalid: backup list history malformed"; }
      catch { return "invalid: backup list history malformed"; }
    }
  }
  return archive;
};

// restoreBackup only accepts an unclaimed, empty target. Events are already
// signed and validated in the archive; direct storage preserves private data
// and avoids applying the target's ordinary write policy to old history.
export async function restoreBackup(relay: Relay, bytes: Uint8Array, caller: string): Promise<unknown | string> {
  const archive = checkedArchive(bytes);
  if (typeof archive === "string") return archive;
  if (relay.settings.policy.owner !== "" || relay.settings.isLeased() || relay.sql.exec(`SELECT 1 FROM events LIMIT 1`).toArray().length || relay.sql.exec(`SELECT 1 FROM blobs LIMIT 1`).toArray().length || relay.sql.exec(`SELECT 1 FROM grasp_objects LIMIT 1`).toArray().length || (relay.slug !== "" && (await relay.media.list({ prefix: `${relay.slug}/`, limit: 1 })).objects.length)) return "restricted: restore requires a fresh, unclaimed relay";
  if (archive.manifest.owner !== caller) return "restricted: target signer is not the backup owner";
  const config = archive.config as Record<string, unknown>;
  const parsed = parseConfig(config, relay.settings.policy);
  if (typeof parsed === "string") return parsed;
  const staged: string[] = [];
  try {
    for (const b of archive.blobs) {
      const data = fromB64(b.data);
      const key = `${relay.slug}/${b.sha256}`;
      await relay.media.put(key, data, { httpMetadata: { contentType: b.type } }); staged.push(key);
    }
    for (const g of archive.git) { const key = `${relay.slug}/${g.key}`; await relay.media.put(key, fromB64(g.data)); staged.push(key); }
  } catch (error) {
    await relay.media.delete(staged).catch(() => {});
    return "error: restore storage staging failed";
  }
  try {
    relay.storage.transactionSync(() => {
      relay.settings.update({ owner: caller });
      applyConfig(relay.settings, parsed, now());
      for (const raw of archive.events) {
        const e = JSON.parse(raw) as Event;
        const error = relay.store.save(e, now());
        if (error && !error.startsWith("duplicate:")) throw new Error(`error: event restore stopped: ${error}`);

      }
      for (const raw of archive.state?.listHistory ?? []) {
        const event = JSON.parse(raw) as Event;
        if (!expiration(event) || expiration(event) > now()) archiveCurrent((q, ...args) => relay.sql.exec(q, ...args as SqlStorageValue[]), event, now());
      }
      for (const id of archive.state?.hidden ?? []) relay.settings.setEvent(id, "hide");
      for (const id of archive.state?.hosted ?? []) relay.sql.exec(`INSERT OR IGNORE INTO grasp_hosted(id) SELECT id FROM events WHERE id=?`, id);
      for (const row of archive.state?.pending ?? []) relay.sql.exec(`INSERT OR IGNORE INTO grasp_pending(id,until) SELECT id,? FROM events WHERE id=?`, row.until, row.id);
      for (const row of archive.state?.prRefs ?? []) relay.sql.exec(`INSERT OR IGNORE INTO grasp_pr_refs(repo,ref,until) VALUES(?,?,?)`, row.repo, row.ref, row.until);
      for (const b of archive.blobs) relay.sql.exec(`INSERT OR REPLACE INTO blobs(sha256,size,type,uploader,uploaded) VALUES(?,?,?,?,?)`, b.sha256, b.size, b.type, b.uploader, b.uploaded);
      for (const g of archive.git) relay.sql.exec(`INSERT OR REPLACE INTO grasp_objects(key,owner,size) VALUES(?,?,?)`, `${relay.slug}/${g.key}`, caller, g.size);
    });
  } catch (error) {
    relay.settings = new Settings(relay.sql);
    relay.settings.load();
    relay.store.hidden = relay.settings.hiddenEvents;
    await relay.media.delete(staged).catch(() => {});
    return error instanceof Error && error.message.startsWith("error:") ? error.message : "error: restore transaction failed";
  }
  await relay.syncSites();
  await relay.publishMembership();
  await relay.publishDiscovery();
  if (relay.sql.exec("SELECT 1 FROM grasp_pending UNION ALL SELECT 1 FROM grasp_pr_refs LIMIT 1").toArray().length || relay.settings.policy.features.grasp02) await relay.ensureAlarm(now() + 1);
  return { restored: true, owner: caller, sourceRelayIdentity: archive.manifest.relayIdentity, targetRelayIdentity: relay.identity.pubkey, events: archive.events.length, blobs: archive.blobs.length, git: archive.git.length, bytes: bytes.length };
}

export async function backupDownload(relay: Relay, req: Request, id: string): Promise<Response> {
  const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, "");
  if (typeof auth === "string") return Response.json({ error: auth }, { status: 401 });
  if (!can(relay.settings.roleOf(auth.pubkey), "storage")) return Response.json({ error: "restricted: not the relay owner" }, { status: 403 });
  if (!BACKUP_ID_RE.test(id)) return Response.json({ error: "invalid: backup id" }, { status: 400 });
  const obj = await relay.media.get(archiveKey(relay, id));
  if (!obj) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(obj.body, { headers: { "content-type": "application/json", "content-length": String(obj.size), "cache-control": "private, no-store", "content-disposition": `attachment; filename="${relay.slug}-${id}.json"` } });
}

async function readCapped(req: Request): Promise<Uint8Array | string> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > BACKUP_MAX_BYTES) return "restricted: backup exceeds 8 MiB";
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > BACKUP_MAX_BYTES) { await reader.cancel(); return "restricted: backup exceeds 8 MiB"; }
    chunks.push(part.value);
  }
  const out = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

export async function restoreBackupRequest(relay: Relay, req: Request): Promise<Response> {
  const preauth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, "");
  if (typeof preauth === "string") return Response.json({ error: preauth }, { status: 401 });
  if (relay.settings.policy.owner !== "" || relay.settings.isLeased()) return Response.json({ error: "restricted: restore requires a fresh, unclaimed relay" }, { status: 403 });
  const input = await readCapped(req);
  if (typeof input === "string") return Response.json({ error: input }, { status: 413 });
  const bytes = input;
  const body = new TextDecoder().decode(bytes);
  const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, body);
  if (typeof auth === "string") return Response.json({ error: auth }, { status: 401 });
  if (new URL(req.url).pathname === "/backups/preview") {
    const parsed = checkedArchive(bytes);
    if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
    const cfg = parseConfig(parsed.config, relay.settings.policy);
    if (typeof cfg === "string") return Response.json({ error: cfg }, { status: 400 });
    if (relay.settings.policy.owner !== "" || relay.settings.isLeased() || relay.sql.exec(`SELECT 1 FROM events LIMIT 1`).toArray().length || relay.sql.exec(`SELECT 1 FROM blobs LIMIT 1`).toArray().length || relay.sql.exec(`SELECT 1 FROM grasp_objects LIMIT 1`).toArray().length || (relay.slug !== "" && (await relay.media.list({ prefix: `${relay.slug}/`, limit: 1 })).objects.length)) return Response.json({ error: "restricted: restore requires a fresh, unclaimed relay" }, { status: 403 });
    if (parsed.manifest.owner !== auth.pubkey) return Response.json({ error: "restricted: target signer is not the backup owner" }, { status: 403 });
    return Response.json({ result: { preview: true, source: parsed.manifest, targetIsFresh: true, config: parsed.config, events: parsed.events.length, blobs: parsed.blobs.length, git: parsed.git.length, bytes: bytes.length } });
  }
  const result = await restoreBackup(relay, bytes, auth.pubkey);
  return typeof result === "string" ? Response.json({ error: result }, { status: result.startsWith("invalid:") ? 400 : 403 }) : Response.json({ result });
}
