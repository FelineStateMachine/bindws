import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import type { Relay } from "../../src/relay.ts";
import { KIND_PUSH_REGISTRATION } from "../../src/kinds.ts";
import { queuePush } from "../../src/push.ts";
import { ev, now, pk, rpc } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

const callback = "https://push.example.com/hooks/device-1";

async function enable(host: string, owner: Uint8Array) {
  await rpc(host, owner, "claim");
  await rpc(host, owner, "setpolicy", { features: { push: true }, pushCallbacks: ["https://push.example.com"] });
}

async function trustAndCapture(name: string, capture: (req: Request) => Response | Promise<Response>) {
  await runInDurableObject(env.RELAY.getByName(name), async (r: Relay) => {
    Object.defineProperty(r, "pushCallbackOrigins", { value: ["https://push.example.com"], configurable: true });
    r.fetcher = async (url, init) => capture(new Request(String(url), init));
  });
}

describe("NIP-9a push engine", () => {
  it.each([{ order: "older", offset: -1 }, { order: "newer", offset: 1 }])("delivers both payloads when the id-only registration is $order", async ({ order, offset }) => {
    const name = "push-engine-" + order;
    const host = name + ".bind.ws";
    const registeredAt = now() - 10;
    const owner = generateSecretKey();
    await enable(host, owner);
    const socket = await WS.connect(host);
    await socket.auth(owner, host);
    const seen: { url: string; body: string }[] = [];
    await trustAndCapture(name, async (req) => { seen.push({ url: req.url, body: await req.text() }); return new Response(null, { status: 204 }); });
    const registration = ev(owner, KIND_PUSH_REGISTRATION, "", [
      ["d", "one"], ["relay", "wss://" + host], ["filter", JSON.stringify({ kinds: [1] })], ["callback", callback], ["include_event"],
    ], registeredAt);
    expect((await socket.ok(registration)).ok).toBe(true);
    const note = ev(owner, 1, "hello");
    expect((await socket.ok(note)).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName(name), async (r: Relay) => { await r.alarm(); });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(callback);
    expect(JSON.parse(seen[0].body)).toEqual({ id: note.id, relay: "wss://" + host + "/", event: JSON.parse(JSON.stringify(note)) });
    const idsOnly = ev(owner, KIND_PUSH_REGISTRATION, "", [
      ["d", "two"], ["relay", "wss://" + host], ["filter", JSON.stringify({ kinds: [1] })], ["callback", callback],
    ], registeredAt + offset);
    expect((await socket.ok(idsOnly)).ok).toBe(true);
    const second = ev(owner, 1, "id only");
    expect((await socket.ok(second)).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName(name), async (r: Relay) => { await r.alarm(); });
    expect(seen).toHaveLength(3);
    const deliveries = seen.map(({ url, body }) => ({ url, payload: JSON.parse(body) })).filter(({ payload }) => payload.id === second.id);
    expect(deliveries).toHaveLength(2);
    // Registration timestamps exercise both selection orders; notification
    // identity and payload content establish correctness, not arrival position.
    expect(deliveries).toEqual(expect.arrayContaining([
      { url: callback, payload: { id: second.id, relay: "wss://" + host + "/", event: JSON.parse(JSON.stringify(second)) } },
      { url: callback, payload: { id: second.id, relay: "wss://" + host + "/" } },
    ]));
  });

  it("does not deliver ignored events, duplicate broadcasts, or events after member removal", async () => {
    const host = "push-auth.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    await enable(host, owner);
    await rpc(host, owner, "setmember", pk(member));
    const socket = await WS.connect(host);
    const seen: Request[] = [];
    await trustAndCapture("push-auth", (req) => { seen.push(req); return new Response(null, { status: 204 }); });
    const registration = ev(member, KIND_PUSH_REGISTRATION, "", [
      ["d", "member"], ["relay", "wss://" + host], ["filter", JSON.stringify({ kinds: [1] })], ["ignore", JSON.stringify({ "#t": ["skip"] })], ["callback", callback],
    ]);
    await socket.auth(member, host);
    expect((await socket.ok(registration)).ok).toBe(true);
    const ignored = ev(owner, 1, "skip", [["t", "skip"]]);
    await socket.ok(ignored);
    await runInDurableObject(env.RELAY.getByName("push-auth"), async (r: Relay) => { r.broadcast(ignored); await r.alarm(); });
    expect(seen).toHaveLength(0);
    const queued = ev(owner, 1, "queued before removal");
    await socket.ok(queued);
    await rpc(host, owner, "removemember", pk(member));
    const after = ev(owner, 1, "after");
    await socket.ok(after);
    await rpc(host, owner, "setmember", pk(member));
    await runInDurableObject(env.RELAY.getByName("push-auth"), async (r: Relay) => { await r.alarm(); });
    expect(seen).toHaveLength(0);
  });

  it("retries transient failures, removes exhausted work, and deletes registrations on 404", async () => {
    const host = "push-retry.bind.ws";
    const owner = generateSecretKey();
    await enable(host, owner);
    const socket = await WS.connect(host);
    await socket.auth(owner, host);
    let status = 500;
    const seen: Request[] = [];
    await trustAndCapture("push-retry", (req) => { seen.push(req); return new Response(null, { status }); });
    const registration = ev(owner, KIND_PUSH_REGISTRATION, "", [
      ["d", "retry"], ["relay", "wss://" + host], ["filter", JSON.stringify({ kinds: [1] })], ["callback", callback],
    ]);
    expect((await socket.ok(registration)).ok).toBe(true);
    const note = ev(owner, 1, "retry me");
    await socket.ok(note);
    for (let i = 0; i < 4; i++) await runInDurableObject(env.RELAY.getByName("push-retry"), async (r: Relay) => { r.sql.exec("UPDATE push_queue SET due=0"); await r.alarm(); });
    expect(seen).toHaveLength(4);
    await runInDurableObject(env.RELAY.getByName("push-retry"), async (r: Relay) => { expect(r.sql.exec("SELECT 1 FROM push_queue").toArray()).toHaveLength(0); });
    status = 404;
    const second = ev(owner, KIND_PUSH_REGISTRATION, "", [
      ["d", "gone"], ["relay", "wss://" + host], ["filter", JSON.stringify({ kinds: [1] })], ["callback", callback],
    ]);
    expect((await socket.ok(second)).ok).toBe(true);
    const last = ev(owner, 1, "gone");
    await socket.ok(last);
    await runInDurableObject(env.RELAY.getByName("push-retry"), async (r: Relay) => { r.sql.exec("UPDATE push_queue SET due=0"); await r.alarm(); });
    await runInDurableObject(env.RELAY.getByName("push-retry"), async (r: Relay) => { expect(r.sql.exec("SELECT 1 FROM events WHERE id=?", second.id).toArray()).toHaveLength(0); });
  });

  it("bounds queued work and drops queued references when policy, visibility, expiry, or registrations change", async () => {
    const host = "push-bounds.bind.ws";
    const owner = generateSecretKey();
    await enable(host, owner);
    const seen: string[] = [];
    await trustAndCapture("push-bounds", async (req) => { seen.push(await req.text()); return new Response(null, { status: 204 }); });
    await runInDurableObject(env.RELAY.getByName("push-bounds"), async (r: Relay) => {
      const registration = ev(owner, KIND_PUSH_REGISTRATION, "", [["d", "bounded"], ["relay", "wss://" + host], ["filter", JSON.stringify({ kinds: [1] })], ["callback", callback]]);
      expect(r.store.save(registration, now())).toBe("");
      for (let i = 0; i < 300; i++) {
        const note = ev(owner, 1, "queued " + i);
        expect(r.store.save(note, now())).toBe("");
        queuePush(r, note);
      }
      expect(r.sql.exec("SELECT count(*) AS n FROM push_queue").one().n).toBe(256);
      queuePush(r, ev(owner, 1, "overflow"));
      expect(r.sql.exec("SELECT count(*) AS n FROM push_queue").one().n).toBe(256);
      r.sql.exec("DELETE FROM push_queue");
      const disabled = ev(owner, 1, "disabled");
      r.store.save(disabled, now());
      queuePush(r, disabled);
      r.settings.update({ features: { ...r.settings.policy.features, push: false } });
      await r.alarm();
      r.settings.update({ features: { ...r.settings.policy.features, push: true } });
      await r.alarm();
      expect(seen.some((x) => x.includes(disabled.id))).toBe(false);
      // A hidden event is removed from the delivery set at tick time.
      r.sql.exec("DELETE FROM push_queue");
      const hidden = ev(owner, 1, "hidden");
      r.store.save(hidden, now());
      queuePush(r, hidden);
      r.settings.setEvent(hidden.id, "hide", "test", now());
      await r.alarm();
      expect(seen.some((x) => x.includes(hidden.id))).toBe(false);
    });
  });

  it("does not fetch after an exhausted attempt and handles a network failure", async () => {
    const host = "push-attempts.bind.ws";
    const owner = generateSecretKey();
    await enable(host, owner);
    let calls = 0;
    await trustAndCapture("push-attempts", () => { calls++; throw new Error("network down"); });
    await runInDurableObject(env.RELAY.getByName("push-attempts"), async (r: Relay) => {
      const registration = ev(owner, KIND_PUSH_REGISTRATION, "", [["d", "attempts"], ["relay", "wss://" + host], ["filter", JSON.stringify({ kinds: [1] })], ["callback", callback]]);
      const note = ev(owner, 1, "network");
      r.store.save(registration, now());
      r.store.save(note, now());
      queuePush(r, note);
      r.sql.exec("UPDATE push_queue SET attempts=3,due=0");
      await r.alarm();
      expect(calls).toBe(1);
      r.sql.exec("INSERT OR IGNORE INTO push_queue(registration_id,event_id,due,attempts,expires) VALUES(?,?,?,?,?)", registration.id, note.id, 0, 4, now() + 100);
      await r.alarm();
      expect(calls).toBe(1);
    });
  });

  it("delivers private events only when the registration author is a party", async () => {
    const host = "push-private-events.bind.ws";
    const owner = generateSecretKey();
    const recipient = generateSecretKey();
    const stranger = generateSecretKey();
    await enable(host, owner);
    const socket = await WS.connect(host);
    await socket.auth(owner, host);
    const seen: string[] = [];
    await trustAndCapture("push-private-events", async (req) => { seen.push(await req.text()); return new Response(null, { status: 204 }); });
    // Sign the event first, then register an ID filter for the ID-only path.
    const dm = ev(owner, 4, "secret", [["p", pk(recipient)]]);
    const actual = ev(owner, KIND_PUSH_REGISTRATION, "", [["d", "private"], ["relay", "wss://" + host], ["filter", JSON.stringify({ ids: [dm.id] })], ["callback", callback]]);
    expect((await socket.ok(actual)).ok).toBe(true);
    await socket.ok(dm);
    await runInDurableObject(env.RELAY.getByName("push-private-events"), async (r: Relay) => { await r.alarm(); });
    expect(seen).toHaveLength(1);
    const unrelated = ev(owner, 4, "other", [["p", pk(stranger)]]);
    await socket.ok(unrelated);
    await runInDurableObject(env.RELAY.getByName("push-private-events"), async (r: Relay) => { await r.alarm(); });
    expect(seen).toHaveLength(1);
  });
});

