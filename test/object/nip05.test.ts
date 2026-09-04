// NIP-05: names under the relay's domain for its members.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { ev, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("NIP-05", () => {
  it("serves members' names for the relay's own host, claimed via kind 0 or assigned by the owner", async () => {
    const host = "names.bind.ws";
    const owner = generateSecretKey();
    const alice = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "allowpubkey", getPublicKey(alice));
    const c = await WS.connect(host);
    await c.ok(ev(alice, 0, JSON.stringify({ name: "alice", nip05: "Alice@names.bind.ws" })));
    await c.ok(ev(stranger, 0, JSON.stringify({ name: "mallory", nip05: "alice@names.bind.ws" }))); // not a member: ignored
    await c.ok(ev(owner, 0, JSON.stringify({ nip05: "owner@elsewhere.example" }))); // other domain: ignored
    let doc: any = await (await SELF.fetch(`http://${host}/.well-known/nostr.json?name=alice`)).json();
    expect(doc.names).toEqual({ alice: getPublicKey(alice) });
    expect(doc.relays[getPublicKey(alice)]).toEqual(["wss://" + host]);
    doc = await (await SELF.fetch(`http://${host}/.well-known/nostr.json?name=nobody`)).json();
    expect(doc.names).toEqual({});
    // Owner assigns and removes names; a taken name can't be claimed by another member.
    expect((await rpc(host, owner, "setmember", getPublicKey(owner), { name: "_" })).result.name).toBe("_");
    expect((await rpc(host, owner, "setmember", getPublicKey(owner), { name: "bad name!" })).status).toBe(400);
    doc = await (await SELF.fetch(`http://${host}/.well-known/nostr.json`)).json();
    expect(Object.keys(doc.names).sort()).toEqual(["_", "alice"]);
    // Assigning a taken name to someone else moves it; clearing frees it.
    expect((await rpc(host, owner, "setmember", getPublicKey(stranger), { name: "alice" })).result.name).toBe("alice");
    expect((await rpc(host, owner, "listmembers")).result.members.find((m: any) => m.pubkey === getPublicKey(alice)).name).toBeNull();
    expect((await rpc(host, owner, "setmember", getPublicKey(stranger), { name: "" })).result.name).toBeNull();
    // The public directory lists people with their names; the owner can hide it.
    let people: any = await (await SELF.fetch(`http://${host}/people`)).json();
    expect(people.people.map((m: any) => m.role)).toEqual(["owner", "member", "member"]);
    expect(people.people[0].name).toBe("_");
    await rpc(host, owner, "setpolicy", { directoryPublic: false });
    people = await (await SELF.fetch(`http://${host}/people`)).json();
    expect(people.people).toEqual([]);
  });
});
