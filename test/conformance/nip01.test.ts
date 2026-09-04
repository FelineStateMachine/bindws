import { describe, it, expect } from "vitest";
import { newEvent, newKey, pub, now, rand, sockets } from "./helpers.ts";

const connect = sockets();

describe("NIP-01 core", () => {
  it("publishes, pushes live, dedups, rejects tampering, queries, replaces, limits, closes", async () => {
    const sk = newKey();
    const alice = await connect();
    const bob = await connect();
    const tag = rand();
    const t0 = now() - 1000;

    // Bob subscribes before anything exists: immediate EOSE.
    bob.send("REQ", "notes", { kinds: [1], "#t": [tag] });
    await bob.expect("EOSE");

    const note = newEvent(sk, 1, "hello <world> & friends", [["t", tag]], t0);
    await alice.publish(note);
    const live = await bob.expect("EVENT");
    expect(live[1]).toBe("notes");
    expect(live[2].id).toBe(note.id);
    expect(live[2].content).toBe(note.content);

    // Duplicate acknowledged, not re-broadcast.
    alice.send("EVENT", note);
    expect(await alice.expectOK(note.id, true)).toMatch(/^duplicate:/);
    await bob.expectNothing();

    // Tampered content is refused with an invalid: prefix.
    alice.send("EVENT", { ...note, content: "tampered" });
    expect(await alice.expectOK(note.id, false)).toMatch(/^invalid:/);

    // Stored query by tag and author.
    const carol = await connect();
    let r = await carol.req({ "#t": [tag], authors: [pub(sk)] });
    expect(r.events.map((e) => e.id)).toEqual([note.id]);

    // Replaceable: newest wins, stale refused.
    const meta1 = newEvent(sk, 0, '{"name":"v1"}', [], t0 + 1);
    const meta2 = newEvent(sk, 0, '{"name":"v2"}', [], t0 + 2);
    await alice.publish(meta2);
    alice.send("EVENT", meta1);
    expect(await alice.expectOK(meta1.id, false)).toMatch(/newer/);
    r = await carol.req({ kinds: [0], authors: [pub(sk)] });
    expect(r.events.map((e) => e.id)).toEqual([meta2.id]);

    // Addressable: same d replaces, different d coexists.
    const a1 = newEvent(sk, 30023, "draft", [["d", "post"]], t0 + 3);
    const a2 = newEvent(sk, 30023, "final", [["d", "post"]], t0 + 4);
    const a3 = newEvent(sk, 30023, "other", [["d", "other"]], t0 + 4);
    for (const e of [a1, a2, a3]) await alice.publish(e);
    r = await carol.req({ kinds: [30023], authors: [pub(sk)] });
    expect(r.events.map((e) => e.id).sort()).toEqual([a2.id, a3.id].sort());

    // Limit, newest-first ordering, and NIP-67 hints.
    for (let i = 0; i < 5; i++) await alice.publish(newEvent(sk, 1, "n" + i, [["t", tag]], t0 + 10 + i));
    r = await carol.req({ kinds: [1], "#t": [tag], limit: 2 });
    expect(r.events.length).toBe(2);
    expect(r.events[0].created_at).toBe(t0 + 14);
    expect(r.hints).toContain("more");
    r = await carol.req({ kinds: [1], "#t": [tag] });
    expect(r.events.length).toBe(6);
    expect(r.hints).toContain("finish");

    // Bob's live sub saw the five notes; CLOSE stops delivery.
    for (let i = 0; i < 5; i++) await bob.expect("EVENT");
    bob.send("CLOSE", "notes");
    await alice.publish(newEvent(sk, 1, "after close", [["t", tag]], t0 + 20));
    await bob.expectNothing();
  });

  it("does not store ephemeral events but does broadcast them", async () => {
    const a = await connect();
    const b = await connect();
    const sk = newKey();
    b.send("REQ", "eph", { kinds: [20001], authors: [pub(sk)] });
    await b.expect("EOSE");
    await a.publish(newEvent(sk, 20001, "poof"));
    await b.expect("EVENT");
    const c = await connect();
    const r = await c.req({ kinds: [20001], authors: [pub(sk)] });
    expect(r.events).toEqual([]);
  });

  it("answers bad input with NOTICE or CLOSED and keeps the connection", async () => {
    const c = await connect();
    c.send("BOGUS", 1);
    expect((await c.expect("NOTICE"))[1]).toMatch(/^error:/);
    c.send("REQ", "x", { kinds: "not-a-list" });
    await c.expectClosed("invalid:");
    c.send("REQ", "still-alive", { kinds: [1], limit: 0 });
    await c.expect("EOSE");
  });
});
