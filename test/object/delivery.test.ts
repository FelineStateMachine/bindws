import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { ev, pk, rpc, alarm } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("NIP-65 automatic delivery", () => {
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
