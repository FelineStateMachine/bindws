// Temporary leases: a memorable name anyone can use for a while, a claim
// that converts it in place, an expiry that wipes it, and a pull that
// copies one relay into another.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../../src/relay.ts";
import { ADJECTIVES, ANIMALS } from "../../src/names.ts";
import { now, ev, rpc, info } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";
import { upload } from "../helpers/media.ts";

const APEX = "http://bind.ws";

// Each caller gets its own address so the per-address limit is tested on its own.
let callers = 0;
async function lease(sk: Uint8Array | null = null, ip = "10.0.0." + ++callers) {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (sk) headers.authorization = await getToken(APEX + "/lease", "POST", (e) => finalizeEvent(e, sk), true);
  const resp = await SELF.fetch(APEX + "/lease", { method: "POST", headers });
  return { status: resp.status, ...(await resp.json<any>()) };
}

// pull drives the alarm until the job is done; the runtime may fire it too.
async function pull(host: string, owner: Uint8Array, from: string) {
  const started = await rpc(host, owner, "pullfrom", from);
  expect(started.status, JSON.stringify(started)).toBe(200);
  const stub = env.RELAY.getByName(host.split(".")[0]);
  for (let i = 0; i < 40; i++) {
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    const st = (await rpc(host, owner, "pullstatus")).result;
    if (!st.running) return st.last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("pull did not finish");
}

describe("temporary leases", () => {
  it("hands out a memorable name that anyone can write to, and a claim converts it in place", async () => {
    const l = await lease();
    expect(l.status).toBe(201);
    const [adj, animal] = l.name.split("-");
    if (animal) expect(ADJECTIVES.includes(adj) && ANIMALS.includes(animal)).toBe(true);
    else expect(/^[a-z]+\d\d$/.test(l.name) && ANIMALS.includes(l.name.slice(0, -2))).toBe(true);
    expect(l.url).toBe(`wss://${l.name}.bind.ws`);
    expect(l.holder).toBeUndefined();
    expect(l.expires_at).toBeGreaterThan(now() + 13 * 86400);
    const host = `${l.name}.bind.ws`;

    let doc = await info(host);
    expect(doc.lease.expires_at).toBe(l.expires_at);
    expect(doc.lease.claim_url).toBe(`https://${host}/`);
    expect(doc.limitation.restricted_writes).toBe(false);
    expect(doc.pubkey).toBeUndefined();
    expect(doc.description).toMatch(/Temporary relay/);
    expect(doc.retention).toEqual([{ time: 14 * 86400 }]);

    const stranger = generateSecretKey();
    const c = await WS.connect(host);
    expect((await c.ok(ev(stranger, 1, "hello from a lease"))).ok).toBe(true);
    const denied = await rpc(host, stranger, "stats");
    expect(denied.status).toBe(403);
    expect(denied.error).toMatch(/temporary relay/);

    const owner = generateSecretKey();
    const claimed = await rpc(host, owner, "claim");
    expect(claimed.result).toEqual({ owner: getPublicKey(owner), claimed: true, converted: true });
    doc = await info(host);
    expect(doc.lease).toBeUndefined();
    expect(doc.pubkey).toBe(getPublicKey(owner));
    expect(doc.description).toBe("");
    expect(doc.self).toBeDefined();
    // The events stay; the lease's keep-for rule stays until the owner resets.
    expect((await c.req({ kinds: [1] })).length).toBe(1);
    expect((await rpc(host, owner, "listretention")).result).toEqual([{ kind: null, days: 14 }]);
    const reset = await rpc(host, owner, "resetrules");
    expect(reset.result.writes).toBe("open");
    expect((await rpc(host, owner, "listretention")).result).toEqual([]);
    expect((await rpc(host, owner, "claim")).result.converted).toBeUndefined();
  });

  it("a signed lease is reserved for its key", async () => {
    const holder = generateSecretKey();
    const l = await lease(holder);
    expect(l.status).toBe(201);
    expect(l.holder).toBe(getPublicKey(holder));
    const host = `${l.name}.bind.ws`;
    expect((await info(host)).lease.holder).toBe(getPublicKey(holder));
    const other = generateSecretKey();
    const denied = await rpc(host, other, "claim");
    expect(denied.status).toBe(403);
    expect(denied.error).toMatch(/reserved/);
    expect((await rpc(host, holder, "claim")).result.claimed).toBe(true);
  });

  it("caps leases per address", async () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < 5; i++) expect((await lease(null, ip)).status).toBe(201);
    const sixth = await lease(null, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.error).toMatch(/^rate-limited/);
    expect((await lease(null, "203.0.113.8")).status).toBe(201);
  });

  it("refuses a bad signature on the lease request", async () => {
    const sk = generateSecretKey();
    const token = await getToken("http://elsewhere.bind.ws/lease", "POST", (e) => finalizeEvent(e, sk), true);
    const resp = await SELF.fetch(APEX + "/lease", { method: "POST", headers: { authorization: token, "cf-connecting-ip": "10.1.1.1" } });
    expect(resp.status).toBe(401);
  });

  it("expires: the alarm wipes everything and frees the name", async () => {
    const l = await lease();
    const host = `${l.name}.bind.ws`;
    const sk = generateSecretKey();
    const c = await WS.connect(host);
    expect((await c.ok(ev(sk, 1, "soon gone"))).ok).toBe(true);
    expect((await upload(host, sk, "a file on a lease")).status).toBe(200);
    const stub = env.RELAY.getByName(l.name);
    await runInDurableObject(stub, async (r: Relay, state) => {
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(l.expires_at * 1000);
      r.settings.update({ lease: { until: now() - 1, holder: "" } });
      await r.alarm();
    });
    const doc = await info(host);
    expect(doc.lease).toBeUndefined();
    expect(doc.pubkey).toBeUndefined();
    expect(doc.limitation.restricted_writes).toBe(true);
    expect((await env.MEDIA.list({ prefix: `${l.name}/` })).objects).toEqual([]);
    const fresh = await WS.connect(host);
    expect(await fresh.req({ kinds: [1] })).toEqual([]);
    expect((await fresh.ok(ev(sk, 1, "again"))).msg).toMatch(/unclaimed/);
    // The freed name can be leased again.
    await runInDurableObject(stub, async (r: Relay) => expect(await r.lease(l.name, host, now() + 60, "")).toBe(""));
    expect((await info(host)).lease).toBeDefined();
  });

  it("an expired lease refuses writes even before the alarm runs", async () => {
    const l = await lease();
    const host = `${l.name}.bind.ws`;
    await runInDurableObject(env.RELAY.getByName(l.name), async (r: Relay) => r.settings.update({ lease: { until: now() - 1, holder: "" } }));
    const c = await WS.connect(host);
    expect((await c.ok(ev(generateSecretKey(), 1, "too late"))).msg).toMatch(/expired/);
    expect((await rpc(host, generateSecretKey(), "claim")).status).toBe(403);
  });
});

