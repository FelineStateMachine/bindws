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

  it("caps an owner's history across distinct bookmark sets", async () => {
    const host = "list-history-owner-cap.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await runInDurableObject(env.RELAY.getByName("list-history-owner-cap"), (relay: Relay) => {
      const base = now();
      for (let i = 0; i < 100; i++) {
        expect(relay.store.save(ev(owner, 30003, "old-" + i, [["d", "set-" + i]], base + i * 2), base + i * 2)).toBe("");
        expect(relay.store.save(ev(owner, 30003, "new-" + i, [["d", "set-" + i]], base + i * 2 + 1), base + i * 2 + 1)).toBe("");
      }
      expect(relay.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM list_history WHERE owner=?`, pk(owner)).one().n).toBe(96);
    });
  });

  it("keeps member history private and clears colon-containing address history on deletion", async () => {
    const host = "list-history-privacy.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member));
    let ownerHistoryID = "";
    await runInDurableObject(env.RELAY.getByName("list-history-privacy"), (relay: Relay) => {
      const base = now();
      relay.store.save(ev(owner, 10002, "owner-old", [], base), base);
      const ownerCurrent = ev(owner, 10002, "owner-new", [], base + 1);
      relay.store.save(ownerCurrent, base + 1);
      ownerHistoryID = ownerCurrent.id;
      relay.store.save(ev(member, 10002, "member-old", [], base + 2), base + 2);
      relay.store.save(ev(member, 10002, "member-new", [], base + 3), base + 3);
      relay.store.save(ev(owner, 30003, "set-old", [["d", "set:with:colon"]], base + 4), base + 4);
      relay.store.save(ev(owner, 30003, "set-new", [["d", "set:with:colon"]], base + 5), base + 5);
    });
    const memberHistory = (await rpc(host, member, "listlisthistory")).result as any[];
    expect(memberHistory).toHaveLength(1);
    expect(memberHistory[0].kind).toBe(10002);
    expect((await rpc(host, member, "restorelist", ownerHistoryID)).status).toBe(404);
    await runInDurableObject(env.RELAY.getByName("list-history-privacy"), (relay: Relay) => {
      const deletion = ev(owner, 5, "", [["a", `30003:${pk(owner)}:set:with:colon`]], now() + 10);
      expect(relay.store.save(deletion, deletion.created_at)).toBe("");
      expect(relay.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM list_history WHERE owner=? AND kind=30003`, pk(owner)).one().n).toBe(0);
    });
  });

  it("does not restore an expired saved list", async () => {
    const host = "list-history-expiry.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await runInDurableObject(env.RELAY.getByName("list-history-expiry"), (relay: Relay) => {
      const base = now();
      relay.store.save(ev(owner, 10003, "expired", [["expiration", String(base - 1)]], base), base);
      relay.store.save(ev(owner, 10003, "current", [], base + 1), base + 1);
    });
    expect((await rpc(host, owner, "listlisthistory")).result).toEqual([]);
  });
});
