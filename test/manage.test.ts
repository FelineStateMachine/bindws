// NIP-86 gaps: the moderation list over the reports queue, address blocks
// from the connecting address, and the per-address rate limit that stops a
// swarm of sockets from multiplying a connection's allowance.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { ev, pk, sleep, rpc, post } from "./helpers/relay.ts";
import { WS } from "./helpers/ws.ts";

describe("listeventsneedingmoderation", () => {
  it("lists open reports by reported thing, deduplicated, for owner and moderator only", async () => {
    const host = "modqueue.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    const author = generateSecretKey();
    const reporter = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(member), {});
    const c = (await WS.tryConnect(host, "10.9.0.1"))!;
    const note = ev(author, 1, "buy my coin");
    expect((await c.ok(note)).ok).toBe(true);
    // Two reports on the note, one on the author alone.
    expect((await c.ok(ev(reporter, 1984, "junk", [["e", note.id, "spam"], ["p", pk(author)]]))).ok).toBe(true);
    expect((await c.ok(ev(member, 1984, "", [["e", note.id, "spam"], ["p", pk(author)]]))).ok).toBe(true);
    expect((await c.ok(ev(reporter, 1984, "bot", [["p", pk(author), "impersonation"]]))).ok).toBe(true);

    const list = await rpc(host, owner, "listeventsneedingmoderation");
    expect(list.status).toBe(200);
    expect(list.result).toEqual([{ id: note.id, reason: "spam: junk" }]);
    expect((await rpc(host, mod, "listeventsneedingmoderation")).result).toEqual([{ id: note.id, reason: "spam: junk" }]);
    expect((await rpc(host, member, "listeventsneedingmoderation")).status).toBe(403);
    expect((await rpc(host, owner, "supportedmethods")).result).toEqual(expect.arrayContaining(["listeventsneedingmoderation", "blockip", "unblockip", "listblockedips"]));

    // Resolving the reports empties the list.
    const reports = (await rpc(host, owner, "listreports")).result as { id: string }[];
    for (const r of reports) await rpc(host, owner, "resolvereport", r.id, "dismiss");
    expect((await rpc(host, owner, "listeventsneedingmoderation")).result).toEqual([]);
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
