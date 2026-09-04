// NIP-43, the rest of it: the relay's own profile, role definitions, roles
// in the roster, the NIP-43 join and leave requests, and the promise that
// the roster and the NIP-29 group never disagree, whichever path changed
// the members.
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { ev, pk, tagsOf, rpc, info } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("relay profile and roles", () => {
  it("signs a kind 0 for the self key, role definitions, and roles in the roster", async () => {
    const host = "profile.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const self = (await info(host)).self as string;
    const c = await WS.connect(host);

    let profile = await c.req({ kinds: [0], authors: [self] });
    expect(profile.length).toBe(1);
    expect(JSON.parse(profile[0].content)).toEqual({ name: "profile", about: "" });
    await rpc(host, owner, "changerelayname", "Pizza");
    await rpc(host, owner, "setpolicy", { description: "pies", icon: "https://img.example/pizza.png" });
    profile = await c.req({ kinds: [0], authors: [self] });
    expect(profile.length).toBe(1);
    expect(JSON.parse(profile[0].content)).toEqual({ name: "Pizza", about: "pies", picture: "https://img.example/pizza.png" });

    const roles = await c.req({ kinds: [33534], authors: [self] });
    expect(roles.map((e) => tagsOf(e, "d")[0][1]).sort()).toEqual(["moderator", "owner"]);
    for (const r of roles) {
      expect(tagsOf(r, "-").length).toBe(1);
      expect(tagsOf(r, "label")[0][1]).toBe(tagsOf(r, "d")[0][1]);
      expect(tagsOf(r, "description")[0][1]).not.toBe("");
    }

    const alice = generateSecretKey();
    await rpc(host, owner, "setmember", pk(alice), {});
    let roster = (await c.req({ kinds: [13534], authors: [self] }))[0];
    expect(roster.tags).toContainEqual(["member", pk(owner), "owner"]);
    expect(roster.tags).toContainEqual(["member", pk(alice)]);

    // A role change must show in the roster and the admins list alike.
    await rpc(host, owner, "setmember", pk(alice), { role: "moderator" });
    roster = (await c.req({ kinds: [13534], authors: [self] }))[0];
    expect(roster.tags).toContainEqual(["member", pk(alice), "moderator"]);
    const admins = (await c.req({ kinds: [39001], authors: [self] }))[0];
    expect(admins.tags).toContainEqual(["p", pk(alice), "moderator"]);
  });
});

