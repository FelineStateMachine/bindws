// NIP-29: one group per relay. Joins and leaves, moderation by owner and
// moderator with the permission boundaries, the relay-signed group state,
// and ownership transfer.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) => finalizeEvent({ kind, content, tags, created_at }, sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

const info = async (host: string) => (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();

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
  // ok publishes and waits for the OK. Live pushes the relay fans out while
  // handling the event (its own put-user, say) arrive first; they are kept
  // in order for a later expect.
  async ok(e: Event) {
    this.send("EVENT", e);
    const held: any[][] = [];
    for (;;) {
      const m = await this.recv();
      if (m[0] === "OK" && m[1] === e.id) {
        this.queue.unshift(...held);
        return { ok: m[2] as boolean, msg: m[3] as string };
      }
      held.push(m);
    }
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

const tagsOf = (e: Event, name: string) => e.tags.filter((t) => t[0] === name);
const has = (e: Event, name: string) => e.tags.some((t) => t[0] === name);

// state fetches the four relay-signed group events, keyed by kind.
async function state(c: WS, self: string) {
  const list = await c.req({ kinds: [39000, 39001, 39002, 39003], authors: [self] });
  return Object.fromEntries(list.map((e) => [e.kind, e])) as Record<number, Event | undefined>;
}

describe("NIP-29 group state", () => {
  it("is signed by the relay after the claim and follows the rules", async () => {
    const host = "grp.bind.ws";
    const name = "grp";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const doc = await info(host);
    expect(doc.supported_nips).toContain(29);
    const c = await WS.connect(host);
    let st = await state(c, doc.self);
    expect(st[39000]!.tags).toEqual(expect.arrayContaining([["d", name], ["name", name], ["about", ""]]));
    expect(has(st[39000]!, "private") || has(st[39000]!, "restricted") || has(st[39000]!, "closed")).toBe(false);
    expect(tagsOf(st[39001]!, "p")).toEqual([["p", getPublicKey(owner), "owner"]]);
    expect(tagsOf(st[39002]!, "p")).toEqual([["p", getPublicKey(owner)]]);
    expect(tagsOf(st[39003]!, "role").map((t) => t[1])).toEqual(["owner", "moderator"]);

    await rpc(host, owner, "setpolicy", { reads: "members", writes: "allowlist", name: "Pizza", icon: "https://x/p.png" });
    // Members-only reads now: the owner authenticates to keep reading.
    const m = await WS.connect(host);
    // (the AUTH challenge was consumed by connect; fetch it again through a fresh socket's state)
    const chal = await (async () => {
      const resp = await SELF.fetch(`http://${host}/`, { headers: { upgrade: "websocket" } });
      const w = new WS(resp.webSocket!);
      const a = await w.expect("AUTH");
      return { w, challenge: a[1] as string };
    })();
    chal.w.send("AUTH", ev(owner, 22242, "", [["relay", "ws://" + host], ["challenge", chal.challenge]]));
    await chal.w.expect("OK");
    st = await state(chal.w, doc.self);
    expect(has(st[39000]!, "private") && has(st[39000]!, "restricted") && has(st[39000]!, "closed")).toBe(true);
    expect(st[39000]!.tags).toEqual(expect.arrayContaining([["name", "Pizza"], ["picture", "https://x/p.png"]]));
    void m;

    await rpc(host, owner, "setpolicy", { reads: "open", directoryPublic: false });
    st = await state(c, doc.self);
    expect(st[39002]).toBeUndefined();
    expect(st[39001]).toBeDefined();
  });
});

describe("NIP-29 joins and leaves", () => {
  it("lets strangers join an open group, refuses duplicates and foreign groups, and records leaves", async () => {
    const host = "open.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const doc = await info(host);
    const alice = generateSecretKey();
    const c = await WS.connect(host);
    c.send("REQ", "live", { kinds: [9000, 9001], authors: [doc.self] });
    await c.expect("EOSE");

    expect((await c.ok(ev(alice, 9021, "hi", [["h", "other"]]))).msg).toMatch(/^blocked: this relay hosts one group: open/);
    expect((await c.ok(ev(alice, 9021, "hi", [["h", "open"]]))).ok).toBe(true);
    const put = await c.expect("EVENT");
    expect(put[2].kind).toBe(9000);
    expect(put[2].tags).toEqual(expect.arrayContaining([["h", "open"], ["p", getPublicKey(alice)]]));
    expect((await rpc(host, owner, "listmembers")).result.members.find((m: any) => m.pubkey === getPublicKey(alice)).via).toBe("join");
    expect((await c.ok(ev(alice, 9021, "again", [["h", "open"]]))).msg).toMatch(/^duplicate: already a member/);
    // The join request itself is kept.
    expect((await c.req({ kinds: [9021], authors: [getPublicKey(alice)] })).length).toBe(1);

    expect((await c.ok(ev(owner, 9022, "", [["h", "open"]]))).msg).toMatch(/transfer ownership first/);
    expect((await c.ok(ev(alice, 9022, "bye", [["h", "open"]]))).ok).toBe(true);
    const rem = await c.expect("EVENT");
    expect(rem[2].kind).toBe(9001);
    expect(tagsOf(rem[2], "p")[0][1]).toBe(getPublicKey(alice));
    expect((await c.ok(ev(alice, 9022, "bye again", [["h", "open"]]))).msg).toMatch(/^invalid: not a member/);
  });

  it("needs an invite code in a closed group", async () => {
    const host = "closed.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist" });
    const bob = generateSecretKey();
    const c = await WS.connect(host);
    expect((await c.ok(ev(bob, 9021, "", [["h", "closed"]]))).msg).toMatch(/^restricted: this group is closed/);
    expect((await c.ok(ev(bob, 9021, "", [["h", "closed"], ["code", "nope"]]))).msg).toMatch(/not valid/);
    const inv = (await rpc(host, owner, "createinvite", 3600, 1, "friends")).result;
    expect((await c.ok(ev(bob, 9021, "", [["h", "closed"], ["code", inv.code]]))).ok).toBe(true);
    expect((await rpc(host, owner, "listmembers")).result.members.find((m: any) => m.pubkey === getPublicKey(bob)).via).toMatch(/^invite /);
    const carol = generateSecretKey();
    expect((await c.ok(ev(carol, 9021, "", [["h", "closed"], ["code", inv.code]]))).msg).toMatch(/used up/);
  });
});

