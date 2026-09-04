// Media beyond the Blossom basics: NIP-94 tags in descriptors (BUD-08), blob
// reports in the moderation queue (BUD-09), and the NIP-96 door onto the
// same bucket and table.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "../../src/negentropy.ts";
import { ev, rpc } from "../helpers/relay.ts";
import { upload } from "../helpers/media.ts";

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

async function nip96Upload(host: string, sk: Uint8Array, bytes: Uint8Array, opts: { type?: string; size?: string; payload?: string; caption?: string } = {}) {
  const url = `http://${host}/nip96`;
  const form = new FormData();
  form.append("file", new File([bytes], "a.txt", { type: opts.type ?? "text/plain" }));
  if (opts.size !== undefined) form.append("size", opts.size);
  if (opts.caption) form.append("caption", opts.caption);
  const resp = await SELF.fetch(url, { method: "POST", headers: { authorization: nip98(sk, url, "POST", opts.payload) }, body: form });
  return { status: resp.status, body: await resp.json<any>(), reason: resp.headers.get("x-reason") ?? "" };
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
    const viaNip96 = await nip96Upload(host, bob, new TextEncoder().encode("questionable"));
    expect(viaNip96.status).toBe(403);
  });
});

describe("NIP-96 door", () => {
  it("advertises itself and shares the bucket, list and delete with Blossom", async () => {
    const host = "nip96.bind.ws";
    const owner = generateSecretKey();
    const bob = generateSecretKey();
    await rpc(host, owner, "claim");

    const doc = await (await SELF.fetch(`http://${host}/.well-known/nostr/nip96.json`)).json<any>();
    expect(doc.api_url).toBe(`https://${host}/nip96`);
    expect(doc.download_url).toBe(`https://${host}`);
    expect(doc.supported_nips).toContain(98);
    expect(doc.plans.free.max_byte_size).toBe(25 * 1024 * 1024);
    expect(doc.content_types).toContain("image/png");

    const bytes = new TextEncoder().encode("through the other door");
    const sha = bytesToHex(sha256(bytes));
    let r = await nip96Upload(host, bob, bytes, { payload: sha, caption: "a caption", size: String(bytes.length) });
    expect([r.status, r.body.status, r.body.message]).toEqual([201, "success", "Upload successful."]);
    expect(r.body.nip94_event.tags).toEqual([["url", `https://${host}/${sha}.txt`], ["m", "text/plain"], ["x", sha], ["ox", sha], ["size", String(bytes.length)]]);
    expect(r.body.nip94_event.content).toBe("a caption");
    r = await nip96Upload(host, bob, bytes);
    expect([r.status, r.body.message]).toEqual([200, "File already stored."]);

    // Served through both doors, listed through both doors.
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(200);
    const viaNip96 = await SELF.fetch(`http://${host}/nip96/${sha}.txt`);
    expect([viaNip96.status, await viaNip96.text()]).toEqual([200, "through the other door"]);
    const listURL = `http://${host}/nip96?page=0&count=10`;
    const list = await (await SELF.fetch(listURL, { headers: { authorization: nip98(bob, listURL, "GET") } })).json<any>();
    expect([list.total, list.page, list.count]).toEqual([1, 0, 10]);
    expect(list.files[0].tags).toEqual(r.body.nip94_event.tags);
    expect((await rpc(host, owner, "listblobs")).result.map((b: any) => b.sha256)).toEqual([sha]);
    expect((await SELF.fetch(`http://${host}/nip96`)).status).toBe(401);

    // Refusals: wrong payload, wrong size field, no file, stranger deleting.
    expect((await nip96Upload(host, bob, new TextEncoder().encode("other"), { payload: sha })).status).toBe(403);
    expect((await nip96Upload(host, bob, bytes, { size: "3" })).status).toBe(400);
    const empty = new FormData();
    empty.append("caption", "no file");
    expect((await SELF.fetch(`http://${host}/nip96`, { method: "POST", headers: { authorization: nip98(bob, `http://${host}/nip96`, "POST") }, body: empty })).status).toBe(400);
    const stranger = generateSecretKey();
    const delURL = `http://${host}/nip96/${sha}`;
    expect((await SELF.fetch(delURL, { method: "DELETE", headers: { authorization: nip98(stranger, delURL, "DELETE") } })).status).toBe(403);
    // The owner has the storage role; the uploader has the file.
    const del = await SELF.fetch(delURL, { method: "DELETE", headers: { authorization: nip98(bob, delURL, "DELETE") } });
    expect([del.status, (await del.json<any>()).status]).toEqual([200, "success"]);
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(404);
    expect((await SELF.fetch(delURL, { method: "DELETE", headers: { authorization: nip98(owner, delURL, "DELETE") } })).status).toBe(404);
    expect((await rpc(host, owner, "listblobs")).result).toEqual([]);

    // A Blossom upload shows up in the NIP-96 listing and the owner can delete it there.
    const up = await upload(host, bob, "blossom side");
    const again = await (await SELF.fetch(listURL, { headers: { authorization: nip98(bob, listURL, "GET") } })).json<any>();
    expect(again.files.map((f: any) => f.tags.find((t: string[]) => t[0] === "x")[1])).toEqual([up.sha]);
    const ownerDel = `http://${host}/nip96/${up.sha}`;
    expect((await SELF.fetch(ownerDel, { method: "DELETE", headers: { authorization: nip98(owner, ownerDel, "DELETE") } })).status).toBe(200);
  });

  it("applies the same gates as Blossom", async () => {
    const bob = generateSecretKey();
    const bytes = new TextEncoder().encode("gated");
    let r = await nip96Upload("nip96-unclaimed.bind.ws", bob, bytes);
    expect([r.status, r.reason.split(":")[0]]).toEqual([403, "restricted"]);

    const host = "nip96-gates.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "banpubkey", getPublicKey(bob), "no");
    r = await nip96Upload(host, bob, bytes);
    expect([r.status, r.reason.split(":")[0]]).toEqual([403, "blocked"]);
    await rpc(host, owner, "setpolicy", { maxBlobMB: 1 });
    r = await nip96Upload(host, owner, new Uint8Array(1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect((await SELF.fetch(`http://${host}/.well-known/nostr/nip96.json`).then((x) => x.json<any>())).plans.free.max_byte_size).toBe(1024 * 1024);
  });
});
