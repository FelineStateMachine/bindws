// NIP-77 across a wake: the filter of an open sync rides on the socket's
// attachment, so a session whose Negentropy object left with the object's
// memory carries on from the store instead of ending with closed:.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, type Event } from "nostr-tools/pure";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Relay } from "../../src/relay.ts";
import { Negentropy, bytesToHex, hexToBytes, type SyncItem } from "../../src/negentropy.ts";
import { now, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

const note = (sk: Uint8Array, content: string, created_at: number) => finalizeEvent({ kind: 1, content, tags: [], created_at }, sk);
const item = (e: Event): SyncItem => ({ timestamp: e.created_at, id: hexToBytes(e.id) });

// wake empties the relay's in-memory sync sessions, which is what a
// hibernation does to them; the sockets and their attachments stay.
const wake = (name: string) => runInDurableObject(env.RELAY.getByName(name), async (r: Relay) => (r as unknown as { syncs: Map<unknown, unknown> }).syncs.clear());
// persisted reads the sync ids on the first socket's attachment.
const persisted = (name: string) => runInDurableObject(env.RELAY.getByName(name), async (r: Relay) => Object.keys(((r as unknown as { ctx: DurableObjectState }).ctx.getWebSockets()[0].deserializeAttachment() as { syncs?: Record<string, unknown> }).syncs ?? {}));

// seed claims a relay and stores three notes; the client holds two of them
// and one the relay never saw.
async function seed(name: string) {
  const host = name + ".bind.ws";
  const owner = generateSecretKey();
  const author = generateSecretKey();
  await rpc(host, owner, "claim");
  const c = await WS.connect(host);
  const t = now() - 100;
  const notes = [note(author, "one", t), note(author, "two", t + 1), note(author, "three", t + 2)];
  for (const n of notes) expect((await c.ok(n)).ok).toBe(true);
  const stray = note(author, "stray", t + 3);
  const mine = [notes[0], notes[1], stray];
  return { host, owner, c, notes, stray, mine };
}

describe("NIP-77 across a wake", () => {
  it("carries a sync on from the store after the session left memory", async () => {
    const { c, notes, stray, mine } = await seed("syncwake");
    const neg = new Negentropy(mine.map(item), sha256);
    c.send("NEG-OPEN", "s1", { kinds: [1] }, bytesToHex(neg.initiate()));
    const first = await c.expect("NEG-MSG");
    expect(await persisted("syncwake")).toEqual(["s1"]);

    await wake("syncwake");
    // The same opening message again, now against a rebuilt session, draws
    // the same answer, and reconciling it names exactly what each side lacks.
    const again = new Negentropy(mine.map(item), sha256);
    c.send("NEG-MSG", "s1", bytesToHex(again.initiate()));
    const second = await c.expect("NEG-MSG");
    expect(second[2]).toBe(first[2]);
    const r = again.reconcile(hexToBytes(second[2]));
    expect(r.reply).toBeNull();
    expect(r.need).toEqual([notes[2].id]);
    expect(r.have).toEqual([stray.id]);

    // NEG-CLOSE takes the filter off the socket; after that a wake ends it.
    c.send("NEG-CLOSE", "s1");
    await new Promise((res) => setTimeout(res, 50));
    expect(await persisted("syncwake")).toEqual([]);
    await wake("syncwake");
    c.send("NEG-MSG", "s1", bytesToHex(again.initiate()));
    const err = await c.expect("NEG-ERR");
    expect(err[2]).toMatch(/^closed: no such sync/);
  });

  it("counts remembered syncs against the cap and drops them with the read rule", async () => {
    const { host, owner, c, mine } = await seed("synccap");
    await rpc(host, owner, "setpolicy", { maxSubs: 1 });
    const neg = new Negentropy(mine.map(item), sha256);
    c.send("NEG-OPEN", "s1", { kinds: [1] }, bytesToHex(neg.initiate()));
    await c.expect("NEG-MSG");
    await wake("synccap");
    c.send("NEG-OPEN", "s2", { kinds: [1] }, bytesToHex(neg.initiate()));
    expect((await c.expect("NEG-ERR"))[2]).toBe("blocked: too many open syncs");

    // Reads tightened to members: the socket has proved nothing, so the
    // remembered sync goes with the subscriptions it never had.
    await rpc(host, owner, "setpolicy", { reads: "members" });
    expect(await persisted("synccap")).toEqual([]);
    c.send("NEG-MSG", "s1", bytesToHex(neg.initiate()));
    expect((await c.expect("NEG-ERR"))[2]).toMatch(/^closed: no such sync/);
  });
});
