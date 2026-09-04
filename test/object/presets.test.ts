// Presets: Haven's four relays as one-click rule bundles, and the owner's
// own lists landing whatever the kind rules say.
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { PRESETS } from "../../src/presets.ts";
import { ev, rpc, post } from "../helpers/relay.ts";

describe("presets", () => {
  it("each preset sets writes, reads, directory, kind rules and retention as its bundle says", async () => {
    const host = "presets.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const list = (await rpc(host, owner, "listpresets")).result;
    expect(list.map((p: any) => p.name)).toEqual(["default", "outbox", "inbox", "private", "chat", "media", "search", "articles", "dm"]);
    for (const p of list) expect(p.about.length).toBeGreaterThan(10);
    expect(list.find((p: any) => p.name === "search").source).toBe("required");
    expect(list.find((p: any) => p.name === "articles").source).toBe("optional");
    expect(list.find((p: any) => p.name === "media").source).toBeUndefined();
    for (const preset of PRESETS) {
      const r = await rpc(host, owner, "applypreset", preset.name, preset.source === "required" ? { source: "wss://elsewhere.bind.ws" } : undefined);
      expect(r.status, preset.name + " " + JSON.stringify(r)).toBe(200);
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

  it("a replica preset needs a source and keeps one standing pull of its kinds", async () => {
    const host = "presets-replica.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    let r = await rpc(host, owner, "applypreset", "search");
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/needs a source/);
    r = await rpc(host, owner, "applypreset", "search", { source: "wss://" + host });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/itself/);
    r = await rpc(host, owner, "applypreset", "media", { source: "wss://elsewhere.bind.ws" });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/does not mirror/);
    r = await rpc(host, owner, "applypreset", "search", { source: "wss://elsewhere.bind.ws" });
    expect(r.status, JSON.stringify(r)).toBe(200);
    expect(r.result.job.kind).toBe("pull");
    expect(r.result.job.label).toBe("replica");
    expect(r.result.job.every).toBe(6);
    expect(r.result.job.relays).toEqual(["wss://elsewhere.bind.ws"]);
    expect(r.result.job.filter.kinds).toEqual([0, 1, 11, 1111, 9802, 30023, 30818]);
    expect((await rpc(host, owner, "listallowedkinds")).result).toEqual([0, 1, 11, 1111, 9802, 30023, 30818]);
    // Applying again replaces the standing job rather than adding one.
    r = await rpc(host, owner, "applypreset", "articles", { source: "wss://other.bind.ws" });
    expect(r.status).toBe(200);
    expect(r.result.job.every).toBe(24);
    const jobs = (await rpc(host, owner, "listjobs")).result.filter((j: any) => j.label === "replica");
    expect(jobs.length).toBe(1);
    expect(jobs[0].filter.kinds).toEqual([0, 30023]);
    // Articles without a source is a plain rule bundle; the replica job goes away.
    r = await rpc(host, owner, "applypreset", "articles");
    expect(r.status).toBe(200);
    expect(r.result.job).toBeNull();
    expect((await rpc(host, owner, "listjobs")).result.filter((j: any) => j.label === "replica")).toEqual([]);
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