describe("pull from another relay", () => {
  it("copies events and files from a lease into a claimed relay, and again only what is new", async () => {
    const l = await lease();
    const src = `${l.name}.bind.ws`;
    const a = generateSecretKey();
    const b = generateSecretKey();
    const c = await WS.connect(src);
    const e1 = ev(a, 1, "one", [], now() - 30);
    const e2 = ev(b, 1, "two", [], now() - 20);
    const e3 = ev(a, 7, "+", [["e", e1.id]], now() - 10);
    for (const e of [e1, e2, e3]) expect((await c.ok(e)).ok).toBe(true);
    const { sha } = await upload(src, a, "a picture, allegedly");

    const owner = generateSecretKey();
    const host = "fresh.bind.ws";
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "owner" });
    expect((await rpc(host, owner, "pullfrom", "https://" + src)).status).toBe(400);
    expect((await rpc(host, owner, "pullfrom", "wss://" + host)).error).toMatch(/itself/);
    expect((await rpc(host, generateSecretKey(), "pullfrom", "wss://" + src)).status).toBe(403);

    let last = await pull(host, owner, "wss://" + src);
    expect(last.error).toBe("");
    expect(last.stored).toBe(3);
    expect(last.blobs).toBe(1);
    const mine = await WS.connect(host);
    expect((await mine.req({ kinds: [1, 7] })).map((e) => e.id).sort()).toEqual([e1.id, e2.id, e3.id].sort());
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(200);
    expect((await rpc(host, owner, "listblobs")).result.map((x: any) => x.sha256)).toEqual([sha]);

    // A second pull after one more event on the source fetches only that one.
    const e4 = ev(b, 1, "four");
    expect((await c.ok(e4)).ok).toBe(true);
    last = await pull(host, owner, "wss://" + src);
    expect(last.stored).toBe(1);
    expect(last.blobs).toBe(0);
    expect((await mine.req({ ids: [e4.id] })).length).toBe(1);
    // Kind rules on the puller apply; the write policy does not.
    await rpc(host, owner, "disallowkind", 7);
    const e5 = ev(a, 7, "-", [["e", e2.id]]);
    expect((await c.ok(e5)).ok).toBe(true);
    last = await pull(host, owner, "wss://" + src);
    expect(last.stored).toBe(0);
    expect(last.skipped).toBe(1);
  });

  it("falls back from sync and records a source that also refuses ordinary queries", async () => {
    const owner = generateSecretKey();
    const closedHost = "closed.bind.ws";
    await rpc(closedHost, owner, "claim");
    await rpc(closedHost, owner, "setpolicy", { reads: "members" });
    const host = "puller.bind.ws";
    await rpc(host, owner, "claim");
    const last = await pull(host, owner, "wss://" + closedHost);
    expect(last.error).toMatch(/import source.*incomplete/);
    expect(last.rounds).toBe(2);
    const jobs = (await rpc(host, owner, "listjobs")).result;
    expect(jobs[0].last.sources[0]).toMatchObject({ mode: "query", status: "refused", error: expect.stringContaining("auth-required") });
  });
});
