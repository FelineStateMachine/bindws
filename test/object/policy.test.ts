// The rules an owner sets and the relay enforces at the socket: who may
// write and read, proof of work, kinds, guests past a members-only rule, the
// web of trust, blocked words, message size, address blocks, and rate limits
// per connection and per address.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { difficulty } from "../../src/event.ts";
import { now, ev, rpc, pk, info, post, sleep } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";
import { upload } from "../helpers/media.ts";

describe("writes, reads, pow, bans and kinds", () => {
  it("enforces writes, reads, pow, bans, and kind rules set by the owner", async () => {
    const host = "gamma.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);

    // owner-only writes
    expect((await rpc(host, owner, "setpolicy", { writes: "owner" })).result.writes).toBe("owner");
    expect((await c.ok(ev(stranger, 1, "x"))).msg).toMatch(/^restricted:/);
    expect((await c.ok(ev(owner, 1, "x"))).ok).toBe(true);

    // allowlist
    await rpc(host, owner, "setpolicy", { writes: "allowlist" });
    expect((await c.ok(ev(member, 1, "y"))).msg).toMatch(/^restricted:/);
    await rpc(host, owner, "allowpubkey", getPublicKey(member), "friend");
    expect((await c.ok(ev(member, 1, "y"))).ok).toBe(true);
    expect((await rpc(host, owner, "listallowedpubkeys")).result).toEqual([{ pubkey: getPublicKey(member), reason: "friend" }]);
    expect((await rpc(host, owner, "listmembers")).result.members.map((m: any) => m.role)).toEqual(["owner", "member"]);
    await rpc(host, owner, "setpolicy", { writes: "open" });

    // bans win over everything, and the owner cannot ban themselves
    await rpc(host, owner, "banpubkey", getPublicKey(stranger), "spam");
    expect((await c.ok(ev(stranger, 1, "z"))).msg).toMatch(/^blocked:/);
    expect((await rpc(host, owner, "banpubkey", getPublicKey(owner))).status).toBe(400);
    await rpc(host, owner, "unrulepubkey", getPublicKey(stranger));
    expect((await c.ok(ev(stranger, 1, "z"))).ok).toBe(true);

    // ban an event: deleted now and refused later
    const e = ev(stranger, 1, "offensive");
    expect((await c.ok(e)).ok).toBe(true);
    await rpc(host, owner, "banevent", e.id, "nope");
    // Left open on purpose: the read rule below has to close it.
    expect((await c.open("q", { ids: [e.id] })).events).toEqual([]);
    expect((await c.ok(e)).msg).toMatch(/^blocked:/);
    expect((await rpc(host, owner, "listbannedevents")).result).toEqual([{ id: e.id, reason: "nope" }]);

    // kind rules
    await rpc(host, owner, "disallowkind", 7);
    expect((await c.ok(ev(stranger, 7, "+"))).msg).toMatch(/kind 7/);
    await rpc(host, owner, "allowkind", 1);
    expect((await c.ok(ev(stranger, 30023, "a", [["d", "x"]]))).msg).toMatch(/kind 30023/);
    expect((await c.ok(ev(stranger, 1, "still fine"))).ok).toBe(true);
    expect((await rpc(host, owner, "listallowedkinds")).result).toEqual([1]);
    await rpc(host, owner, "unrulekind", 1);
    await rpc(host, owner, "unrulekind", 7);

    // proof of work
    await rpc(host, owner, "setpolicy", { minPow: 4 });
    // One random id in sixteen starts with a zero nibble and would pass; pick one that does not.
    let weak = ev(stranger, 1, "weak");
    while (difficulty(weak).difficulty >= 4) weak = ev(stranger, 1, "weak " + Math.random());
    expect((await c.ok(weak)).msg).toMatch(/^pow:/);
    await rpc(host, owner, "setpolicy", { minPow: 0 });

    // reads need auth: tightening the rule closes the subscription still open
    await rpc(host, owner, "setpolicy", { reads: "auth" });
    expect((await c.expect("CLOSED"))[2]).toMatch(/^auth-required:/);
    expect((await c.query({ kinds: [1] })).closed).toMatch(/^auth-required:/);
    await c.auth(stranger, host);
    expect((await c.req({ kinds: [1] })).length).toBeGreaterThan(0);

    // NIP-11 reflects it all
    await rpc(host, owner, "changerelayname", "Gamma Club");
    await rpc(host, owner, "changerelaydescription", "members only");
    const info = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();
    expect(info.name).toBe("Gamma Club");
    expect(info.limitation.auth_required).toBe(true);
    expect(info.limitation.restricted_writes).toBe(false);
  });

  it("only the owner may manage", async () => {
    const host = "delta.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const r = await rpc(host, generateSecretKey(), "setpolicy", { writes: "owner" });
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/^restricted:/);
    expect((await rpc(host, generateSecretKey(), "supportedmethods")).result).toContain("claim");
  });
});

