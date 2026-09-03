// Fills a relay with test files and reports, signed by the dev seed key. Usage: node scripts/junk.mjs https://<name>.bind.ws
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const sk = new Uint8Array(32).fill(7);
const base = process.argv[2].replace(/\/$/, "");
const now = () => Math.floor(Date.now() / 1000);
const sign = (kind, tags, content = "") => finalizeEvent({ kind, created_at: now(), tags, content }, sk);
const auth = (e) => "Nostr " + Buffer.from(JSON.stringify(e)).toString("base64");

const files = [
  ["favicon.svg", "image/svg+xml", readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8").match(/<svg[^`]*<\/svg>/)[0]],
  ["notes.txt", "text/plain", "junk file for testing the files list\n".repeat(200)],
  ["blob.bin", "application/octet-stream", Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => (i * 7919) & 255))],
  ["hello.json", "application/json", JSON.stringify({ hello: "world", when: now() })],
];
for (const [name, type, body] of files) {
  const data = typeof body === "string" ? Buffer.from(body) : body;
  const x = createHash("sha256").update(data).digest("hex");
  const e = sign(24242, [["t", "upload"], ["x", x], ["expiration", String(now() + 300)]], "upload " + name);
  const r = await fetch(base + "/upload", { method: "PUT", headers: { authorization: auth(e), "content-type": type }, body: data });
  console.log("upload", name, r.status, (await r.text()).slice(0, 120));
}

// Reports against a couple of the newest notes on the relay, plus one against a random pubkey.
const { Relay } = await import("nostr-tools/relay");
const relay = await Relay.connect(base.replace(/^http/, "ws"));
const notes = await new Promise((res) => { const got = []; relay.subscribe([{ kinds: [1], limit: 3 }], { onevent: (e) => got.push(e), oneose: () => res(got) }); });
const reports = notes.map((n, i) => sign(1984, [["e", n.id, ["spam", "nudity", "impersonation"][i % 3]], ["p", n.pubkey]], ["obvious spam", "not for this relay", "pretending to be someone"][i % 3]));
reports.push(sign(1984, [["p", getPublicKey(new Uint8Array(32).fill(9)), "other"]], "just a test report on a pubkey"));
for (const r of reports) { try { await relay.publish(r); console.log("report", r.id.slice(0, 8), "ok"); } catch (err) { console.log("report", r.id.slice(0, 8), String(err)); } }
relay.close();
