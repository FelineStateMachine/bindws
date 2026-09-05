// Portable backup archives cover configuration, events, site media and Git
// bytes, while refusing tampering, the wrong signer and non-fresh targets.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { createBackup, restoreBackup } from "../../src/backups.ts";
import { storeBlob } from "../../src/blossom.ts";
import type { Relay } from "../../src/relay.ts";
import { ev, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("portable backups", () => {
  it("round trips configuration, events, a media blob and a Git object, with preview and exclusions", async () => {
    const source = "backup-source.bind.ws";
    const owner = generateSecretKey(), writer = generateSecretKey();
    await rpc(source, owner, "claim");
    await rpc(source, owner, "setpolicy", { name: "Recovered", reads: "members" });
    const c = await WS.connect(source);
    await c.ok(ev(writer, 1, "retained"));
    const archive = await runInDurableObject(env.RELAY.getByName("backup-source"), async (relay: Relay) => {
      await storeBlob(relay, new TextEncoder().encode("site bytes"), "text/plain", pk(writer), 10);
      await relay.media.put("backup-source/git/test-object", new TextEncoder().encode("git bytes"));
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
    expect(preview.git).toBe(1);
    await runInDurableObject(env.RELAY.getByName("backup-target"), async (relay: Relay) => {
      expect(relay.settings.policy.name).toBe("Recovered");
      expect((await relay.media.get("backup-target/" + ""))).toBeNull();
      expect((await relay.media.get("backup-target/" + "git/test-object"))?.size).toBe(9);
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
