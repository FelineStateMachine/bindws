import { describe, it, expect } from "vitest";
import { newEvent, newKey, pub, now, rand, sockets } from "./helpers.ts";

const connect = sockets();

describe("NIP-50 search", () => {
  it("matches words in content, case-insensitively, ignores extensions, is injection-safe, and matches live", async () => {
    const sk = newKey();
    const c = await connect();
    const w = rand();
    const texts = [`Purple ${w}elephants dance`, `${w}orange juice`, `the ${w}elephant in the room`];
    for (const [i, t] of texts.entries()) await c.publish(newEvent(sk, 1, t, [], now() - 10 + i));
    await c.publish(newEvent(sk, 4, `${w}elephant encrypted`, [["p", pub(sk)]], now() - 5));

    let r = await c.req({ search: `${w}elephant`, authors: [pub(sk)] });
    expect(r.events.map((e) => e.content)).toEqual([texts[2]]);
    r = await c.req({ search: `PURPLE include:spam dance ${w}elephants`, authors: [pub(sk)] });
    expect(r.events.map((e) => e.content)).toEqual([texts[0]]);
    r = await c.req({ search: `${w}juice OR NOT "`, authors: [pub(sk)] });
    expect(r.hints).toContain("finish");

    c.send("REQ", "live", { search: `${w}banana`, authors: [pub(sk)] });
    await c.drain();
    await c.publish(newEvent(sk, 1, `a ${w}Banana split`));
    await c.expect("EVENT");
  });
});
