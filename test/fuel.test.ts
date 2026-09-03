import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../src/relay.ts";
import { bolt11Msats } from "../src/fuel.ts";

const SERVICE = "ab".repeat(32);
const provider = generateSecretKey();
const providerPk = getPublicKey(provider);
const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) => finalizeEvent({ kind, content, tags, created_at }, sk);

// A fake lightning provider, injected into the relay instance: the LNURL
// document names our provider key, and the callback returns a fixed invoice.
async function mockProvider(name: string) {
  const stub = env.RELAY.getByName(name);
  await runInDurableObject(stub, async (r: Relay) => {
    r.fetcher = async (url: string) => {
      if (url === "https://ln.test/.well-known/lnurlp/fuel") {
        return Response.json({ callback: "https://ln.test/cb", minSendable: 1000, maxSendable: 100_000_000_000, nostrPubkey: providerPk, allowsNostr: true });
      }
      if (url.startsWith("https://ln.test/cb?")) {
        const nostr = new URL(url).searchParams.get("nostr") ?? "";
        return Response.json(JSON.parse(nostr).kind === 9734 ? { pr: "lnbc10u1fakeinvoice" } : { status: "ERROR", reason: "bad request" });
      }
      return new Response("unexpected " + url, { status: 500 });
    };
  });
}

async function claim(host: string, sk: Uint8Array) {
  const url = `http://${host}/`;
  const payload = { method: "claim", params: [] };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const r = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  expect(r.status).toBe(200);
}

async function ws(host: string) {
  const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket" } });
  const sock = resp.webSocket!;
  sock.accept();
  const queue: any[][] = [];
  const waiters: ((m: any[]) => void)[] = [];
  sock.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const recv = () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<any[]>((res) => waiters.push(res)));
  await recv(); // AUTH
  return {
    async ok(e: Event) {
      sock.send(JSON.stringify(["EVENT", e]));
      const m = await recv();
      return { ok: m[2] as boolean, msg: m[3] as string };
    },
  };
}

function zapRequest(payer: Uint8Array, host: string, msats: number) {
  return ev(payer, 9734, "", [["p", SERVICE], ["amount", String(msats)], ["relays", "wss://" + host]]);
}

function receipt(req: Event, bolt11: string, signer = provider, p = SERVICE) {
  return ev(signer, 9735, "", [["p", p], ["P", req.pubkey], ["bolt11", bolt11], ["description", JSON.stringify(req)]]);
}

describe("bolt11 amounts", () => {
  it("reads the human-readable amount", () => {
    expect(bolt11Msats("lnbc10n1abc")).toBe(1000);
    expect(bolt11Msats("lnbc10u1abc")).toBe(1_000_000);
    expect(bolt11Msats("lnbc2500u1abc")).toBe(250_000_000);
    expect(bolt11Msats("lnbc1m1abc")).toBe(100_000_000);
    expect(bolt11Msats("lnbc1abc")).toBe(0);
    expect(bolt11Msats("lnbc20p1abc")).toBe(2);
    expect(bolt11Msats("lnbc25p1abc")).toBe(0); // sub-msat precision is invalid
    expect(bolt11Msats("lntb500n1abc")).toBe(50_000);
    expect(bolt11Msats("nonsense")).toBe(0);
  });
});

