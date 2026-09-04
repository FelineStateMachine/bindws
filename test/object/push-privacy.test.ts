import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { KIND_PUSH_REGISTRATION } from "../../src/kinds.ts";
import { now, ev, pk, post, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("push registration privacy", () => {
  it("keeps registrations author-only in queries, counts, filters and sync", async () => {
    const owner = generateSecretKey();
    const other = generateSecretKey();
    const recipient = generateSecretKey();
    const host = "push-private.bind.ws";
    await rpc(host, owner, "claim");
    const mine = ev(owner, KIND_PUSH_REGISTRATION, "mine", [["d", "mine"], ["p", pk(recipient)]], now() - 10);
    const theirs = ev(other, KIND_PUSH_REGISTRATION, "theirs", [["d", "theirs"], ["p", pk(recipient)]], now() - 5);
    const note = ev(owner, 1, "public", [], now());

    await runInDurableObject(env.RELAY.getByName("push-private"), async (r: Relay) => {
      const before = r.store.stats();
      expect(r.store.save(mine, now())).toBe("");
      expect(r.store.save(theirs, now())).toBe("");
      expect(r.store.save(note, now())).toBe("");

      const filter = { kinds: [KIND_PUSH_REGISTRATION], tags: {} };
      const hidden = r.store.query(filter, { pubkeys: [], all: true }, 20, now());
      expect(hidden.rows).toEqual([]);
      expect(r.store.query(filter, { pubkeys: [pk(recipient)], all: true }, 20, now()).rows).toEqual([]);
      expect(r.store.query(filter, { pubkeys: [pk(owner)], all: true }, 20, now()).rows.map((x) => JSON.parse(x).id)).toEqual([mine.id]);
      expect(r.store.query({ ids: [theirs.id], tags: {} }, { pubkeys: [pk(owner)], all: true }, 20, now()).rows).toEqual([]);
      expect(r.store.count([filter], { pubkeys: [], all: true }, now())).toBe(0);
      expect(r.store.count([filter], { pubkeys: [pk(owner)], all: true }, now())).toBe(1);
      expect(r.store.countHLL(filter, { pubkeys: [], all: true }, 0, now()).count).toBe(0);
      expect(r.store.syncItems(filter, { pubkeys: [], all: true }, 20, now())).toEqual([]);
      expect(r.store.syncItems(filter, { pubkeys: [pk(owner)], all: true }, 20, now())).toEqual([{ timestamp: mine.created_at, id: expect.any(Uint8Array) }]);

      // Internal jobs use all:true and sequence reads. Registrations stay out.
      expect(r.store.after(0, filter, 20, now()).map((x) => JSON.parse(x.raw).id)).toEqual([]);
      expect(r.store.recent(20, now()).map((x) => JSON.parse(x).id)).not.toContain(mine.id);
      expect(r.store.recent(20, now()).map((x) => JSON.parse(x).id)).not.toContain(theirs.id);
      expect(r.store.dumpPage(0, 20).map((x) => JSON.parse(x.raw).id)).not.toContain(mine.id);
      expect(r.store.dumpPage(0, 20).map((x) => JSON.parse(x.raw).id)).not.toContain(theirs.id);

      expect(r.store.stats().events).toBe(before.events + 1);
      expect(r.store.kinds(0).map((x) => x.kind)).not.toContain(KIND_PUSH_REGISTRATION);
      expect(r.store.kindCounts(0).map((x) => x.kind)).not.toContain(KIND_PUSH_REGISTRATION);
      expect(r.store.kindStats().map((x) => x.kind)).not.toContain(KIND_PUSH_REGISTRATION);
    });
  });

  it("keeps stored registrations private through the HTTP count and query bridge", async () => {
    const owner = generateSecretKey();
    const other = generateSecretKey();
    const recipient = generateSecretKey();
    const bystander = generateSecretKey();
    const host = "push-bridge-private.bind.ws";
    await rpc(host, owner, "claim");
    const mine = ev(owner, KIND_PUSH_REGISTRATION, "mine", [["d", "mine"], ["p", pk(recipient)]], now() - 10);
    const theirs = ev(other, KIND_PUSH_REGISTRATION, "theirs", [["d", "theirs"], ["p", pk(recipient)]], now() - 5);
    await runInDurableObject(env.RELAY.getByName("push-bridge-private"), async (r: Relay) => {
      // This bypasses feature and write gates so the read boundary is tested
      // even when push is switched off.
      expect(r.store.save(mine, now())).toBe("");
      expect(r.store.save(theirs, now())).toBe("");
      expect(r.store.count([{ kinds: [KIND_PUSH_REGISTRATION], tags: {} }], { pubkeys: [pk(other)] }, now())).toBe(1);
      expect(r.store.query({ kinds: [KIND_PUSH_REGISTRATION], tags: {} }, { pubkeys: [pk(other)] }, 20, now()).rows.map((x) => JSON.parse(x).id)).toEqual([theirs.id]);
    });

    for (const [key, count] of [[owner, 1], [other, 1], [recipient, 0], [bystander, 0]] as const) {
      const result = await post(host, key, "/count", [{ kinds: [KIND_PUSH_REGISTRATION] }]);
      expect(result.status, JSON.stringify(result)).toBe(200);
      expect(result.body.count, JSON.stringify({ key: pk(key), owner: pk(owner), other: pk(other), recipient: pk(recipient) })).toBe(count);
      const query = await post(host, key, "/query", [{ kinds: [KIND_PUSH_REGISTRATION] }]);
      expect(query.status, JSON.stringify(query)).toBe(200);
      expect(query.body.map((e: { id: string }) => e.id)).toEqual(key === owner ? [mine.id] : key === other ? [theirs.id] : []);
    }
  });

  it("keeps stored registrations private for authenticated websocket reads and live delivery", async () => {
    const owner = generateSecretKey();
    const other = generateSecretKey();
    const recipient = generateSecretKey();
    const bystander = generateSecretKey();
    const host = "push-socket-private.bind.ws";
    await rpc(host, owner, "claim");
    const mine = ev(owner, KIND_PUSH_REGISTRATION, "mine", [["d", "mine"], ["p", pk(recipient)]], now() - 10);
    const theirs = ev(other, KIND_PUSH_REGISTRATION, "theirs", [["d", "theirs"], ["p", pk(recipient)]], now() - 5);
    await runInDurableObject(env.RELAY.getByName("push-socket-private"), async (r: Relay) => {
      expect(r.store.save(mine, now())).toBe("");
      expect(r.store.save(theirs, now())).toBe("");
    });

    const ownerSocket = await WS.connect(host);
    const otherSocket = await WS.connect(host);
    const recipientSocket = await WS.connect(host);
    const bystanderSocket = await WS.connect(host);
    await ownerSocket.auth(owner, host);
    await otherSocket.auth(other, host);
    await recipientSocket.auth(recipient, host);
    await bystanderSocket.auth(bystander, host);
    expect((await ownerSocket.open("mine", { kinds: [KIND_PUSH_REGISTRATION] })).events.map((e) => e.id)).toEqual([mine.id]);
    expect((await otherSocket.open("other", { kinds: [KIND_PUSH_REGISTRATION] })).events.map((e) => e.id)).toEqual([theirs.id]);
    expect((await recipientSocket.open("recipient", { kinds: [KIND_PUSH_REGISTRATION] })).events).toEqual([]);
    expect((await bystanderSocket.open("bystander", { kinds: [KIND_PUSH_REGISTRATION] })).events).toEqual([]);

    const live = ev(owner, KIND_PUSH_REGISTRATION, "live", [["d", "live"]]);
    await runInDurableObject(env.RELAY.getByName("push-socket-private"), async (r: Relay) => {
      expect(r.store.save(live, now())).toBe("");
      r.broadcast(live);
    });
    expect((await ownerSocket.recvOr(200))?.[2]?.id).toBe(live.id);
    expect(await otherSocket.recvOr(200)).toBeNull();
    expect(await recipientSocket.recvOr(200)).toBeNull();
    expect(await bystanderSocket.recvOr(200)).toBeNull();
  });
});
