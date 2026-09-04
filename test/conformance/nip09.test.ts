import { describe, it, expect } from "vitest";
import { newEvent, newKey, pub, now, sockets } from "./helpers.ts";

const connect = sockets();

describe("NIP-09 deletion", () => {
  it("lets only the author delete, keeps deleted ids out, ignores strangers", async () => {
    const sk = newKey();
    const other = newKey();
    const alice = await connect();
    const stranger = await connect();
    const carol = await connect();
    const note = newEvent(sk, 1, "regret", [], now() - 100);
    await alice.publish(note);

    await stranger.publish(newEvent(other, 5, "", [["e", note.id]]));
    expect((await carol.req({ ids: [note.id] })).events.length).toBe(1);

    await alice.publish(newEvent(sk, 5, "", [["e", note.id], ["k", "1"]]));
    expect((await carol.req({ ids: [note.id] })).events.length).toBe(0);
    alice.send("EVENT", note);
    expect(await alice.expectOK(note.id, false)).toMatch(/^blocked:/);
  });

  it("deletes addressable versions up to the request time via a tags", async () => {
    const sk = newKey();
    const c = await connect();
    const t0 = now() - 100;
    await c.publish(newEvent(sk, 30023, "v1", [["d", "x"]], t0));
    await c.publish(newEvent(sk, 5, "", [["a", `30023:${pub(sk)}:x`]], t0 + 1));
    expect((await c.req({ kinds: [30023], authors: [pub(sk)], "#d": ["x"] })).events.length).toBe(0);
  });
});
