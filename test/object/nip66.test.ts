// NIP-66: the relay signs a kind 30166 discovery record about itself, under
// its primary URL, restating the NIP-11 document as tags, and re-signs it
// only when what it says would change.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { rpc, info } from "../helpers/relay.ts";

// query reads through the HTTP bridge as the owner, so the read rule never gets in the way.
async function query(host: string, sk: Uint8Array, filter: unknown): Promise<Event[]> {
  const url = `http://${host}/query`;
  const body = [filter];
  const authorization = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, body as any);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body) });
  expect(resp.status).toBe(200);
  return resp.json<Event[]>();
}

const vals = (e: Event, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1]);

describe("NIP-66 discovery record", () => {
  it("is signed by the relay under its primary URL, restates NIP-11 and follows the rules", async () => {
    const host = "sixtysix.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { tags: ["bitcoin", "cats"], languageTags: ["en", "pt-BR", "pt"], reads: "auth" });
    await rpc(host, owner, "allowkind", 1);
    await rpc(host, owner, "disallowkind", 4);
    const doc = await info(host);
    expect(doc.supported_nips).toContain(66);
    const self = doc.self as string;
    expect(self).toMatch(/^[0-9a-f]{64}$/);

    const found = await query(host, owner, { kinds: [30166], authors: [self] });
    expect(found.length).toBe(1);
    const e = found[0];
    expect(vals(e, "d")).toEqual([`wss://${host}/`]);
    expect(vals(e, "n")).toEqual(["clearnet"]);
    expect(vals(e, "T")).toEqual(["CommunityManagerRelays", "SearchRelays"]);
    expect(vals(e, "N")).toContain("1");
    expect(vals(e, "N")).toContain("66");
    expect(vals(e, "N")).toContain("43");
    expect(vals(e, "R").sort()).toEqual(["!payment", "!pow", "!writes", "auth"]);
    expect(vals(e, "t")).toEqual(["bitcoin", "cats"]);
    expect(e.tags.filter((t) => t[0] === "l")).toEqual([["l", "en", "ISO-639-1"], ["l", "pt", "ISO-639-1"]]);
    expect(vals(e, "k")).toEqual(["1", "!4"]);
    expect(e.tags[0]).toEqual(["-"]);
    const content = JSON.parse(e.content);
    expect(content.self).toBe(self);
    expect(content.tags).toEqual(["bitcoin", "cats"]);
    expect(content.limitation.auth_required).toBe(true);
  });

  it("is re-signed when the rules change and left alone when they do not", async () => {
    const host = "sixtysix-again.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const self = (await info(host)).self as string;
    const first = (await query(host, owner, { kinds: [30166], authors: [self] }))[0];
    expect(first).toBeDefined();
    expect(vals(first, "T")).toEqual(["PublicInbox", "SearchRelays"]);
    expect(vals(first, "R")).toContain("!auth");
    expect(vals(first, "R")).toContain("!pow");

    // The same policy again: nothing to say, so nothing is signed.
    await rpc(host, owner, "setpolicy", { reads: "open" });
    const same = await query(host, owner, { kinds: [30166], authors: [self] });
    expect(same.length).toBe(1);
    expect(same[0].id).toBe(first.id);

    // Proof of work and owner-only writes change the requirements and the type.
    await rpc(host, owner, "setpolicy", { minPow: 8, writes: "owner" });
    const next = await query(host, owner, { kinds: [30166], authors: [self] });
    expect(next.length).toBe(1);
    expect(next[0].id).not.toBe(first.id);
    expect(next[0].created_at).toBeGreaterThan(first.created_at);
    expect(vals(next[0], "R")).toContain("pow");
    expect(vals(next[0], "R")).toContain("writes");
    expect(vals(next[0], "T")).toEqual(["PublicOutbox", "SearchRelays"]);
    expect(JSON.parse(next[0].content).limitation.min_pow_difficulty).toBe(8);
  });
});
