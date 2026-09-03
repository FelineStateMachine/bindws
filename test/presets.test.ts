// Presets: Haven's four relays as one-click rule bundles, and the owner's
// own lists landing whatever the kind rules say.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { PRESETS } from "../src/presets.ts";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = []) => finalizeEvent({ kind, content, tags, created_at: now() }, sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

async function post(host: string, sk: Uint8Array, path: string, body: unknown) {
  const url = `http://${host}${path}`;
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, body as Record<string, unknown>);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify(body) });
  return { status: resp.status, body: await resp.json<any>() };
}

describe("presets", () => {
  it("each preset sets writes, reads, directory, kind rules and retention as its bundle says", async () => {
    const host = "presets.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const list = (await rpc(host, owner, "listpresets")).result;
    expect(list.map((p: any) => p.name)).toEqual(["default", "outbox", "inbox", "private", "chat"]);
    for (const p of list) expect(p.about.length).toBeGreaterThan(10);
    for (const preset of PRESETS) {
      const r = await rpc(host, owner, "applypreset", preset.name);
      expect(r.status, preset.name).toBe(200);
      expect(r.result.writes).toBe(preset.writes);
      expect(r.result.reads).toBe(preset.reads);
      expect(r.result.directoryPublic).toBe(preset.directoryPublic);
      expect((await rpc(host, owner, "listallowedkinds")).result).toEqual([...preset.allow].sort((a, b) => a - b));
      expect((await rpc(host, owner, "listblockedkinds")).result).toEqual([...preset.block].sort((a, b) => a - b));
      expect((await rpc(host, owner, "listretention")).result).toEqual(preset.retention);
    }
    // Back to default leaves no rules behind.
    await rpc(host, owner, "applypreset", "chat");
    const d = await rpc(host, owner, "applypreset", "default");
    expect(d.result.writes).toBe("open");
    expect((await rpc(host, owner, "listallowedkinds")).result).toEqual([]);
    expect((await rpc(host, owner, "listretention")).result).toEqual([]);
    expect((await rpc(host, owner, "applypreset", "haven")).status).toBe(400);
  });

  it("needs the rules action: a moderator may list presets but not apply one", async () => {
    const host = "presets-mod.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", getPublicKey(mod), { role: "moderator" });
    expect((await rpc(host, mod, "listpresets")).status).toBe(200);
    const denied = await rpc(host, mod, "applypreset", "outbox");
    expect(denied.status).toBe(403);
    expect((await rpc(host, owner, "getpolicy")).result.writes).toBe("open");
  });

  it("the owner's own lists land under an allow list that excludes them; a stranger's do not", async () => {
    const host = "presets-lists.bind.ws";
    const owner = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "applypreset", "inbox");
    const mine = ev(owner, 10002, "", [["r", "wss://" + host]]);
    let r = await post(host, owner, "/events", mine);
    expect(r.body.accepted, r.body.message).toBe(true);
    const theirs = ev(stranger, 10002, "", [["r", "wss://" + host]]);
    r = await post(host, stranger, "/events", theirs);
    expect(r.body.accepted).toBe(false);
    expect(r.body.message).toMatch(/does not accept kind 10002/);
    // A stranger's note is what the inbox is for.
    r = await post(host, stranger, "/events", ev(stranger, 1, "hello", [["p", getPublicKey(owner)]]));
    expect(r.body.accepted).toBe(true);
    const q = await post(host, owner, "/query", [{ kinds: [10002], authors: [getPublicKey(owner)] }]);
    expect(q.body.map((e: Event) => e.id)).toEqual([mine.id]);
  });
});