describe("guests", () => {
  it("lets a stranger through a members-only rule for open kinds and for replies to members", async () => {
    const host = "guests.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member), {});
    let r = await rpc(host, owner, "setpolicy", { writes: "allowlist", openKinds: [7, 7, 70000, -1], guestReplies: true });
    expect(r.result.openKinds).toEqual([7]);
    expect(r.result.guestReplies).toBe(true);

    const c = await WS.connect(host);
    const note = ev(member, 1, "a member's note");
    expect((await c.ok(note))).toEqual({ ok: true, msg: "" });
    const outsiderNote = ev(stranger, 1, "hello?");
    expect((await c.ok(outsiderNote)).msg).toMatch(/only accepts events from its members/);
    // An open kind passes the rule; a reply to a member passes; a reply to nothing here does not.
    expect((await c.ok(ev(stranger, 7, "+", [["e", note.id]]))).ok).toBe(true);
    expect((await c.ok(ev(stranger, 1, "nice", [["e", note.id, "", "reply"]]))).ok).toBe(true);
    expect((await c.ok(ev(stranger, 1111, "a comment", [["E", note.id]]))).ok).toBe(true);
    expect((await c.ok(ev(stranger, 1, "into the void", [["e", "ab".repeat(32)]]))).ok).toBe(false);
    // A reply to another stranger's event is not a reply to a member.
    const guestReply = (await c.req({ kinds: [1], authors: [pk(stranger)] }))[0];
    expect((await c.ok(ev(generateSecretKey(), 1, "reply to a guest", [["e", guestReply.id]]))).ok).toBe(false);
    // Bans still win, and so do kind rules.
    await rpc(host, owner, "disallowkind", 7);
    expect((await c.ok(ev(stranger, 7, "-", [["e", note.id]]))).msg).toMatch(/does not accept kind 7/);
    await rpc(host, owner, "setpolicy", { guestReplies: false });
    expect((await c.ok(ev(stranger, 1, "again", [["e", note.id]]))).ok).toBe(false);
    // Only me plus open kinds: the owner's rule, guests' kinds.
    await rpc(host, owner, "unrulekind", 7);
    await rpc(host, owner, "setpolicy", { writes: "owner" });
    expect((await c.ok(ev(member, 1, "member note"))).msg).toMatch(/only the relay owner/);
    expect((await c.ok(ev(member, 7, "+", [["e", note.id]]))).ok).toBe(true);
  });
});

