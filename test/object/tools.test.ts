// Console search, importing a file, NIP-29 pins, and the weekly digest.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { unwrapEvent } from "nostr-tools/nip59";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Relay } from "../../src/relay.ts";
import { bytesToHex } from "../../src/negentropy.ts";
import { now, ev, rpc, drive } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

// signedPut sends a raw body with a NIP-98 token whose payload tag is the body's hash.
async function signedPut(host: string, path: string, sk: Uint8Array | null, body: string) {
  const url = `http://${host}${path}`;
  const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
  if (sk) {
    const token = ev(sk, 27235, "", [["u", url], ["method", "PUT"], ["payload", bytesToHex(sha256(new TextEncoder().encode(body)))]]);
    headers.authorization = "Nostr " + btoa(JSON.stringify(token));
  }
  const resp = await SELF.fetch(url, { method: "PUT", headers, body });
  return { status: resp.status, ...(await resp.json<any>()) };
}

describe("search in the console", () => {
  it("finds notes by words and answers by role", async () => {
    const host = "seek.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", getPublicKey(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", getPublicKey(member), {});
    const c = await WS.connect(host);
    const fox = ev(owner, 1, "the quick brown fox");
    expect((await c.ok(fox)).ok).toBe(true);
    expect((await c.ok(ev(owner, 1, "lorem ipsum dolor"))).ok).toBe(true);
    const hits = (await rpc(host, owner, "searchevents", "fox", 50)).result as Event[];
    expect(hits.map((e) => e.id)).toEqual([fox.id]);
    expect((await rpc(host, mod, "searchevents", "ipsum")).result.length).toBe(1);
    expect((await rpc(host, member, "searchevents", "fox")).status).toBe(403);
    // An empty query is the recent list.
    expect((await rpc(host, owner, "searchevents", "", 10)).result.length).toBeGreaterThanOrEqual(2);
  });
});

describe("import a file", () => {
  it("stores what checks out from a JSONL and a JSON array, then forgets the file", async () => {
    const host = "ingest.bind.ws";
    const owner = generateSecretKey();
    const alice = generateSecretKey();
    const banned = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "owner" });
    await rpc(host, owner, "banpubkey", getPublicKey(banned), "spam");
    const a1 = ev(alice, 1, "first", [], now() - 300);
    const a2 = ev(alice, 1, "second", [], now() - 200);
    const b1 = ev(banned, 1, "unwanted", [], now() - 100);
    const forged = { ...ev(alice, 1, "genuine"), content: "tampered" };
    const jsonl = [a1, a2, b1, forged].map((e) => JSON.stringify(e)).join("\n") + "\nnot json at all\n";

    expect((await signedPut(host, "/import", null, jsonl)).status).toBe(401);
    expect((await signedPut(host, "/import", alice, jsonl)).status).toBe(403);
    const r = await signedPut(host, "/import?name=old-relay.jsonl", owner, jsonl);
    expect(r.status).toBe(202);
    expect(r.bytes).toBeGreaterThan(0);
    const stub = env.RELAY.getByName("ingest");
    await runInDurableObject(stub, async (relay: Relay) => expect(relay.mediaBytes()).toBeGreaterThan(0));
    expect((await env.MEDIA.list({ prefix: "ingest/imports/" })).objects.length).toBe(1);

    const jobs = await drive(host, owner);
    const job = jobs.find((j) => j.kind === "import")!;
    expect(job.relays).toEqual(["old-relay.jsonl"]);
    expect(job.last?.error).toBe("");
    expect(job.last?.stored).toBe(2);
    expect(job.last?.skipped).toBe(3);
    expect(job.last?.duplicates).toBe(0);
    expect((await env.MEDIA.list({ prefix: "ingest/imports/" })).objects).toEqual([]);
    await runInDurableObject(stub, async (relay: Relay) => expect(relay.mediaBytes()).toBe(0));
    const c = await WS.connect(host);
    expect((await c.req({ kinds: [1], authors: [getPublicKey(alice)] })).map((e) => e.id).sort()).toEqual([a1.id, a2.id].sort());

    // A JSON array of the same events: all duplicates.
    const again = await signedPut(host, "/import", owner, JSON.stringify([a1, a2]));
    expect(again.status).toBe(202);
    const job2 = (await drive(host, owner)).find((j) => j.kind === "import" && j.id === again.job)!;
    expect(job2.last?.stored).toBe(0);
    expect(job2.last?.duplicates).toBe(2);
    expect((await signedPut(host, "/import", owner, "   ")).status).toBe(400);
  });
});