describe("push admission and callback isolation", () => {
  it("rejects unapproved and malformed registrations and permits replacement at the author cap", async () => {
    const host = "push-admission.bind.ws";
    const owner = generateSecretKey();
    const outsider = generateSecretKey();
    await enable(host, owner);
    const socket = await WS.connect(host);
    const registration = (d: string, url = callback, filter = "{}", relay = "wss://" + host + "/", time = Math.floor(Date.now() / 1000)) => ev(owner, KIND_PUSH_REGISTRATION, "", [["d", d], ["relay", relay], ["filter", filter], ["callback", url]], time);
    expect((await socket.ok(registration("no-auth"))).msg).toContain("auth-required:");
    await socket.auth(owner, host);
    expect((await socket.ok(registration("no-host-approval"))).ok).toBe(false);
    await trustAndCapture("push-admission", () => new Response(null, { status: 204 }));
    for (const bad of [registration("path", callback, "{}", "wss://" + host + "/wrong"), registration("filter", callback, '{"unknown":true}'), registration("search", callback, '{"search":"topic"}'), registration("port", "https://push.example.com:444/path")]) expect((await socket.ok(bad)).ok).toBe(false);
    const stranger = await WS.connect(host);
    await stranger.auth(outsider, host);
    expect((await stranger.ok(ev(outsider, KIND_PUSH_REGISTRATION, "", registration("stranger").tags))).msg).toContain("members");
    for (let i = 0; i < 4; i++) expect((await socket.ok(registration(String(i)))).ok).toBe(true);
    expect((await socket.ok(registration("fifth"))).ok).toBe(false);
    expect((await socket.ok(registration("0", callback + "-updated", "{}", "wss://" + host + "/", Math.floor(Date.now() / 1000) + 1))).ok).toBe(true);
    socket.ws.close(); stranger.ws.close();
  });

  it("accepts another event while a callback is still waiting", async () => {
    const host = "push-slow.bind.ws";
    const owner = generateSecretKey();
    await enable(host, owner);
    const socket = await WS.connect(host);
    await socket.auth(owner, host);
    await trustAndCapture("push-slow", () => new Response(null, { status: 204 }));
    expect((await socket.ok(ev(owner, KIND_PUSH_REGISTRATION, "", [["d", "slow"], ["relay", "wss://" + host], ["filter", '{"kinds":[1]}'], ["callback", callback]]))).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName("push-slow"), async (r: Relay) => {
      let release!: () => void;
      let started!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const fetching = new Promise<void>((resolve) => { started = resolve; });
      r.fetcher = async () => { started(); await pending; return new Response(null, { status: 204 }); };
      const conn = r.virtualConn(host, pk(owner));
      const first = ev(owner, 1, "first");
      expect((await r.acceptAny(first, conn)).ok).toBe(true);
      r.broadcast(first);
      const tick = r.alarm();
      await fetching;
      try { expect((await r.acceptAny(ev(owner, 1, "during callback"), conn)).ok).toBe(true); }
      finally { release(); await tick; }
    });
  });
});

