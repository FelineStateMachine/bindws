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

describe("marmot", () => {
  it("checks the exact KeyPackage and group envelope shapes", () => {
    const sk = generateSecretKey();
    expect(marmotShape(ev(sk, KIND_MARMOT_KEY_PACKAGE, "AQ==", tags))).toBe("");
    expect(marmotShape(ev(sk, KIND_MARMOT_KEY_PACKAGE, "AQ==", [...tags, ["d", "11".repeat(32)]]))).toMatch(/^invalid:/);
    expect(marmotShape(ev(sk, KIND_MARMOT_GROUP, "AQ==", [["h", "ab".repeat(32)]]))).toBe("");
    expect(marmotShape(ev(sk, KIND_MARMOT_GROUP, "AQ==", [["h", "AB".repeat(32)]]))).toMatch(/^invalid:/);
    expect(marmotShape(ev(sk, KIND_MARMOT_GROUP, "AQ==", [["h", "ab".repeat(32)], ["x", "no"]]))).toMatch(/^invalid:/);
  });

  it("keeps Marmot off until the owner enables it and preserves NIP-29 h checks", async () => {
    const host = "marmot-off.bind.ws";
    const owner = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const group = ev(stranger, KIND_MARMOT_GROUP, "AQ==", [["h", "ab".repeat(32)]]);
    expect((await c.ok(group)).msg).toMatch(/^restricted:/);
    expect((await c.open("m", { kinds: [KIND_MARMOT_GROUP] })).closed).toMatch(/^unsupported:/);
    await rpc(host, owner, "setpolicy", { features: { marmot: true } });
    expect((await c.ok(group)).ok).toBe(true);
    const foreign = ev(stranger, 1, "hello", [["h", "other"]]);
    expect((await c.ok(foreign)).msg).toMatch(/^blocked: this relay hosts/);
    expect((await info(host)).supported_nips).toContain(1);
    c.ws.close();
  });

  it("requires an authenticated admitted account for group envelopes on limited relays", async () => {
    const host = "marmot-auth.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const ephemeral = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member));
    await rpc(host, owner, "setpolicy", { features: { marmot: true }, writes: "allowlist" });
    const c = await WS.connect(host);
    const group = () => ev(ephemeral, KIND_MARMOT_GROUP, "AQ==", [["h", "cd".repeat(32)]]);
    expect((await c.ok(group())).msg).toMatch(/^auth-required:/);
    await c.auth(member, host);
    expect((await c.ok(group())).ok).toBe(true);
    c.ws.close();
  });
});
