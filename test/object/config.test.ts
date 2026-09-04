// The owner's configuration as a whole: export and import, with the rules
// and address blocks travelling along, retention and purge, and teardown.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Relay } from "../../src/relay.ts";
import { bytesToHex } from "../../src/negentropy.ts";
import { now, ev, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("configuration export and import", () => {
  it("round-trips policy, members, bans and kinds between relays without touching data or owner", async () => {
    const a = "cfg-a.bind.ws", b = "cfg-b.bind.ws";
    const ownerA = generateSecretKey(), ownerB = generateSecretKey();
    const m1 = getPublicKey(generateSecretKey()), bad = getPublicKey(generateSecretKey());
    await rpc(a, ownerA, "claim");
    await rpc(a, ownerA, "setpolicy", { writes: "allowlist", reads: "members", name: "Club", joinTerms: "be kind", minPow: 3, directoryPublic: false });
    await rpc(a, ownerA, "setmember", m1, { name: "alice", note: "friend" });
    await rpc(a, ownerA, "banpubkey", bad, "spam");
    await rpc(a, ownerA, "allowkind", 1);
    await rpc(a, ownerA, "disallowkind", 7);
    const cfg = (await rpc(a, ownerA, "exportconfig")).result;
    expect(cfg.format).toBe("bind.ws/relay-config/2");
    expect(cfg.policy.owner).toBeUndefined();
    expect(cfg.members).toEqual([{ pubkey: m1, name: "alice", note: "friend", role: "member" }]);
    expect(cfg.bans).toEqual([{ pubkey: bad, reason: "spam" }]);
    expect(cfg.kinds).toEqual({ allow: [1], block: [7] });

    await rpc(b, ownerB, "claim");
    const c = await WS.connect(b);
    await c.ok(ev(ownerB, 1, "keep me"));
    expect((await rpc(b, ownerB, "importconfig", { format: "nope" })).status).toBe(400);
    const after = (await rpc(b, ownerB, "importconfig", cfg)).result;
    expect(after.members).toEqual(cfg.members);
    expect(after.bans).toEqual(cfg.bans);
    expect(after.kinds).toEqual(cfg.kinds);
    const p = (await rpc(b, ownerB, "getpolicy")).result;
    expect([p.writes, p.reads, p.name, p.joinTerms, p.minPow, p.directoryPublic, p.owner]).toEqual(["allowlist", "members", "Club", "be kind", 3, false, getPublicKey(ownerB)]);
    expect((await rpc(b, ownerB, "stats")).result.events).toBeGreaterThan(0);
    const doc: any = await (await SELF.fetch(`http://${b}/.well-known/nostr.json?name=alice`)).json();
    expect(doc.names).toEqual({ alice: m1 });
    // The roster on b now carries the imported member.
    const rc = await WS.connect(b);
    await rc.auth(ownerB, b);
    const r = await rc.req({ kinds: [13534] });
    expect(r[0].tags).toContainEqual(["member", m1]);
  });

  it("dry-runs a document into a summary of changes and applies nothing; a section left out is left alone", async () => {
    const host = "cfg-dry.bind.ws";
    const owner = generateSecretKey();
    const m1 = getPublicKey(generateSecretKey()), m2 = getPublicKey(generateSecretKey());
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", m1, { name: "alice" });
    await rpc(host, owner, "allowkind", 1);
    const doc = {
      format: "bind.ws/relay-config/2",
      policy: { writes: "owner", minPow: 2, reads: "sideways", nonsense: 1, owner: "ab".repeat(32) },
      members: [{ pubkey: m1, name: "alice", note: "", role: "moderator" }, { pubkey: m2, name: "bob", note: "", role: "member" }, { pubkey: "nope" }],
      kinds: { allow: [1, 7], block: [99999] },
      retention: [{ kind: null, days: 30 }],
    };
    const dry = (await rpc(host, owner, "importconfig", doc, { dryRun: true })).result;
    expect(dry.dryRun).toBe(true);
    expect(dry.changes.policy.map((c: any) => c.field).sort()).toEqual(["minPow", "writes"]);
    expect(dry.changes.members.add.map((m: any) => m.pubkey)).toEqual([m2]);
    expect(dry.changes.members.change.map((m: any) => m.pubkey)).toEqual([m1]);
    expect(dry.changes.kinds.allow.add).toEqual([7]);
    expect(dry.changes.retention.add).toEqual([{ kind: null, days: 30 }]);
    expect(dry.changes.summary.length).toBeGreaterThanOrEqual(4);
    expect(dry.warnings).toEqual(["policy.reads: value not accepted", "policy.nonsense: not a setting", "policy.owner: not carried by a configuration", "members[2]: pubkey must be 64 hex chars", "kinds.block[0]: kind out of range"]);
    // Nothing moved.
    expect((await rpc(host, owner, "getpolicy")).result.writes).toBe("open");
    expect((await rpc(host, owner, "listmembers")).result.members.map((m: any) => m.pubkey)).toEqual([getPublicKey(owner), m1]);
    expect((await rpc(host, owner, "listaudit")).result.some((r: any) => r.action === "importconfig")).toBe(false);
    // Applied, and then a rules-only document leaves the people alone.
    expect((await rpc(host, owner, "importconfig", doc)).status).toBe(200);
    expect((await rpc(host, owner, "listmembers")).result.members.length).toBe(3);
    expect((await rpc(host, owner, "importconfig", { format: "bind.ws/relay-config/2", policy: { writes: "open" }, kinds: { allow: [], block: [] } })).status).toBe(200);
    expect((await rpc(host, owner, "getpolicy")).result.writes).toBe("open");
    expect((await rpc(host, owner, "listmembers")).result.members.length).toBe(3);
    expect((await rpc(host, owner, "listallowedkinds")).result).toEqual([]);
    expect((await rpc(host, owner, "listretention")).result).toEqual([{ kind: null, days: 30 }]);
    const again = (await rpc(host, owner, "importconfig", doc, { dryRun: true })).result;
    expect(again.changes.summary.filter((l: string) => !l.startsWith("writes")).length).toBe(1);
  });
});

describe("rules in export and import", () => {
  it("carries the new rules through export and import", async () => {
    const a = "gate-a.bind.ws", b = "gate-b.bind.ws";
    const owner = generateSecretKey();
    await rpc(a, owner, "claim");
    await rpc(b, owner, "claim");
    await rpc(a, owner, "setpolicy", { writes: "wot", openKinds: [7, 9735], guestReplies: true, reportThreshold: 3 });
    await rpc(a, owner, "setblockedwords", ["casino"]);
    const cfg = (await rpc(a, owner, "exportconfig")).result;
    expect(cfg.policy).toMatchObject({ writes: "wot", openKinds: [7, 9735], guestReplies: true, reportThreshold: 3, blockedWords: ["casino"] });
    expect((await rpc(b, owner, "importconfig", cfg)).status).toBe(200);
    const p = (await rpc(b, owner, "getpolicy")).result;
    expect(p).toMatchObject({ writes: "wot", openKinds: [7, 9735], guestReplies: true, reportThreshold: 3, blockedWords: ["casino"] });
    // resetrules puts the guest rules back but keeps the moderation ones.
    await rpc(b, owner, "resetrules");
    const q = (await rpc(b, owner, "getpolicy")).result;
    expect(q).toMatchObject({ writes: "open", openKinds: [], guestReplies: false, reportThreshold: 3, blockedWords: ["casino"] });
  });
});

describe("address blocks in the configuration", () => {
  it("export carries them and import applies them, dropping the sockets they refuse", async () => {
    const a = "addr-a.bind.ws";
    const b = "addr-b.bind.ws";
    const owner = generateSecretKey();
    const bad = "203.0.113.9";
    await rpc(a, owner, "claim");
    await rpc(b, owner, "claim");
    await rpc(a, owner, "blockip", bad, "scraper");
    await rpc(a, owner, "blockip", "2001:DB8::9", "");
    const cfg = (await rpc(a, owner, "exportconfig")).result;
    const byIP = (l: { ip: string; reason: string }[]) => [...l].sort((x, y) => x.ip.localeCompare(y.ip));
    expect(byIP(cfg.addresses)).toEqual([{ ip: "2001:db8::9", reason: "" }, { ip: bad, reason: "scraper" }]);

    // The second relay has a stale block of its own and an open socket from the address about to be refused.
    await rpc(b, owner, "blockip", "198.51.100.200", "old");
    const open = (await WS.tryConnect(b, bad))!;
    expect((await open.ok(ev(owner, 1, "before"))).ok).toBe(true);
    cfg.addresses.push({ ip: "not an address", reason: "x" }, { reason: "no ip" });
    const imported = await rpc(b, owner, "importconfig", cfg);
    expect(imported.status).toBe(200);
    expect(byIP(imported.result.addresses)).toEqual([{ ip: "2001:db8::9", reason: "" }, { ip: bad, reason: "scraper" }]);
    expect((await rpc(b, owner, "listblockedips")).result.map((x: { ip: string }) => x.ip).sort()).toEqual(["2001:db8::9", bad]);
    for (let i = 0; i < 40 && !open.closed; i++) await new Promise((r) => setTimeout(r, 25));
    expect(open.closed?.code).toBe(4403);
    expect(await WS.tryConnect(b, bad)).toBeNull();
    expect(await WS.tryConnect(b, "198.51.100.200")).not.toBeNull();
    // A document without the list leaves the blocks alone; an empty list clears them.
    delete cfg.addresses;
    await rpc(b, owner, "importconfig", cfg);
    expect((await rpc(b, owner, "listblockedips")).result.length).toBe(2);
    cfg.addresses = [];
    await rpc(b, owner, "importconfig", cfg);
    expect((await rpc(b, owner, "listblockedips")).result).toEqual([]);
    expect(await WS.tryConnect(b, bad)).not.toBeNull();
  });
});

describe("storage: retention and purge", () => {
  it("refuses events past a keep-for rule, sheds old ones daily, spares replaceable kinds from the catch-all, and purges on demand", async () => {
    const host = "keep.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const day = 86400;
    // Before any rule: an old reaction, an old note, an old profile all land.
    expect((await c.ok(ev(owner, 7, "+", [], now() - 40 * day))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "old note", [], now() - 40 * day))).ok).toBe(true);
    expect((await c.ok(ev(owner, 0, '{"name":"old me"}', [], now() - 400 * day))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "fresh note"))).ok).toBe(true);

    // Reactions kept 30 days, everything else 100 days.
    expect((await rpc(host, owner, "setretention", 7, 30)).result).toEqual([{ kind: 7, days: 30 }]);
    await rpc(host, owner, "setretention", null, 100);
    expect((await c.ok(ev(owner, 7, "+", [], now() - 31 * day))).msg).toMatch(/^blocked: this relay keeps kind 7 for 30 days/);
    expect((await c.ok(ev(owner, 7, "+", [], now() - 29 * day))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "too old", [], now() - 101 * day))).msg).toMatch(/keeps kind 1 for 100 days/);
    // The catch-all spares replaceable kinds: a very old profile still lands.
    expect((await c.ok(ev(owner, 0, '{"name":"newer old me"}', [], now() - 300 * day))).ok).toBe(true);
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.retention).toEqual([{ kinds: [7], time: 30 * day }, { time: 100 * day }]);

    // The daily sweep sheds the 40-day-old reaction and keeps the 40-day-old note (under 100).
    const stub = env.RELAY.getByName("keep");
    await runInDurableObject(stub, async (r: Relay) => expect(r.sweepRetention(now())).toBe(1));
    let st = (await rpc(host, owner, "storagestats")).result;
    const byKind = Object.fromEntries(st.kinds.map((k: any) => [k.kind, k.n]));
    expect(byKind).toEqual({ 1: 2, 7: 1, 0: 2, 13534: 1, 30166: 1, 33534: 2, 39000: 1, 39001: 1, 39002: 1, 39003: 1 }); // the roster, profile, discovery record, role definitions and group state are the relay's own
    expect(st.events).toBe(13);
    expect(st.eventBytes).toBeGreaterThan(0);
    expect(st.retention).toEqual([{ kind: 7, days: 30 }, { kind: null, days: 100 }]);

    // Purge notes older than 10 days, then everything of kind 7.
    expect((await rpc(host, owner, "purgekind", 1, 10)).result).toEqual({ deleted: 1 });
    expect((await rpc(host, owner, "purgekind", 7, 0)).result).toEqual({ deleted: 1 });
    st = (await rpc(host, owner, "storagestats")).result;
    expect(st.events).toBe(11);

    // Rules travel with the configuration; removing one is days 0.
    const cfg = (await rpc(host, owner, "exportconfig")).result;
    expect(cfg.retention).toEqual([{ kind: 7, days: 30 }, { kind: null, days: 100 }]);
    await rpc(host, owner, "setretention", null, 0);
    expect((await rpc(host, owner, "listretention")).result).toEqual([{ kind: 7, days: 30 }]);
    expect((await rpc(host, owner, "setretention", 70000, 5)).status).toBe(400);
    // Load-bearing kinds can be neither expired nor purged, and the catch-all skips them.
    expect((await rpc(host, owner, "setretention", 0, 5)).status).toBe(400);
    expect((await rpc(host, owner, "purgekind", 13534, 0)).status).toBe(400);
    await rpc(host, owner, "setretention", null, 1);
    expect((await rpc(host, owner, "purgekind", null, 0)).result.deleted).toBe(1); // the fresh note; profile, roster and group state stay
    expect((await rpc(host, owner, "storagestats")).result.kinds.map((k: any) => k.kind).sort((a: number, b: number) => a - b)).toEqual([0, 13534, 30166, 33534, 39000, 39001, 39002, 39003]);
  });
});

