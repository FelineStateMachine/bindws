// Moderation: reports that hide an event until a moderator looks, the queue
// over NIP-86, a ban that erases, and the log every change leaves.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { now, ev, rpc, pk } from "../helpers/relay.ts";
import { WS } from "../helpers/ws.ts";
import { upload } from "../helpers/media.ts";

async function publish(host: string, e: Event): Promise<{ ok: boolean; msg: string }> {
  const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket" } });
  const ws = resp.webSocket!;
  ws.accept();
  return new Promise((res) => {
    ws.addEventListener("message", (m) => {
      const a = JSON.parse(m.data as string);
      if (a[0] === "OK") {
        ws.close();
        res({ ok: a[2], msg: a[3] });
      }
    });
    ws.send(JSON.stringify(["EVENT", e]));
  });
}

type Row = { seq: number; at: number; actor: string; action: string; target: string; detail: string };

describe("moderation queue", () => {
  it("files NIP-56 reports for the owner and resolves them with ban, delete or dismiss", async () => {
    const host = "mods.bind.ws";
    const owner = generateSecretKey();
    const troll = generateSecretKey();
    const reporter = generateSecretKey();
    await rpc(host, owner, "claim");
    const c = await WS.connect(host);
    const bad = ev(troll, 1, "something awful");
    await c.ok(bad);
    const report = ev(reporter, 1984, "please look", [["e", bad.id, "spam"], ["p", getPublicKey(troll)]]);
    expect((await c.ok(report)).msg).toBe("info: report received");
    expect(await c.req({ kinds: [1984] })).toEqual([]); // never served
    let q = (await rpc(host, owner, "listreports")).result;
    expect(q.length).toBe(1);
    expect(q[0]).toMatchObject({ id: report.id, target_event: bad.id, target_pubkey: getPublicKey(troll), type: "spam", status: "open" });
    expect((await rpc(host, owner, "resolvereport", report.id, "ban")).result).toBe(true);
    expect(await c.req({ ids: [bad.id] })).toEqual([]);
    expect((await c.ok(ev(troll, 1, "back"))).msg).toMatch(/^blocked:/);
    expect((await rpc(host, owner, "listreports")).result).toEqual([]);
    expect((await rpc(host, owner, "listreports", "resolved")).result[0].action).toBe("ban");
  });
});

describe("report thresholds", () => {
  it("hides an event once enough people report it, until a moderator resolves the reports", async () => {
    const host = "threshold.bind.ws";
    const owner = generateSecretKey();
    const author = generateSecretKey();
    const r1 = generateSecretKey();
    const r2 = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await rpc(host, owner, "setpolicy", { reportThreshold: 2 })).result.reportThreshold).toBe(2);
    const c = await WS.connect(host);
    const note = ev(author, 1, "contested");
    expect((await c.ok(note)).ok).toBe(true);
    const report = (sk: Uint8Array) => ev(sk, 1984, "nope", [["e", note.id, "spam"], ["p", pk(author)]]);
    const firstReport = report(r1);
    expect((await c.ok(firstReport)).ok).toBe(true);
    expect((await c.ok(firstReport)).ok).toBe(true); // retry the same signed report across clock ticks
    expect((await c.req({ ids: [note.id] })).length).toBe(1);
    expect((await c.ok(report(r2))).ok).toBe(true);
    // Hidden everywhere stored events are read.
    expect(await c.req({ ids: [note.id] })).toEqual([]);
    expect((await c.count({ authors: [pk(author)] })).count).toBe(0);
    expect((await SELF.fetch(`http://${host}/e/${note.id}`)).status).toBe(404);
    const feed = await (await SELF.fetch(`http://${host}/feed.xml`)).text();
    expect(feed.includes(note.id)).toBe(false);
    const reports = (await rpc(host, owner, "listreports")).result;
    expect(reports.length).toBe(2);
    expect(reports.every((r: any) => r.hidden === 1)).toBe(true);
    expect((await rpc(host, owner, "listeventsneedingmoderation")).result.map((r: any) => r.id)).toEqual([note.id]);
    // Dismissing one report leaves the hold; dismissing the last lifts it.
    await rpc(host, owner, "resolvereport", reports[0].id, "dismiss");
    expect(await c.req({ ids: [note.id] })).toEqual([]);
    await rpc(host, owner, "resolvereport", reports[1].id, "dismiss");
    expect((await c.req({ ids: [note.id] })).length).toBe(1);
    // Reports on a pubkey alone never hide anything.
    expect((await c.ok(ev(r1, 1984, "person", [["p", pk(author), "impersonation"]]))).ok).toBe(true);
    expect((await c.ok(ev(r2, 1984, "person", [["p", pk(author), "impersonation"]]))).ok).toBe(true);
    expect((await c.req({ ids: [note.id] })).length).toBe(1);
    // Delete makes it permanent.
    const again = ev(author, 1, "contested again");
    expect((await c.ok(again)).ok).toBe(true);
    for (const sk of [r1, r2]) expect((await c.ok(ev(sk, 1984, "nope", [["e", again.id, "spam"], ["p", pk(author)]]))).ok).toBe(true);
    expect(await c.req({ ids: [again.id] })).toEqual([]);
    const open = (await rpc(host, owner, "listreports")).result.filter((r: any) => r.target_event === again.id);
    await rpc(host, owner, "resolvereport", open[0].id, "delete");
    expect((await c.ok(again)).msg).toMatch(/banned/);
  });
});