describe("web of trust", () => {
  it("admits the people members follow, and follows the lists as they change", async () => {
    const host = "wot.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const friend = generateSecretKey();
    const friendOfMember = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    expect((await c.ok(ev(owner, 3, "", [["p", pk(friend)]]))).ok).toBe(true);
    const r = await rpc(host, owner, "setpolicy", { writes: "wot" });
    expect(r.result.writes).toBe("wot");
    expect((await c.ok(ev(friend, 1, "a friend of the owner"))).ok).toBe(true);
    expect((await c.ok(ev(stranger, 1, "nobody follows me"))).msg).toMatch(/members and the people they follow/);
    expect((await upload(host, stranger, "a stranger's file")).status).toBe(403);
    expect((await upload(host, friend, "a friend's file")).status).toBe(200);

    // A member's list arriving extends the web; the member leaving shrinks it.
    await rpc(host, owner, "setmember", pk(member), {});
    expect((await c.ok(ev(member, 3, "", [["p", pk(friendOfMember)]]))).ok).toBe(true);
    expect((await c.ok(ev(friendOfMember, 1, "followed by a member"))).ok).toBe(true);
    await rpc(host, owner, "removemember", pk(member));
    expect((await c.ok(ev(friendOfMember, 1, "the member left"))).ok).toBe(false);
    // The owner's newer list without the friend drops them.
    expect((await c.ok(ev(owner, 3, "", [["p", pk(stranger)]], now() + 1))).ok).toBe(true);
    expect((await c.ok(ev(friend, 1, "unfollowed"))).ok).toBe(false);
    expect((await c.ok(ev(stranger, 1, "now followed"))).ok).toBe(true);
    // The group flags read the rule as restricted and closed.
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.limitation.restricted_writes).toBe(true);
    const meta = (await c.req({ kinds: [39000] }))[0];
    expect(meta.tags.some((t: string[]) => t[0] === "restricted")).toBe(true);
    expect(meta.tags.some((t: string[]) => t[0] === "closed")).toBe(true);
  });
});

describe("blocked words", () => {
  it("refuses content with a blocked word from anyone but the owner and moderators", async () => {
    const host = "words.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(member), {});
    let r = await rpc(host, owner, "setblockedwords", ["  Casino ", "free   money", "x", "a".repeat(65), "casino"]);
    expect(r.result).toEqual(["casino", "free money"]);
    expect((await rpc(host, owner, "getpolicy")).result.blockedWords).toEqual(["casino", "free money"]);
    // A moderator may set the list too.
    r = await rpc(host, mod, "setblockedwords", ["casino"]);
    expect(r.status).toBe(200);
    expect((await rpc(host, member, "setblockedwords", ["casino"])).status).toBe(403);

    const c = await WS.connect(host);
    expect((await c.ok(ev(member, 1, "Big CASINO night"))).msg).toBe("blocked: content contains a blocked word");
    expect((await c.ok(ev(generateSecretKey(), 1, "casino"))).ok).toBe(false);
    expect((await c.ok(ev(member, 1, "a quiet evening"))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "the casino is closed"))).ok).toBe(true);
    expect((await c.ok(ev(mod, 1, "no casino talk please"))).ok).toBe(true);
    // The list travels with the configuration.
    const cfg = (await rpc(host, owner, "exportconfig")).result;
    expect(cfg.policy.blockedWords).toEqual(["casino"]);
  });
});

describe("blocked words in tags and as patterns", () => {
  it("takes /patterns/, refuses a bad one with the reason, and reaches into tags on request", async () => {
    const host = "patterns.bind.ws";
    const owner = generateSecretKey();
    const guest = generateSecretKey();
    await rpc(host, owner, "claim");

    // A pattern that does not compile fails the call; nothing is saved.
    const bad = await rpc(host, owner, "setblockedwords", ["spam", "/(unclosed/"]);
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/^invalid: /);
    expect((await rpc(host, owner, "getpolicy")).result.blockedWords).toEqual([]);
    const long = await rpc(host, owner, "setblockedwords", ["/" + "a".repeat(200) + "/"]);
    expect(long.status).toBe(400);
    expect(long.error).toMatch(/longer than 200/);

    // Plain words are lowercased; a pattern keeps its case and is compiled case-insensitive.
    const kept = (await rpc(host, owner, "setblockedwords", ["Casino", "/free\\s+money/", "/\\bwin\\d{3,}/"])).result;
    expect(kept).toEqual(["casino", "/free\\s+money/", "/\\bwin\\d{3,}/"]);

    const ws = await WS.connect(host);
    expect((await ws.ok(ev(guest, 1, "FREE   MONEY here"))).msg).toBe("blocked: content contains a blocked word");
    expect((await ws.ok(ev(guest, 1, "you Win1234 now"))).msg).toBe("blocked: content contains a blocked word");
    expect((await ws.ok(ev(guest, 1, "winner takes all"))).ok).toBe(true);
    expect((await ws.ok(ev(guest, 1, "a night at the CASINO"))).ok).toBe(false);
    // The owner says what they like.
    expect((await ws.ok(ev(owner, 1, "free money"))).ok).toBe(true);

    // Tags are not searched until the switch is on.
    expect((await ws.ok(ev(guest, 1, "look", [["t", "casino"]]))).ok).toBe(true);
    expect((await rpc(host, owner, "setpolicy", { blockedWordsInTags: true })).result.blockedWordsInTags).toBe(true);
    const tagged = await ws.ok(ev(guest, 1, "look again", [["t", "Casino"]]));
    expect(tagged.ok).toBe(false);
    expect(tagged.msg).toBe("blocked: a tag contains a blocked word");
    expect((await ws.ok(ev(guest, 1, "pattern in a tag", [["r", "https://x.example/free money"]]))).ok).toBe(false);
    // The tag name itself is not a value.
    expect((await ws.ok(ev(guest, 1, "fine", [["casino", "x"]]))).ok).toBe(true);
    await rpc(host, owner, "setpolicy", { blockedWordsInTags: false });
    expect((await ws.ok(ev(guest, 1, "look once more", [["t", "casino"]]))).ok).toBe(true);
  });
});

