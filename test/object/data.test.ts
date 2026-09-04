// Dumps to R2, per-member keep-for and caps, and members inviting members.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { writeDump } from "../../src/dumps.ts";
import { now, ev, pk, rpc, get, post } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("dumps", () => {
  it("writes a JSONL of every event to R2, lists it, serves it to a signature, rotates and counts as media", async () => {
    const host = "dumpy.bind.ws";
    const owner = generateSecretKey();
    const writer = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    for (let i = 0; i < 3; i++) expect((await c.ok(ev(writer, 1, "note " + i))).ok).toBe(true);
    expect((await rpc(host, owner, "setpolicy", { dumps: "daily", dumpsKeep: 2 })).result.dumps).toBe("daily");

    const d = (await rpc(host, owner, "dumpnow")).result;
    expect(d.name).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const total = (await rpc(host, owner, "stats")).result.events;
    expect(d.events).toBe(total);
    expect(total).toBeGreaterThanOrEqual(3);
    const obj = await env.MEDIA.get(`dumpy/dumps/${d.name}`);
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(d.events);
    for (const l of lines) expect(JSON.parse(l).id).toMatch(/^[0-9a-f]{64}$/);
    expect(d.bytes).toBe(text.length);

    const list = (await rpc(host, owner, "listdumps")).result;
    expect(list.map((x: any) => x.name)).toEqual([d.name]);
    expect(list[0].url).toBe("/dumps/" + d.name);

    // Download needs a signature from someone with the storage action.
    const signed = await get(host, "/dumps/" + d.name, owner);
    expect(signed.status).toBe(200);
    expect(signed.headers.get("content-disposition")).toContain(d.name);
    expect(await signed.text()).toBe(text);
    expect((await get(host, "/dumps/" + d.name, null)).status).toBe(401);
    expect((await get(host, "/dumps/" + d.name, writer)).status).toBe(403);
    expect((await get(host, "/dumps/nope.jsonl", owner)).status).toBe(400);
    expect((await get(host, "/dumps/1999-01-01.jsonl", owner)).status).toBe(404);

    const stub = env.RELAY.getByName("dumpy");
    await runInDurableObject(stub, async (r: Relay) => {
      expect(r.mediaBytes()).toBe(d.bytes);
      // Two older dumps and a keep of two: the oldest goes.
      await writeDump(r, now() - 2 * 86400);
      await writeDump(r, now() - 86400);
    });
    const after = (await rpc(host, owner, "listdumps")).result.map((x: any) => x.name);
    expect(after.length).toBe(2);
    expect(after[0]).toBe(d.name);
    expect((await env.MEDIA.list({ prefix: "dumpy/dumps/" })).objects.length).toBe(2);
    expect((await rpc(host, owner, "storagestats")).result.dumps).toBe(2);

    expect((await rpc(host, owner, "deletedump", after[1])).result).toBe(true);
    expect((await env.MEDIA.list({ prefix: "dumpy/dumps/" })).objects.length).toBe(1);
    expect((await rpc(host, writer, "listdumps")).status).toBe(403);
  });

  it("the alarm writes a scheduled dump once a day, not twice", async () => {
    const host = "dumpz.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const stub = env.RELAY.getByName("dumpz");
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(0);
    await rpc(host, owner, "setpolicy", { dumps: "daily" });
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(1);
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(1);
  });
});

describe("per-member keep-for and caps", () => {
  it("a member's keep-for refuses old events and sweeps theirs, while others follow the relay's rules", async () => {
    const host = "keepy.bind.ws";
    const owner = generateSecretKey();
    const a = generateSecretKey();
    const b = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await rpc(host, owner, "setmember", pk(a), { keepDays: 10 })).status).toBe(200);
    await rpc(host, owner, "setmember", pk(b), {});
    const members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.find((m: any) => m.pubkey === pk(a)).keep_days).toBe(10);

    const c = await WS.connect(host);
    expect((await c.ok(ev(a, 1, "too old", [], now() - 20 * 86400))).msg).toMatch(/keeps your events for 10 days/);
    expect((await c.ok(ev(b, 1, "old but fine", [], now() - 20 * 86400))).ok).toBe(true);
    expect((await c.ok(ev(a, 1, "recent enough", [], now() - 5 * 86400))).ok).toBe(true);
    // Profiles are never swept by a keep-for.
    expect((await c.ok(ev(a, 0, JSON.stringify({ name: "a" }), [], now() - 30 * 86400))).ok).toBe(true);

    await rpc(host, owner, "setmember", pk(a), { keepDays: 3 });
    const gone = await runInDurableObject(env.RELAY.getByName("keepy"), async (r: Relay) => r.sweepRetention(now()));
    expect(gone).toBe(1);
    expect((await c.req({ kinds: [1], authors: [pk(a)] })).length).toBe(0);
    expect((await c.req({ kinds: [0], authors: [pk(a)] })).length).toBe(1);
    expect((await c.req({ kinds: [1], authors: [pk(b)] })).length).toBe(1);

    // Only the owner sets limits, and never on themselves.
    const mod = generateSecretKey();
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    expect((await rpc(host, mod, "setmember", pk(b), { keepDays: 1 })).status).toBe(403);
    await rpc(host, owner, "setmember", pk(owner), { keepDays: 1 });
    expect((await c.ok(ev(owner, 1, "owner, old", [], now() - 20 * 86400))).ok).toBe(true);
  });

  it("a cap refuses the event that would cross it, and the owner is never capped", async () => {
    const host = "cappy.bind.ws";
    const owner = generateSecretKey();
    const m = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(m), { maxBytes: 1200 });
    const c = await WS.connect(host);
    const big = "x".repeat(400);
    expect((await c.ok(ev(m, 1, big))).ok).toBe(true);
    const r = await c.ok(ev(m, 1, big + "2"));
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/^restricted: you have reached your storage cap/);
    expect((await c.ok(ev(m, 7, "+"))).ok).toBe(true); // small ones still fit
    for (let i = 0; i < 3; i++) expect((await c.ok(ev(owner, 1, big + i))).ok).toBe(true);
    // Raising the cap lets it through; the cache follows the store.
    await rpc(host, owner, "setmember", pk(m), { maxBytes: 5000 });
    expect((await c.ok(ev(m, 1, big + "3"))).ok).toBe(true);
    const cfg = (await rpc(host, owner, "exportconfig")).result;
    expect(cfg.members.find((x: any) => x.pubkey === pk(m)).maxBytes).toBe(5000);
  });
});

