// Rules an evaluator asked for: the socket message cap per relay, blocked
// words that reach into tags and take a regular expression, and address
// blocks that travel with the exported configuration.
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { ev, rpc, info } from "./helpers/relay.ts";
import { WS } from "./helpers/ws.ts";

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

describe("blocked words", () => {
  it("takes /patterns/, refuses a bad one with the reason, and reaches into tags on request", async () => {
    const host = "words.bind.ws";
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

describe("address blocks in the configuration", () => {
  it("export carries them and import applies them, dropping the sockets they refuse", async () => {
    const a = "cfg-a.bind.ws";
    const b = "cfg-b.bind.ws";
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
    // A document without the list clears the blocks, like the other lists.
    delete cfg.addresses;
    await rpc(b, owner, "importconfig", cfg);
    expect((await rpc(b, owner, "listblockedips")).result).toEqual([]);
    expect(await WS.tryConnect(b, bad)).not.toBeNull();
  });
});
