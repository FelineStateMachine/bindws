import { describe, it, expect } from "vitest";
import { newEvent, newKey, now, sleep, sockets } from "./helpers.ts";

const connect = sockets();

describe("NIP-40 expiration", () => {
  it("refuses expired events, serves unexpired ones, and stops serving after expiry", async () => {
    const sk = newKey();
    const c = await connect();
    const dead = newEvent(sk, 1, "gone", [["expiration", String(now() - 1)]]);
    c.send("EVENT", dead);
    expect(await c.expectOK(dead.id, false)).toMatch(/expired/);
    const soon = newEvent(sk, 1, "soon", [["expiration", String(now() + 2)]]);
    await c.publish(soon);
    expect((await c.req({ ids: [soon.id] })).events.length).toBe(1);
    await sleep(2500);
    expect((await c.req({ ids: [soon.id] })).events.length).toBe(0);
    c.send("COUNT", "q", { ids: [soon.id] });
    expect((await c.expect("COUNT"))[2].count).toBe(0);
  });
});
