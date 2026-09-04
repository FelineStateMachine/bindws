import { describe, it, expect } from "vitest";
import { newEvent, newKey, pub, now, randHex, sockets } from "./helpers.ts";

const connect = sockets();

describe("NIP-45 COUNT", () => {
  it("counts across OR'd filters without double counting, and adds an hll sketch for tag filters", async () => {
    const sk = newKey();
    const c = await connect();
    const target = randHex();
    for (let i = 0; i < 3; i++) await c.publish(newEvent(sk, 1, "n", [["t", target]], now() - 10 + i));
    await c.publish(newEvent(sk, 7, "+", [["e", target]], now() - 5));

    c.send("COUNT", "n", { kinds: [1], authors: [pub(sk)] }, { kinds: [7], authors: [pub(sk)] });
    expect((await c.expect("COUNT"))[2].count).toBe(4);
    c.send("COUNT", "n", { kinds: [1], authors: [pub(sk)] }, { "#t": [target], authors: [pub(sk)] });
    expect((await c.expect("COUNT"))[2].count).toBe(3);

    c.send("COUNT", "r", { kinds: [7], "#e": [target] });
    const res = (await c.expect("COUNT"))[2];
    expect(res.count).toBe(1);
    expect(res.hll).toMatch(/^[0-9a-f]{512}$/);
    // Register: offset = nibble 32 of the target + 8; byte[offset] indexes,
    // zero run after it plus one is the value.
    const offset = parseInt(target[32], 16) + 8;
    const pk = pub(sk);
    const regIndex = parseInt(pk.substr(offset * 2, 2), 16);
    const rest = pk.slice((offset + 1) * 2);
    let zeros = 0;
    for (const ch of rest) {
      const n = parseInt(ch, 16);
      if (n === 0) {
        zeros += 4;
        continue;
      }
      zeros += Math.clz32(n) - 28;
      break;
    }
    expect(parseInt(res.hll.substr(regIndex * 2, 2), 16)).toBe(zeros + 1);
  });
});
