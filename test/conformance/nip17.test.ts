import { describe, it, expect } from "vitest";
import { newEvent, newKey, pub, now, sockets } from "./helpers.ts";

const connect = sockets();

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