describe("fuel", () => {
  it("issues invoices, credits valid receipts once, ignores forgeries, and lifts the out-of-fuel restriction", async () => {
    const host = "fuel-a.bind.ws";
    await mockProvider("fuel-a");
    const owner = generateSecretKey();
    const payer = generateSecretKey();
    await claim(host, owner);

    // Fresh relay: within allowances, fuel status public.
    let status: any = await (await SELF.fetch(`http://${host}/fuel`)).json();
    expect(status.enabled).toBe(true);
    expect(status.outOfFuel).toBe(false);
    expect(status.balanceMsats).toBe(0);

    // Blow past the row-write allowance: writes stop, reads continue.
    const stub = env.RELAY.getByName("fuel-a");
    // 150k over the 250k allowance is 300 sats, which the zap below covers.
    await runInDurableObject(stub, async (r: Relay) => r.fuel.record(now(), { rowsWritten: 400_000 }));
    status = await (await SELF.fetch(`http://${host}/fuel`)).json();
    expect(status.outOfFuel).toBe(true);
    expect(status.chargedMsats).toBeGreaterThan(0);
    const c = await ws(host);
    expect((await c.ok(ev(owner, 1, "no fuel"))).msg).toMatch(/^restricted: .*out of fuel/);
    const info: any = await (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json();
    expect(info.limitation.payment_required).toBe(true);
    expect(info.payments_url).toBe("https://" + host + "/");

    // Invoice: a signed zap request naming the service and this relay.
    const req = zapRequest(payer, host, 1_000_000);
    const inv = await (await SELF.fetch(`http://${host}/fuel/invoice`, { method: "POST", body: JSON.stringify({ zapRequest: req }) })).json<any>();
    expect(inv.invoice).toBe("lnbc10u1fakeinvoice");
    expect(inv.providerPubkey).toBe(providerPk);
    const badReq = zapRequest(payer, "other.bind.ws", 1_000_000);
    expect((await SELF.fetch(`http://${host}/fuel/invoice`, { method: "POST", body: JSON.stringify({ zapRequest: badReq }) })).status).toBe(400);

    // Forgeries: wrong signer, wrong service, wrong relay, amount mismatch.
    expect((await c.ok(receipt(req, "lnbc10u1x", generateSecretKey()))).msg).toMatch(/^restricted/);
    expect((await c.ok(receipt(req, "lnbc10u1x", provider, "cd".repeat(32)))).msg).toMatch(/^restricted/);
    expect((await c.ok(receipt(badReq, "lnbc10u1x"))).msg).toMatch(/^restricted/);
    expect((await c.ok(receipt(req, "lnbc20u1x"))).msg).toMatch(/^restricted/);

    // The real receipt, published by the provider, is accepted despite the
    // restriction and credited exactly once.
    const good = receipt(req, "lnbc10u1realinvoice");
    let r = await c.ok(good);
    expect(r.ok).toBe(true);
    expect(r.msg).toBe("fuel: credited 1000 sats");
    r = await c.ok(good);
    expect(r.msg).toMatch(/^duplicate:/);
    status = await (await SELF.fetch(`http://${host}/fuel`)).json();
    expect(status.creditedMsats).toBe(1_000_000);
    expect(status.credits[0].payer).toBe(getPublicKey(payer));
    expect(status.outOfFuel).toBe(false);
    expect((await c.ok(ev(owner, 1, "fueled"))).ok).toBe(true);

    // Time awake beyond the allowance burns the balance down; traffic never does.
    await runInDurableObject(stub, async (r: Relay) => r.fuel.record(now(), { bytesOut: 50 * 1024 * 1024 * 1024 }));
    status = await (await SELF.fetch(`http://${host}/fuel`)).json();
    const afterTraffic = status.balanceMsats;
    await runInDurableObject(stub, async (r: Relay) => r.fuel.record(now(), { activeMs: 150 * 3600_000 }));
    status = await (await SELF.fetch(`http://${host}/fuel`)).json();
    expect(status.balanceMsats).toBeLessThan(afterTraffic);
    // The relay's own rows from this test add a few msats on top.
    const expected = 0.15 * status.rates.satsPerMillionRows * 1000 + 50 * status.rates.satsPerActiveHour * 1000; // 150k rows over, 50 hours over
    expect(status.chargedMsats).toBeGreaterThanOrEqual(expected);
    expect(status.chargedMsats).toBeLessThan(expected + 5000);
  });

  it("accepts provider receipts even on owner-only relays, and charges storage daily", async () => {
    const host = "fuel-b.bind.ws";
    await mockProvider("fuel-b");
    const owner = generateSecretKey();
    await claim(host, owner);
    const url = `http://${host}/`;
    const payload = { method: "setpolicy", params: [{ writes: "owner" }] };
    const token = await getToken(url, "POST", (e) => finalizeEvent(e, owner), true, payload);
    await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
    const c = await ws(host);
    expect((await c.ok(ev(generateSecretKey(), 1, "stranger"))).msg).toMatch(/^restricted:/);
    const req = zapRequest(generateSecretKey(), host, 21_000);
    expect((await c.ok(receipt(req, "lnbc210n1x"))).msg).toBe("fuel: credited 21 sats");

    const stub = env.RELAY.getByName("fuel-b");
    await runInDurableObject(stub, async (r: Relay) => {
      const t = now();
      r.fuel.cfg.freeEventsMB = 0; // everything is over the allowance now
      r.fuel.cfg.freeMediaMB = 0;
      const GB = 1024 * 1024 * 1024;
      r.fuel.chargeStorage(t, GB, 2 * GB); // first tick: one day of 1 GB events and 2 GB media
      const s1 = r.fuel.status(t, GB, 2 * GB);
      expect(s1.chargedMsats).toBe(Math.round(((400 + 2 * 30) * 1000) / 30));
      r.fuel.chargeStorage(t, GB, 2 * GB); // same day: no double charge
      expect(r.fuel.status(t, GB, 2 * GB).chargedMsats).toBe(s1.chargedMsats);
    });
  });

  it("meters traffic, rows and time awake through the websocket path", async () => {
    const host = "fuel-c.bind.ws";
    const owner = generateSecretKey();
    await claim(host, owner);
    const c = await ws(host);
    for (let i = 0; i < 5; i++) await c.ok(ev(owner, 1, "metered " + i));
    const stub = env.RELAY.getByName("fuel-c");
    await runInDurableObject(stub, async (r: Relay) => {
      const s = r.fuelStatus();
      expect(s.bytesIn).toBeGreaterThan(1000);
      expect(s.bytesOut).toBeGreaterThan(100);
      expect(s.rowsWritten).toBeGreaterThanOrEqual(5);
      expect(s.activeMs).toBeGreaterThanOrEqual(10_000);
      expect(s.eventBytes).toBeGreaterThan(0);
    });
  });
});
