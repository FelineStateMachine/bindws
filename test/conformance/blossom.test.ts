// Files, from outside: a Blossom upload, the download with and without a
// range, the listing and the delete. The one door that touches the media
// bucket, so a host whose bucket is not R2 (docs/16) is checked here.
import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { newEvent, newKey, pub, now, rand, hex, HTTP_URL } from "./helpers.ts";

// A Blossom token: kind 24242 with the verb and the hash, base64 in the header.
function token(sk: Uint8Array, verb: "upload" | "get" | "list" | "delete", sha?: string): string {
  const tags = [["t", verb], ...(sha ? [["x", sha]] : []), ["expiration", String(now() + 300)]];
  return "Nostr " + Buffer.from(JSON.stringify(newEvent(sk, 24242, verb, tags))).toString("base64");
}

describe("Blossom media", () => {
  it("uploads a file, serves it whole and by range, lists it, and deletes it", async () => {
    const sk = newKey();
    const body = new TextEncoder().encode(`a small file ${rand()} with enough bytes for a range`);
    const sha = hex(sha256(body));

    const put = await fetch(`${HTTP_URL}/upload`, { method: "PUT", headers: { authorization: token(sk, "upload", sha), "content-type": "text/plain" }, body });
    expect(put.status, await put.clone().text()).toBe(200);
    const desc: any = await put.json();
    expect([desc.sha256, desc.size, desc.type]).toEqual([sha, body.length, "text/plain"]);
    expect(desc.url).toMatch(new RegExp(`/${sha}\\.txt$`));

    // The whole file, with its type and hash-derived etag.
    const get = await fetch(`${HTTP_URL}/${sha}.txt`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/plain");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body);

    // A byte range: the second word.
    const part = await fetch(`${HTTP_URL}/${sha}`, { headers: { range: "bytes=2-6" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 2-6/${body.length}`);
    expect(await part.text()).toBe("small");

    // HEAD says it is there without a body.
    const head = await fetch(`${HTTP_URL}/${sha}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    // The uploader's listing carries it.
    const list = await fetch(`${HTTP_URL}/list/${pub(sk)}`, { headers: { authorization: token(sk, "list") } });
    expect(list.status).toBe(200);
    expect((await list.json<any>()).map((d: any) => d.sha256)).toContain(sha);

    // The uploader deletes it; the same bytes can come back afterwards.
    const del = await fetch(`${HTTP_URL}/${sha}`, { method: "DELETE", headers: { authorization: token(sk, "delete", sha) } });
    expect(del.status).toBe(204);
    expect((await fetch(`${HTTP_URL}/${sha}`)).status).toBe(404);
    const again = await fetch(`${HTTP_URL}/upload`, { method: "PUT", headers: { authorization: token(sk, "upload", sha), "content-type": "text/plain" }, body });
    expect(again.status).toBe(200);
    expect((await fetch(`${HTTP_URL}/${sha}`)).status).toBe(200);
    await fetch(`${HTTP_URL}/${sha}`, { method: "DELETE", headers: { authorization: token(sk, "delete", sha) } });
  });
});