describe("message size", () => {
  it("is the owner's rule, clamped, and NIP-11 says so", async () => {
    const host = "msgsize.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await info(host)).limitation.max_message_length).toBe(128 * 1024);

    // Below the floor and above the ceiling both clamp.
    expect((await rpc(host, owner, "setpolicy", { maxMessageKB: 1 })).result.maxMessageKB).toBe(16);
    expect((await rpc(host, owner, "setpolicy", { maxMessageKB: 5000 })).result.maxMessageKB).toBe(1024);
    expect((await rpc(host, owner, "setpolicy", { maxMessageKB: 16 })).result.maxMessageKB).toBe(16);
    expect((await info(host)).limitation.max_message_length).toBe(16 * 1024);

    const ws = await WS.connect(host);
    // A note of 20 KB is over the 16 KB cap: refused with a NOTICE, not stored.
    const big = ev(owner, 1, "x".repeat(20 * 1024));
    ws.raw(JSON.stringify(["EVENT", big]));
    const notice = await ws.expect("NOTICE");
    expect(notice[1]).toBe("error: message too large");
    // A small one still lands.
    expect((await ws.ok(ev(owner, 1, "small"))).ok).toBe(true);

    // Raising the cap lets the same note through.
    await rpc(host, owner, "setpolicy", { maxMessageKB: 64 });
    expect((await ws.ok(big)).ok).toBe(true);
  });
});

describe("rate limits", () => {
  it("throttles a chatty connection with a retry hint", async () => {
    const host = "limits.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { eventsPerMinute: 2, reqsPerMinute: 2 });
    const c = await WS.connect(host);
    expect((await c.ok(ev(owner, 1, "a"))).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "b"))).ok).toBe(true);
    const third = await c.ok(ev(owner, 1, "c"));
    expect(third.ok).toBe(false);
    expect(third.msg).toMatch(/^rate-limited: quota exceeded; retry in \d+s$/);
    await c.open("r1", { kinds: [1] });
    await c.open("r2", { kinds: [1] });
    expect((await c.open("r3", { kinds: [1] })).closed).toMatch(/^rate-limited:/);
  });
});

