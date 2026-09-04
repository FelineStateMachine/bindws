// Views: folds the relay signs as kind 30078 records, and presence as an
// ephemeral kind 20078 from memory.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../../src/relay.ts";
import { KIND_PRESENCE, KIND_VIEW, viewD } from "../../src/views.ts";
import { now, ev, tagsOf, rpc, info, alarm } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";

async function view(host: string, name: string, sk: Uint8Array | null = null) {
  const url = `http://${host}/view/${name}`;
  const headers: Record<string, string> = {};
  if (sk) headers.authorization = await getToken(url, "GET", (e) => finalizeEvent(e, sk), true);
  const resp = await SELF.fetch(url, { headers });
  return { status: resp.status, body: (await resp.json()) as any };
}

// A relay with an owner, a member with a profile and a relay list, a
// calendar event with an RSVP, two articles and a zap receipt.
async function seed(name: string) {
  const host = `${name}.bind.ws`;
  const owner = generateSecretKey();
  const alice = generateSecretKey();
  await rpc(host, owner, "claim");
  await rpc(host, owner, "setmember", getPublicKey(alice), { name: "alice" });
  const c = await WS.connect(host);
  await c.auth(alice, host);
  const put = async (e: Event) => expect((await c.ok(e)).msg).toBe("");
  await put(ev(alice, 0, JSON.stringify({ name: "Alice", picture: "https://x/a.png" })));
  await put(ev(alice, 10002, "", [["r", "wss://relay.damus.io"], ["r", "wss://nos.lol/"]]));
  await put(ev(owner, 10002, "", [["r", "wss://nos.lol"]]));
  const cal = ev(alice, 31923, "", [["d", "picnic"], ["title", "Picnic"], ["start", String(now() + 3 * 86400)]]);
  await put(cal);
  await put(ev(owner, 31925, "", [["d", "r1"], ["a", `31923:${getPublicKey(alice)}:picnic`], ["status", "accepted"], ["p", getPublicKey(alice)]]));
  const a1 = ev(alice, 30023, "words", [["d", "one"], ["title", "One"], ["published_at", "1700000000"]], now() - 100);
  const a2 = ev(alice, 30023, "more words", [["d", "two"], ["title", "Two"]]);
  await put(a1);
  await put(a2);
  const payer = generateSecretKey();
  const zapReq = ev(payer, 9734, "", [["p", getPublicKey(alice)], ["e", a1.id], ["relays", "wss://" + host], ["amount", "1000000"]]);
  await put(ev(generateSecretKey(), 9735, "", [["p", getPublicKey(alice)], ["e", a1.id], ["bolt11", "lnbc10u1abc"], ["description", JSON.stringify(zapReq)]]));
  return { host, owner, alice, c, a1, a2, cal };
}

