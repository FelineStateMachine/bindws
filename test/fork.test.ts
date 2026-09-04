// Fork a name: lease a new name reserved for a key, pull this relay into
// it, hand over the claim. Built from lease and jobs.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import type { Relay } from "../src/relay.ts";
import { ADJECTIVES, ANIMALS } from "../src/names.ts";
import { now, ev, rpc, info, post } from "./helpers/relay.ts";

// settle drives the new object's alarm until its pull has finished.
async function settle(name: string) {
  const stub = env.RELAY.getByName(name);
  for (let i = 0; i < 40; i++) {
    const done = await runInDurableObject(stub, async (r: Relay) => {
      await r.alarm();
      const jobs = await r.jobs();
      return jobs.length > 0 && jobs.every((j) => !j.running && j.nextRun === 0);
    });
    if (done) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the fork did not finish pulling");
}

async function seed(host: string) {
  const owner = generateSecretKey();
  const friend = generateSecretKey();
  const member = generateSecretKey();
  await rpc(host, owner, "claim");
  await rpc(host, owner, "setmember", getPublicKey(member), { name: "bob", note: "a friend" });
  const e1 = ev(owner, 1, "mine", [], now() - 30);
  const e2 = ev(friend, 1, "theirs", [], now() - 20);
  const e3 = ev(owner, 30023, "an article", [["d", "a"]], now() - 10);
  for (const e of [e1, e2, e3]) expect((await post(host, e.pubkey === getPublicKey(owner) ? owner : friend, "/events", e)).body.accepted).toBe(true);
  return { owner, friend, member, e1, e2, e3 };
}

describe("fork a name", () => {
  it("leases a chosen name for the caller, pulls everything and the people, and a claim converts it", async () => {
    const host = "origin.bind.ws";
    const { owner, member, e1, e2, e3 } = await seed(host);
    const r = await rpc(host, owner, "forkrelay", { name: "offshoot", people: true });
    expect(r.status, JSON.stringify(r)).toBe(200);
    expect(r.result.name).toBe("offshoot");
    expect(r.result.url).toBe("wss://offshoot.bind.ws");
    expect(r.result.holder).toBe(getPublicKey(owner));
    expect(r.result.expires_at).toBeGreaterThan(now() + 13 * 86400);
    expect(r.result.handover).toMatch(/offshoot\.bind\.ws/);

    const doc = await info("offshoot.bind.ws");
    expect(doc.lease.holder).toBe(getPublicKey(owner));
    expect(doc.description).toMatch(/^Forked from origin\.bind\.ws/);
    await settle("offshoot");
    const q = await post("offshoot.bind.ws", owner, "/query", [{ kinds: [1, 30023] }]);
    expect(q.body.map((e: Event) => e.id).sort()).toEqual([e1.id, e2.id, e3.id].sort());

    // Reserved: a stranger cannot claim it; the holder can, and the people came along.
    expect((await rpc("offshoot.bind.ws", generateSecretKey(), "claim")).status).toBe(403);
    expect((await rpc("offshoot.bind.ws", owner, "claim")).result.converted).toBe(true);
    const people = (await rpc("offshoot.bind.ws", owner, "listmembers")).result.members.filter((m: any) => m.role !== "owner");
    expect(people.map((m: any) => m.pubkey)).toEqual([getPublicKey(member)]);
    expect((await info("offshoot.bind.ws")).pubkey).toBe(getPublicKey(owner));
  });

  it("picks a memorable name, hands it to another key, and respects the filter", async () => {
    const host = "origin2.bind.ws";
    const { owner, e1, e3, member } = await seed(host);
    const heir = generateSecretKey();
    const r = await rpc(host, owner, "forkrelay", { holder: getPublicKey(heir), filter: { authors: [getPublicKey(owner)] } });
    expect(r.status, JSON.stringify(r)).toBe(200);
    const [adj, animal] = r.result.name.split("-");
    if (animal) expect(ADJECTIVES.includes(adj) && ANIMALS.includes(animal)).toBe(true);
    else expect(ANIMALS.includes(r.result.name.slice(0, -2))).toBe(true);
    expect(r.result.holder).toBe(getPublicKey(heir));
    const h = r.result.name + ".bind.ws";
    await settle(r.result.name);
    const q = await post(h, heir, "/query", [{ kinds: [1, 30023] }]);
    expect(q.body.map((e: Event) => e.id).sort()).toEqual([e1.id, e3.id].sort());
    // No people asked for, none copied.
    expect((await rpc(h, owner, "claim")).status).toBe(403);
    expect((await rpc(h, heir, "claim")).result.claimed).toBe(true);
    const lm = await rpc(h, heir, "listmembers"); expect(lm.status, JSON.stringify(lm)).toBe(200); expect(lm.result.members.map((m: any) => m.pubkey)).not.toContain(getPublicKey(member));
  });

  it("refuses a taken name, a bad name, a second fork within the hour, and anyone but the owner", async () => {
    const host = "origin3.bind.ws";
    const { owner, member } = await seed(host);
    const taken = generateSecretKey();
    await rpc("taken.bind.ws", taken, "claim");
    let r = await rpc(host, owner, "forkrelay", { name: "taken" });
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/taken/);
    r = await rpc(host, owner, "forkrelay", { name: "no way" });
    expect(r.status).toBe(400);
    r = await rpc(host, owner, "forkrelay", { name: "origin3" });
    expect(r.status).toBe(400);
    // Refusals do not spend the hourly fork.
    r = await rpc(host, owner, "forkrelay", { name: "twig" });
    expect(r.status, JSON.stringify(r)).toBe(200);
    r = await rpc(host, owner, "forkrelay", { name: "twig2" });
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/one fork an hour/);
    expect((await info("twig2.bind.ws")).lease).toBeUndefined();
    await rpc(host, owner, "setmember", getPublicKey(member), { role: "moderator" });
    expect((await rpc(host, member, "forkrelay", { name: "twig3" })).status).toBe(403);
  });
});