describe("NIP-29 moderation", () => {
  it("applies put-user, remove-user, edit-metadata, delete-event and create-invite by role", async () => {
    const host = "mod.bind.ws";
    const h = ["h", "mod"];
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const mod2 = generateSecretKey();
    const alice = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    const doc = await info(host);
    const c = await WS.connect(host);
    const pk = getPublicKey;

    expect((await c.ok(ev(stranger, 9000, "", [h, ["p", pk(alice)]]))).msg).toMatch(/^restricted: not a group admin/);
    expect((await c.ok(ev(owner, 9000, "", [h, ["p", pk(mod), "moderator"]]))).ok).toBe(true);
    expect((await c.ok(ev(owner, 9000, "", [h, ["p", pk(mod2), "moderator", "gardener"]]))).ok).toBe(true);
    let members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.find((m: any) => m.pubkey === pk(mod)).role).toBe("moderator");
    let st = await state(c, doc.self);
    expect(tagsOf(st[39001]!, "p")).toEqual(expect.arrayContaining([["p", pk(mod), "moderator"], ["p", pk(mod2), "moderator"]]));
    // The relay's own put-user carries the roles held now.
    const records = await c.req({ kinds: [9000], authors: [doc.self], "#p": [pk(mod)] });
    expect(records.some((e) => tagsOf(e, "p")[0].includes("moderator"))).toBe(true);

    expect((await c.ok(ev(mod, 9000, "", [h, ["p", pk(alice)]]))).ok).toBe(true);
    expect((await c.ok(ev(mod, 9000, "", [h, ["p", pk(stranger), "moderator"]]))).msg).toMatch(/only the owner appoints/);
    expect((await c.ok(ev(mod, 9000, "", [h, ["p", pk(mod2)]]))).msg).toMatch(/only the owner changes moderators/);
    expect((await c.ok(ev(mod, 9000, "", [h, ["p", pk(owner)]]))).msg).toMatch(/changes by transfer/);
    expect((await c.ok(ev(mod, 9001, "", [h, ["p", pk(owner)]]))).msg).toMatch(/owner cannot be removed/);
    expect((await c.ok(ev(mod, 9001, "", [h, ["p", pk(mod2)]]))).msg).toMatch(/only the owner removes moderators/);
    expect((await c.ok(ev(mod, 9001, "", [h, ["p", pk(alice)]]))).ok).toBe(true);
    expect((await rpc(host, owner, "listmembers")).result.members.some((m: any) => m.pubkey === pk(alice))).toBe(false);
    // Demotion by the owner.
    expect((await c.ok(ev(owner, 9000, "", [h, ["p", pk(mod2)]]))).ok).toBe(true);
    members = (await rpc(host, owner, "listmembers")).result.members;
    expect(members.find((m: any) => m.pubkey === pk(mod2)).role).toBe("member");

    expect((await c.ok(ev(mod, 9002, "", [h, ["name", "Nope"]]))).msg).toMatch(/moderators cannot do that/);
    expect((await c.ok(ev(owner, 9002, "", [h, ["name", "Mods"], ["about", "a tidy place"], ["picture", "https://x/i.png"]]))).ok).toBe(true);
    const d2 = await info(host);
    expect([d2.name, d2.description, d2.icon]).toEqual(["Mods", "a tidy place", "https://x/i.png"]);
    st = await state(c, doc.self);
    expect(st[39000]!.tags).toEqual(expect.arrayContaining([["name", "Mods"], ["about", "a tidy place"]]));

    // Alice was removed; re-add so she can post, then a moderator deletes her note.
    expect((await c.ok(ev(owner, 9000, "", [h, ["p", pk(alice)]]))).ok).toBe(true);
    const note = ev(alice, 1, "rude", [h]);
    expect((await c.ok(note)).ok).toBe(true);
    expect((await c.ok(ev(stranger, 9005, "", [h, ["e", note.id]]))).ok).toBe(false);
    expect((await c.ok(ev(mod, 9005, "", [h, ["e", note.id]]))).ok).toBe(true);
    expect((await c.req({ ids: [note.id] })).length).toBe(0);
    const roster = (await c.req({ kinds: [13534], authors: [doc.self] }))[0];
    expect((await c.ok(ev(mod, 9005, "", [h, ["e", roster.id]]))).msg).toMatch(/relay's own records/);

    expect((await c.ok(ev(mod, 9009, "come along", [h, ["code", "party-2026"]]))).ok).toBe(true);
    expect((await rpc(host, owner, "listinvites")).result.some((i: any) => i.code === "party-2026" && i.note === "come along")).toBe(true);
    expect((await c.ok(ev(mod, 9009, "", [h, ["code", "party-2026"]]))).msg).toMatch(/^duplicate:/);
    expect((await c.ok(ev(mod, 9009, "", [h, ["code", "x"]]))).msg).toMatch(/^invalid:/);
    await rpc(host, owner, "setpolicy", { writes: "allowlist" });
    expect((await c.ok(ev(stranger, 9021, "", [h, ["code", "party-2026"]]))).ok).toBe(true);

    expect((await c.ok(ev(owner, 9007, "", [h]))).msg).toMatch(/^unsupported:/);
    expect((await c.ok(ev(owner, 9008, "", [h]))).msg).toMatch(/^unsupported:/);
    expect((await c.ok(ev(owner, 9010, "", [h]))).msg).toMatch(/^unsupported:/);
    expect((await c.ok(ev(owner, 39000, "", [["d", "mod"], ["name", "forged"]]))).msg).toMatch(/written by the relay/);
  });

  it("gives a moderator the NIP-86 methods for keeping the peace and nothing else", async () => {
    const host = "team.bind.ws";
    const owner = generateSecretKey();
    const mod = generateSecretKey();
    const mod2 = generateSecretKey();
    const alice = generateSecretKey();
    const pk = getPublicKey;
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", pk(alice), { name: "alice" });
    expect((await rpc(host, mod, "stats")).status).toBe(403);
    await rpc(host, owner, "setmember", pk(mod), { role: "moderator" });
    await rpc(host, owner, "setmember", pk(mod2), { role: "moderator" });
    expect((await rpc(host, owner, "listmembers")).result.members.map((m: any) => m.role)).toEqual(["owner", "moderator", "moderator", "member"]);

    expect((await rpc(host, mod, "stats")).status).toBe(200);
    expect((await rpc(host, mod, "getpolicy")).status).toBe(200);
    expect((await rpc(host, mod, "listreports")).status).toBe(200);
    expect((await rpc(host, mod, "setmember", pk(alice), { note: "ok" })).status).toBe(200);
    expect((await rpc(host, mod, "setmember", pk(alice), { role: "moderator" })).error).toMatch(/only the owner sets roles/);
    expect((await rpc(host, mod, "setmember", pk(mod2), { note: "x" })).status).toBe(403);
    expect((await rpc(host, mod, "removemember", pk(mod2))).status).toBe(403);
    expect((await rpc(host, mod, "banpubkey", pk(mod2), "grr")).status).toBe(403);
    expect((await rpc(host, mod, "banpubkey", pk(owner), "grr")).status).toBe(400);
    for (const m of ["setpolicy", "storagestats", "exportconfig", "pullstatus", "deleterelay", "changerelayname", "resetrules"]) {
      const r = await rpc(host, mod, m, "x");
      expect(r.status, m).toBe(403);
      expect(r.error, m).toMatch(/moderators cannot do that/);
    }
    expect((await rpc(host, mod, "transferowner", pk(mod))).status).toBe(403);
    expect((await rpc(host, mod, "banpubkey", pk(alice), "rude")).status).toBe(200);
    expect((await rpc(host, mod, "listbannedpubkeys")).result.map((b: any) => b.pubkey)).toEqual([pk(alice)]);
    const inv = await rpc(host, mod, "createinvite", 3600, 0, "");
    expect(inv.status).toBe(200);
    expect((await rpc(host, mod, "revokeinvite", inv.result.code)).result).toBe(true);
    // Demoted, the door closes again.
    await rpc(host, owner, "setmember", pk(mod), { role: "member" });
    expect((await rpc(host, mod, "stats")).status).toBe(403);
  });
});