describe("members invite members", () => {
  it("depth and quota bound the tree, both join paths record the inviter, and a subtree goes in one publish", async () => {
    const host = "treey.bind.ws";
    const owner = generateSecretKey();
    const a = generateSecretKey();
    const b = generateSecretKey();
    const c2 = generateSecretKey();
    const e = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist", memberInvites: { depth: 2, quota: 1 } });
    expect((await rpc(host, owner, "getpolicy")).result.memberInvites).toEqual({ depth: 2, quota: 1 });

    // The owner invites A through the HTTP door.
    const inv = (await rpc(host, owner, "createinvite", 86400, 0, "for a")).result;
    expect((await post(host, a, "/api/invites/claim", { code: inv.code })).body.status).toBe("joined");
    let members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.find((m: any) => m.pubkey === pk(a)).invited_by).toBe(pk(owner));

    // A is one hop out and may hold one live invite.
    const invA = await rpc(host, a, "createinvite", 86400, 1, "for b");
    expect(invA.status, JSON.stringify(invA)).toBe(200);
    expect((await rpc(host, a, "createinvite")).error).toMatch(/already hold 1 live invite/);
    expect((await rpc(host, a, "listinvites")).result.map((i: any) => i.code)).toEqual([invA.result.code]);
    expect((await rpc(host, a, "revokeinvite", inv.code)).status).toBe(403);
    expect((await rpc(host, a, "listmembers")).status).toBe(403);

    // B joins with A's code over the NIP-29 door; two hops out, B cannot invite.
    const ws = await WS.connect(host);
    expect((await ws.ok(ev(b, 9021, "", [["h", "treey"], ["code", invA.result.code]]))).ok).toBe(true);
    members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.find((m: any) => m.pubkey === pk(b)).invited_by).toBe(pk(a));
    expect((await rpc(host, b, "createinvite")).error).toMatch(/do not reach/);
    // A's invite is used up, so A may mint again; C joins, then E, whom the owner makes a moderator.
    const invA2 = (await rpc(host, a, "createinvite", 86400, 2, "more")).result;
    expect((await ws.ok(ev(c2, 9021, "", [["h", "treey"], ["code", invA2.code]]))).ok).toBe(true);
    expect((await ws.ok(ev(e, 9021, "", [["h", "treey"], ["code", invA2.code]]))).ok).toBe(true);
    await rpc(host, owner, "setmember", pk(e), { role: "moderator" });
    members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.find((m: any) => m.pubkey === pk(a)).invites).toBe(0);

    // Switched off, members are back to asking the owner.
    await rpc(host, owner, "setpolicy", { memberInvites: { depth: 0, quota: 0 } });
    expect((await rpc(host, a, "createinvite")).status).toBe(403);

    // Removing A takes B and C along, leaves the moderator E, and publishes once.
    const stub = env.RELAY.getByName("treey");
    await runInDurableObject(stub, async (r: Relay) => {
      const orig = r.publishMembership.bind(r);
      (r as any).__pub = 0;
      (r as any).publishMembership = async (...changes: { pubkey: string; added?: boolean }[]) => {
        (r as any).__pub++;
        return orig(...changes);
      };
    });
    // The moderator may do it: A is a plain member, and E's own branch stays.
    const removed = (await rpc(host, e, "removesubtree", pk(a))).result.removed;
    expect(removed.sort()).toEqual([pk(a), pk(b), pk(c2)].sort());
    members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.map((m: any) => m.pubkey).sort()).toEqual([pk(owner), pk(e)].sort());
    await runInDurableObject(stub, async (r: Relay) => expect((r as any).__pub).toBe(1));
    expect((await ws.req({ kinds: [9001] })).length).toBe(3);
    expect((await rpc(host, owner, "removesubtree", pk(owner))).status).toBe(400);
  });
});
