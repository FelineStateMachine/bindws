import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodePack, type GitObject } from "ntig";
import { generateSecretKey } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BACKUP_MAX_BYTES, createBackup, restoreBackup } from "../../src/backups.ts";
import { gitRepository } from "../../src/grasp.ts";
import type { RepositoryAnnouncement } from "../../src/grasp-policy.ts";
import type { Relay } from "../../src/relay.ts";
import { pk, rpc } from "../helpers/relay.ts";

const text = new TextEncoder();
const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const hex = (value: string) => { const output = new Uint8Array(value.length / 2); for (let i = 0; i < output.length; i++) output[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16); return output; };
async function oid(type: string, data: Uint8Array) {
  const header = text.encode(`${type} ${data.length}\0`); const input = new Uint8Array(header.length + data.length); input.set(header); input.set(data, header.length);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-1", input)));
}
async function gitCommit(message: string, parent: string | null = null) {
  const blobData = text.encode(`${message}\n`); const blob = await oid("blob", blobData);
  const treeData = new Uint8Array(32); treeData.set(text.encode("100644 file\0")); treeData.set(hex(blob), 12); const tree = await oid("tree", treeData);
  const commitData = text.encode(`tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Backup <backup@example.com> 1 +0000\ncommitter Backup <backup@example.com> 1 +0000\n\n${message}\n`); const commit = await oid("commit", commitData);
  const objects: GitObject[] = [{ oid: blob, type: "blob", data: blobData }, { oid: tree, type: "tree", data: treeData }, { oid: commit, type: "commit", data: commitData }];
  return { commit, pack: await encodePack(objects) };
}
const repository = (owner: string, identifier: string): RepositoryAnnouncement => ({ id: `repo:${owner}:${identifier}`, owner, identifier, clone: [], relays: [], maintainers: [], private: false });

async function archiveBytes(relay: Relay, key: string) {
  const object = await relay.media.get(`${relay.slug}/backups/${key}.json`); return new Uint8Array(await object!.arrayBuffer());
}
function updateArchiveHash(archive: Record<string, any>) {
  const copy = structuredClone(archive); copy.manifest.archiveSha256 = ""; archive.manifest.archiveSha256 = digest(new TextEncoder().encode(JSON.stringify(copy)));
}

describe("SQLite Git backups", () => {
  it("round trips a cataloged member-owned repository and permits further push and replay", async () => {
    const ownerSecret = generateSecretKey(); const owner = pk(ownerSecret); const member = pk(generateSecretKey()); const source = `sql-git-backup-source-${owner.slice(0, 8)}`; const target = `sql-git-backup-target-${owner.slice(0, 8)}`;
    await rpc(`${source}.bind.ws`, ownerSecret, "claim");
    const archive = await runInDurableObject(env.RELAY.getByName(source), async (relay: Relay) => {
      const announcement = repository(member, "member-repo"); const git = await gitRepository(relay, announcement);
      const first = await gitCommit("first"); await git.commit({ id: "first", updates: [{ name: "refs/heads/main", old: null, new: first.commit }], pack: first.pack });
      const second = await gitCommit("second", first.commit); await git.commit({ id: "second", updates: [{ name: "refs/heads/main", old: first.commit, new: second.commit }], pack: second.pack });
      const catalog = relay.sql.exec<{ owner: string; identifier: string }>("SELECT owner,identifier FROM git_sqlite_catalog WHERE repository=?", git.prefix).one();
      expect(catalog).toEqual({ owner: member, identifier: "member-repo" });
      expect(typeof await createBackup(relay, "sql-roundtrip")).not.toBe("string");
      return archiveBytes(relay, "sql-roundtrip");
    });
    const restored = await runInDurableObject(env.RELAY.getByName(target), async (relay: Relay) => {
      relay.slug = `${target}.bind.ws`;
      const result = await restoreBackup(relay, archive, owner);
      expect(typeof result).not.toBe("string");
      const row = relay.sql.exec<{ repository: string; owner: string; identifier: string }>("SELECT c.repository,c.owner,c.identifier FROM git_sqlite_catalog c").one();
      expect(row.owner).toBe(member); expect(row.identifier).toBe("member-repo");
      const git = await gitRepository(relay, repository(member, "member-repo"));
      expect((await git.loadRefs()).refs["refs/heads/main"]).toBeTruthy();
      const replay = await git.commit({ id: "second", updates: [{ name: "refs/heads/main", old: "0".repeat(40), new: "f".repeat(40) }] }).catch((error) => error);
      expect(replay).toBeInstanceOf(Error);
      const oldTip = (await git.loadRefs()).refs["refs/heads/main"];
      const third = await gitCommit("third", oldTip);
      const thirdRequest = { id: "third", updates: [{ name: "refs/heads/main", old: oldTip, new: third.commit }], pack: third.pack };
      await git.commit(thirdRequest);
      expect((await git.commit(thirdRequest)).replayed).toBe(true);
    });
    expect(restored).toBeUndefined();
  });

  it("rejects rehashed structural tampering and namespace mismatch before target writes", async () => {
    const owner = pk(generateSecretKey()); const source = `sql-git-backup-tamper-source-${owner.slice(0, 8)}`; const target = `sql-git-backup-tamper-target-${owner.slice(0, 8)}`;
    const original = await runInDurableObject(env.RELAY.getByName(source), async (relay: Relay) => {
      relay.settings.update({ owner });
      const git = await gitRepository(relay, repository(owner, "tamper")); const first = await gitCommit("tamper"); await git.commit({ id: "tamper", updates: [{ name: "refs/heads/main", old: null, new: first.commit }], pack: first.pack }); await createBackup(relay, "tamper"); return archiveBytes(relay, "tamper");
    });
    const tampered = JSON.parse(new TextDecoder().decode(original)) as Record<string, any>;
    tampered.sqlGit.repositories[0].key = "f".repeat(64); updateArchiveHash(tampered);
    const damaged = JSON.parse(new TextDecoder().decode(original)) as Record<string, any>;
    const chunk = damaged.sqlGit.repositories[0].objects[0].chunks[0]; const middle = Math.floor(chunk.length / 2);
    damaged.sqlGit.repositories[0].objects[0].chunks[0] = `${chunk.slice(0, middle)}${chunk[middle] === "A" ? "B" : "A"}${chunk.slice(middle + 1)}`; updateArchiveHash(damaged);
    await runInDurableObject(env.RELAY.getByName(target), async (relay: Relay) => {
      relay.slug = `${target}.bind.ws`;
      for (const candidate of [tampered, damaged]) {
        const result = await restoreBackup(relay, text.encode(JSON.stringify(candidate)), owner);
        expect(String(result)).toMatch(/^invalid:/);
        expect(relay.settings.policy.owner).toBe("");
        expect(relay.sql.exec("SELECT 1 FROM git_sqlite_objects LIMIT 1").toArray()).toHaveLength(0);
      }
    });
  });

  it("rejects a snapshot over the portable size bound before touching a target", async () => {
    const owner = pk(generateSecretKey());
    const result = await runInDurableObject(env.RELAY.getByName("sql-git-backup-size"), async (relay: Relay) => restoreBackup(relay, new Uint8Array(BACKUP_MAX_BYTES + 1), owner));
    expect(result).toMatch(/^restricted: backup exceeds/);
  });
});
