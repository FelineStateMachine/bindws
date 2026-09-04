// The write gate and the moderation tools: guests past a limited write
// rule, the web of trust, blocked words, a ban that erases, and reports
// that hide an event until a moderator looks.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { now, ev, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";
import { upload } from "../helpers/media.ts";

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

describe("ban and erase", () => {
  it("removes everything a banned pubkey wrote and uploaded when asked", async () => {
    const host = "erase.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const other = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member), {});
    await rpc(host, owner, "setmember", pk(other), {});
    const c = await WS.connect(host);
    for (const e of [ev(member, 0, JSON.stringify({ name: "soon gone" })), ev(member, 1, "one"), ev(member, 1, "two"), ev(other, 1, "stays")]) expect((await c.ok(e)).ok).toBe(true);
    const { sha } = await upload(host, member, "a file to erase");
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(200);
    // A plain ban keeps the history.
    expect((await rpc(host, owner, "banpubkey", pk(other), "plain")).result).toBe(true);
    expect((await c.req({ authors: [pk(other)] })).length).toBe(1);
    // A ban with erase does not.
    expect((await rpc(host, owner, "banpubkey", pk(member), "gone", true)).result).toBe(true);
    expect(await c.req({ authors: [pk(member)] })).toEqual([]);
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(404);
    expect((await rpc(host, owner, "listblobs")).result).toEqual([]);
    expect((await rpc(host, owner, "listmembers")).result.members.some((m: any) => m.pubkey === pk(member))).toBe(false);
    expect((await c.ok(ev(member, 1, "back?"))).msg).toMatch(/banned/);
    // The same through a report.
    const reporter = generateSecretKey();
    await rpc(host, owner, "setpolicy", { writes: "open" });
    const bad = ev(generateSecretKey(), 1, "report me");
    expect((await c.ok(bad)).ok).toBe(true);
    expect((await c.ok(ev(reporter, 1984, "spam", [["e", bad.id, "spam"], ["p", bad.pubkey]]))).ok).toBe(true);
    const report = (await rpc(host, owner, "listreports")).result[0];
    expect((await rpc(host, owner, "resolvereport", report.id, "ban", true)).result).toBe(true);
    expect(await c.req({ authors: [bad.pubkey] })).toEqual([]);
  });
});

describe("report thresholds", () => {
  it("hides an event once enough people report it, until a moderator resolves the reports", async () => {
    const host = "threshold.bind.ws";
    const owner = generateSecretKey();
    const author = generateSecretKey();
    const r1 = generateSecretKey();
    const r2 = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await rpc(host, owner, "setpolicy", { reportThreshold: 2 })).result.reportThreshold).toBe(2);
    const c = await WS.connect(host);
    const note = ev(author, 1, "contested");
    expect((await c.ok(note)).ok).toBe(true);
    const report = (sk: Uint8Array) => ev(sk, 1984, "nope", [["e", note.id, "spam"], ["p", pk(author)]]);
    expect((await c.ok(report(r1))).ok).toBe(true);
    expect((await c.ok(report(r1))).ok).toBe(true); // the same reporter twice counts once
    expect((await c.req({ ids: [note.id] })).length).toBe(1);
    expect((await c.ok(report(r2))).ok).toBe(true);
    // Hidden everywhere stored events are read.
    expect(await c.req({ ids: [note.id] })).toEqual([]);
    expect((await c.count({ authors: [pk(author)] })).count).toBe(0);
    expect((await SELF.fetch(`http://${host}/e/${note.id}`)).status).toBe(404);
    const feed = await (await SELF.fetch(`http://${host}/feed.xml`)).text();
    expect(feed.includes(note.id)).toBe(false);
    const reports = (await rpc(host, owner, "listreports")).result;
    expect(reports.length).toBe(2);
    expect(reports.every((r: any) => r.hidden === 1)).toBe(true);
    expect((await rpc(host, owner, "listeventsneedingmoderation")).result.map((r: any) => r.id)).toEqual([note.id]);
    // Dismissing one report leaves the hold; dismissing the last lifts it.
    await rpc(host, owner, "resolvereport", reports[0].id, "dismiss");
    expect(await c.req({ ids: [note.id] })).toEqual([]);
    await rpc(host, owner, "resolvereport", reports[1].id, "dismiss");
    expect((await c.req({ ids: [note.id] })).length).toBe(1);
    // Reports on a pubkey alone never hide anything.
    expect((await c.ok(ev(r1, 1984, "person", [["p", pk(author), "impersonation"]]))).ok).toBe(true);
    expect((await c.ok(ev(r2, 1984, "person", [["p", pk(author), "impersonation"]]))).ok).toBe(true);
    expect((await c.req({ ids: [note.id] })).length).toBe(1);
    // Delete makes it permanent.
    const again = ev(author, 1, "contested again");
    expect((await c.ok(again)).ok).toBe(true);
    for (const sk of [r1, r2]) expect((await c.ok(ev(sk, 1984, "nope", [["e", again.id, "spam"], ["p", pk(author)]]))).ok).toBe(true);
    expect(await c.req({ ids: [again.id] })).toEqual([]);
    const open = (await rpc(host, owner, "listreports")).result.filter((r: any) => r.target_event === again.id);
    await rpc(host, owner, "resolvereport", open[0].id, "delete");
    expect((await c.ok(again)).msg).toMatch(/banned/);
  });
});

describe("configuration", () => {
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
