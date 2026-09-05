import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { ev, now, pk, rpc } from "../helpers/relay.ts";

describe("private list recovery", () => {
  it("keeps bounded private versions and returns an unsigned owner restore", async () => {
    const host = "list-history.bind.ws";
    const owner = generateSecretKey();
    const other = generateSecretKey();
    await rpc(host, owner, "claim");
    const base = now();
    await runInDurableObject(env.RELAY.getByName("list-history"), (relay: Relay) => {
      for (let i = 0; i < 14; i++) expect(relay.store.save(ev(owner, 10002, "v" + i, [["r", "wss://relay" + i]], base + i), base + i)).toBe("");
      expect(relay.store.save(ev(other, 10002, "other", [], base + 20), base + 20)).toBe("");
      expect(relay.store.save(ev(owner, 10003, "bookmarks", [], base + 21), base + 21)).toBe("");
    });
    const history = (await rpc(host, owner, "listlisthistory")).result as any[];
    expect(history.length).toBe(12);
    expect(history.every((x) => x.owner === undefined && x.kind === 10002 || x.kind === 10003)).toBe(true);
    expect((await rpc(host, other, "listlisthistory")).status).toBe(403);
    const chosen = history.find((x) => x.kind === 10002);
    const restored = (await rpc(host, owner, "restorelist", chosen.event_id)).result;
    expect(restored.draft).toMatchObject({ kind: 10002, content: expect.stringMatching(/^v/) });
    expect(restored.draft).not.toHaveProperty("sig");
    expect(restored.draft).not.toHaveProperty("pubkey");
    expect(restored.diff).toMatchObject({ contentChanged: true });
    expect(restored.draft.created_at).toBeGreaterThanOrEqual(base + 14);
    expect((await rpc(host, other, "restorelist", chosen.event_id)).status).toBe(403);
    await runInDurableObject(env.RELAY.getByName("list-history"), (relay: Relay) => {
      expect(relay.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM list_history WHERE owner=?`, pk(owner)).one().n).toBeLessThanOrEqual(96);
    });
  });

  it("clears prior versions when the author vanishes", async () => {
    const host = "list-history-vanish.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await runInDurableObject(env.RELAY.getByName("list-history-vanish"), (relay: Relay) => {
      relay.store.save(ev(owner, 3, "old"), now());
      relay.store.save(ev(owner, 3, "new"), now() + 1);
      relay.store.vanish(pk(owner), now() + 100);
    });
    expect((await rpc(host, owner, "listlisthistory")).result).toEqual([]);
  });
});
