// Succession: an heir and a dead-man's switch. The owner's presence is
// recorded on signed actions; silence past the delay starts a month of
// warnings; silence through the month hands the relay to the heir.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { unwrapEvent } from "nostr-tools/nip59";
import type { Relay } from "../../src/relay.ts";
import { now, pk, rpc, info, alarm } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

const DAY = 86400;

// inbox reads the wraps addressed to a key and opens them with it.
async function inbox(host: string, sk: Uint8Array): Promise<string[]> {
  const c = await WS.connect(host);
  await c.auth(sk, host);
  const wraps = await c.req({ kinds: [1059], "#p": [pk(sk)] });
  return wraps.map((w) => unwrapEvent(w, sk).content);
}

// silence backdates the owner's last sign-in and holds the hourly presence
// write so the test's own owner calls do not refresh it.
async function silence(name: string, days: number) {
  await runInDurableObject(env.RELAY.getByName(name), async (r: Relay, state) => {
    await state.storage.put("ownerSeenAt", now() - days * DAY);
    r.succession.seenWrite = Date.now();
  });
}

describe("succession", () => {
  it("names an heir who must be a member, with an allowed delay", async () => {
    const host = "heirs.bind.ws";
    const owner = generateSecretKey();
    const heir = generateSecretKey();
    await rpc(host, owner, "claim");
    let r = await rpc(host, owner, "setsuccession", { heir: pk(heir), afterDays: 90 });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/member first/);
    await rpc(host, owner, "setmember", pk(heir), {});
    r = await rpc(host, owner, "setsuccession", { heir: pk(heir), afterDays: 10 });
    expect(r.error).toMatch(/afterDays/);
    r = await rpc(host, owner, "setsuccession", { heir: pk(heir), afterDays: 90 });
    expect(r.status).toBe(200);
    expect(r.result.succession).toEqual({ heir: pk(heir), afterDays: 90 });
    expect(r.result.warning).toBeNull();
    expect(r.result.handoverAt).toBeGreaterThan(now() + 119 * DAY);
    expect((await rpc(host, owner, "getpolicy")).result.notify.succession).toBe(true);
    // The heir may read the status; a moderator may not; the plan stays out of exports.
    const mod = generateSecretKey();
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    expect((await rpc(host, heir, "successionstatus")).result.succession.heir).toBe(pk(heir));
    expect((await rpc(host, mod, "successionstatus")).status).toBe(403);
    expect((await rpc(host, owner, "exportconfig")).result.policy.succession).toBeUndefined();
    expect((await rpc(host, owner, "clearsuccession")).result).toBe(true);
    expect((await rpc(host, owner, "getpolicy")).result.succession).toBeNull();
  });

  it("records the owner's presence on signed actions, not a member's", async () => {
    const host = "seen.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member), {});
    const seenAt = () => runInDurableObject(env.RELAY.getByName("seen"), async (_r: Relay, state) => (await state.storage.get<number>("ownerSeenAt")) ?? 0);
    expect(await seenAt()).toBeGreaterThan(now() - 5);
    const backdate = () => runInDurableObject(env.RELAY.getByName("seen"), async (r: Relay, state) => {
      await state.storage.put("ownerSeenAt", now() - 5 * DAY);
      r.succession.seenWrite = 0;
    });
    await backdate();
    const m = await WS.connect(host);
    await m.auth(member, host);
    expect(await seenAt()).toBeLessThan(now() - 4 * DAY);
    const o = await WS.connect(host);
    await o.auth(owner, host);
    expect(await seenAt()).toBeGreaterThan(now() - 5);
    await backdate();
    await rpc(host, owner, "stats");
    expect(await seenAt()).toBeGreaterThan(now() - 5);
  });

  it("warns after the delay, stops when the owner shows up, and hands over after the month", async () => {
    const host = "estate.bind.ws";
    const name = "estate";
    const owner = generateSecretKey();
    const heir = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(heir), { name: "heir" });
    await rpc(host, owner, "setsuccession", { heir: pk(heir), afterDays: 90 });

    // Silent for 60 days: nothing happens.
    await silence(name, 60);
    await alarm(name);
    expect((await info(host)).succession_pending).toBeUndefined();
    // Silent for 91 days: the warning month starts, the owner is told.
    await silence(name, 91);
    await alarm(name);
    let doc = await info(host);
    expect(doc.succession_pending).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    let msgs = await inbox(host, owner);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatch(/not signed in .* 91 days/);
    // A second alarm the same week says nothing more.
    await alarm(name);
    expect((await inbox(host, owner)).length).toBe(1);

    // The owner acts: the warning is called off.
    await runInDurableObject(env.RELAY.getByName(name), async (r: Relay) => {
      r.succession.seenWrite = 0;
    });
    let st = (await rpc(host, owner, "successionstatus")).result;
    expect(st.warning).toBeNull();
    expect(st.silentDays).toBe(0);
    expect((await info(host)).succession_pending).toBeUndefined();

    // Silent again, through the whole month: the relay changes hands.
    await silence(name, 95);
    await alarm(name);
    expect((await rpc(host, heir, "successionstatus")).result.warning).not.toBeNull();
    await runInDurableObject(env.RELAY.getByName(name), async (r: Relay, state) => {
      const warn = { since: now() - 31 * DAY, lastNotified: now() - 31 * DAY };
      await state.storage.put("succession_warn", warn);
      r.succession.warn = warn;
    });
    await alarm(name);
    doc = await info(host);
    expect(doc.pubkey).toBe(pk(heir));
    expect(doc.succession_pending).toBeUndefined();
    const members = (await rpc(host, heir, "listmembers")).result.members as { pubkey: string; role?: string }[];
    expect(members.find((m) => m.pubkey === pk(owner))?.role).toBe("moderator");
    expect((await rpc(host, heir, "getpolicy")).result.succession).toBeNull();
    st = (await rpc(host, heir, "successionstatus")).result;
    expect(st.log).toEqual([{ at: expect.any(Number), from: pk(owner), to: pk(heir) }]);
    expect(st.ownerSeenAt).toBeGreaterThan(now() - 5);
    msgs = await inbox(host, owner);
    expect(msgs.some((m) => /now belongs to/.test(m))).toBe(true);
    expect((await inbox(host, heir)).some((m) => /is yours now/.test(m))).toBe(true);
    // The old owner is a moderator now: no more than that.
    expect((await rpc(host, owner, "setpolicy", { name: "mine again" })).status).toBe(403);
  });

  it("drops the plan when the heir is no longer a member", async () => {
    const host = "orphan.bind.ws";
    const owner = generateSecretKey();
    const heir = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(heir), {});
    await rpc(host, owner, "setsuccession", { heir: pk(heir), afterDays: 90 });
    await rpc(host, owner, "removemember", pk(heir));
    await silence("orphan", 100);
    await alarm("orphan");
    expect((await rpc(host, owner, "getpolicy")).result.succession).toBeNull();
    expect((await inbox(host, owner)).some((m) => /no longer a member/.test(m))).toBe(true);
    expect((await info(host)).pubkey).toBe(pk(owner));
  });
});
