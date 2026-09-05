import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { generateSecretKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { DEFAULT_POLICY, featureOn } from "../../src/settings.ts";
import { KIND_GIT_ISSUE, KIND_GIT_PR, KIND_REPO, KIND_REPO_STATE } from "../../src/kinds.ts";
import { graspSyncTick, eventSource, GRASP_SYNC_PAGE, type GraspSyncConnect } from "../../src/grasp-sync.ts";
import { nip11 } from "../../src/nip11.ts";
import { now, type Event } from "../../src/event.ts";
import { ev, pk, rpc } from "../helpers/relay.ts";
import type { Relay } from "../../src/relay.ts";

const SOURCE = "wss://history.example";
async function scope(name: string, action: (relay: Relay, owner: Uint8Array, host: string) => Promise<void>) {
  const owner = generateSecretKey(), host = `${name}.bind.ws`;
  await rpc(host, owner, "claim");
  await runInDurableObject(env.RELAY.getByName(name), async (relay, context) => {
    await context.storage.deleteAlarm();
    for (let i = 0; relay.repositoryAccess.busy && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await relay.repositoryAccess.run("alarm", async () => {
      relay.settings.update({ writes: "open", reads: "open", features: { ...relay.settings.policy.features, grasp: true, grasp02: true, grasp03: false, grasp05: false } });
      try { await action(relay, owner, host); }
      finally { relay.settings.update({ features: { ...relay.settings.policy.features, grasp02: false, grasp03: false, grasp05: false } }); await context.storage.deleteAlarm(); }
    }, () => { throw new Error("fixture did not acquire authority"); });
  });
}
function seed(relay: Relay, owner: Uint8Array, host: string) {
  const repo = ev(owner, KIND_REPO, "", [["d", "repo"], ["clone", `https://${host}/${npubEncode(pk(owner))}/repo.git`], ["relays", `wss://${host}`, SOURCE]]);
  expect(relay.accept(repo, relay.virtualConn(host, pk(owner))).ok).toBe(true);
  relay.sql.exec("DELETE FROM grasp_pending WHERE id=?", repo.id);
  return { repo, coordinate: `30617:${pk(owner)}:repo` };
}
function fake(reply: (source: string, sub: string, filters: unknown[]) => unknown[][]) {
  const sent: { source: string; m: unknown[] }[] = [];
  let connections = 0, closed = 0;
  const connect: GraspSyncConnect = async (_relay, source) => {
    connections++;
    const queue: unknown[][] = [];
    return {
      send(...m) { sent.push({ source, m }); if (m[0] === "REQ") queue.push(...reply(source, String(m[1]), m.slice(2))); },
      recv() { const m = queue.shift(); return m ? Promise.resolve(m) : Promise.reject(new Error("idle")); },
      close() { closed++; },
    };
  };
  return { connect, sent, counts: () => ({ connections, closed }) };
}
const empty = (_source: string, sub: string) => [["EOSE", sub]];
const has = (relay: Relay, event: Event) => relay.sql.exec("SELECT id FROM events WHERE id=?", event.id).toArray().length > 0;

describe("GRASP event synchronization", () => {
  it("keeps later profiles opt-in and dependency gated", () => {
    const legacy = { ...DEFAULT_POLICY, features: { ...DEFAULT_POLICY.features, grasp: true } };
    delete (legacy.features as Partial<typeof legacy.features>).grasp02;
    expect(featureOn(legacy, "grasp02")).toBe(false);
    for (const name of ["grasp02", "grasp03", "grasp05", "grasp06"] as const) expect(featureOn(DEFAULT_POLICY, name)).toBe(false);
    expect(featureOn({ ...DEFAULT_POLICY, features: { ...DEFAULT_POLICY.features, grasp02: true } }, "grasp02")).toBe(false);
    expect(featureOn({ ...DEFAULT_POLICY, features: { ...DEFAULT_POLICY.features, grasp: true, grasp03: true, grasp05: true } }, "grasp05")).toBe(false);
    expect(featureOn({ ...DEFAULT_POLICY, features: { ...DEFAULT_POLICY.features, grasp: true, grasp02: true, grasp03: true } }, "grasp03")).toBe(true);
    expect(featureOn({ ...DEFAULT_POLICY, features: { ...DEFAULT_POLICY.features, grasp: true, grasp06: true } }, "grasp06")).toBe(true);
  });

  it("schedules a wake when synchronization is enabled on an otherwise idle relay", async () => {
    const host = "grasp-sync-enable.bind.ws", owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await rpc(host, owner, "setpolicy", { features: { grasp: true, grasp02: true } })).status).toBe(200);
    await runInDurableObject(env.RELAY.getByName("grasp-sync-enable"), async (relay, context) => {
      expect(await context.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 2000);
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp02: false } });
      await context.storage.deleteAlarm();
    });
  });

  it("imports signed state and PRs with 03 off, checks scope and subscription, and honors normal write policy", async () => {
    await scope("grasp-sync-scope", async (relay, owner, host) => {
      const { coordinate } = seed(relay, owner, host), other = generateSecretKey();
      const state = ev(owner, KIND_REPO_STATE, "", [["d", "repo"]]);
      const pr = ev(other, KIND_GIT_PR, "", [["a", coordinate], ["c", "a".repeat(40)], ["clone", "https://git.example/repo.git"]]);
      const unrelated = ev(other, KIND_REPO_STATE, "", [["d", "repo"]]);
      const wrongSub = ev(other, KIND_GIT_ISSUE, "wrong subscription", [["a", coordinate]]);
      const blocked = ev(other, KIND_GIT_ISSUE, "blocked author", [["a", coordinate]]);
      relay.settings.setBan(pk(other), true);
      const f = fake((_source, sub) => sub.includes("history") ? [["EVENT", sub, unrelated], ["EVENT", "wrong", wrongSub], ["EVENT", sub, blocked], ["EVENT", sub, state], ["EOSE", sub]] : empty("", sub));
      await graspSyncTick(relay, f.connect);
      expect(has(relay, state)).toBe(true);
      for (const e of [unrelated, wrongSub, blocked]) expect(has(relay, e)).toBe(false);
      expect(relay.sql.exec<{ error: string }>("SELECT error FROM grasp_event_sync").one().error).toBe("admission-gap");
      relay.settings.setBan(pk(other), false);
      relay.sql.exec("UPDATE grasp_event_sync SET due=0");
      const p = fake((_source, sub) => [["EVENT", sub, pr], ["EOSE", sub]]);
      await graspSyncTick(relay, p.connect);
      expect(has(relay, pr)).toBe(true);
      expect(p.counts()).toEqual({ connections: 1, closed: 1 });
    });
  });

  it("imports post-EOSE outbox replies without a tags and discovers only write relays", async () => {
    await scope("grasp-sync-outbox", async (relay, owner, host) => {
      const { coordinate } = seed(relay, owner, host), author = generateSecretKey(), responder = generateSecretKey();
      const issue = ev(author, KIND_GIT_ISSUE, "issue", [["a", coordinate]]);
      const list = ev(author, 10002, "", [["r", "wss://outbox.example", "write"], ["r", "wss://read.example", "read"]]);
      for (const e of [issue, list]) expect(relay.accept(e, relay.virtualConn(host, pk(owner))).ok).toBe(true);
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp03: true } });
      await graspSyncTick(relay, fake(empty).connect);
      const rows = relay.sql.exec<{ id: string; source: string; scope: string }>("SELECT id,source,scope FROM grasp_event_sync").toArray();
      expect(rows.some(r => r.source.includes("read.example"))).toBe(false);
      const target = rows.find(r => r.source.includes("outbox.example") && JSON.parse(r.scope).mode === "thread")!;
      expect(target).toBeDefined();
      relay.sql.exec("UPDATE grasp_event_sync SET due=?", now() + 3600);
      relay.sql.exec("UPDATE grasp_event_sync SET due=0 WHERE id=?", target.id);
      const reply = ev(responder, 1111, "after EOSE", [["E", issue.id]]);
      const f = fake((_source, sub) => sub.includes("live") ? [["EOSE", sub], ["EVENT", sub, reply]] : empty("", sub));
      await graspSyncTick(relay, f.connect);
      expect(has(relay, reply)).toBe(true);
      expect(f.counts()).toEqual({ connections: 1, closed: 1 });
      expect(f.sent.some(({ m }) => JSON.stringify(m).includes('"#E"'))).toBe(true);
      await graspSyncTick(relay, fake(empty).connect);
      const metadata = relay.sql.exec<{ scope: string }>("SELECT scope FROM grasp_event_sync").toArray().map(r => JSON.parse(r.scope)).filter(s => s.mode === "metadata");
      expect(metadata.some(s => s.filters[0].authors.includes(pk(responder)) && s.filters[0].kinds.includes(10317))).toBe(true);
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp03: false } });
      await graspSyncTick(relay, fake(empty).connect);
      expect(relay.sql.exec("SELECT id FROM grasp_event_sync WHERE source LIKE '%outbox.example%'").toArray()).toHaveLength(0);
    });
  });

  it("retains incomplete and saturated history, never skips a full timestamp, and reserves retries", async () => {
    await scope("grasp-sync-history", async (relay, owner, host) => {
      const { coordinate } = seed(relay, owner, host);
      const noEose = fake((_source, sub) => [["EOSE", "wrong-" + sub]]);
      await graspSyncTick(relay, noEose.connect);
      const original = relay.sql.exec<{ windows: string; due: number; failures: number }>("SELECT windows,due,failures FROM grasp_event_sync").one();
      expect(JSON.parse(original.windows)).toHaveLength(1);
      expect(original.failures).toBe(1);
      expect(original.due).toBeGreaterThan(now());
      await graspSyncTick(relay, noEose.connect);
      expect(noEose.counts().connections).toBe(1);
      const time = now() - 10, window = JSON.stringify([{ since: time, until: time }]);
      relay.sql.exec("UPDATE grasp_event_sync SET windows=?,due=0", window);
      const events = Array.from({ length: GRASP_SYNC_PAGE }, (_, i) => ev(owner, KIND_GIT_ISSUE, String(i), [["a", coordinate]], time));
      const full = fake((_source, sub) => sub.includes("history") ? [...events.map(e => ["EVENT", sub, e]), ["EOSE", sub]] : empty("", sub));
      await graspSyncTick(relay, full.connect);
      const row = relay.sql.exec<{ windows: string; error: string; live_since: number }>("SELECT windows,error,live_since FROM grasp_event_sync").one();
      expect(row.windows).toBe(window);
      expect(row.error).toBe("partial-single-second");
      expect(row.live_since).toBeGreaterThanOrEqual(time);
      expect(has(relay, events[255])).toBe(true);
    });
  });

  it("rejects unsafe sources and stays idle when disabled", async () => {
    await scope("grasp-sync-disabled", async (relay, owner, host) => {
      seed(relay, owner, host);
      for (const source of [`wss://${host}`, "wss://localhost", "wss://127.0.0.1", "ws://source.example", "wss://a:b@source.example", "wss://source.example/path?secret=x"]) expect(eventSource(relay, source)).toBeNull();
      const f = fake(empty);
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp02: false } });
      expect(await graspSyncTick(relay, f.connect)).toBe(0);
      expect(f.counts().connections).toBe(0);
    });
  });

  it("archives unlisted announcements only with 05 enabled and counts them toward the quota", async () => {
    await scope("grasp-sync-archive", async (relay, owner, host) => {
      relay.settings.update({ git: { ...relay.settings.policy.git, maxRepositories: 16 } });
      const maintainer = generateSecretKey();
      const announcement = (n: number) => ev(owner, KIND_REPO, "", [["d", `archive-${n}`], ["maintainers", pk(maintainer)], ["clone", `https://git.example/archive-${n}.git`], ["relays", SOURCE]]);
      expect(relay.accept(announcement(0), relay.virtualConn(host, pk(owner))).ok).toBe(false);
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp05: true } });
      expect(nip11(relay, host).supported_grasps).toEqual(["GRASP-01"]);
      expect(nip11(relay, host).repo_acceptance_criteria).toContain("without naming this service");
      for (let n = 0; n < 16; n++) expect(relay.accept(announcement(n), relay.virtualConn(host, pk(owner))).ok).toBe(true);
      expect(relay.accept(announcement(16), relay.virtualConn(host, pk(owner))).msg).toContain("at most 16 repositories");
      expect(relay.sql.exec("SELECT * FROM grasp_hosted").toArray()).toHaveLength(16);
      await graspSyncTick(relay, fake(empty).connect);
      expect(relay.sql.exec("SELECT * FROM grasp_event_sync").toArray()).toHaveLength(16);
      relay.settings.update({ features: { ...relay.settings.policy.features, grasp05: false } });
      const companion = ev(maintainer, KIND_REPO, "", [["d", "archive-0"]]);
      expect(relay.accept(companion, relay.virtualConn(host, pk(maintainer))).ok).toBe(true);
      expect(relay.sql.exec("SELECT * FROM grasp_hosted").toArray()).toHaveLength(16);
    });
  });
});
