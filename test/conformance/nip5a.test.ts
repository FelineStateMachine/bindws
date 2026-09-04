// NIP-5A from outside the relay: discover the host forms from NIP-11, upload
// the files through Blossom, publish signed manifests, and fetch each site
// through its canonical single-label hostname.
import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { newEvent, newKey, pub, hex, HTTP_URL, RELAY_URL, now, sleep, Client } from "./helpers.ts";
import { npubEncode } from "nostr-tools/nip19";

function blossomToken(sk: Uint8Array, action: string, hash?: string): string {
  const tags = [["t", action], ...(hash ? [["x", hash]] : []), ["expiration", String(now() + 300)]];
  return "Nostr " + Buffer.from(JSON.stringify(newEvent(sk, 24242, action, tags))).toString("base64");
}

async function upload(sk: Uint8Array, body: string, type: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const hash = hex(sha256(bytes));
  const response = await fetch(`${HTTP_URL}/upload`, {
    method: "PUT",
    headers: { authorization: blossomToken(sk, "upload", hash), "content-type": type },
    body: bytes,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const descriptor: any = await response.json();
  expect(descriptor.sha256).toBe(hash);
  return hash;
}

function siteHash(paths: string[][]): string {
  const lines = paths.map((t) => `${t[2]} ${t[1]}\n`).sort().join("");
  return hex(sha256(new TextEncoder().encode(lines)));
}

function discoveredHost(template: string, replacements: Record<string, string>): string {
  let value = template;
  for (const [key, replacement] of Object.entries(replacements)) value = value.replace(`<${key}>`, replacement);
  return new URL(value).hostname;
}

// siteFetch keeps Wrangler runs local while using the canonical hostname
// when RELAY_URL points at a public relay.
function siteFetch(host: string, path: string, init: RequestInit = {}) {
  const endpoint = new URL(HTTP_URL);
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]" || endpoint.hostname === "::1";
  endpoint.hostname = local ? `${host.split(".")[0]}.localhost` : host;
  endpoint.pathname = path;
  return fetch(endpoint, init);
}

async function waitForSite(host: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await siteFetch(host, "/");
    if (response.status === 200) { await response.arrayBuffer(); return; }
    await response.arrayBuffer();
    await sleep(100);
  }
  throw new Error(`site index did not become visible at ${host}`);
}

describe("NIP-5A static websites", () => {
  it("discovers canonical labels, serves root/named/snapshot sites, and applies fallbacks", async () => {
    const infoResponse = await fetch(HTTP_URL, { headers: { accept: "application/nostr+json" } });
    expect(infoResponse.status).toBe(200);
    const doc: any = await infoResponse.json();
    expect(doc.nsites).toMatchObject({ kinds: [15128, 35128, 5128] });
    expect(typeof doc.nsites.root).toBe("string");
    expect(typeof doc.nsites.named).toBe("string");
    expect(typeof doc.nsites.snapshot).toBe("string");

    const sk = newKey();
    const index = "<!doctype html><title>root</title>";
    const blogIndex = "<!doctype html><title>blog</title>";
    const notFound = "<!doctype html><title>missing</title>";
    const indexHash = await upload(sk, index, "text/html; charset=utf-8");
    const blogHash = await upload(sk, blogIndex, "text/html; charset=utf-8");
    const notFoundHash = await upload(sk, notFound, "text/html; charset=utf-8");
    const paths = [["path", "/index.html", indexHash], ["path", "/blog/index.html", blogHash], ["path", "/404.html", notFoundHash]];
    const aggregate = siteHash(paths);
    const c = await Client.connect(RELAY_URL);
    try {
      const root = newEvent(sk, 15128, "", paths);
      await c.publish(root);
      const named = newEvent(sk, 35128, "", [...paths, ["d", "demo-site"]]);
      await c.publish(named);
      const snapshot = newEvent(sk, 5128, "", [...paths, ["x", aggregate, "aggregate"], ["a", `15128:${pub(sk)}:`]]);
      await c.publish(snapshot);

      const replacements = { npub: npubEncode(pub(sk)) };
      const rootHost = discoveredHost(doc.nsites.root, replacements);
      const namedHost = discoveredHost(doc.nsites.named, { pubkeyB36: base36(pub(sk)), dTag: "demo-site" });
      const snapshotHost = discoveredHost(doc.nsites.snapshot, { snapshotIdB36: base36(snapshot.id) });
      // The event acknowledgement and KV index update are separate async
      // tasks on some deployments, so wait for each discovered label rather
      // than relying on a fixed delay.
      for (const host of [rootHost, namedHost, snapshotHost]) await waitForSite(host);

      for (const host of [rootHost, namedHost, snapshotHost]) {
        const response = await siteFetch(host, "/");
        expect(response.status, host).toBe(200);
        expect(await response.text(), host).toBe(index);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("etag")).toBe(`"${indexHash}"`);
        expect(response.headers.get("cache-control")).toContain("public");
        const head = await siteFetch(host, "/index.html", { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe(String(new TextEncoder().encode(index).length));

        const blog = await siteFetch(host, "/blog/");
        expect(blog.status).toBe(200);
        expect(await blog.text()).toBe(blogIndex);
        const fallback = await siteFetch(host, "/does-not-exist.txt");
        expect(fallback.status).toBe(404);
        expect(await fallback.text()).toBe(notFound);
        const redirect = await siteFetch(host, "/blog", { redirect: "manual" });
        expect(redirect.status).toBe(308);
        expect(new URL(redirect.headers.get("location")!).pathname).toBe("/blog/");
      }

      const notFoundSite = await siteFetch(rootHost, "/no-extension", { redirect: "manual" });
      expect(notFoundSite.status).toBe(308);
      const missingManifest = await siteFetch(discoveredHost(doc.nsites.root, { npub: npubEncode(pub(newKey())) }), "/");
      expect(missingManifest.status).toBe(404);
    } finally {
      c.close();
    }
  });
});

function base36(hexKey: string): string {
  return BigInt("0x" + hexKey).toString(36).padStart(50, "0");
}
