import { describe, it, expect, afterEach } from "vitest";
import { Client, newEvent, newKey, pub, now, RELAY_URL } from "./helpers.ts";

const open: Client[] = [];
const connect = async () => {
  const c = await Client.connect();
  open.push(c);
  return c;
};
afterEach(() => open.splice(0).forEach((c) => c.close()));

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

describe("NIP-70 protected events", () => {
  it("accepts ['-'] events only from a connection authenticated as the author", async () => {
    const sk = newKey();
    const c = await connect();
    const e = newEvent(sk, 1, "members only", [["-"]]);
    c.send("EVENT", e);
    expect(await c.expectOK(e.id, false)).toMatch(/^auth-required:/);
    await c.auth(newKey());
    c.send("EVENT", e);
    await c.expectOK(e.id, false);
    await c.auth(sk);
    await c.publish(e);
  });
});

describe("NIP-17 / NIP-59 private kinds", () => {
  it("serves gift wraps only to their recipients, stored and live, and lets recipients delete them", async () => {
    const sender = newKey();
    const recipient = newKey();
    const stranger = newKey();
    const s = await connect();
    const wrap = newEvent(sender, 1059, "ciphertext", [["p", pub(recipient)]], now() - 100);
    await s.publish(wrap);

    const x = await connect();
    x.send("REQ", "dm", { kinds: [1059], "#p": [pub(recipient)] });
    await x.expectClosed("auth-required:");
    let r = await x.req({ "#p": [pub(recipient)] });
    expect(r.events).toEqual([]);
    expect(r.hints).toContain("auth");
    x.send("COUNT", "n", { "#p": [pub(recipient)] });
    expect((await x.expect("COUNT"))[2].count).toBe(0);

    await x.auth(stranger);
    r = await x.req({ kinds: [1059], "#p": [pub(recipient)] });
    expect(r.events).toEqual([]);
    x.send("REQ", "live", { kinds: [1059], "#p": [pub(recipient)] });
    await x.expect("EOSE");
    await s.publish(newEvent(sender, 1059, "ciphertext2", [["p", pub(recipient)]], now() - 99));
    await x.expectNothing();

    const rc = await connect();
    await rc.auth(recipient);
    r = await rc.req({ kinds: [1059], "#p": [pub(recipient)] });
    expect(r.events.length).toBe(2);
    rc.send("REQ", "live", { kinds: [1059], "#p": [pub(recipient)] });
    await rc.drain();
    const wrap3 = newEvent(sender, 1059, "ciphertext3", [["p", pub(recipient)]], now() - 98);
    await s.publish(wrap3);
    expect((await rc.expect("EVENT"))[2].id).toBe(wrap3.id);

    await rc.publish(newEvent(recipient, 5, "", [["e", wrap3.id]]));
    expect((await rc.req({ ids: [wrap3.id] })).events).toEqual([]);
    s.send("EVENT", wrap3);
    expect(await s.expectOK(wrap3.id, false)).toMatch(/^blocked:/);
  });
});
