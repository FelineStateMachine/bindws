// Blossom beyond upload and fetch: BUD-06 asks whether an upload would be
// accepted, BUD-04 copies a blob from a URL, ours or anyone's.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "../../src/negentropy.ts";
import { rpc } from "../helpers/relay.ts";
import { blossomToken, upload } from "../helpers/media.ts";

async function head(host: string, headers: Record<string, string>) {
  const resp = await SELF.fetch(`http://${host}/upload`, { method: "HEAD", headers });
  return { status: resp.status, reason: resp.headers.get("x-reason") ?? "", text: await resp.text() };
}

async function mirror(host: string, sk: Uint8Array, url: unknown, sha?: string, raw?: string) {
  const resp = await SELF.fetch(`http://${host}/mirror`, { method: "PUT", headers: { authorization: blossomToken(sk, "upload", sha), "content-type": "application/json" }, body: raw ?? JSON.stringify({ url }) });
  const text = await resp.text();
  return { status: resp.status, body: text ? JSON.parse(text) : null, reason: resp.headers.get("x-reason") ?? "" };
}

describe("BUD-06 upload requirements", () => {
  it("answers HEAD /upload from the headers and the policy, with no body", async () => {
    const host = "buds-head.bind.ws";
    const owner = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    const bytes = new TextEncoder().encode("a small file");
    const sha = bytesToHex(sha256(bytes));
    const ok = { "x-sha-256": sha, "x-content-type": "text/plain", "x-content-length": String(bytes.length), authorization: blossomToken(owner, "upload", sha) };

    let r = await head(host, ok);
    expect([r.status, r.reason, r.text]).toEqual([200, "", ""]);
    r = await head(host, { ...ok, "x-sha-256": "nope" });
    expect([r.status, r.reason.split(":")[0]]).toEqual([400, "invalid"]);
    const { "x-content-length": _, ...noLength } = ok;
    r = await head(host, noLength);
    expect(r.status).toBe(411);
    r = await head(host, { ...ok, "x-content-length": "twelve" });
    expect(r.status).toBe(400);
    const { authorization: __, ...noAuth } = ok;
    r = await head(host, noAuth);
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/^auth-required/);
    r = await head(host, { ...ok, "x-content-length": String(26 * 1024 * 1024) });
    expect(r.status).toBe(413);
    expect(r.reason).toMatch(/25 MB/);
    r = await head(host, { ...ok, authorization: blossomToken(owner, "upload", "ab".repeat(32)) });
    expect(r.status).toBe(400);

    await rpc(host, owner, "setpolicy", { writes: "owner" });
    r = await head(host, { ...ok, authorization: blossomToken(stranger, "upload", sha) });
    expect(r.status).toBe(403);
    expect(r.reason).toMatch(/^restricted/);

    // Already stored is still a 200: the PUT would answer with the descriptor.
    expect((await upload(host, owner, "a small file")).status).toBe(200);
    expect((await head(host, ok)).status).toBe(200);
  });
});

describe("BUD-04 mirror", () => {
  it("copies a blob from another relay on this host, once", async () => {
    const a = "buds-src.bind.ws";
    const b = "buds-dst.bind.ws";
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    await rpc(a, alice, "claim");
    await rpc(b, bob, "claim");
    const up = await upload(a, alice, "the same bytes, elsewhere");
    expect(up.status).toBe(200);
    expect(up.body.url).toBe(`https://${a}/${up.sha}.txt`);

    let r = await mirror(b, bob, up.body.url, up.sha);
    expect(r.status, r.reason).toBe(201);
    expect(r.body).toEqual({ url: `https://${b}/${up.sha}.txt`, sha256: up.sha, size: up.body.size, type: "text/plain", uploaded: expect.any(Number), nip94: expect.any(Array) });
    const got = await SELF.fetch(`http://${b}/${up.sha}`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("the same bytes, elsewhere");
    const list = (await rpc(b, bob, "listblobs")).result;
    expect(list.map((x: any) => [x.sha256, x.uploader])).toEqual([[up.sha, getPublicKey(bob)]]);

    r = await mirror(b, bob, up.body.url, up.sha);
    expect(r.status).toBe(200);
    expect(r.body.sha256).toBe(up.sha);
    expect((await rpc(b, bob, "listblobs")).result.length).toBe(1);
  });

  it("refuses what it should: wrong hash, bad body, bad url, no auth, policy", async () => {
    const a = "buds-src2.bind.ws";
    const b = "buds-dst2.bind.ws";
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(a, alice, "claim");
    await rpc(b, bob, "claim");
    const up = await upload(a, alice, "bytes to mirror");

    let r = await mirror(b, bob, up.body.url, "ab".repeat(32));
    expect([r.status, r.reason.split(":")[0]]).toEqual([409, "invalid"]);
    expect((await rpc(b, bob, "listblobs")).result).toEqual([]);
    r = await mirror(b, bob, undefined, undefined, "not json");
    expect(r.status).toBe(400);
    r = await mirror(b, bob, "");
    expect(r.status).toBe(400);
    r = await mirror(b, bob, "ftp:/nope");
    expect(r.status).toBe(400);
    r = await mirror(b, bob, "http://example.com/" + up.sha);
    expect([r.status, r.reason]).toEqual([400, "invalid: only https urls can be mirrored"]);
    r = await mirror(b, bob, `https://${a}/${"cd".repeat(32)}`);
    expect([r.status, r.reason]).toEqual([502, "error: the origin answered 404"]);
    const noAuth = await SELF.fetch(`http://${b}/mirror`, { method: "PUT", body: JSON.stringify({ url: up.body.url }) });
    expect(noAuth.status).toBe(401);

    await rpc(b, bob, "setpolicy", { writes: "owner" });
    r = await mirror(b, stranger, up.body.url, up.sha);
    expect(r.status).toBe(403);
    await rpc(b, bob, "setpolicy", { writes: "open", maxBlobMB: 1 });
    // The origin declares its size, so an oversized blob is refused before any bytes move.
    await rpc(a, alice, "setpolicy", { maxBlobMB: 2 });
    const big = await SELF.fetch(`http://${a}/upload`, { method: "PUT", headers: { authorization: blossomToken(alice, "upload"), "content-type": "application/octet-stream" }, body: new Uint8Array(1024 * 1024 + 1) });
    expect(big.status).toBe(200);
    r = await mirror(b, bob, (await big.json<any>()).url);
    expect(r.status).toBe(413);
  });

});