describe("listeventsneedingmoderation", () => {
  it("lists open reports by reported thing, deduplicated, for owner and moderator only", async () => {
    const host = "modqueue.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    const author = generateSecretKey();
    const reporter = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(member), {});
    const c = (await WS.tryConnect(host, "10.9.0.1"))!;
    const note = ev(author, 1, "buy my coin");
    expect((await c.ok(note)).ok).toBe(true);
    // Two reports on the note, one on the author alone.
    expect((await c.ok(ev(reporter, 1984, "junk", [["e", note.id, "spam"], ["p", pk(author)]]))).ok).toBe(true);
    expect((await c.ok(ev(member, 1984, "", [["e", note.id, "spam"], ["p", pk(author)]]))).ok).toBe(true);
    expect((await c.ok(ev(reporter, 1984, "bot", [["p", pk(author), "impersonation"]]))).ok).toBe(true);

    const list = await rpc(host, owner, "listeventsneedingmoderation");
    expect(list.status).toBe(200);
    expect(list.result).toEqual([{ id: note.id, reason: "spam: junk" }]);
    expect((await rpc(host, mod, "listeventsneedingmoderation")).result).toEqual([{ id: note.id, reason: "spam: junk" }]);
    expect((await rpc(host, member, "listeventsneedingmoderation")).status).toBe(403);
    expect((await rpc(host, owner, "supportedmethods")).result).toEqual(expect.arrayContaining(["listeventsneedingmoderation", "blockip", "unblockip", "listblockedips"]));

    // Resolving the reports empties the list.
    const reports = (await rpc(host, owner, "listreports")).result as { id: string }[];
    for (const r of reports) await rpc(host, owner, "resolvereport", r.id, "dismiss");
    expect((await rpc(host, owner, "listeventsneedingmoderation")).result).toEqual([]);
  });
});

describe("ban and erase", () => {
  it("removes everything a banned pubkey wrote and uploaded when asked", async () => {
    const host = "erase.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    const other = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(member), {});
    await rpc(host, owner, "setmember", pk(other), {});
    const c = await WS.connect(host);
    for (const e of [ev(member, 0, JSON.stringify({ name: "soon gone" })), ev(member, 1, "one"), ev(member, 1, "two"), ev(other, 1, "stays")]) expect((await c.ok(e)).ok).toBe(true);
    const { sha } = await upload(host, member, "a file to erase");
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(200);
    // A plain ban keeps the history.
    expect((await rpc(host, owner, "banpubkey", pk(other), "plain")).result).toBe(true);
    expect((await c.req({ authors: [pk(other)] })).length).toBe(1);
    // A ban with erase does not.
    expect((await rpc(host, owner, "banpubkey", pk(member), "gone", true)).result).toBe(true);
    expect(await c.req({ authors: [pk(member)] })).toEqual([]);
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(404);
    expect((await rpc(host, owner, "listblobs")).result).toEqual([]);
    expect((await rpc(host, owner, "listmembers")).result.members.some((m: any) => m.pubkey === pk(member))).toBe(false);
    expect((await c.ok(ev(member, 1, "back?"))).msg).toMatch(/banned/);
    // The same through a report.
    const reporter = generateSecretKey();
    await rpc(host, owner, "setpolicy", { writes: "open" });
    const bad = ev(generateSecretKey(), 1, "report me");
    expect((await c.ok(bad)).ok).toBe(true);
    expect((await c.ok(ev(reporter, 1984, "spam", [["e", bad.id, "spam"], ["p", bad.pubkey]]))).ok).toBe(true);
    const report = (await rpc(host, owner, "listreports")).result[0];
    expect((await rpc(host, owner, "resolvereport", report.id, "ban", true)).result).toBe(true);
    expect(await c.req({ authors: [bad.pubkey] })).toEqual([]);
  });
});

