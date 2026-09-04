// Dumps to R2, and the signed door that serves them.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { writeDump } from "../../src/dumps.ts";
import { now, ev, rpc, get } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

describe("dumps", () => {
  it("writes a JSONL of every event to R2, lists it, serves it to a signature, rotates and counts as media", async () => {
    const host = "dumpy.bind.ws";
    const owner = generateSecretKey();
    const writer = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    for (let i = 0; i < 3; i++) expect((await c.ok(ev(writer, 1, "note " + i))).ok).toBe(true);
    expect((await rpc(host, owner, "setpolicy", { dumps: "daily", dumpsKeep: 2 })).result.dumps).toBe("daily");

    const d = (await rpc(host, owner, "dumpnow")).result;
    expect(d.name).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const total = (await rpc(host, owner, "stats")).result.events;
    expect(d.events).toBe(total);
    expect(total).toBeGreaterThanOrEqual(3);
    const obj = await env.MEDIA.get(`dumpy/dumps/${d.name}`);
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(d.events);
    for (const l of lines) expect(JSON.parse(l).id).toMatch(/^[0-9a-f]{64}$/);
    expect(d.bytes).toBe(text.length);

    const list = (await rpc(host, owner, "listdumps")).result;
    expect(list.map((x: any) => x.name)).toEqual([d.name]);
    expect(list[0].url).toBe("/dumps/" + d.name);

    // Download needs a signature from someone with the storage action.
    const signed = await get(host, "/dumps/" + d.name, owner);
    expect(signed.status).toBe(200);
    expect(signed.headers.get("content-disposition")).toContain(d.name);
    expect(await signed.text()).toBe(text);
    expect((await get(host, "/dumps/" + d.name, null)).status).toBe(401);
    expect((await get(host, "/dumps/" + d.name, writer)).status).toBe(403);
    expect((await get(host, "/dumps/nope.jsonl", owner)).status).toBe(400);
    expect((await get(host, "/dumps/1999-01-01.jsonl", owner)).status).toBe(404);

    const stub = env.RELAY.getByName("dumpy");
    await runInDurableObject(stub, async (r: Relay) => {
      expect(r.mediaBytes()).toBe(d.bytes);
      // Two older dumps and a keep of two: the oldest goes.
      await writeDump(r, now() - 2 * 86400);
      await writeDump(r, now() - 86400);
    });
    const after = (await rpc(host, owner, "listdumps")).result.map((x: any) => x.name);
    expect(after.length).toBe(2);
    expect(after[0]).toBe(d.name);
    expect((await env.MEDIA.list({ prefix: "dumpy/dumps/" })).objects.length).toBe(2);
    expect((await rpc(host, owner, "storagestats")).result.dumps).toBe(2);

    expect((await rpc(host, owner, "deletedump", after[1])).result).toBe(true);
    expect((await env.MEDIA.list({ prefix: "dumpy/dumps/" })).objects.length).toBe(1);
    expect((await rpc(host, writer, "listdumps")).status).toBe(403);
  });

  it("the alarm writes a scheduled dump once a day, not twice", async () => {
    const host = "dumpz.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const stub = env.RELAY.getByName("dumpz");
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(0);
    await rpc(host, owner, "setpolicy", { dumps: "daily" });
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(1);
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    expect((await rpc(host, owner, "listdumps")).result.length).toBe(1);
  });
});