describe("pins", () => {
  it("a moderator's pin list becomes a signed 39005, and unpinning takes it down", async () => {
    const host = "board.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", getPublicKey(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", getPublicKey(member), {});
    const c = await WS.connect(host);
    const note = ev(owner, 1, "read this first");
    expect((await c.ok(note)).ok).toBe(true);
    const h = ["h", "board"];
    expect((await c.ok(ev(member, 9010, "", [h, ["e", note.id]]))).msg).toMatch(/^restricted/);
    expect((await c.ok(ev(mod, 9010, "", [h, ["e", note.id], ["a", "30023:" + getPublicKey(owner) + ":welcome"]]))).ok).toBe(true);
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    const [pins] = await c.req({ kinds: [39005] });
    expect(pins.pubkey).toBe(info.self);
    expect(pins.tags).toEqual(expect.arrayContaining([["d", "board"], ["e", note.id], ["a", "30023:" + getPublicKey(owner) + ":welcome"]]));
    expect((await rpc(host, mod, "listpins")).result).toEqual([["e", note.id], ["a", "30023:" + getPublicKey(owner) + ":welcome"]]);
    // A client cannot write the record itself.
    expect((await c.ok(ev(owner, 39005, "", [["d", "board"], ["e", note.id]]))).msg).toMatch(/blocked/);
    // The console's methods edit the same list.
    expect((await rpc(host, owner, "unpinevent", "30023:" + getPublicKey(owner) + ":welcome")).result).toEqual([["e", note.id]]);
    expect((await rpc(host, member, "unpinevent", note.id)).status).toBe(403);
    expect((await rpc(host, mod, "unpinevent", note.id)).result).toEqual([]);
    expect(await c.req({ kinds: [39005] })).toEqual([]);
    // The cap.
    const many = Array.from({ length: 21 }, (_, i) => ["e", i.toString(16).padStart(64, "0")]);
    expect((await c.ok(ev(mod, 9010, "", [h, ...many]))).msg).toMatch(/at most 20/);
  });
});

describe("weekly digest", () => {
  it("writes the owner once a week with what changed, and stays quiet otherwise", async () => {
    const host = "weekly.bind.ws";
    const owner = generateSecretKey();
    const pk = getPublicKey(owner);
    const friend = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { notify: { digest: true } });
    const stub = env.RELAY.getByName("weekly");
    const wraps = () => runInDurableObject(stub, async (r: Relay) => r.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM events WHERE kind=1059`).one().n);
    // The first tick with the switch on starts the clock and says nothing.
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect(await wraps()).toBe(0);
    await rpc(host, owner, "setmember", getPublicKey(friend), { name: "friend" });
    const c = await WS.connect(host);
    expect((await c.ok(ev(owner, 1, "a week's worth"))).ok).toBe(true);
    await runInDurableObject(stub, async (_r: Relay, state) => state.storage.put("lastDigest", now() - 8 * 86400));
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect(await wraps()).toBe(1);
    const o = await WS.connect(host);
    await o.auth(owner, host);
    const [wrap] = await o.req({ kinds: [1059], "#p": [pk] });
    const rumor = unwrapEvent(wrap, owner);
    expect(rumor.kind).toBe(14);
    expect(rumor.content).toMatch(/People: 1 joined/);
    expect(rumor.content).toMatch(/Stored: 1 events/);
    // A day later there is nothing new to say, and it is not a week yet.
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect(await wraps()).toBe(1);
    // A quiet week still gets one line: push last week's changes out of the window first.
    await runInDurableObject(stub, async (r: Relay, state) => {
      r.sql.exec(`UPDATE members SET joined_at = joined_at - 30 * 86400`);
      r.sql.exec(`UPDATE events SET created_at = created_at - 30 * 86400 WHERE kind = 1`);
      await state.storage.put("lastDigest", now() - 8 * 86400);
    });
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect(await wraps()).toBe(2);
    const two = await o.req({ kinds: [1059], "#p": [pk] });
    const texts = two.map((w) => unwrapEvent(w, owner).content);
    expect(texts.some((t) => /Nothing changed/.test(t))).toBe(true);
  });
});
