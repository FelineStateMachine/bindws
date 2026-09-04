import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { KIND_MARMOT_GROUP, KIND_MARMOT_KEY_PACKAGE } from "../../src/kinds.ts";
import { marmotShape } from "../../src/marmot.ts";
import { ev, info, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

const tags = [
  ["d", "00".repeat(32)],
  ["mls_protocol_version", "1.0"],
  ["i", "ab".repeat(16)],
  ["mls_ciphersuite", "0x0001"],
  ["mls_extensions", "0x0001"],
  ["mls_proposals", "0x0001"],
  ["app_components", "0x8009"],
];
const GROUP_CONTENT = "A".repeat(40); // 30 decoded bytes: nonce plus AEAD tag minimum.

describe("marmot", () => {
  it("checks the exact KeyPackage and group envelope shapes", () => {
    const sk = generateSecretKey();
    expect(marmotShape(ev(sk, KIND_MARMOT_KEY_PACKAGE, "AQ==", tags))).toBe("");
    expect(marmotShape(ev(sk, KIND_MARMOT_KEY_PACKAGE, "AQ==", [...tags, ["d", "11".repeat(32)]]))).toMatch(/^invalid:/);
    expect(marmotShape(ev(sk, KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "ab".repeat(32)]]))).toBe("");
    expect(marmotShape(ev(sk, KIND_MARMOT_GROUP, "AQ==", [["h", "ab".repeat(32)]]))).toMatch(/^invalid:/);
    expect(marmotShape(ev(sk, KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "AB".repeat(32)]]))).toMatch(/^invalid:/);
    expect(marmotShape(ev(sk, KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "ab".repeat(32)], ["x", "no"]]))).toMatch(/^invalid:/);
  });

  it("keeps Marmot off until the owner enables it and preserves NIP-29 h checks", async () => {
    const host = "marmot-off.bind.ws";
    const owner = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const group = ev(stranger, KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "ab".repeat(32)]]);
    expect((await c.ok(group)).msg).toMatch(/^restricted:/);
    expect((await c.query({ kinds: [KIND_MARMOT_GROUP] })).closed).toMatch(/^unsupported:/);
    await rpc(host, owner, "setpolicy", { features: { marmot: true } });
    expect((await c.ok(group)).ok).toBe(true);
    const foreign = ev(stranger, 1, "hello", [["h", "other"]]);
    expect((await c.ok(foreign)).msg).toMatch(/^blocked: this relay hosts/);
    expect((await info(host)).supported_nips).toContain(1);
    c.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("the members template requires admitted account authentication while encrypted messages stay publicly readable", async () => {
    const host = "marmot-auth.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const ephemeral = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member));
    await rpc(host, owner, "applypreset", "marmot-members");
    const c = await WS.connect(host);
    const group = () => ev(ephemeral, KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "cd".repeat(32)]]);
    expect((await c.ok(group())).msg).toMatch(/^auth-required:/);
    await c.auth(member, host);
    expect((await c.ok(group())).ok).toBe(true);
    const stranger = await WS.connect(host);
    await stranger.auth(generateSecretKey(), host);
    const denied = ev(generateSecretKey(), KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "ee".repeat(32)]]);
    expect((await stranger.ok(denied)).msg).toMatch(/^auth-required:/);
    stranger.ws.close();
    const reader = await WS.connect(host);
    const messages = await reader.query({ kinds: [KIND_MARMOT_GROUP], "#h": ["cd".repeat(32)] });
    expect(messages.events.map((e) => e.pubkey)).toEqual([pk(ephemeral)]);
    reader.ws.close();
    const reused = ev(ephemeral, KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "de".repeat(32)]]);
    expect((await c.ok(reused)).msg).toMatch(/fresh ephemeral author|already used/);
    c.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("counts opaque group bytes against the authenticated account cap", async () => {
    const host = "marmot-cap.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member), { maxBytes: 700 });
    await rpc(host, owner, "applypreset", "marmot-members");
    const c = await WS.connect(host);
    await c.auth(member, host);
    const first = ev(generateSecretKey(), KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "ef".repeat(32)]]);
    expect((await c.ok(first)).ok).toBe(true);
    const second = ev(generateSecretKey(), KIND_MARMOT_GROUP, GROUP_CONTENT, [["h", "01".repeat(32)]]);
    expect((await c.ok(second)).msg).toMatch(/^restricted: you have reached your storage cap/);
    c.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
