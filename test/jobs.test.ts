// Jobs: owner backfill from the relays in a kind 10002, rebroadcast to
// other relays with a cursor, standing jobs on an interval, caps and
// removal. Relays on this host are dialled object to object.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../src/relay.ts";
import type { Job } from "../src/jobs.ts";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) => finalizeEvent({ kind, content, tags, created_at }, sk);
const pk = (sk: Uint8Array) => getPublicKey(sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

class WS {
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
  }
  static async connect(host: string) {
    const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket" } });
    const c = new WS(resp.webSocket!);
    await c.expect("AUTH");
    return c;
  }
  send(...m: unknown[]) {
    this.ws.send(JSON.stringify(m));
  }
  recv(): Promise<any[]> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((res) => this.waiters.push(res));
  }
  async expect(type: string) {
    const m = await this.recv();
    expect(m[0], JSON.stringify(m)).toBe(type);
    return m;
  }
  async ok(e: Event) {
    this.send("EVENT", e);
    const m = await this.expect("OK");
    return { ok: m[2] as boolean, msg: m[3] as string };
  }
  private n = 0;
  async req(filter: unknown) {
    const id = "q" + ++this.n;
    this.send("REQ", id, filter);
    const events: Event[] = [];
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EVENT" && m[1] === id) events.push(m[2]);
      else if (m[0] === "EOSE" && m[1] === id) {
        this.send("CLOSE", id);
        return events;
      } else if (m[0] === "CLOSED" && m[1] === id) throw new Error(m[2]);
    }
  }
}

// relay claims a name and posts the given events to it.
async function relay(host: string, owner: Uint8Array, events: Event[] = []) {
  await rpc(host, owner, "claim");
  const c = await WS.connect(host);
  for (const e of events) expect((await c.ok(e)).ok, e.id).toBe(true);
  return c;
}

const due = (j: Job) => j.running || (j.nextRun > 0 && j.nextRun <= now());