describe("roster and group agreement", () => {
  it("keeps 13534, 39001 and 39002 in step with the member table through every path", async () => {
    const host = "instep.bind.ws";
    const owner = generateSecretKey();
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const carol = generateSecretKey();
    const dave = generateSecretKey();
    const erin = generateSecretKey();
    const h = ["h", "instep"];
    await rpc(host, owner, "claim");
    const self = (await info(host)).self as string;
    const c = await WS.connect(host);

    // expected: pubkey -> role, maintained by the test as it walks the paths
    const want = new Map<string, string>([[pk(owner), "owner"]]);
    let step = 0;
    async function check() {
      step++;
      const [roster] = await c.req({ kinds: [13534], authors: [self] });
      const [admins] = await c.req({ kinds: [39001], authors: [self] });
      const [members] = await c.req({ kinds: [39002], authors: [self] });
      const fromRoster = new Map(tagsOf(roster, "member").map((t) => [t[1], t[2] ?? "member"]));
      expect(fromRoster, `roster at step ${step}`).toEqual(want);
      expect(new Set(tagsOf(members, "p").map((t) => t[1])), `members at step ${step}`).toEqual(new Set(want.keys()));
      const wantAdmins = new Map([...want].filter(([, r]) => r !== "member"));
      expect(new Map(tagsOf(admins, "p").map((t) => [t[1], t[2]])), `admins at step ${step}`).toEqual(wantAdmins);
      const listed = (await rpc(host, sk(want), "listallowedpubkeys")).result.map((m: any) => m.pubkey).sort();
      expect(listed, `listmembers at step ${step}`).toEqual([...want.keys()].filter((p) => want.get(p) !== "owner").sort());
    }
    const keys = { [pk(owner)]: owner, [pk(alice)]: alice, [pk(bob)]: bob, [pk(carol)]: carol, [pk(dave)]: dave, [pk(erin)]: erin };
    const sk = (m: Map<string, string>) => keys[[...m].find(([, r]) => r === "owner")![0]];
    await check();

    await rpc(host, owner, "setmember", pk(alice), {});
    want.set(pk(alice), "member");
    await check();

    expect((await c.ok(ev(bob, 9021, "", [h]))).ok).toBe(true);
    want.set(pk(bob), "member");
    await check();

    await rpc(host, owner, "setmember", pk(alice), { role: "moderator" });
    want.set(pk(alice), "moderator");
    await check();

    expect((await c.ok(ev(bob, 9022, "", [h]))).ok).toBe(true);
    want.delete(pk(bob));
    await check();

    await rpc(host, owner, "setmember", pk(carol), {});
    await rpc(host, owner, "banpubkey", pk(carol), "spam");
    await check();

    await rpc(host, owner, "setmember", pk(dave), {});
    await rpc(host, owner, "removemember", pk(dave));
    await check();

    expect((await c.ok(ev(owner, 9000, "", [h, ["p", pk(dave), "moderator"]]))).ok).toBe(true);
    want.set(pk(dave), "moderator");
    await check();
    expect((await c.ok(ev(owner, 9001, "", [h, ["p", pk(dave)]]))).ok).toBe(true);
    want.delete(pk(dave));
    await check();

    expect((await rpc(host, owner, "transferowner", pk(alice))).status).toBe(200);
    want.set(pk(alice), "owner");
    want.set(pk(owner), "moderator");
    await check();

    const cfg = (await rpc(host, alice, "exportconfig")).result;
    cfg.members = [{ pubkey: pk(erin), name: null, note: "" }];
    expect((await rpc(host, alice, "importconfig", cfg)).status).toBe(200);
    want.delete(pk(owner));
    want.set(pk(erin), "member");
    await check();
    // The import announced who came and who went.
    expect((await c.req({ kinds: [8000], authors: [self], "#p": [pk(erin)] })).length).toBe(1);
    expect((await c.req({ kinds: [8001], authors: [self], "#p": [pk(owner)] })).length).toBe(1);
    expect((await c.req({ kinds: [9001], authors: [self], "#p": [pk(owner)] })).length).toBe(1);
  });
});

describe("NIP-43 join and leave requests", () => {
  it("admits with a claim, refuses bad codes, and revokes on request", async () => {
    const host = "fortythree.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist" });
    const code = (await rpc(host, owner, "createinvite", 3600, 0, "friends")).result.code as string;
    const sam = generateSecretKey();
    const c = await WS.connect(host);

    // NIP-70: a "-" tagged request needs the socket authenticated.
    expect((await c.ok(ev(sam, 28934, "", [["-"], ["claim", code]]))).msg).toMatch(/^auth-required/);
    await c.auth(sam, host);
    let r = await c.ok(ev(sam, 28934, "", [["-"], ["claim", "nope"]]));
    expect(r.ok).toBe(false);
    expect(r.msg).toBe("restricted: that is an invalid invite code.");
    r = await c.ok(ev(sam, 28934, "", [["-"]]));
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/^restricted: a join request needs a claim/);
    r = await c.ok(ev(sam, 28934, "", [["-"], ["claim", code]]));
    expect(r.ok).toBe(true);
    expect(r.msg).toBe("info: welcome to fortythree!");
    expect((await rpc(host, owner, "listallowedpubkeys")).result.map((m: any) => m.pubkey)).toContain(pk(sam));
    r = await c.ok(ev(sam, 28934, "", [["-"], ["claim", code]]));
    expect(r.ok).toBe(true);
    expect(r.msg).toMatch(/^duplicate: you are already a member/);
    // Requests are ephemeral: nothing was stored.
    expect((await c.req({ kinds: [28934] })).length).toBe(0);

    r = await c.ok(ev(sam, 28936, "", [["-"]]));
    expect(r.ok).toBe(true);
    expect(r.msg).toBe("info: access revoked.");
    expect((await rpc(host, owner, "listallowedpubkeys")).result.map((m: any) => m.pubkey)).not.toContain(pk(sam));
    r = await c.ok(ev(sam, 28936, "", [["-"]]));
    expect(r.ok).toBe(true);
    expect(r.msg).toMatch(/^duplicate: you are not a member/);
    // The owner cannot leave.
    const o = await WS.connect(host);
    await o.auth(owner, host);
    expect((await o.ok(ev(owner, 28936, "", [["-"]]))).msg).toMatch(/^restricted: the owner cannot leave/);
  });
});
