// Portable backup archives cover configuration, events, site media and Git
// bytes, while refusing tampering, the wrong signer and non-fresh targets.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { BACKUP_MAX_BYTES, createBackup, restoreBackup } from "../../src/backups.ts";
import { storeBlob } from "../../src/blossom.ts";
import type { Relay } from "../../src/relay.ts";
import { ev, nip98, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("portable backups", () => {
  it("can omit Git payloads while retaining the legacy bounded archive format", async () => {
    const owner = generateSecretKey();
    const result = await runInDurableObject(env.RELAY.getByName("backup-no-git"), async (relay: Relay) => {
      relay.settings.update({ owner: pk(owner) });
      const created = await createBackup(relay, "no-git", { maxBytes: BACKUP_MAX_BYTES, maxEntries: 12_000, includeGit: false });
      if (typeof created === "string") throw new Error(created);
      const object = await relay.media.get(created.key);
      return JSON.parse(new TextDecoder().decode(await object!.arrayBuffer()));
    });
    expect(result.sqlGit).toBeUndefined();
    expect(result.manifest.git).toBe(0);
  });

  it("serves owner-only download and keeps signed preview read-only", async () => {
    const source = "backup-http-source.bind.ws";
    const target = "backup-http-target.bind.ws";
    const owner = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(source, owner, "claim");
    const archive = await runInDurableObject(env.RELAY.getByName("backup-http-source"), async (relay: Relay) => {
      await relay.store.save(ev(owner, 1, "http backup"), 1);
      expect(typeof await createBackup(relay, "http-test")).not.toBe("string");
      const object = await relay.media.get("backup-http-source/backups/http-test.json");
      return new Uint8Array(await object!.arrayBuffer());
    });
    const downloadURL = `http://${source}/backups/http-test`;
    expect((await SELF.fetch(downloadURL)).status).toBe(401);
    expect((await SELF.fetch(downloadURL, { headers: { authorization: await nip98(stranger, downloadURL) } })).status).toBe(403);
    const downloaded = await SELF.fetch(downloadURL, { headers: { authorization: await nip98(owner, downloadURL) } });
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(archive);

    const previewURL = `http://${target}/backups/preview`;
    const before = await SELF.fetch(`http://${target}/`, { headers: { accept: "application/nostr+json" } });
    const preview = await SELF.fetch(previewURL, { method: "POST", headers: { authorization: await nip98(owner, previewURL, "POST", JSON.parse(new TextDecoder().decode(archive))) }, body: new TextDecoder().decode(archive) });
    expect(preview.status).toBe(200);
    expect((await preview.clone().json<any>()).result).toMatchObject({ preview: true, targetIsFresh: true });
    expect((await preview.clone().json<any>()).result.events).toBeGreaterThanOrEqual(1);
    const after = await SELF.fetch(`http://${target}/`, { headers: { accept: "application/nostr+json" } });
    expect(await before.text()).toBe(await after.text());
    // The preview response is metadata, not a restore capability or archive.
    const previewBody = await preview.text();
    const restoreWithPreview = await SELF.fetch(`http://${target}/backups/restore`, { method: "POST", headers: { authorization: await nip98(owner, `http://${target}/backups/restore`, "POST", JSON.parse(previewBody)) }, body: previewBody });
    expect(restoreWithPreview.status).toBe(400);
    const restoreURL = `http://${target}/backups/restore`;
    const body = new TextDecoder().decode(archive);
    const previewToken = await nip98(owner, previewURL, "POST", JSON.parse(body));
    expect((await SELF.fetch(restoreURL, { method: "POST", headers: { authorization: previewToken }, body })).status).toBe(401);
    const restored = await SELF.fetch(restoreURL, { method: "POST", headers: { authorization: await nip98(owner, restoreURL, "POST", JSON.parse(body)) }, body });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await restored.json<any>()).result.restored).toBe(true);
  });

  it("rejects a tampered signed body and a valid body signed by the wrong owner", async () => {
    const source = "backup-http-tamper-source.bind.ws";
    const target = "backup-http-tamper-target.bind.ws";
    const owner = generateSecretKey();
    const wrong = generateSecretKey();
    await rpc(source, owner, "claim");
    const archive = await runInDurableObject(env.RELAY.getByName("backup-http-tamper-source"), async (relay: Relay) => {
      await relay.store.save(ev(owner, 1, "tamper"), 1);
      await createBackup(relay, "tamper-http");
      const object = await relay.media.get("backup-http-tamper-source/backups/tamper-http.json");
      return new TextDecoder().decode(await object!.arrayBuffer());
    });
    const restoreURL = `http://${target}/backups/restore`;
    const changed = archive.slice(0, -2) + (archive.endsWith("}") ? " ]" : " }");
    const badAuth = await nip98(owner, restoreURL, "POST", JSON.parse(archive));
    expect((await SELF.fetch(restoreURL, { method: "POST", headers: { authorization: badAuth }, body: changed })).status).toBe(401);
    const wrongAuth = await nip98(wrong, restoreURL, "POST", JSON.parse(archive));
    const denied = await SELF.fetch(restoreURL, { method: "POST", headers: { authorization: wrongAuth }, body: archive });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain("backup owner");
  });

  it("caps chunked restore uploads without a Content-Length", async () => {
    const url = "http://backup-stream-cap.bind.ws/backups/restore";
    const response = await SELF.fetch(url, { method: "POST", headers: { authorization: await nip98(generateSecretKey(), url, "POST") }, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(BACKUP_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } }) });
    expect(response.status).toBe(413);
  });

  it("round trips configuration, events and a media blob, with preview and exclusions", async () => {
    const source = "backup-source.bind.ws";
    const owner = generateSecretKey(), writer = generateSecretKey();
    await rpc(source, owner, "claim");
    await rpc(source, owner, "setpolicy", { name: "Recovered", reads: "members" });
    const c = await WS.connect(source);
    await c.ok(ev(writer, 1, "retained"));
    const archive = await runInDurableObject(env.RELAY.getByName("backup-source"), async (relay: Relay) => {
      const oldList = ev(owner, 3, "older", [], 10);
      relay.store.save(oldList, 10);
      relay.store.save(ev(owner, 3, "latest", [], 11), 11);
      const held = ev(writer, 1, "hidden state");
      relay.store.save(held, 12);
      relay.settings.setEvent(held.id, "hide");
      relay.sql.exec(`INSERT INTO grasp_pending(id,until) VALUES(?,?)`, held.id, 9999999999);
      relay.sql.exec(`INSERT INTO grasp_pr_refs(repo,ref,until) VALUES(?,?,?)`, `pr:${pk(writer)}:repo`, `refs/nostr/${"a".repeat(64)}`, 9999999999);
      relay.sql.exec(`INSERT INTO grasp_pr_refs(repo,ref,until) VALUES(?,?,?)`, `pr:${pk(writer)}:repo`, `refs/nostr/${"b".repeat(64)}`, 0);
      await storeBlob(relay, new TextEncoder().encode("site bytes"), "text/plain", pk(writer), 10);
      await relay.store.save(ev(owner, 30390, '{"callback":"https://secret.invalid"}'), 10);
      const result = await createBackup(relay, "roundtrip");
      expect(typeof result).not.toBe("string");
      const object = await relay.media.get("backup-source/backups/roundtrip.json");
      const bytes = new Uint8Array(await object!.arrayBuffer());
      expect(new TextDecoder().decode(bytes)).not.toContain("secret.invalid");
      return bytes;
    });
    const preview = await runInDurableObject(env.RELAY.getByName("backup-target"), async (relay: Relay) => {
      relay.slug = "backup-target";
      const before = Number(relay.sql.exec(`SELECT count(*) AS n FROM events`).one().n ?? 0);
      const result = await restoreBackup(relay, archive, pk(owner));
      expect(typeof result).not.toBe("string");
      expect(relay.sql.exec(`SELECT count(*) AS n FROM events`).one().n).toBeGreaterThan(before);
      return result as { blobs: number; git: number };
    });
    expect(preview.blobs).toBe(1);
    expect(preview.git).toBe(0);
    await runInDurableObject(env.RELAY.getByName("backup-target"), async (relay: Relay) => {
      expect(relay.settings.policy.name).toBe("Recovered");
      expect(relay.sql.exec(`SELECT repo,ref,until FROM grasp_pr_refs ORDER BY ref`).toArray()).toEqual([{ repo: `pr:${pk(writer)}:repo`, ref: `refs/nostr/${"a".repeat(64)}`, until: 9999999999 }, { repo: `pr:${pk(writer)}:repo`, ref: `refs/nostr/${"b".repeat(64)}`, until: 0 }]);
      expect(relay.store.listHistory(pk(owner), Math.floor(Date.now() / 1000))).toHaveLength(1);
      expect(relay.settings.hiddenEvents.size).toBe(1);
      expect(relay.sql.exec(`SELECT count(*) n FROM grasp_pending`).one().n).toBe(1);
      expect((await relay.media.get("backup-target/" + ""))).toBeNull();
    });
  });

  it("rejects tampering and wrong owner before changing a fresh target, and rejects a non-fresh target", async () => {
    const source = "backup-tamper.bind.ws";
    const owner = generateSecretKey(), wrong = generateSecretKey();
    await rpc(source, owner, "claim");
    const archive = await runInDurableObject(env.RELAY.getByName("backup-tamper"), async (relay: Relay) => {
      await relay.store.save(ev(owner, 1, "safe"), 1);
      await createBackup(relay, "tamper");
      const object = await relay.media.get("backup-tamper/backups/tamper.json");
      return new Uint8Array(await object!.arrayBuffer());
    });
    const damaged = archive.slice(); damaged[damaged.length - 4] ^= 1;
    const result = await runInDurableObject(env.RELAY.getByName("backup-tamper-target"), async (relay: Relay) => {
      relay.slug = "backup-tamper-target";
      expect(await restoreBackup(relay, damaged, pk(owner))).toMatch(/^invalid:/);
      expect(relay.settings.policy.owner).toBe("");
      expect(await restoreBackup(relay, archive, pk(wrong))).toContain("backup owner");
      expect(relay.settings.policy.owner).toBe("");
      return restoreBackup(relay, archive, pk(owner));
    });
    expect(typeof result).not.toBe("string");
    const nonfresh = await runInDurableObject(env.RELAY.getByName("backup-nonfresh"), async (relay: Relay) => {
      relay.settings.update({ owner: pk(owner) });
      return restoreBackup(relay, archive, pk(owner));
    });
    expect(nonfresh).toContain("fresh");
  });
});
