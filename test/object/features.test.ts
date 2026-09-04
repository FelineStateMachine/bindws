// Features an owner switches off (settings.ts, features): the NIP-11 list
// loses the number, the door answers 404, the socket refuses the verb, and
// the full-text index follows the search mode.
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { ev, rpc, info, get, post, pk } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";
import { upload } from "../helpers/media.ts";

const status = async (host: string, path: string) => (await get(host, path)).status;

describe("features", () => {
  it("are all on by default, and setpolicy takes a map that survives export and import", async () => {
    const host = "feat-default.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const p = (await rpc(host, owner, "getpolicy")).result;
    expect(p.features).toEqual({ search: "prose", sync: true, count: true, discovery: true, names: true, files: true, pages: true, signer: true, sites: { enabled: true, mirror: true } });
    for (const n of [5, 45, 46, 50, 66, 77]) expect((await info(host)).supported_nips).toContain(n);
    const r = await rpc(host, owner, "setpolicy", { features: { search: "full", sync: false, bogus: true, count: "no" } });
    expect(r.result.features).toMatchObject({ search: "full", sync: false, count: true });
    expect(r.result.features.bogus).toBeUndefined();
    const cfg = (await rpc(host, owner, "exportconfig")).result;
    expect(cfg.policy.features).toMatchObject({ search: "full", sync: false });
    const other = "feat-import.bind.ws";
    await rpc(other, owner, "claim");
    expect((await rpc(other, owner, "importconfig", cfg)).status).toBe(200);
    expect((await rpc(other, owner, "getpolicy")).result.features).toMatchObject({ search: "full", sync: false });
    const doc = await info(other);
    expect(doc.supported_nips).not.toContain(77);
    expect(doc.supported_nips).toContain(50);
  });

  it("search: prose indexes notes, full indexes reactions too, off refuses the filter", async () => {
    const host = "feat-search.bind.ws";
    const owner = generateSecretKey();
    const alice = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    expect((await c.ok(ev(alice, 1, "hello world"))).ok).toBe(true);
    expect((await c.ok(ev(alice, 7, "hello", [["e", "ab".repeat(32)]]))).ok).toBe(true);
    expect((await c.req({ search: "hello" })).map((e) => e.kind)).toEqual([1]);
    await rpc(host, owner, "setpolicy", { features: { search: "full" } });
    expect((await c.ok(ev(alice, 7, "hello again", [["e", "cd".repeat(32)]]))).ok).toBe(true);
    expect((await c.req({ search: "hello" })).map((e) => e.kind).sort()).toEqual([1, 7]);
    await rpc(host, owner, "setpolicy", { features: { search: "off" } });
    expect((await c.query({ search: "hello" })).closed).toMatch(/^unsupported: search/);
    expect((await c.req({ kinds: [1] })).length).toBe(1);
    expect((await info(host)).supported_nips).not.toContain(50);
  });

  it("count and sync off are refused at the socket and leave the list", async () => {
    const host = "feat-socket.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    expect((await c.count({ kinds: [1] })).closed).toBe("");
    expect(await c.sync("s1", { kinds: [1] })).toBe("");
    await rpc(host, owner, "setpolicy", { features: { count: false, sync: false } });
    expect((await c.count({ kinds: [1] })).closed).toMatch(/^unsupported: COUNT/);
    expect(await c.sync("s2", { kinds: [1] })).toMatch(/^unsupported: sync/);
    const nips = (await info(host)).supported_nips;
    expect(nips).not.toContain(45);
    expect(nips).not.toContain(77);
    expect(nips).toContain(1);
  });

  it("names, files and pages off answer 404 at their doors and refuse uploads", async () => {
    const host = "feat-doors.bind.ws";
    const owner = generateSecretKey();
    const alice = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(alice), { name: "alice" });
    const up = await upload(host, alice, "a file");
    expect(up.status).toBe(200);
    expect(await status(host, "/.well-known/nostr.json?name=alice")).toBe(200);
    expect(await status(host, `/${up.sha}`)).toBe(200);
    expect(await status(host, "/.well-known/nostr/nip96.json")).toBe(200);
    expect(await status(host, "/feed.xml")).toBe(200);
    await rpc(host, owner, "setpolicy", { features: { names: false, files: false, pages: false } });
    expect(await status(host, "/.well-known/nostr.json?name=alice")).toBe(404);
    expect(await status(host, `/${up.sha}`)).toBe(404);
    expect(await status(host, "/.well-known/nostr/nip96.json")).toBe(404);
    expect(await status(host, "/feed.xml")).toBe(404);
    const again = await upload(host, alice, "another file");
    expect(again.status).toBe(404);
    // The page, NIP-11 and management stay.
    expect(await status(host, "/")).toBe(200);
    expect((await info(host)).supported_nips).not.toContain(5);
    expect((await rpc(host, owner, "stats")).status).toBe(200);
  });

  it("discovery off takes the record down, and on brings it back", async () => {
    const host = "feat-discovery.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const self = (await info(host)).self as string;
    const records = async () => (await post(host, owner, "/query", [{ kinds: [30166], authors: [self] }])).body.length;
    expect(await records()).toBe(1);
    await rpc(host, owner, "setpolicy", { features: { discovery: false } });
    expect(await records()).toBe(0);
    expect((await info(host)).supported_nips).not.toContain(66);
    await rpc(host, owner, "setpolicy", { features: { discovery: true } });
    expect(await records()).toBe(1);
  });

  it("signer off treats kind 24133 like any other event", async () => {
    const host = "feat-signer.bind.ws";
    const owner = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "owner", reads: "auth" });
    const c = await WS.connect(host);
    const traffic = () => ev(stranger, 24133, "x", [["p", getPublicKey(owner)]]);
    expect((await c.ok(traffic())).ok).toBe(true);
    expect((await c.open("nc", { kinds: [24133] })).closed).toBe("");
    await rpc(host, owner, "setpolicy", { features: { signer: false } });
    expect((await c.ok(traffic())).msg).toMatch(/^restricted:/);
    expect((await c.open("nc2", { kinds: [24133] })).closed).toMatch(/^auth-required/);
    expect((await info(host)).supported_nips).not.toContain(46);
  });
});