// drive fires the alarm until no job is running or due, and returns the list.
async function drive(host: string, owner: Uint8Array): Promise<Job[]> {
  const stub = env.RELAY.getByName(host.split(".")[0]);
  for (let i = 0; i < 80; i++) {
    await runInDurableObject(stub, async (r: Relay) => r.alarm());
    const jobs = (await rpc(host, owner, "listjobs")).result as Job[];
    if (!jobs.some(due)) return jobs;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("jobs did not settle");
}

describe("owner backfill", () => {
  it("fetches the owner's own history from the relays in their kind 10002, and nothing else", async () => {
    const me = generateSecretKey();
    const stranger = generateSecretKey();
    const a = "hist-a.bind.ws";
    const b = "hist-b.bind.ws";
    const mine = [ev(me, 1, "on a", [], now() - 30), ev(me, 1, "also on a", [], now() - 20), ev(me, 30023, "an article", [["d", "x"]], now() - 10)];
    await relay(a, generateSecretKey(), [mine[0], mine[1], ev(stranger, 1, "not mine")]);
    await relay(b, generateSecretKey(), [mine[2], ev(stranger, 1, "also not mine")]);

    const host = "hist.bind.ws";
    const c = await relay(host, me);
    expect((await rpc(host, me, "backfill")).status).toBe(400);
    expect((await c.ok(ev(me, 10002, "", [["r", "wss://" + a, "read"], ["r", "wss://" + b, "write"], ["r", "wss://" + host]]))).ok).toBe(true);

    const started = await rpc(host, me, "backfill");
    expect(started.status).toBe(200);
    expect(started.result.label).toBe("backfill");
    expect(started.result.relays).toEqual(["wss://" + a, "wss://" + b]);
    expect(started.result.filter).toEqual({ authors: [pk(me)] });
    const jobs = await drive(host, me);
    const job = jobs.find((j) => j.id === started.result.id)!;
    expect(job.last?.error).toBe("");
    expect(job.last?.stored).toBe(3);
    expect(job.nextRun).toBe(0);
    const got = await c.req({ kinds: [1, 30023] });
    expect(got.map((e) => e.id).sort()).toEqual(mine.map((e) => e.id).sort());
    expect(got.every((e) => e.pubkey === pk(me))).toBe(true);
    // A member without the jobs action cannot start one; a bad list is refused.
    expect((await rpc(host, stranger, "backfill")).status).toBe(403);
    expect((await rpc(host, me, "backfill", ["https://" + a])).status).toBe(400);
  });
});

describe("rebroadcast", () => {
  it("forwards matching events to every target, counts duplicates as sent, and moves the cursor", async () => {
    const owner = generateSecretKey();
    const src = "blast.bind.ws";
    const e1 = ev(owner, 1, "one", [], now() - 30);
    const e2 = ev(owner, 1, "two", [], now() - 20);
    const e7 = ev(owner, 7, "+", [["e", e1.id]], now() - 10);
    const c = await relay(src, owner, [e1, e2, e7]);
    const t1 = "target-a.bind.ws";
    const t2 = "target-b.bind.ws";
    const c1 = await relay(t1, generateSecretKey(), [e1]); // already there: a duplicate counts as sent
    const c2 = await relay(t2, generateSecretKey());

    const bad = await rpc(src, owner, "addjob", { kind: "push", relays: ["wss://" + src], filter: { kinds: [1] } });
    expect(bad.error).toMatch(/itself/);
    const started = await rpc(src, owner, "addjob", { kind: "push", relays: ["wss://" + t1, "wss://" + t2], filter: { kinds: [1] } });
    expect(started.status, JSON.stringify(started)).toBe(200);
    let jobs = await drive(src, owner);
    let job = jobs.find((j) => j.id === started.result.id)!;
    expect(job.last?.error).toBe("");
    expect(job.last?.sent).toBe(4);
    expect(job.last?.refused).toBe(0);
    expect(job.cursor).toBeGreaterThan(0);
    expect((await c1.req({ kinds: [1, 7] })).map((e) => e.id).sort()).toEqual([e1.id, e2.id].sort());
    expect((await c2.req({ kinds: [1, 7] })).map((e) => e.id).sort()).toEqual([e1.id, e2.id].sort());

    // Nothing on the source is stored by a push; a second run sends only what is new.
    const e3 = ev(owner, 1, "three");
    expect((await c.ok(e3)).ok).toBe(true);
    expect((await rpc(src, owner, "runjob", started.result.id)).result).toBe(true);
    jobs = await drive(src, owner);
    job = jobs.find((j) => j.id === started.result.id)!;
    expect(job.last?.sent).toBe(2);
    expect((await c2.req({ ids: [e3.id] })).length).toBe(1);

    // A target that refuses counts refusals and does not stop the others.
    const closed = "target-c.bind.ws";
    const cOwner = generateSecretKey();
    await relay(closed, cOwner);
    await rpc(closed, cOwner, "setpolicy", { writes: "owner" });
    const again = await rpc(src, owner, "addjob", { kind: "push", relays: ["wss://" + closed], filter: { kinds: [1] } });
    jobs = await drive(src, owner);
    job = jobs.find((j) => j.id === again.result.id)!;
    expect(job.last?.refused).toBe(3);
    expect(job.last?.sent).toBe(0);
  });

  it("never rebroadcasts private kinds from a members-only relay", async () => {
    const owner = generateSecretKey();
    const src = "quiet.bind.ws";
    const friend = generateSecretKey();
    const dm = ev(owner, 4, "secret", [["p", pk(friend)]]);
    const note = ev(owner, 1, "public");
    await relay(src, owner);
    await rpc(src, owner, "setpolicy", { reads: "members" });
    const target = "loud.bind.ws";
    const ct = await relay(target, generateSecretKey());
    const stub = env.RELAY.getByName("quiet");
    await runInDurableObject(stub, async (r: Relay) => {
      expect(r.accept(dm, null).stored).toBe(true);
      expect(r.accept(note, null).stored).toBe(true);
    });
    const refused = await rpc(src, owner, "addjob", { kind: "push", relays: ["wss://" + target], filter: { kinds: [4] } });
    expect(refused.error).toMatch(/private kinds/);
    const started = await rpc(src, owner, "addjob", { kind: "push", relays: ["wss://" + target] });
    const jobs = await drive(src, owner);
    const job = jobs.find((j) => j.id === started.result.id)!;
    // The note and the relay's own signed records go; the message does not.
    expect(job.last?.sent).toBeGreaterThanOrEqual(1);
    expect(job.last?.skipped).toBeGreaterThanOrEqual(1);
    expect((await ct.req({ kinds: [1, 4] })).map((e) => e.kind)).toEqual([1]);
  });
});

describe("standing jobs", () => {
  it("runs a recurring pull on its interval, caps standing jobs, and can be removed", async () => {
    const owner = generateSecretKey();
    const src = "upstream.bind.ws";
    const e1 = ev(owner, 1, "first", [], now() - 10);
    const cs = await relay(src, owner, [e1]);
    const host = "mirror.bind.ws";
    const c = await relay(host, owner);

    expect((await rpc(host, owner, "addjob", { kind: "pull", relays: ["wss://" + src], every: 2 })).status).toBe(400);
    const started = await rpc(host, owner, "addjob", { kind: "pull", relays: ["wss://" + src], every: 1 });
    expect(started.status).toBe(200);
    let jobs = await drive(host, owner);
    let job = jobs.find((j) => j.id === started.result.id)!;
    // The note plus the upstream relay's own signed records.
    expect(job.last?.stored).toBeGreaterThanOrEqual(1);
    expect(job.nextRun).toBeGreaterThan(now() + 3500);
    expect(job.nextRun).toBeLessThanOrEqual(now() + 3600);
    expect((await c.req({ ids: [e1.id] })).length).toBe(1);
    const firstFinish = job.last!.finishedAt;
    // The daily alarm is not scheduled past the next run.
    const stub = env.RELAY.getByName("mirror");
    await runInDurableObject(stub, async (_r: Relay, state) => {
      const at = await state.storage.getAlarm();
      expect(at).not.toBeNull();
      expect(at!).toBeLessThanOrEqual(job.nextRun * 1000 + 500);
    });

    // Time passes: the interval elapses and the mirror picks up what is new.
    const e2 = ev(owner, 1, "second");
    expect((await cs.ok(e2)).ok).toBe(true);
    await runInDurableObject(stub, async (_r: Relay, state) => {
      const list = (await state.storage.get<Job[]>("jobs"))!;
      list.find((j) => j.id === started.result.id)!.nextRun = now() - 1;
      await state.storage.put("jobs", list);
    });
    await new Promise((r) => setTimeout(r, 1100));
    jobs = await drive(host, owner);
    job = jobs.find((j) => j.id === started.result.id)!;
    expect(job.last!.finishedAt).toBeGreaterThan(firstFinish);
    expect(job.last?.stored).toBeGreaterThanOrEqual(1);
    expect(job.last?.stored).toBeLessThan(5);
    expect((await c.req({ ids: [e2.id] })).length).toBe(1);

    // At most five standing jobs; a once job still fits; removal frees the slot.
    for (let i = 0; i < 4; i++) expect((await rpc(host, owner, "addjob", { kind: "pull", relays: [`wss://other-${i}.bind.ws`], every: 24 })).status).toBe(200);
    const sixth = await rpc(host, owner, "addjob", { kind: "pull", relays: ["wss://other-9.bind.ws"], every: 24 });
    expect(sixth.status).toBe(409);
    expect(sixth.error).toMatch(/standing/);
    expect((await rpc(host, owner, "removejob", started.result.id)).result).toBe(true);
    expect((await rpc(host, owner, "removejob", started.result.id)).result).toBe(false);
    expect(((await rpc(host, owner, "listjobs")).result as Job[]).some((j) => j.id === started.result.id)).toBe(false);
    expect((await rpc(host, owner, "addjob", { kind: "pull", relays: ["wss://other-9.bind.ws"], every: 24 })).status).toBe(200);
    // The old one-pull view still answers.
    const st = (await rpc(host, owner, "pullstatus")).result;
    expect(st.last === null || typeof st.last.stored === "number").toBe(true);
  });
});
