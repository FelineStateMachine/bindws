import { describe, it, expect } from "vitest";
import { newEvent, newKey, pub, now, RELAY_URL, sockets } from "./helpers.ts";

const connect = sockets();

describe("NIP-62 vanish", () => {
  it("deletes everything from the pubkey up to the request, plus gift wraps to it, and blocks resurrection", async () => {
    const sk = newKey();
    const other = newKey();
    const c = await connect();
    const t0 = now() - 100;
    const note = newEvent(sk, 1, "regret", [], t0);
    const meta = newEvent(sk, 0, "{}", [], t0);
    const wrap = newEvent(other, 1059, "dm", [["p", pub(sk)]], t0);
    const keep = newEvent(other, 1, "unrelated", [], t0);
    for (const e of [note, meta, wrap, keep]) await c.publish(e);

    let v = newEvent(sk, 62, "", [["relay", "wss://other.example"]], t0 + 1);
    c.send("EVENT", v);
    await c.expectOK(v.id, false);
    expect((await c.req({ authors: [pub(sk)] })).events.length).toBe(2);

    v = newEvent(sk, 62, "bye", [["relay", RELAY_URL]], t0 + 1);
    await c.publish(v);
    expect((await c.req({ authors: [pub(sk)] })).events).toEqual([]);
    expect((await c.req({ ids: [keep.id] })).events.length).toBe(1);
    const rc = await connect();
    await rc.auth(sk);
    expect((await rc.req({ kinds: [1059], "#p": [pub(sk)] })).events).toEqual([]);

    c.send("EVENT", note);
    expect(await c.expectOK(note.id, false)).toMatch(/^blocked:/);
    await c.publish(newEvent(sk, 1, "fresh start", [], t0 + 2));

    v = newEvent(other, 62, "", [["relay", "ALL_RELAYS"]], t0 + 3);
    await c.publish(v);
    expect((await c.req({ authors: [pub(other)] })).events).toEqual([]);
  });
});