describe("per-address rate limit", () => {
  it("caps all sockets from one address at four times a connection's allowance", async () => {
    const host = "swarm.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { eventsPerMinute: 5 });
    const ip = "198.51.100.7";
    const socks: WS[] = [];
    for (let i = 0; i < 6; i++) socks.push((await WS.tryConnect(host, ip))!);
    // Four per socket stays under the per-connection five; the address
    // allowance is twenty, so the twenty-first event across them is refused.
    let accepted = 0;
    let refused = "";
    for (const c of socks) {
      for (let j = 0; j < 4 && !refused; j++) {
        const r = await c.ok(ev(owner, 1, `n${accepted}`));
        if (r.ok) accepted++;
        else refused = r.msg;
      }
    }
    expect(accepted).toBe(20);
    expect(refused).toMatch(/^rate-limited:/);
    // A lone socket from elsewhere is only bound by its own bucket.
    const alone = (await WS.tryConnect(host, "198.51.100.8"))!;
    for (let j = 0; j < 4; j++) expect((await alone.ok(ev(owner, 1, `alone${j}`))).ok).toBe(true);
  });

  it("is the bridge's rate limit too", async () => {
    const host = "bridgelimit.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { reqsPerMinute: 1 });
    const ip = "198.51.100.9";
    for (let i = 0; i < 4; i++) expect((await post(host, owner, "/count", [{ kinds: [1] }], { "cf-connecting-ip": ip })).status).toBe(200);
    const fifth = await post(host, owner, "/count", [{ kinds: [1] }], { "cf-connecting-ip": ip });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error).toMatch(/^rate-limited:/);
    expect((await post(host, owner, "/count", [{ kinds: [1] }], { "cf-connecting-ip": "198.51.100.10" })).status).toBe(200);
  });
});

describe("address blocks", () => {
  it("refuses the socket and the doors, drops open sockets, and can be undone", async () => {
    const host = "blocks.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    const bad = "203.0.113.5";
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(member), {});

    const open = (await WS.tryConnect(host, bad))!;
    expect((await open.ok(ev(member, 1, "before"))).ok).toBe(true);
    expect((await rpc(host, member, "blockip", bad, "scraper")).status).toBe(403);
    expect((await rpc(host, mod, "blockip", "not an address", "x")).status).toBe(400);
    expect((await rpc(host, mod, "blockip", bad, "scraper")).result).toBe(true);
    expect((await rpc(host, owner, "listblockedips")).result).toEqual([{ ip: bad, reason: "scraper" }]);

    for (let i = 0; i < 40 && !open.closed; i++) await sleep(25);
    expect(open.closed?.code).toBe(4403);
    expect(await WS.tryConnect(host, bad)).toBeNull();
    const refused = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket", "cf-connecting-ip": bad } });
    expect(refused.status).toBe(403);
    const door = await post(host, member, "/events", ev(member, 1, "still here?"), { "cf-connecting-ip": bad });
    expect(door.status).toBe(403);
    expect(door.body.error).toMatch(/^blocked: this address/);
    expect((await post(host, member, "/count", [{ kinds: [1] }], { "cf-connecting-ip": bad })).status).toBe(403);
    // Another address is unaffected, and so is management from the blocked one.
    expect((await post(host, member, "/events", ev(member, 1, "elsewhere"), { "cf-connecting-ip": "203.0.113.6" })).status).toBe(200);
    expect(await WS.tryConnect(host, "203.0.113.6")).not.toBeNull();
    expect((await rpc(host, owner, "stats")).status).toBe(200);
    // Blocks are part of the portable configuration.
    expect((await rpc(host, owner, "exportconfig")).result.addresses).toEqual([{ ip: bad, reason: "scraper" }]);

    expect((await rpc(host, owner, "unblockip", bad)).result).toBe(true);
    expect((await rpc(host, owner, "listblockedips")).result).toEqual([]);
    const again = await WS.tryConnect(host, bad);
    expect(again).not.toBeNull();
    expect((await again!.ok(ev(member, 1, "back"))).ok).toBe(true);
  });

  it("accepts IPv6 and rejects ranges and names", async () => {
    const host = "blocks6.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await rpc(host, owner, "blockip", "2001:DB8::1", "")).result).toBe(true);
    expect((await rpc(host, owner, "listblockedips")).result).toEqual([{ ip: "2001:db8::1", reason: "" }]);
    expect(await WS.tryConnect(host, "2001:db8::1")).toBeNull();
    for (const bad of ["10.0.0.0/8", "relay.example", "1.2.3", "::::", "999.1.1.1"]) expect((await rpc(host, owner, "blockip", bad, "")).status).toBe(400);
  });
});
