import { describe, it, expect } from "vitest";
import { newEvent, newKey, now, RELAY_URL, sockets } from "./helpers.ts";

const connect = sockets();

describe("NIP-42 AUTH", () => {
  it("refuses bad challenges, wrong relays, stale timestamps, wrong kinds; accepts several keys", async () => {
    const sk = newKey();
    const c = await connect();
    const bad = (tags: string[][], ts = now(), kind = 22242) => newEvent(sk, kind, "", tags, ts);
    let e = bad([["relay", RELAY_URL], ["challenge", "nope"]]);
    c.send("AUTH", e);
    expect(await c.expectOK(e.id, false)).toMatch(/challenge/);
    e = bad([["relay", "wss://elsewhere.example"], ["challenge", c.challenge]]);
    c.send("AUTH", e);
    expect(await c.expectOK(e.id, false)).toMatch(/relay/);
    e = bad([["relay", RELAY_URL], ["challenge", c.challenge]], now() - 3600);
    c.send("AUTH", e);
    expect(await c.expectOK(e.id, false)).toMatch(/time/);
    e = bad([["relay", RELAY_URL], ["challenge", c.challenge]], now(), 1);
    c.send("AUTH", e);
    await c.expectOK(e.id, false);
    // kind 22242 sent as a plain EVENT is never accepted.
    const asEvent = newEvent(sk, 22242, "", [["relay", RELAY_URL], ["challenge", c.challenge]]);
    c.send("EVENT", asEvent);
    expect(await c.expectOK(asEvent.id, false)).toMatch(/^(blocked|invalid):/);
    await c.auth(sk);
    await c.auth(newKey());
  });
});