describe("ownership transfer", () => {
  it("hands the relay to a member and keeps the old owner on as a moderator", async () => {
    const host = "handover.bind.ws";
    const owner = generateSecretKey();
    const bob = generateSecretKey();
    const pk = getPublicKey;
    await rpc(host, owner, "claim");
    const before = await info(host);
    expect((await rpc(host, owner, "transferowner", pk(bob))).error).toMatch(/must be a member first/);
    expect((await rpc(host, owner, "transferowner", pk(owner))).status).toBe(400);
    await rpc(host, owner, "setmember", pk(bob), { name: "bob" });
    const r = await rpc(host, owner, "transferowner", pk(bob));
    expect(r.result).toEqual({ owner: pk(bob), previous: pk(owner) });

    const after = await info(host);
    expect(after.pubkey).toBe(pk(bob));
    expect(after.self).toBe(before.self);
    const members = (await rpc(host, bob, "listmembers")).result.members;
    expect(members.map((m: any) => [m.pubkey, m.role])).toEqual([[pk(bob), "owner"], [pk(owner), "moderator"]]);
    const c = await WS.connect(host);
    const st = await state(c, after.self);
    expect(tagsOf(st[39001]!, "p")).toEqual([["p", pk(bob), "owner"], ["p", pk(owner), "moderator"]]);
    const roster = (await c.req({ kinds: [13534], authors: [after.self] }))[0];
    expect(tagsOf(roster, "member")).toEqual(expect.arrayContaining([["member", pk(bob), "owner"], ["member", pk(owner), "moderator"]]));

    expect((await rpc(host, owner, "setpolicy", { writes: "owner" })).status).toBe(403);
    expect((await rpc(host, bob, "setpolicy", { writes: "owner" })).status).toBe(200);
    expect((await rpc(host, owner, "banpubkey", pk(bob), "")).status).toBe(400);
    expect((await rpc(host, bob, "banpubkey", pk(owner), "")).status).toBe(200);
    expect((await rpc(host, owner, "stats")).status).toBe(403);
  });
});
