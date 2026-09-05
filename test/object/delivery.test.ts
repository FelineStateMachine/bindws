import { env, runInDurableObject } from "cloudflare:test";
import { deliveryTick, queueDelivery } from "../../src/delivery.ts";
import type { Relay } from "../../src/relay.ts";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { ev, pk, rpc, alarm } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("NIP-65 automatic delivery", () => {
  it("retries a refused target to its finite limit and stops on private relay policy", async () => {
    const owner = generateSecretKey(), targetOwner = generateSecretKey();
    const source = "retry-source.bind.ws", target = "retry-target.bind.ws";
    await rpc(source, owner, "claim"); await rpc(target, targetOwner, "claim");
    await rpc(target, targetOwner, "setpolicy", { writes: "owner" });
    await rpc(source, owner, "setpolicy", { delivery: { enabled: true, maxTargets: 1 } });
    await runInDurableObject(env.RELAY.getByName("retry-source"), async (relay: Relay) => {
      relay.store.save(ev(owner, 10002, "", [["r", "wss://" + target]]), 1);
      const note = ev(owner, 1, "retry me"); relay.store.save(note, 1);
      expect(queueDelivery(relay, note)).toBe(true);
      for (let i = 0; i < 4; i++) {
        relay.sql.exec(`UPDATE delivery_queue SET due=0`);
        await deliveryTick(relay);
      }
      expect(relay.sql.exec(`SELECT status,attempts FROM delivery_queue WHERE event_id=?`, note.id).one()).toMatchObject({ status: "rejected", attempts: 4 });
      relay.settings.update({ reads: "members" });
      expect(queueDelivery(relay, ev(owner, 1, "private relay note"))).toBe(false);
    });
  });

  it("routes public events to the author's write relay and exposes target status", async () => {
    const owner = generateSecretKey();
    const source = "auto-source.bind.ws", target = "auto-target.bind.ws";
    await rpc(target, generateSecretKey(), "claim");
    await rpc(source, owner, "claim");
    await rpc(source, owner, "setpolicy", { delivery: { enabled: true, maxTargets: 4 } });
    const targetSocket = await WS.connect(target);
    const sourceSocket = await WS.connect(source);
    const list = ev(owner, 10002, "", [["r", "wss://" + target, "write"]]);
    expect((await sourceSocket.ok(list)).ok).toBe(true);
    const note = ev(owner, 1, "routed");
    expect((await sourceSocket.ok(note)).ok).toBe(true);
    await alarm("auto-source");
    expect((await targetSocket.req({ ids: [note.id] })).map((e) => e.id)).toEqual([note.id]);
    const status = await rpc(source, owner, "deliverystatus");
    expect(status.result).toEqual(expect.arrayContaining([expect.objectContaining({ event_id: note.id, target: "wss://" + target, status: "accepted" })]));
  });

  it("does not queue private or protected events", async () => {
    const owner = generateSecretKey(), friend = generateSecretKey();
    const source = "auto-filter.bind.ws", target = "auto-filter-target.bind.ws";
    await rpc(target, generateSecretKey(), "claim");
    await rpc(source, owner, "claim");
    await rpc(source, owner, "setpolicy", { delivery: { enabled: true, maxTargets: 4 } });
    const socket = await WS.connect(source);
    expect((await socket.ok(ev(owner, 10002, "", [["r", "wss://" + target, "write"]]))).ok).toBe(true);
    const dm = ev(owner, 4, "secret", [["p", pk(friend)]]);
    const protectedEvent = ev(owner, 1, "protected", [["-", ""]]);
    expect((await socket.ok(dm)).ok).toBe(true);
    expect((await socket.ok(protectedEvent)).ok).toBe(false);
    const status = await rpc(source, owner, "deliverystatus");
    expect(status.result.filter((x: any) => [dm.id, protectedEvent.id].includes(x.event_id))).toEqual([]);
  });
});
