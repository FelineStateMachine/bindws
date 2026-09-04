// Members: invites, members-only reads and eviction, per-member keep-for
// and caps, members inviting members, and the migration of the members table.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { now, ev, rpc, post, pk } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("invites", () => {
  it("lets the owner mint links that non-members can claim, with expiry and use limits", async () => {
    const host = "invite.bind.ws";
    const owner = generateSecretKey();
    const guest = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist", joinTerms: "Be kind." });
    expect((await rpc(host, guest, "createinvite")).status).toBe(403);
    const inv = (await rpc(host, owner, "createinvite", 3600, 1, "for guest")).result;
    expect(inv.code).toMatch(/^[0-9a-f]{32}$/);
    expect(inv.max_uses).toBe(1);

    // The page renders the terms for a valid code and a problem for a bad one.
    let page = await (await SELF.fetch(`http://${host}/invite/${inv.code}`)).text();
    expect(page).toContain("Be kind.");
    expect(page).toContain("Join with extension");
    page = await (await SELF.fetch(`http://${host}/invite/nope`)).text();
    expect(page).toContain("isn't valid");

    // Before joining: writes refused. After: accepted, and the roster changed.
    const c = await WS.connect(host);
    expect((await c.ok(ev(guest, 1, "hi"))).msg).toMatch(/^restricted:/);
    let r = await post(host, guest, "/api/invites/claim", { code: inv.code });
    expect(r.body).toEqual({ status: "joined", role: "member" });
    expect((await c.ok(ev(guest, 1, "hi again"))).ok).toBe(true);
    r = await post(host, guest, "/api/invites/claim", { code: inv.code });
    expect(r.body.status).toBe("already_member");
    r = await post(host, generateSecretKey(), "/api/invites/claim", { code: inv.code });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("invite_exhausted");
    expect((await post(host, generateSecretKey(), "/api/invites/claim", { code: "bogus" })).body.error).toBe("invite_invalid");
    const list = (await rpc(host, owner, "listinvites")).result;
    expect(list[0].uses).toBe(1);
    expect((await rpc(host, owner, "revokeinvite", inv.code)).result).toBe(true);
    expect((await rpc(host, owner, "listinvites")).result).toEqual([]);
    const members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.find((m: any) => m.pubkey === getPublicKey(guest)).via).toMatch(/^invite /);
  });
});

describe("members-only reads and eviction", () => {
  it("serves only members when reads=members, and closes the door on bans and removals", async () => {
    const host = "closed.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "allowpubkey", getPublicKey(member));
    await rpc(host, owner, "setpolicy", { reads: "members" });
    const s = await WS.connect(host);
    expect((await s.query({ kinds: [1] })).closed).toMatch(/^auth-required:/);
    await s.auth(stranger, host);
    expect((await s.query({ kinds: [1] })).closed).toMatch(/^restricted: .*members/);
    const m = await WS.connect(host);
    await m.auth(member, host);
    expect((await m.query({ kinds: [1] })).closed).toBe("");
    m.send("REQ", "live", { kinds: [1] });
    await m.expect("EOSE");

    // Removal ends every subscription with a reason; the socket stays.
    await rpc(host, owner, "unrulepubkey", getPublicKey(member));
    const closed = await m.expect("CLOSED");
    expect(closed[1]).toBe("live");
    expect(closed[2]).toMatch(/^restricted:/);
    expect(m.closed).toBeNull();

    // A ban closes the socket outright.
    const b = await WS.connect(host);
    await b.auth(stranger, host);
    await rpc(host, owner, "banpubkey", getPublicKey(stranger), "bye");
    for (let i = 0; i < 20 && !b.closed; i++) await new Promise((r) => setTimeout(r, 50));
    expect(b.closed?.code).toBe(4403);
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

describe("members migration", () => {
  it("folds the earlier allow list and names table into members on load", async () => {
    const stub = env.RELAY.getByName("legacy");
    const owner = generateSecretKey();
    const a = getPublicKey(generateSecretKey());
    const b = getPublicKey(generateSecretKey());
    await runInDurableObject(stub, async (r: Relay) => {
      r.settings.update({ owner: getPublicKey(owner) });
      r.sql.exec(`INSERT INTO pubkey_rules(pubkey,rule,reason,at) VALUES(?,'allow','old friend',1000)`, a);
      r.sql.exec(`INSERT INTO nip05(name,pubkey,at) VALUES('bob',?,2000)`, b);
      r.sql.exec(`INSERT INTO nip05(name,pubkey,at) VALUES('alice',?,3000)`, a);
      r.settings.load();
      const m = r.settings.members();
      expect(m.map((x) => [x.role, x.name, x.via])).toEqual([["owner", null, "claimed"], ["member", "alice", "added"], ["member", "bob", "profile"]]);
      expect(r.settings.isAllowed(a) && r.settings.isAllowed(b)).toBe(true);
      expect(r.sql.exec(`SELECT count(*) AS n FROM pubkey_rules`).one().n).toBe(0);
      r.settings.load(); // idempotent
      expect(r.settings.members().length).toBe(3);
    });
  });
});
