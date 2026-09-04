// Doors for a client without a socket: the HTTP bridge, and NIP-46 as
// transport, where kind 24133 passes the ownership and write gates and a
// subscription to it alone passes the read gate.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { ev, rpc, post } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("HTTP bridge", () => {
  it("accepts events, answers queries and counts with NIP-98, applying the same gates", async () => {
    const host = "bridge.bind.ws";
    const owner = generateSecretKey();
    const other = generateSecretKey();
    await rpc(host, owner, "claim");
    const e = ev(owner, 1, "over http");
    let r = await post(host, owner, "/events", e);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ event_id: e.id, accepted: true, message: "" });
    r = await post(host, owner, "/events", e);
    expect(r.body.accepted).toBe(true);
    expect(r.body.message).toMatch(/^duplicate:/);

    r = await post(host, other, "/query", [{ kinds: [1], authors: [getPublicKey(owner)] }]);
    expect(r.status).toBe(200);
    expect(r.body.map((x: Event) => x.id)).toEqual([e.id]);
    r = await post(host, other, "/count", [{ kinds: [1] }]);
    expect(r.body.count).toBe(1);

    // Unsigned, wrong-URL, and non-JSON requests are refused cleanly.
    expect((await post(host, null, "/query", [{}])).status).toBe(401);
    const badUrlToken = await getToken("http://elsewhere.bind.ws/query", "POST", (x) => finalizeEvent(x, other), true, [{}] as any);
    const bad = await SELF.fetch(`http://${host}/query`, { method: "POST", headers: { authorization: badUrlToken }, body: "[{}]" });
    expect(bad.status).toBe(401);

    // A subscriber on the socket sees bridge writes live.
    const c = await WS.connect(host);
    await c.open("live", { kinds: [1] });
    const e2 = ev(owner, 1, "pushed");
    await post(host, owner, "/events", e2);
    expect((await c.expect("EVENT"))[2].id).toBe(e2.id);

    // Private kinds via the bridge follow the recipient rule; the signer counts as authenticated.
    const recipient = generateSecretKey();
    const wrap = ev(generateSecretKey(), 1059, "dm", [["p", getPublicKey(recipient)]]);
    await post(host, owner, "/events", wrap);
    r = await post(host, other, "/query", [{ kinds: [1059] }]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]); // authenticated but not a party: silently filtered
    expect((await post(host, null, "/query", [{ kinds: [1059] }])).status).toBe(401);
    r = await post(host, recipient, "/query", [{ kinds: [1059] }]);
    expect(r.body.map((x: Event) => x.id)).toEqual([wrap.id]);
  });
});

