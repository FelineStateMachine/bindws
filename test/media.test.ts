// Media beyond the Blossom basics: NIP-94 tags in descriptors (BUD-08) and
// blob reports in the moderation queue (BUD-09).
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "../src/negentropy.ts";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) => finalizeEvent({ kind, content, tags, created_at }, sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

const blossomToken = (sk: Uint8Array, sha: string, action = "upload") =>
  "Nostr " + btoa(JSON.stringify(ev(sk, 24242, action, [["t", action], ["x", sha], ["expiration", String(now() + 300)]])));

async function upload(host: string, sk: Uint8Array, text: string) {
  const body = new TextEncoder().encode(text);
  const sha = bytesToHex(sha256(body));
  const resp = await SELF.fetch(`http://${host}/upload`, { method: "PUT", headers: { authorization: blossomToken(sk, sha), "content-type": "text/plain" }, body });
  return { status: resp.status, sha, body: await resp.json<any>() };
}

// nip98 signs a token by hand so the payload tag can be the file hash, as
// NIP-96 wants, rather than the hash of a JSON body.
const nip98 = (sk: Uint8Array, url: string, method: string, payload?: string) =>
  "Nostr " + btoa(JSON.stringify(ev(sk, 27235, "", [["u", url], ["method", method], ...(payload ? [["payload", payload]] : [])])));

async function report(host: string, sk: Uint8Array, tags: string[][], content = "not ok", raw?: string) {
  const body = raw ?? JSON.stringify(ev(sk, 1984, content, tags));
  const resp = await SELF.fetch(`http://${host}/report`, { method: "PUT", headers: { "content-type": "application/json" }, body });
  const text = await resp.text();
  return { status: resp.status, body: text ? JSON.parse(text) : null, reason: resp.headers.get("x-reason") ?? "" };
}

describe("BUD-08 nip94 tags", () => {
  it("descriptors from upload and list carry the tags the relay can vouch for", async () => {
    const host = "nip94.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const up = await upload(host, owner, "tagged bytes");
    expect(up.status).toBe(200);
    const url = `https://${host}/${up.sha}.txt`;
    expect(up.body.nip94).toEqual([["url", url], ["m", "text/plain"], ["x", up.sha], ["ox", up.sha], ["size", "12"]]);
    const list = await (await SELF.fetch(`http://${host}/list/${getPublicKey(owner)}`)).json<any>();
    expect(list[0].nip94).toEqual(up.body.nip94);
  });
});

describe("BUD-09 blob reports", () => {
  it("files a report per held blob into the moderation queue, and deleting blocks the hash", async () => {
    const host = "blobreport.bind.ws";
    const owner = generateSecretKey();
    const bob = generateSecretKey();
    const carol = generateSecretKey();
    await rpc(host, owner, "claim");
    const up = await upload(host, bob, "questionable");
    expect(up.status).toBe(200);
    const unknown = "ab".repeat(32);

    let r = await report(host, carol, [["x", up.sha, "nudity"], ["x", unknown, "spam"]]);
    expect([r.status, r.body]).toEqual([200, { ok: true, filed: 1 }]);
    const open = (await rpc(host, owner, "listreports")).result;
    expect(open.length).toBe(1);
    expect(open[0]).toMatchObject({ reporter: getPublicKey(carol), target_pubkey: getPublicKey(bob), target_event: up.sha, type: "nudity", content: "not ok", blob: 1 });

    r = await report(host, carol, [["x", unknown, "spam"]]);
    expect([r.status, r.reason.split(":")[0]]).toEqual([404, "not found"]);
    r = await report(host, carol, [["e", up.sha]]);
    expect(r.status).toBe(400);
    const forged = ev(carol, 1984, "signed", [["x", up.sha]]);
    forged.content = "tampered";
    r = await report(host, carol, [], "", JSON.stringify(forged));
    expect([r.status, r.reason.split(":")[0]]).toEqual([400, "invalid"]);
    r = await report(host, carol, [["x", up.sha]], "", JSON.stringify(ev(carol, 1, "", [["x", up.sha]])));
    expect(r.status).toBe(400);
    expect((await report("nobody-home.bind.ws", carol, [["x", up.sha]])).status).toBe(403);

    expect((await rpc(host, owner, "resolvereport", open[0].id, "delete")).result).toBe(true);
    expect((await SELF.fetch(`http://${host}/${up.sha}`)).status).toBe(404);
    expect((await rpc(host, owner, "listreports")).result).toEqual([]);
    const again = await upload(host, bob, "questionable");
    expect([again.status, again.body.error.split(":")[0]]).toEqual([403, "blocked"]);
  });
});
