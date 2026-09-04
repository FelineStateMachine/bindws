import { describe, it, expect } from "vitest";
import { newEvent, newKey, sockets } from "./helpers.ts";

const connect = sockets();

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
