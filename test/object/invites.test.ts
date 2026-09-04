// NIP-86 membership invite claims: management, member invite-tree policy,
// and the existing HTTP/NIP-43 admission paths.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { checkInvite, listClaims } from "../../src/invites.ts";
import { now, ev, rpc, post, pk } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("NIP-86 membership claim management", () => {
  it("creates, lists, deletes, and audits membership claims while keeping ownership separate", async () => {
    const host = "claims.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const stranger = generateSecretKey();
    expect((await rpc(host, stranger, "createclaim", "not-ownership")).status).toBe(403);
    await rpc(host, owner, "claim");

    for (const code of ["abc", "bad space", "\u00fcmlaut", "x".repeat(65), "ok_code"]) {
      const r = await rpc(host, owner, "createclaim", code);
      expect(r.status, code).toBe(code === "ok_code" ? 200 : 400);
    }
    expect((await rpc(host, owner, "createclaim", "ok_code")).status).toBe(400);
    expect((await rpc(host, owner, "createclaim", "another_code")).result).toBe(true);
    expect((await rpc(host, owner, "listclaims", "unexpected")).status).toBe(400);
    expect((await rpc(host, owner, "createclaim")).status).toBe(400);
    expect((await rpc(host, owner, "createclaim", null)).status).toBe(400);
    expect((await rpc(host, owner, "createclaim", { code: "object_code" })).status).toBe(400);
    for (const params of [[], [null], [1234], ["abc"], ["ok_code", "extra"]]) {
      expect((await rpc(host, owner, "deleteclaim", ...params)).status).toBe(400);
    }
    expect(((await rpc(host, owner, "listclaims")).result as string[]).sort()).toEqual(["another_code", "ok_code"]);
    const invite = (await rpc(host, owner, "listinvites")).result.find((i: any) => i.code === "ok_code");
    expect(invite.expires_at - invite.created_at).toBe(3 * 86400);
    expect(invite).toMatchObject({ max_uses: 0, uses: 0, created_by: pk(owner), note: "" });
    expect((await rpc(host, owner, "supportedmethods")).result).toEqual(expect.arrayContaining(["claim", "listclaims", "createclaim", "deleteclaim"]));

    // The claim is usable through the public HTTP admission door and is not
    // the relay ownership claim method.
    expect((await post(host, stranger, "/api/invites/claim", { code: "ok_code" })).body.status).toBe("joined");
    expect((await rpc(host, owner, "listclaims")).result).toContain("ok_code");
    // The ownership claim remains its own, idempotent management method.
    expect((await rpc(host, owner, "claim")).result).toMatchObject({ claimed: true, owner: pk(owner) });
    expect((await rpc(host, stranger, "claim")).status).toBe(403);

    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    expect((await rpc(host, mod, "listclaims")).result).toEqual(expect.arrayContaining(["another_code", "ok_code"]));
    expect((await rpc(host, mod, "deleteclaim", "missing_code")).result).toBe(true);
    expect((await rpc(host, mod, "deleteclaim", "ok_code")).result).toBe(true);
    expect((await rpc(host, owner, "listclaims")).result).not.toContain("ok_code");
    expect((await rpc(host, mod, "createclaim", "moderator-code")).result).toBe(true);
    expect((await rpc(host, owner, "revokeinvite", "moderator-code")).result).toBe(true);

    const deleted = generateSecretKey();
    const ws = await WS.connect(host);
    expect((await rpc(host, owner, "createclaim", "deleted_code")).result).toBe(true);
    expect((await rpc(host, owner, "deleteclaim", "deleted_code")).result).toBe(true);
    expect((await post(host, deleted, "/api/invites/claim", { code: "deleted_code" })).body.error).toBe("invite_invalid");
    await ws.auth(deleted, host);
    expect((await ws.ok(ev(deleted, 28934, "", [["-"], ["claim", "deleted_code"]]))).msg).toMatch(/invalid invite code/);

    const audit = (await rpc(host, owner, "listaudit")).result as any[];
    expect(audit.some((x) => x.action === "createclaim" && x.target === "another_code")).toBe(true);
    expect(audit.some((x) => x.action === "deleteclaim" && x.target === "ok_code")).toBe(true);
    const beforeRead = audit.length;
    expect((await rpc(host, owner, "listclaims")).status).toBe(200);
    expect(((await rpc(host, owner, "listaudit")).result as any[]).length).toBe(beforeRead);
  });

  it("filters expired and exhausted claims before applying the 200-row limit", async () => {
    const host = "claimfilter.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const t = now();
    await runInDurableObject(env.RELAY.getByName("claimfilter"), (r: Relay) => {
      // Recent expired rows remain in the invite table for normal invite
      // cleanup, so this also exercises listclaims' live predicate directly.
      for (let i = 0; i < 205; i++) {
        r.sql.exec(
          `INSERT INTO invites(code,created_by,created_at,expires_at,max_uses,uses,note) VALUES(?,?,?,?,?,?,?)`,
          `expired_${i}`, pk(owner), t - i, t - 1, 0, 0, "",
        );
      }
      for (let i = 0; i < 205; i++) {
        r.sql.exec(
          `INSERT INTO invites(code,created_by,created_at,expires_at,max_uses,uses,note) VALUES(?,?,?,?,?,?,?)`,
          `used_${i}`, pk(owner), t - i, t + 86400, 1, 1, "",
        );
      }
      r.sql.exec(
        `INSERT INTO invites(code,created_by,created_at,expires_at,max_uses,uses,note) VALUES(?,?,?,?,?,?,?)`,
        "boundary_code", pk(owner), t, t, 0, 0, "",
      );
      r.sql.exec(`INSERT INTO invites(code,created_by,created_at,expires_at,max_uses,uses,note) VALUES(?,?,?,?,?,?,?)`, "live_code", pk(owner), t - 1000, t + 86400, 0, 0, "");
      // An explicit clock makes the expiry-second boundary deterministic.
      expect(listClaims(r.sql, t)).toEqual(["boundary_code", "live_code"]);
      expect(checkInvite(r.sql, "boundary_code", t)).toBe("ok");
      expect(listClaims(r.sql, t + 1)).toEqual(["live_code"]);
      expect(checkInvite(r.sql, "boundary_code", t + 1)).toBe("invite_expired");
      r.sql.exec(`DELETE FROM invites WHERE code=?`, "boundary_code");
    });
    const claims = (await rpc(host, owner, "listclaims")).result as string[];
    expect(claims).toEqual(["live_code"]);
    const guest = generateSecretKey();
    expect((await post(host, guest, "/api/invites/claim", { code: "expired_0" })).body.error).toBe("invite_expired");
    expect((await post(host, guest, "/api/invites/claim", { code: "used_0" })).body.error).toBe("invite_exhausted");
    expect((await rpc(host, owner, "createclaim", "expired_0")).error).toMatch(/^duplicate:/);
  });

  it("isolates member claims and enforces shared quota and depth", async () => {
    const host = "memberclaims.bind.ws";
    const owner = generateSecretKey();
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist", memberInvites: { depth: 2, quota: 2 } });
    await rpc(host, owner, "setmember", pk(alice), {});
    await rpc(host, owner, "setmember", pk(bob), {});

    expect((await rpc(host, alice, "listclaims", "unexpected")).status).toBe(400);
    expect((await rpc(host, alice, "createclaim", "four_code", "extra")).status).toBe(400);
    const aliceInvite = (await rpc(host, alice, "createinvite")).result;
    expect(aliceInvite.max_uses).toBe(0);
    expect(aliceInvite.expires_at - aliceInvite.created_at).toBe(3 * 86400);
    expect((await rpc(host, alice, "createclaim", "alice_one")).result).toBe(true);
    expect((await rpc(host, alice, "createinvite")).status).toBe(403);
    expect((await rpc(host, alice, "createclaim", "alice_three")).status).toBe(403);
    const aliceClaims = (await rpc(host, alice, "listclaims")).result as string[];
    expect(aliceClaims.sort()).toEqual([aliceInvite.code, "alice_one"].sort());
    expect((await rpc(host, bob, "listclaims")).result).toEqual([]);
    expect((await rpc(host, bob, "deleteclaim", "alice_one")).status).toBe(403);
    expect((await rpc(host, stranger, "listclaims")).status).toBe(403);

    // A child may claim over NIP-43; the invitation creator remains Alice.
    const ws = await WS.connect(host);
    expect((await ws.ok(ev(stranger, 28934, "", [["-"], ["claim", "alice_one"]]))).msg).toMatch(/^auth-required/);
    await ws.auth(stranger, host);
    expect((await ws.ok(ev(stranger, 28934, "", [["-"], ["claim", "alice_one"]]))).ok).toBe(true);
    const member = (await rpc(host, owner, "listmembers")).result.members.find((m: any) => m.pubkey === pk(stranger));
    expect(member.invited_by).toBe(pk(alice));
    expect((await rpc(host, stranger, "createclaim", "stranger_code")).status).toBe(403);
    expect((await rpc(host, alice, "deleteclaim", "alice_one")).result).toBe(true);
    expect((await rpc(host, alice, "deleteclaim", "unknown_code")).status).toBe(403);
    // Deletion through either API frees exactly one slot in the same quota.
    expect((await rpc(host, alice, "createclaim", "alice_two")).result).toBe(true);
    expect((await rpc(host, alice, "createclaim", "alice_three")).status).toBe(403);
    expect((await rpc(host, alice, "revokeinvite", aliceInvite.code)).result).toBe(true);
    expect((await rpc(host, alice, "createclaim", "alice_three")).result).toBe(true);
    await rpc(host, owner, "setpolicy", { memberInvites: { depth: 0, quota: 0 } });
    for (const method of ["createclaim", "listclaims", "deleteclaim"]) expect((await rpc(host, alice, method, ...(method === "listclaims" ? [] : ["alice_three"]))).status).toBe(403);
  });

  it("scopes live claims before the cap and limits the administrative listing", async () => {
    const host = "claimscope.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member));
    await rpc(host, owner, "setpolicy", { memberInvites: { depth: 2, quota: 2 } });
    await rpc(host, member, "createclaim", "member-code");
    await runInDurableObject(env.RELAY.getByName("claimscope"), (r: Relay) => {
      const t = now();
      r.sql.exec(`UPDATE invites SET created_at=? WHERE code=?`, t - 1000, "member-code");
      for (let i = 0; i < 205; i++) r.sql.exec(`INSERT INTO invites(code,created_by,created_at,expires_at,max_uses,uses,note) VALUES(?,?,?,?,?,?,?)`, `owner_${i}`, pk(owner), t, t + 86400, 0, 0, "");
    });
    expect((await rpc(host, member, "listclaims")).result).toEqual(["member-code"]);
    const all = (await rpc(host, owner, "listclaims")).result as string[];
    expect(all).toHaveLength(200);
    expect(all.every((code) => code.startsWith("owner_"))).toBe(true);
  });

  it("shares limited invites with NIP-43 and NIP-29 joins, exhaustion, and bans", async () => {
    const host = "claimjoins.bind.ws";
    const owner = generateSecretKey();
    const first = generateSecretKey();
    const second = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist" });
    const limited = (await rpc(host, owner, "createinvite", 3600, 1, "single-use")).result;
    expect((await rpc(host, owner, "listclaims")).result).toEqual([limited.code]);
    const ws = await WS.connect(host);
    await ws.auth(first, host);
    expect((await ws.ok(ev(first, 28934, "", [["-"], ["claim", limited.code]]))).ok).toBe(true);
    expect((await rpc(host, owner, "listclaims")).result).toEqual([]);
    expect((await rpc(host, owner, "listinvites")).result[0]).toMatchObject({ code: limited.code, uses: 1 });
    expect((await post(host, second, "/api/invites/claim", { code: limited.code })).body.error).toBe("invite_exhausted");
    await ws.auth(second, host);
    expect((await ws.ok(ev(second, 28934, "", [["-"], ["claim", limited.code]]))).msg).toMatch(/used up/);
    expect((await rpc(host, owner, "deleteclaim", limited.code)).result).toBe(true);
    expect((await rpc(host, owner, "revokeinvite", limited.code)).result).toBe(false);
    await rpc(host, owner, "createclaim", "group-code");
    expect((await ws.ok(ev(second, 9021, "", [["h", "claimjoins"], ["code", "group-code"]]))).ok).toBe(true);
    const banned = generateSecretKey();
    await rpc(host, owner, "banpubkey", pk(banned));
    expect((await post(host, banned, "/api/invites/claim", { code: "group-code" })).status).toBe(403);
    expect((await rpc(host, banned, "createclaim", "banned-code")).status).toBe(403);
    expect((await rpc(host, owner, "getpolicy")).result.owner).toBe(pk(owner));
  });
});