describe("NIP-46 transport", () => {
  it("carries kind 24133 on an unclaimed relay, live only, never stored", async () => {
    const host = "phone.bind.ws";
    const signerKey = generateSecretKey();
    const client = generateSecretKey();
    // A signer that names its key in the filter and never AUTHs, the way
    // Amethyst's bunker listens under a transport key.
    const listener = await WS.connect(host);
    expect((await listener.open("nc", { kinds: [24133], "#p": [getPublicKey(signerKey)] })).closed).toBe("");
    // A bystander subscribed to the kind alone, naming no key.
    const bystander = await WS.connect(host);
    expect((await bystander.open("nc", { kinds: [24133] })).closed).toBe("");

    const sender = await WS.connect(host);
    const req = ev(client, 24133, "ciphertext", [["p", getPublicKey(signerKey)]]);
    expect(await sender.ok(req)).toEqual({ ok: true, msg: "" });
    const got = await listener.expect("EVENT");
    expect(got[1]).toBe("nc");
    expect(got[2].id).toBe(req.id);
    // The reply, addressed to the client, reaches a socket that AUTHed as the
    // client, and one that asks by the signer's key as author.
    const clientSock = await WS.connect(host);
    expect((await clientSock.open("nc", { kinds: [24133] })).closed).toBe("");
    await clientSock.auth(client, host);
    const byAuthor = await WS.connect(host);
    expect((await byAuthor.open("nc", { kinds: [24133], authors: [getPublicKey(signerKey)] })).closed).toBe("");
    const reply = ev(signerKey, 24133, "ciphertext", [["p", getPublicKey(client)]]);
    expect(await listener.ok(reply)).toEqual({ ok: true, msg: "" });
    expect((await clientSock.expect("EVENT"))[2].id).toBe(reply.id);
    expect((await byAuthor.expect("EVENT"))[2].id).toBe(reply.id);
    // The bystander saw neither; a later frame proves the queue is empty.
    expect((await bystander.open("probe", { kinds: [24133] })).closed).toBe("");
    // Anything else is still refused while unclaimed, and the request left no trace.
    expect((await sender.ok(ev(client, 1, "hello"))).msg).toMatch(/unclaimed/);
    const later = await WS.connect(host);
    expect((await later.open("q", { kinds: [24133] })).closed).toBe("");
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.pubkey).toBeUndefined();
  });

  it("passes the write policy but not bans", async () => {
    const host = "locked.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "owner" });
    const stranger = generateSecretKey();
    const c = await WS.connect(host);
    expect((await c.ok(ev(stranger, 1, "no"))).msg).toMatch(/only the relay owner/);
    expect((await c.ok(ev(stranger, 24133, "x", [["p", getPublicKey(owner)]]))).ok).toBe(true);
    await rpc(host, owner, "banpubkey", getPublicKey(stranger), "spam");
    const d = await WS.connect(host);
    expect((await d.ok(ev(stranger, 24133, "x", [["p", getPublicKey(owner)]]))).msg).toMatch(/banned/);
    expect((await rpc(host, owner, "stats")).result.kinds.map((k: { kind: number }) => k.kind)).not.toContain(24133);
  });

  it("serves a subscription to 24133 alone under members-only reads, and nothing wider", async () => {
    const host = "private.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { reads: "members" });
    const c = await WS.connect(host);
    expect((await c.open("a", { kinds: [24133] })).closed).toBe("");
    expect((await c.open("b", { kinds: [24133], "#p": ["ab".repeat(32)] }, { kinds: [24133] })).closed).toBe("");
    expect((await c.open("c", { kinds: [24133, 1] })).closed).toMatch(/^auth-required/);
    expect((await c.open("d", { kinds: [24133] }, { kinds: [1] })).closed).toMatch(/^auth-required/);
    expect((await c.open("e", {})).closed).toMatch(/^auth-required/);
    // NIP-11 says so, and advertises the transport.
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.limitation.auth_required).toBe(true);
    expect(info.supported_nips).toContain(46);
    // Amber's probe before it lists a relay: a throwaway key, no AUTH, a
    // subscription naming the key, and its own event echoed back.
    const probe = generateSecretKey();
    expect((await c.open("nc", { kinds: [24133], "#p": [getPublicKey(probe)] })).closed).toBe("");
    const self = ev(probe, 24133, "Test bunker event", [["p", getPublicKey(probe)]]);
    expect(await c.ok(self)).toEqual({ ok: true, msg: "" });
    expect((await c.expect("EVENT"))[2].id).toBe(self.id);
    // A signer's reply reaches the client that asked for it by key, unauthed.
    const client = generateSecretKey();
    const d = await WS.connect(host);
    expect((await d.open("nc", { kinds: [24133], "#p": [getPublicKey(client)] })).closed).toBe("");
    const reply = ev(owner, 24133, "ciphertext", [["p", getPublicKey(client)]]);
    expect(await c.ok(reply)).toEqual({ ok: true, msg: "" });
    expect((await d.expect("EVENT"))[2].id).toBe(reply.id);
  });

  it("serves the signer library with a long cache", async () => {
    const resp = await SELF.fetch("http://any.bind.ws/signer.js?v=abc");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/javascript/);
    expect(resp.headers.get("cache-control")).toMatch(/max-age=604800/);
    const js = await resp.text();
    expect(js).toContain("NostrSigner");
    const page = await (await SELF.fetch("http://any.bind.ws/")).text();
    expect(page).toMatch(/window\.SIGNER_URL = "\/signer\.js\?v=[0-9a-f]{12}"/);
  });
});