describe("views", () => {
  it("publishes the six stored views from the alarm, signed by the relay", async () => {
    const s = await seed("views");
    await rpc(s.host, s.owner, "banpubkey", getPublicKey(generateSecretKey()), "spam");
    await alarm("views");
    const doc = await info(s.host);
    expect(doc.views.map((v: any) => v.name)).toEqual(["profiles", "relays", "calendar", "moderation", "articles", "zaps", "presence"]);
    expect(doc.views.find((v: any) => v.name === "presence").kind).toBe(KIND_PRESENCE);

    const profiles = (await view(s.host, "profiles")).body as Event;
    expect(profiles.kind).toBe(KIND_VIEW);
    expect(profiles.pubkey).toBe(doc.self);
    expect(tagsOf(profiles, "d")[0][1]).toBe(viewD("profiles"));
    const ps = tagsOf(profiles, "p");
    expect(ps[0][1]).toBe(getPublicKey(s.owner));
    expect(ps[1]).toEqual(["p", getPublicKey(s.alice), "Alice", "https://x/a.png", "alice@views.bind.ws"]);

    const relays = (await view(s.host, "relays")).body as Event;
    expect(tagsOf(relays, "r")).toEqual([["r", "wss://nos.lol", "2"], ["r", "wss://relay.damus.io", "1"]]);

    const calendar = (await view(s.host, "calendar")).body as Event;
    const a = tagsOf(calendar, "a");
    expect(a.length).toBe(1);
    expect(a[0][1]).toBe(`31923:${getPublicKey(s.alice)}:picnic`);
    expect(a[0][3]).toBe("Picnic");
    expect(a[0][4]).toBe("1");

    const moderation = (await view(s.host, "moderation")).body as Event;
    const counts = JSON.parse(moderation.content);
    expect(counts.bans).toBe(1);
    expect(counts.month).toBe(new Date().toISOString().slice(0, 7));

    const articles = (await view(s.host, "articles")).body as Event;
    expect(tagsOf(articles, "a").map((t) => t.slice(1))).toEqual([
      [`30023:${getPublicKey(s.alice)}:two`, "Two", String(s.a2.created_at)],
      [`30023:${getPublicKey(s.alice)}:one`, "One", "1700000000"],
    ]);

    const zaps = (await view(s.host, "zaps")).body as Event;
    expect(tagsOf(zaps, "e")).toEqual([["e", s.a1.id, "1000000"]]);
    expect(tagsOf(zaps, "p")).toEqual([["p", getPublicKey(s.alice), "1000000"]]);

    // The records are ordinary events a client can subscribe to.
    const got = await s.c.req({ kinds: [KIND_VIEW], authors: [doc.self] });
    expect(got.map((e) => tagsOf(e, "d")[0][1]).sort()).toEqual(["articles", "calendar", "moderation", "profiles", "relays", "zaps"].map(viewD).sort());
    const runs = (await rpc(s.host, s.owner, "listviews")).result;
    expect(runs.find((v: any) => v.name === "zaps").last.rows).toBeGreaterThan(0);
  });

  it("hourly views republish only when their inputs moved", async () => {
    const s = await seed("views-hourly");
    await alarm("views-hourly");
    const first = (await view(s.host, "zaps")).body as Event;
    const backdate = () => runInDurableObject(env.RELAY.getByName("views-hourly"), async (_r: Relay, state) => state.storage.put("view-at:zaps", now() - 4000));
    await backdate();
    await alarm("views-hourly");
    expect(((await view(s.host, "zaps")).body as Event).id).toBe(first.id);
    const payer = generateSecretKey();
    const zapReq = ev(payer, 9734, "", [["p", getPublicKey(s.alice)], ["e", s.a2.id], ["relays", "wss://" + s.host], ["amount", "2000000"]]);
    expect((await s.c.ok(ev(generateSecretKey(), 9735, "", [["p", getPublicKey(s.alice)], ["bolt11", "lnbc20u1abc"], ["description", JSON.stringify(zapReq)]]))).ok).toBe(true);
    await backdate();
    await alarm("views-hourly");
    const second = (await view(s.host, "zaps")).body as Event;
    expect(second.id).not.toBe(first.id);
    expect(tagsOf(second, "p")).toEqual([["p", getPublicKey(s.alice), "3000000"]]);
  });

  it("a members-only view is folded on request and never stored", async () => {
    const s = await seed("views-members");
    await rpc(s.host, s.owner, "setpolicy", { directoryPublic: false });
    await alarm("views-members");
    expect((await view(s.host, "profiles")).status).toBe(401);
    expect((await view(s.host, "profiles", generateSecretKey())).status).toBe(403);
    const mine = await view(s.host, "profiles", s.alice);
    expect(mine.status).toBe(200);
    expect(tagsOf(mine.body, "p").length).toBe(2);
    const doc = await info(s.host);
    expect(doc.views.find((v: any) => v.name === "profiles").audience).toBe("members");
    const stored = await s.c.req({ kinds: [KIND_VIEW], authors: [doc.self], "#d": [viewD("profiles")] });
    expect(stored).toEqual([]);
    // Public again: the daily tick stores it.
    await rpc(s.host, s.owner, "setpolicy", { directoryPublic: true });
    await runInDurableObject(env.RELAY.getByName("views-members"), async (_r: Relay, state) => state.storage.put("view-at:profiles", 0));
    await alarm("views-members");
    expect((await s.c.req({ kinds: [KIND_VIEW], authors: [doc.self], "#d": [viewD("profiles")] })).length).toBe(1);
  });

  it("presence is broadcast on auth and on a write, throttled, and read from memory", async () => {
    const s = await seed("views-presence");
    const watcher = await WS.connect(s.host);
    watcher.send("REQ", "p", { kinds: [KIND_PRESENCE] });
    await watcher.expect("EOSE");
    const bob = generateSecretKey();
    const b = await WS.connect(s.host);
    // Seeding signed alice in, which broadcast once; start the throttle over.
    await runInDurableObject(env.RELAY.getByName("views-presence"), async (r: Relay) => { (r as unknown as { presenceAt: number }).presenceAt = 0; });
    await b.auth(bob, s.host);
    const first = await watcher.recvOr(2000);
    expect(first && first[0]).toBe("EVENT");
    const pres = first![2] as Event;
    expect(pres.kind).toBe(KIND_PRESENCE);
    expect(tagsOf(pres, "p").some((t) => t[1] === getPublicKey(bob) && t[2] === "online")).toBe(true);
    // A write inside the throttle window waits.
    expect((await b.ok(ev(bob, 1, "hi", [], now()))).ok).toBe(true);
    expect(await watcher.recvOr(400)).toBeNull();
    const live = await view(s.host, "presence");
    expect(live.status).toBe(200);
    expect(tagsOf(live.body, "p").some((t) => t[1] === getPublicKey(bob) && t[2] === "online")).toBe(true);
    // Members-only reads keep it to members.
    await rpc(s.host, s.owner, "setpolicy", { reads: "members" });
    expect((await view(s.host, "presence")).status).toBe(401);
    expect((await view(s.host, "presence", s.alice)).status).toBe(200);
  });

  it("retention leaves what the relay signed alone, and a switch takes a view down", async () => {
    const s = await seed("views-keep");
    await alarm("views-keep");
    const doc = await info(s.host);
    expect((await s.c.ok(ev(s.alice, KIND_VIEW, "", [["d", "mine"]], now() - 10 * 86400))).ok).toBe(true);
    await rpc(s.host, s.owner, "setretention", KIND_VIEW, 1);
    await runInDurableObject(env.RELAY.getByName("views-keep"), async (r: Relay) => {
      r.sql.exec(`UPDATE events SET created_at=? WHERE kind=?`, now() - 10 * 86400, KIND_VIEW);
      expect(r.sweepRetention(now())).toBe(1);
    });
    expect((await s.c.req({ kinds: [KIND_VIEW], authors: [doc.self] })).length).toBe(6);
    expect((await s.c.req({ kinds: [KIND_VIEW], authors: [getPublicKey(s.alice)] })).length).toBe(0);
    expect((await rpc(s.host, s.owner, "purgekind", KIND_VIEW, 0)).result.deleted).toBe(0);

    await rpc(s.host, s.owner, "setpolicy", { views: { articles: false } });
    expect((await view(s.host, "articles")).status).toBe(404);
    expect((await s.c.req({ kinds: [KIND_VIEW], authors: [doc.self], "#d": [viewD("articles")] })).length).toBe(0);
    expect((await info(s.host)).views.map((v: any) => v.name)).not.toContain("articles");
    const exported = (await rpc(s.host, s.owner, "exportconfig")).result;
    expect(exported.policy.views).toEqual({ articles: false });
    await rpc(s.host, s.owner, "setpolicy", { views: { articles: true } });
    expect((await view(s.host, "articles")).status).toBe(200);
  });
});
