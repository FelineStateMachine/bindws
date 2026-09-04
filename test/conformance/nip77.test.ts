import { describe, it, expect } from "vitest";
import { newEvent, newKey, pub, now, item, sockets } from "./helpers.ts";

const connect = sockets();

describe("NIP-77 negentropy", () => {
  it("reconciles a client set against the relay's, respecting visibility", async () => {
    const sk = newKey();
    const recipient = newKey();
    const c = await connect();
    const t0 = now() - 1000;
    const relayHas = [];
    for (let i = 0; i < 100; i++) relayHas.push(await (async () => {
      const e = newEvent(sk, 1, String(i), [], t0 + Math.floor(i / 3));
      await c.publish(e);
      return e;
    })());
    const local = [];
    for (let i = 0; i < 5; i++) local.push(newEvent(sk, 1, "local " + i, [], t0 + 10 + i));
    const wrap = newEvent(sk, 1059, "dm", [["p", pub(recipient)]], t0 + 5);
    await c.publish(wrap);

    const clientItems = [...relayHas.slice(0, 60), ...local].map(item);
    const { have, need } = await c.sync(clientItems, { kinds: [1], authors: [pub(sk)] });
    expect(have).toEqual(local.map((e) => e.id).sort());
    expect(need).toEqual(relayHas.slice(60).map((e) => e.id).sort());

    // Strangers never learn the gift wrap; the recipient does.
    let r = await c.sync(relayHas.map(item), { authors: [pub(sk)] });
    expect(r.need).toEqual([]);
    const rc = await connect();
    await rc.auth(recipient);
    r = await rc.sync(relayHas.map(item), { authors: [pub(sk)] });
    expect(r.need).toEqual([wrap.id]);

    // Error paths.
    c.send("NEG-MSG", "nope", "61");
    expect((await c.expect("NEG-ERR"))[2]).toMatch(/^closed:/);
    c.send("NEG-OPEN", "bad", {}, "zz");
    expect((await c.expect("NEG-ERR"))[2]).toMatch(/^invalid:/);
    const x = await connect();
    x.send("NEG-OPEN", "dm", { kinds: [1059] }, "61");
    expect((await x.expect("NEG-ERR"))[2]).toMatch(/^auth-required:/);
    x.send("NEG-OPEN", "v", { kinds: [1], authors: [pub(sk)] }, "62");
    expect((await x.expect("NEG-MSG"))[2]).toBe("61");
  });
});