describe("push alarm durability", () => {
  it("aborts a stalled callback and persists a retry instead of waiting indefinitely", async () => {
    const host = "push-timeout.bind.ws";
    const owner = generateSecretKey();
    await enable(host, owner);
    await trustAndCapture("push-timeout", () => new Response(null, { status: 204 }));
    const socket = await WS.connect(host);
    await socket.auth(owner, host);
    expect((await socket.ok(ev(owner, KIND_PUSH_REGISTRATION, "", [["d", "timeout"], ["relay", "wss://" + host], ["filter", '{"kinds":[1]}'], ["callback", callback]]))).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName("push-timeout"), async (r: Relay) => {
      let aborted = false;
      r.fetcher = async (_url, init) => new Promise<Response>((_resolve, reject) => {
        expect(init?.redirect).toBe("manual");
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      });
      const note = ev(owner, 1, "stalled");
      r.accept(note, null); r.broadcast(note);
      await r.alarm();
      expect(aborted).toBe(true);
      const job = r.sql.exec<{ attempts: number; due: number }>("SELECT attempts,due FROM push_queue WHERE event_id=?", note.id).one();
      expect(job.attempts).toBe(1);
      expect(job.due).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  it("schedules work created later in an alarm and recreates callback tables after teardown", async () => {
    const host = "push-late-alarm.bind.ws";
    const owner = generateSecretKey();
    await enable(host, owner);
    await trustAndCapture("push-late-alarm", () => new Response(null, { status: 204 }));
    const socket = await WS.connect(host);
    await socket.auth(owner, host);
    expect((await socket.ok(ev(owner, KIND_PUSH_REGISTRATION, "", [["d", "late"], ["relay", "wss://" + host], ["filter", '{"kinds":[1]}'], ["callback", callback]]))).ok).toBe(true);
    await runInDurableObject(env.RELAY.getByName("push-late-alarm"), async (r: Relay) => {
      const publish = r.publishDiscovery;
      r.publishDiscovery = async () => {
        const note = ev(owner, 1, "late alarm event");
        if (r.accept(note, null).stored) r.broadcast(note);
      };
      try { await r.alarm(); }
      finally { r.publishDiscovery = publish; }
      expect(r.sql.exec("SELECT 1 FROM push_queue").toArray()).toHaveLength(1);
      expect(await r.storage.getAlarm()).toBeLessThan(Date.now() + 3000);
      await r.teardown();
      await r.alarm();
      expect(r.sql.exec("SELECT 1 FROM push_queue").toArray()).toHaveLength(0);
    });
  });
});
