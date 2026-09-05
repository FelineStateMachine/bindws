import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { Socket, dial, runPullRound, type PullJob, type PullSocket } from "../../src/pull.ts";
import { runPullSourceRound, type Job } from "../../src/jobs.ts";
import { ev, now, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

async function claimed(host: string, owner: Uint8Array) {
  await rpc(host, owner, "claim");
  return WS.connect(host);
}

async function run(name: string, job: PullJob) {
  return runInDurableObject(env.RELAY.getByName(name), async (relay: Relay) => runPullRound(relay, job));
}

class RefusingSocket implements PullSocket {
  constructor(private query: boolean) {}
  send() { /* scripted refusal */ }
  async recv() { return (this.query ? ["CLOSED", "history", "auth-required: source refused history"] : ["NEG-ERR", "pull", "unsupported: sync is switched off"]) as unknown[]; }
  close() { /* scripted socket */ }
}

class ScriptedSocket implements PullSocket {
  constructor(private messages: unknown[][]) {}
  send() { /* scripted socket */ }
  async recv() { return this.messages.shift() ?? ["EOSE", "history"]; }
  close() { /* scripted socket */ }
}

describe("history pull fallback", () => {
  it("falls back from a refused NIP-77 sync and resumes ordinary queries", async () => {
    const owner = generateSecretKey();
    const source = "pull-query-source.bind.ws";
    const destination = "pull-query-destination.bind.ws";
    const sourceClient = await claimed(source, owner);
    await rpc(source, owner, "setpolicy", { features: { sync: false } });
    const first = ev(owner, 1, "first", [], now() - 20);
    const second = ev(owner, 1, "second", [], now() - 10);
    expect((await sourceClient.ok(first)).ok).toBe(true);
    expect((await sourceClient.ok(second)).ok).toBe(true);
    await claimed(destination, owner);

    const job: PullJob = {
      url: "wss://" + source,
      startedAt: now(),
      rounds: 0,
      stored: 0,
      skipped: 0,
      blobs: 0,
      failures: 0,
      filter: { authors: [getPublicKey(owner)] },
    };
    const firstRound = await run("pull-query-destination", job);
    expect(firstRound).toEqual({ more: true, error: "" });
    expect(job.progress).toMatchObject({ mode: "query", status: "running", pages: 0 });
    expect(job.progress?.windows).toEqual([{ since: 0, until: job.startedAt }]);

    const secondRound = await run("pull-query-destination", job);
    expect(secondRound).toEqual({ more: false, error: "" });
    expect(job.progress).toMatchObject({ mode: "query", status: "best-effort", pages: 1, partial: false });
    expect(job.stored).toBe(2);
  });

  it("marks a saturated one-second query window partial", async () => {
    const owner = generateSecretKey();
    const source = "pull-query-saturated-source.bind.ws";
    const destination = "pull-query-saturated-destination.bind.ws";
    await claimed(source, owner);
    await rpc(source, owner, "setpolicy", { features: { sync: false } });
    const timestamp = now() - 30;
    const events: Event[] = [];
    await runInDurableObject(env.RELAY.getByName("pull-query-saturated-source"), async (relay: Relay) => {
      for (let i = 0; i < 501; i++) {
        const event = ev(owner, 1, "same timestamp " + i, [], timestamp);
        events.push(event);
        expect(relay.store.save(event, now())).toBe("");
      }
    });
    await claimed(destination, owner);
    const job: PullJob = {
      url: "wss://" + source,
      startedAt: timestamp,
      rounds: 0,
      stored: 0,
      skipped: 0,
      blobs: 0,
      failures: 0,
      filter: { authors: [getPublicKey(owner)], since: timestamp },
    };
    expect((await run("pull-query-saturated-destination", job)).more).toBe(true);
    const result = await run("pull-query-saturated-destination", job);
    expect(result).toEqual({ more: false, error: "" });
    expect(job.progress).toMatchObject({ mode: "query", status: "partial", pages: 1, partial: true });
    expect(job.progress?.warning).toMatch(/one-second window reached/);
    expect(job.stored).toBe(500);
    expect(events).toHaveLength(501);
  });

  it("advances past a refused source and resumes the next source after JSON persistence", async () => {
    const owner = generateSecretKey();
    const source = "pull-refused-source.bind.ws";
    const destination = "pull-refused-destination.bind.ws";
    await claimed(source, owner);
    await rpc(source, owner, "setpolicy", { features: { sync: false } });
    const sourceClient = await WS.connect(source);
    const note = ev(owner, 1, "from the second source", [], now() - 10);
    expect((await sourceClient.ok(note)).ok).toBe(true);
    await claimed(destination, owner);
    const job = {
      id: "pull-test",
      kind: "pull",
      label: "pull",
      relays: ["wss://first.example", "wss://" + source],
      filter: { authors: [getPublicKey(owner)] },
      every: 0,
      createdAt: now(),
      nextRun: 0,
      running: true,
      startedAt: now(),
      rounds: 0,
      failures: 0,
      relayIndex: 0,
      cursor: 0,
      stored: 0,
      skipped: 0,
      blobs: 0,
      sent: 0,
      refused: 0,
      last: null,
    } as Job;
    let refusalRounds = 0;
    const connect = async (relay: Relay, url: string): Promise<PullSocket> => {
      if (url === "wss://first.example") return new RefusingSocket(refusalRounds++ > 0);
      return new Socket(await dial(relay, url));
    };
    const first = await runInDurableObject(env.RELAY.getByName("pull-refused-destination"), async (relay: Relay) => runPullSourceRound(relay, job, connect));
    expect(first).toEqual({ more: true, error: "" });
    expect(job.relayIndex).toBe(0);
    expect(job.pullSources?.[0]).toMatchObject({ mode: "query", status: "running" });
    const persisted = JSON.parse(JSON.stringify(job)) as Job;
    const refused = await runInDurableObject(env.RELAY.getByName("pull-refused-destination"), async (relay: Relay) => runPullSourceRound(relay, persisted, connect));
    expect(refused).toEqual({ more: true, error: "" });
    expect(persisted.relayIndex).toBe(1);
    expect(persisted.pullSources?.[0]).toMatchObject({ status: "refused", error: expect.stringContaining("auth-required") });
    const third = await runInDurableObject(env.RELAY.getByName("pull-refused-destination"), async (relay: Relay) => runPullSourceRound(relay, persisted));
    expect(third).toEqual({ more: true, error: "" });
    expect(persisted.relayIndex).toBe(1);
    expect(persisted.pullSources?.[1]).toMatchObject({ mode: "query", status: "running" });
    const fourth = await runInDurableObject(env.RELAY.getByName("pull-refused-destination"), async (relay: Relay) => runPullSourceRound(relay, persisted));
    expect(fourth).toEqual({ more: false, error: "" });
    expect(persisted.relayIndex).toBe(2);
    expect(persisted.pullSources?.[1]).toMatchObject({ status: "best-effort", pages: 1, stored: 1 });
  });

  it("retries transient connection failures three times before advancing", async () => {
    const owner = generateSecretKey();
    const destination = "pull-retry-destination.bind.ws";
    await claimed(destination, owner);
    const job = {
      id: "pull-retry-test", kind: "pull", label: "pull", relays: ["wss://flaky.example", "wss://next.example"], filter: {}, every: 0,
      createdAt: now(), nextRun: 0, running: true, startedAt: now(), rounds: 0, failures: 0, relayIndex: 0, cursor: 0,
      stored: 0, skipped: 0, blobs: 0, sent: 0, refused: 0, last: null,
    } as Job;
    let attempts = 0;
    const connect = async (_relay: Relay, url: string): Promise<PullSocket> => {
      if (url === "wss://flaky.example") { attempts++; throw new Error("temporary network failure"); }
      return new ScriptedSocket([["NEG-ERR", "pull", "unsupported"]]);
    };
    for (let i = 0; i < 2; i++) {
      const r = await runInDurableObject(env.RELAY.getByName("pull-retry-destination"), async (relay: Relay) => runPullSourceRound(relay, job, connect));
      expect(r.error).toMatch(/temporary network failure/);
      expect(job.relayIndex).toBe(0);
    }
    const third = await runInDurableObject(env.RELAY.getByName("pull-retry-destination"), async (relay: Relay) => runPullSourceRound(relay, job, connect));
    expect(third).toEqual({ more: true, error: "" });
    expect(attempts).toBe(3);
    expect(job.pullSources?.[0]).toMatchObject({ status: "failed", failures: 3 });
    expect(job.relayIndex).toBe(1);
  });

  it("skips invalid, wrong-author, and out-of-window source events", async () => {
    const owner = generateSecretKey();
    const stranger = generateSecretKey();
    const destination = "pull-validation-destination.bind.ws";
    await claimed(destination, owner);
    const good = ev(owner, 1, "in window", [], 100);
    const wrongAuthor = ev(stranger, 1, "wrong author", [], 100);
    const outOfWindow = ev(owner, 1, "too old", [], 50);
    const invalid = { ...good, content: "tampered" };
    let round = 0;
    const connect = async (): Promise<PullSocket> => round++ === 0
      ? new ScriptedSocket([["NEG-ERR", "pull", "unsupported"]])
      : new ScriptedSocket([["EVENT", "history", invalid], ["EVENT", "history", wrongAuthor], ["EVENT", "history", outOfWindow], ["EVENT", "history", good], ["EOSE", "history"]]);
    const job: PullJob = { url: "wss://scripted.example", startedAt: 100, rounds: 0, stored: 0, skipped: 0, blobs: 0, failures: 0, filter: { authors: [getPublicKey(owner)], since: 80 } };
    await runInDurableObject(env.RELAY.getByName("pull-validation-destination"), async (relay: Relay) => runPullRound(relay, job, connect));
    const result = await runInDurableObject(env.RELAY.getByName("pull-validation-destination"), async (relay: Relay) => runPullRound(relay, job, connect));
    expect(result).toEqual({ more: false, error: "" });
    expect(job.stored).toBe(1);
    expect(job.skipped).toBe(3);
    expect(job.progress).toMatchObject({ status: "partial", partial: true, pages: 1 });
  });

  it("splits a saturated multi-second window and preserves the split after JSON cloning", async () => {
    const owner = generateSecretKey();
    const destination = "pull-split-destination.bind.ws";
    await claimed(destination, owner);
    const repeated = ev(owner, 1, "repeated", [], 50);
    let round = 0;
    const connect = async (): Promise<PullSocket> => {
      if (round++ === 0) return new ScriptedSocket([["NEG-ERR", "pull", "unsupported"]]);
      return new ScriptedSocket([...Array.from({ length: 500 }, () => ["EVENT", "history", repeated] as unknown[]), ["EOSE", "history"]]);
    };
    const job: PullJob = { url: "wss://scripted.example", startedAt: 100, rounds: 0, stored: 0, skipped: 0, blobs: 0, failures: 0, filter: { authors: [getPublicKey(owner)], since: 0 } };
    expect((await runInDurableObject(env.RELAY.getByName("pull-split-destination"), async (relay: Relay) => runPullRound(relay, job, connect))).more).toBe(true);
    expect((await runInDurableObject(env.RELAY.getByName("pull-split-destination"), async (relay: Relay) => runPullRound(relay, job, connect))).more).toBe(true);
    expect(job.progress?.windows).toEqual([{ since: 0, until: 50 }, { since: 51, until: 100 }]);
    const persisted = JSON.parse(JSON.stringify(job)) as PullJob;
    await runInDurableObject(env.RELAY.getByName("pull-split-destination"), async (relay: Relay) => runPullRound(relay, persisted, connect));
    expect(persisted.progress?.windows).toBeDefined();
    expect(persisted.progress?.pages).toBe(2);
  });
});