describe("teardown", () => {
  it("requires the typed name, then wipes everything and returns the name to unclaimed", async () => {
    const host = "gone.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", getPublicKey(member), { name: "bob" });
    const c = await WS.connect(host);
    await c.ok(ev(owner, 1, "to be deleted"));
    await c.open("live", { kinds: [1] });
    const body = new TextEncoder().encode("bytes");
    const sha = bytesToHex(sha256(body));
    const token = "Nostr " + btoa(JSON.stringify(ev(owner, 24242, "upload", [["t", "upload"], ["x", sha], ["expiration", String(now() + 300)]])));
    expect((await SELF.fetch(`http://${host}/upload`, { method: "PUT", headers: { authorization: token, "content-type": "text/plain" }, body })).status).toBe(200);

    expect((await rpc(host, member, "deleterelay", "gone")).status).toBe(403);
    const wrong = await rpc(host, owner, "deleterelay", "typo");
    expect(wrong.status).toBe(400);
    expect((await rpc(host, owner, "stats")).result.events).toBeGreaterThan(0);

    expect((await rpc(host, owner, "deleterelay", "gone")).result).toEqual({ deleted: true, name: "gone" });
    for (let i = 0; i < 20 && !c.closed; i++) await new Promise((r) => setTimeout(r, 50));
    expect(c.closed?.code).toBe(4410);
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.pubkey).toBeUndefined();
    expect(info.self).toBeUndefined();
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(404);
    expect((await env.MEDIA.list({ prefix: "gone/" })).objects).toEqual([]);
    const fresh = await WS.connect(host);
    expect(await fresh.req({ kinds: [1] })).toEqual([]);
    expect((await fresh.ok(ev(owner, 1, "again"))).msg).toMatch(/unclaimed/);
    const doc: any = await (await SELF.fetch(`http://${host}/.well-known/nostr.json?name=bob`)).json();
    expect(doc.names).toEqual({});
    // Anyone can claim the name again, including someone else.
    const other = generateSecretKey();
    expect((await rpc(host, other, "claim")).result.claimed).toBe(true);
  });
});