describe("moderation log", () => {
  it("records what changed, who did it and to whom, and reads back newest first", async () => {
    const host = "auditlog.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const member = generateSecretKey();
    const spammer = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(member), {});
    expect((await rpc(host, owner, "getpolicy")).status).toBe(200);
    expect((await rpc(host, mod, "banpubkey", pk(spammer), "spam")).status).toBe(200);
    expect((await rpc(host, owner, "blockip", "203.0.113.9", "swarm")).status).toBe(200);
    expect((await rpc(host, owner, "setblockedwords", ["casino"])).status).toBe(200);
    expect((await rpc(host, owner, "setpolicy", { reads: "auth", maxSubs: 5 })).status).toBe(200);
    // A refused call leaves nothing.
    expect((await rpc(host, mod, "setpolicy", { reads: "open" })).status).toBe(403);
    expect((await rpc(host, owner, "banpubkey", "zz", "")).status).toBe(400);

    const rows = (await rpc(host, owner, "listaudit")).result as Row[];
    const actions = rows.map((r) => [r.actor.slice(0, 8), r.action, r.target]);
    expect(actions.slice(0, 4)).toEqual([
      [pk(owner).slice(0, 8), "setpolicy", ""],
      [pk(owner).slice(0, 8), "setblockedwords", ""],
      [pk(owner).slice(0, 8), "blockip", "203.0.113.9"],
      [pk(mod).slice(0, 8), "banpubkey", pk(spammer)],
    ]);
    expect(rows[0].detail).toBe('["reads","maxSubs"]');
    expect(rows[1].detail).toBe('["casino"]');
    expect(rows[2].detail).toBe('"swarm"');
    expect(rows.map((r) => r.action)).not.toContain("getpolicy");
    expect(rows.map((r) => r.action)).toContain("setmember");
    for (const r of rows) expect(r.at).toBeGreaterThan(now() - 60);
    // seq descends; paging with `before` continues from a row.
    expect(rows[0].seq).toBeGreaterThan(rows[1].seq);
    const older = (await rpc(host, owner, "listaudit", rows[1].seq)).result as Row[];
    expect(older[0].seq).toBe(rows[2].seq);
    // Moderators read it, members do not, and reading is not itself logged.
    expect((await rpc(host, mod, "listaudit")).status).toBe(200);
    expect((await rpc(host, member, "listaudit")).status).toBe(403);
    expect(((await rpc(host, owner, "listaudit")).result as Row[])[0].action).toBe("setpolicy");
  });

  it("records NIP-29 moderation events under their names", async () => {
    const host = "auditgroup.bind.ws";
    const owner = generateSecretKey();
    const someone = generateSecretKey();
    await rpc(host, owner, "claim");
    const put = ev(owner, 9000, "", [["h", host.split(".")[0]], ["p", pk(someone), "member"]]);
    expect((await publish(host, put)).ok).toBe(true);
    const remove = ev(owner, 9001, "", [["h", host.split(".")[0]], ["p", pk(someone)]]);
    expect((await publish(host, remove)).ok).toBe(true);
    const rows = (await rpc(host, owner, "listaudit")).result as Row[];
    expect(rows.slice(0, 2).map((r) => [r.action, r.target, r.actor])).toEqual([
      ["remove-user", pk(someone), pk(owner)],
      ["put-user", pk(someone), pk(owner)],
    ]);
  });
});
