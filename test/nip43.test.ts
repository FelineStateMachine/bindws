// NIP-43, the rest of it: the relay's own profile, role definitions, roles
// in the roster, the NIP-43 join and leave requests, and the promise that
// the roster and the NIP-29 group never disagree, whichever path changed
// the members.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";

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

const info = async (host: string) => (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();

class WS {
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  challenge = "";
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
    c.challenge = (await c.expect("AUTH"))[1];
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
  async auth(sk: Uint8Array, host: string) {
    this.send("AUTH", ev(sk, 22242, "", [["relay", "ws://" + host], ["challenge", this.challenge]]));
    const m = await this.expect("OK");
    expect(m[2], m[3]).toBe(true);
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

describe("relay profile and roles", () => {
  it("signs a kind 0 for the self key, role definitions, and roles in the roster", async () => {
    const host = "profile.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const self = (await info(host)).self as string;
    const c = await WS.connect(host);

    let profile = await c.req({ kinds: [0], authors: [self] });
    expect(profile.length).toBe(1);
    expect(JSON.parse(profile[0].content)).toEqual({ name: "profile", about: "" });
    await rpc(host, owner, "changerelayname", "Pizza");
    await rpc(host, owner, "setpolicy", { description: "pies", icon: "https://img.example/pizza.png" });
    profile = await c.req({ kinds: [0], authors: [self] });
    expect(profile.length).toBe(1);
    expect(JSON.parse(profile[0].content)).toEqual({ name: "Pizza", about: "pies", picture: "https://img.example/pizza.png" });

    const roles = await c.req({ kinds: [33534], authors: [self] });
    expect(roles.map((e) => tagsOf(e, "d")[0][1]).sort()).toEqual(["moderator", "owner"]);
    for (const r of roles) {
      expect(tagsOf(r, "-").length).toBe(1);
      expect(tagsOf(r, "label")[0][1]).toBe(tagsOf(r, "d")[0][1]);
      expect(tagsOf(r, "description")[0][1]).not.toBe("");
    }

    const alice = generateSecretKey();
    await rpc(host, owner, "setmember", pk(alice), {});
    let roster = (await c.req({ kinds: [13534], authors: [self] }))[0];
    expect(roster.tags).toContainEqual(["member", pk(owner), "owner"]);
    expect(roster.tags).toContainEqual(["member", pk(alice)]);

    // A role change must show in the roster and the admins list alike.
    await rpc(host, owner, "setmember", pk(alice), { role: "moderator" });
    roster = (await c.req({ kinds: [13534], authors: [self] }))[0];
    expect(roster.tags).toContainEqual(["member", pk(alice), "moderator"]);
    const admins = (await c.req({ kinds: [39001], authors: [self] }))[0];
    expect(admins.tags).toContainEqual(["p", pk(alice), "moderator"]);
  });
});

describe("roster and group agreement", () => {
  it("keeps 13534, 39001 and 39002 in step with the member table through every path", async () => {
    const host = "instep.bind.ws";
    const owner = generateSecretKey();
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const carol = generateSecretKey();
    const dave = generateSecretKey();
    const erin = generateSecretKey();
    const h = ["h", "instep"];
    await rpc(host, owner, "claim");
    const self = (await info(host)).self as string;
    const c = await WS.connect(host);

    // expected: pubkey -> role, maintained by the test as it walks the paths
    const want = new Map<string, string>([[pk(owner), "owner"]]);
    let step = 0;
    async function check() {
      step++;
      const [roster] = await c.req({ kinds: [13534], authors: [self] });
      const [admins] = await c.req({ kinds: [39001], authors: [self] });
      const [members] = await c.req({ kinds: [39002], authors: [self] });
      const fromRoster = new Map(tagsOf(roster, "member").map((t) => [t[1], t[2] ?? "member"]));
      expect(fromRoster, `roster at step ${step}`).toEqual(want);
      expect(new Set(tagsOf(members, "p").map((t) => t[1])), `members at step ${step}`).toEqual(new Set(want.keys()));
      const wantAdmins = new Map([...want].filter(([, r]) => r !== "member"));
      expect(new Map(tagsOf(admins, "p").map((t) => [t[1], t[2]])), `admins at step ${step}`).toEqual(wantAdmins);
      const listed = (await rpc(host, sk(want), "listallowedpubkeys")).result.map((m: any) => m.pubkey).sort();
      expect(listed, `listmembers at step ${step}`).toEqual([...want.keys()].filter((p) => want.get(p) !== "owner").sort());
    }
    const keys = { [pk(owner)]: owner, [pk(alice)]: alice, [pk(bob)]: bob, [pk(carol)]: carol, [pk(dave)]: dave, [pk(erin)]: erin };
    const sk = (m: Map<string, string>) => keys[[...m].find(([, r]) => r === "owner")![0]];
    await check();

    await rpc(host, owner, "setmember", pk(alice), {});
    want.set(pk(alice), "member");
    await check();

    expect((await c.ok(ev(bob, 9021, "", [h]))).ok).toBe(true);
    want.set(pk(bob), "member");
    await check();

    await rpc(host, owner, "setmember", pk(alice), { role: "moderator" });
    want.set(pk(alice), "moderator");
    await check();

    expect((await c.ok(ev(bob, 9022, "", [h]))).ok).toBe(true);
    want.delete(pk(bob));
    await check();

    await rpc(host, owner, "setmember", pk(carol), {});
    await rpc(host, owner, "banpubkey", pk(carol), "spam");
    await check();

    await rpc(host, owner, "setmember", pk(dave), {});
    await rpc(host, owner, "removemember", pk(dave));
    await check();

    expect((await c.ok(ev(owner, 9000, "", [h, ["p", pk(dave), "moderator"]]))).ok).toBe(true);
    want.set(pk(dave), "moderator");
    await check();
    expect((await c.ok(ev(owner, 9001, "", [h, ["p", pk(dave)]]))).ok).toBe(true);
    want.delete(pk(dave));
    await check();

    expect((await rpc(host, owner, "transferowner", pk(alice))).status).toBe(200);
    want.set(pk(alice), "owner");
    want.set(pk(owner), "moderator");
    await check();

    const cfg = (await rpc(host, alice, "exportconfig")).result;
    cfg.members = [{ pubkey: pk(erin), name: null, note: "" }];
    expect((await rpc(host, alice, "importconfig", cfg)).status).toBe(200);
    want.delete(pk(owner));
    want.set(pk(erin), "member");
    await check();
    // The import announced who came and who went.
    expect((await c.req({ kinds: [8000], authors: [self], "#p": [pk(erin)] })).length).toBe(1);
    expect((await c.req({ kinds: [8001], authors: [self], "#p": [pk(owner)] })).length).toBe(1);
    expect((await c.req({ kinds: [9001], authors: [self], "#p": [pk(owner)] })).length).toBe(1);
  });
});

describe("NIP-43 join and leave requests", () => {
  it("admits with a claim, refuses bad codes, and revokes on request", async () => {
    const host = "fortythree.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { writes: "allowlist" });
    const code = (await rpc(host, owner, "createinvite", 3600, 0, "friends")).result.code as string;
    const sam = generateSecretKey();
    const c = await WS.connect(host);

    // NIP-70: a "-" tagged request needs the socket authenticated.
    expect((await c.ok(ev(sam, 28934, "", [["-"], ["claim", code]]))).msg).toMatch(/^auth-required/);
    await c.auth(sam, host);
    let r = await c.ok(ev(sam, 28934, "", [["-"], ["claim", "nope"]]));
    expect(r.ok).toBe(false);
    expect(r.msg).toBe("restricted: that is an invalid invite code.");
    r = await c.ok(ev(sam, 28934, "", [["-"]]));
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/^restricted: a join request needs a claim/);
    r = await c.ok(ev(sam, 28934, "", [["-"], ["claim", code]]));
    expect(r.ok).toBe(true);
    expect(r.msg).toBe("info: welcome to fortythree!");
    expect((await rpc(host, owner, "listallowedpubkeys")).result.map((m: any) => m.pubkey)).toContain(pk(sam));
    r = await c.ok(ev(sam, 28934, "", [["-"], ["claim", code]]));
    expect(r.ok).toBe(true);
    expect(r.msg).toMatch(/^duplicate: you are already a member/);
    // Requests are ephemeral: nothing was stored.
    expect((await c.req({ kinds: [28934] })).length).toBe(0);

    r = await c.ok(ev(sam, 28936, "", [["-"]]));
    expect(r.ok).toBe(true);
    expect(r.msg).toBe("info: access revoked.");
    expect((await rpc(host, owner, "listallowedpubkeys")).result.map((m: any) => m.pubkey)).not.toContain(pk(sam));
    r = await c.ok(ev(sam, 28936, "", [["-"]]));
    expect(r.ok).toBe(true);
    expect(r.msg).toMatch(/^duplicate: you are not a member/);
    // The owner cannot leave.
    const o = await WS.connect(host);
    await o.auth(owner, host);
    expect((await o.ok(ev(owner, 28936, "", [["-"]]))).msg).toMatch(/^restricted: the owner cannot leave/);
  });
});
