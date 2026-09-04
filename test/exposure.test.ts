// The read rule, door by door. A members-only relay with the directory off
// holds a named member, her note and her file. A stranger and a signed-in
// non-member then knock on every path the relay answers, over HTTP and the
// socket, and nothing that names her, her note or her file may come back.
// Then she asks, and it all does. This is the test that keeps the next
// door honest: add a path here when you add one to the relay.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { npubEncode } from "nostr-tools/nip19";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "../src/negentropy.ts";
import { VIEWS } from "../src/views.ts";

const now = () => Math.floor(Date.now() / 1000);
const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = []) => finalizeEvent({ kind, content, tags, created_at: now() }, sk);
const pk = (sk: Uint8Array) => getPublicKey(sk);

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}

// nip98 signs a GET or a body-less request for the exact URL.
const nip98 = (sk: Uint8Array, url: string, method = "GET") => getToken(url, method, (e) => finalizeEvent(e, sk), true);
// nip98Body signs a request with a body, for the bridge.
const nip98Body = (sk: Uint8Array, url: string, method: string, body: unknown) => getToken(url, method, (e) => finalizeEvent(e, sk), true, body as object);
// blossom mints a kind 24242 token for an action, optionally naming a hash.
const blossom = (sk: Uint8Array, action: string, sha?: string) =>
  "Nostr " + btoa(JSON.stringify(ev(sk, 24242, action, [["t", action], ...(sha ? [["x", sha]] : []), ["expiration", String(now() + 300)]])));

class WS {
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  challenge = "";
  frames: string[] = []; // every frame received, for the leak check
  constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      this.frames.push(e.data as string);
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
  async auth(sk: Uint8Array, host: string) {
    this.send("AUTH", ev(sk, 22242, "", [["relay", "ws://" + host], ["challenge", this.challenge]]));
    const m = await this.expect("OK");
    expect(m[2], m[3]).toBe(true);
  }
  async ok(e: Event) {
    this.send("EVENT", e);
    const m = await this.expect("OK");
    return { ok: m[2] as boolean, msg: m[3] as string };
  }
  // open subscribes and returns the events plus "" on EOSE, or the CLOSED reason.
  async open(id: string, ...filters: unknown[]) {
    this.send("REQ", id, ...filters);
    const events: Event[] = [];
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EVENT" && m[1] === id) events.push(m[2]);
      else if (m[0] === "EOSE" && m[1] === id) return { events, closed: "" };
      else if (m[0] === "CLOSED" && m[1] === id) return { events, closed: m[2] as string };
      else throw new Error(JSON.stringify(m));
    }
  }
  async count(id: string, filter: unknown) {
    this.send("COUNT", id, filter);
    const m = await this.recv();
    return m[0] === "COUNT" ? { count: m[2].count as number, closed: "" } : { count: -1, closed: m[2] as string };
  }
  async sync(id: string, filter: unknown) {
    this.send("NEG-OPEN", id, filter, "61");
    const m = await this.recv();
    return m[0] === "NEG-ERR" ? (m[2] as string) : "";
  }
}

interface Fixture {
  host: string;
  owner: Uint8Array;
  eve: Uint8Array;
  stranger: Uint8Array;
  sha: string;
  noteId: string;
  secrets: string[];
}

async function seed(host: string): Promise<Fixture> {
  const owner = generateSecretKey();
  const eve = generateSecretKey();
  const stranger = generateSecretKey();
  await rpc(host, owner, "claim");
  expect((await rpc(host, owner, "setmember", pk(eve), { name: "evelynq7" })).status).toBe(200);
  const body = new TextEncoder().encode("eve's quarterly numbers");
  const sha = bytesToHex(sha256(body));
  const up = await SELF.fetch(`http://${host}/upload`, { method: "PUT", headers: { authorization: blossom(eve, "upload", sha), "content-type": "text/plain" }, body });
  expect([200, 201]).toContain(up.status);
  const c = await WS.connect(host);
  const note = ev(eve, 1, "the numbers are in");
  expect((await c.ok(note)).ok).toBe(true);
  c.ws.close();
  await rpc(host, owner, "setpolicy", { reads: "members", writes: "allowlist", directoryPublic: false });
  return { host, owner, eve, stranger, sha, noteId: note.id, secrets: [pk(eve), npubEncode(pk(eve)), note.id, sha, "evelynq7"] };
}

// Every HTTP path a relay answers that could carry something of a member's.
function doors(f: Fixture): { path: string; method?: string; gated: boolean; blossom?: string }[] {
  return [
    { path: "/", gated: false },
    { path: "/people", gated: false },
    { path: "/.well-known/nostr.json", gated: false },
    { path: "/.well-known/nostr.json?name=nobodyq7", gated: false },
    { path: `/list/${pk(f.eve)}`, gated: true, blossom: "list" },
    { path: `/${f.sha}`, gated: true, blossom: "get" },
    { path: `/${f.sha}`, method: "HEAD", gated: true, blossom: "get" },
    { path: `/nip96/${f.sha}`, gated: true, blossom: "get" },
    { path: "/nip96?page=0", gated: true },
    ...VIEWS.map((v) => ({ path: `/view/${v.name}`, gated: true })),
    { path: "/fuel", gated: false },
    { path: "/card.json", gated: false },
    { path: "/card.nostr", gated: false },
    { path: "/card.svg", gated: false },
    { path: `/e/${f.noteId}`, gated: false },
    { path: `/feed.xml?author=${pk(f.eve)}`, gated: false },
    { path: "/terms", gated: false },
    { path: "/api/join-policy", gated: false },
    { path: "/.well-known/nostr/nip96.json", gated: false },
  ];
}

// leaks returns which secrets appear in a text.
const leaks = (text: string, secrets: string[]) => secrets.filter((s) => text.includes(s));

describe("the read rule at every door", () => {
  it("shows a stranger nothing of a member, her note or her file", async () => {
    const f = await seed("exposure-stranger.bind.ws");
    for (const d of doors(f)) {
      const resp = await SELF.fetch(`http://${f.host}${d.path}`, { method: d.method ?? "GET" });
      const text = await resp.text();
      expect(leaks(text, f.secrets), `${d.method ?? "GET"} ${d.path} -> ${resp.status}`).toEqual([]);
      if (d.gated) expect(resp.status, d.path).toBe(401);
    }
    // The information document names the owner and the relay, nothing else.
    const info = await SELF.fetch(`http://${f.host}/`, { headers: { accept: "application/nostr+json" } });
    const doc = await info.json<any>();
    expect(doc.pubkey).toBe(pk(f.owner));
    expect(leaks(JSON.stringify(doc), f.secrets)).toEqual([]);
    for (const v of doc.views) expect(v.audience, v.name).toBe("members");
    // Pages and the feed are gone, not just empty.
    expect((await SELF.fetch(`http://${f.host}/e/${f.noteId}`)).status).toBe(404);
    expect((await SELF.fetch(`http://${f.host}/feed.xml`)).status).toBe(404);
    // A report about her file from a stranger is refused before the hash is looked up.
    const report = ev(f.stranger, 1984, "", [["x", f.sha, "spam"]]);
    const filed = await SELF.fetch(`http://${f.host}/report`, { method: "PUT", body: JSON.stringify(report) });
    expect(filed.status).toBe(403);
    const other = ev(f.stranger, 1984, "", [["x", "ab".repeat(32), "spam"]]);
    expect((await SELF.fetch(`http://${f.host}/report`, { method: "PUT", body: JSON.stringify(other) })).status).toBe(403);
    // The bridge without a signature.
    for (const path of ["/query", "/count"]) {
      const resp = await SELF.fetch(`http://${f.host}${path}`, { method: "POST", body: JSON.stringify([{ authors: [pk(f.eve)] }]) });
      expect(resp.status).toBe(401);
      expect(leaks(await resp.text(), f.secrets)).toEqual([]);
    }

    // The socket: REQ, COUNT and NEG-OPEN are refused. Signer traffic is the
    // one exception, and only to a filter that already names her key: the
    // payload is ciphertext, and NIP-46 clients and signers never AUTH.
    const c = await WS.connect(f.host);
    expect((await c.open("r", { authors: [pk(f.eve)] })).closed).toMatch(/^auth-required/);
    expect((await c.count("n", { authors: [pk(f.eve)] })).closed).toMatch(/^auth-required/);
    expect(await c.sync("s", { authors: [pk(f.eve)] })).toMatch(/^auth-required/);
    expect((await c.open("nc", { kinds: [24133] })).closed).toBe("");
    const sender = await WS.connect(f.host);
    expect((await sender.ok(ev(generateSecretKey(), 24133, "ciphertext", [["p", pk(f.eve)]]))).ok).toBe(true);
    // A later round trip proves no EVENT frame was queued in between.
    expect((await c.open("probe", { kinds: [24133] })).events).toEqual([]);
    expect(leaks(c.frames.join("\n"), f.secrets.filter((s) => s !== pk(f.eve)))).toEqual([]);
  });

  it("shows a signed-in non-member the same nothing, with 403 where the stranger got 401", async () => {
    const f = await seed("exposure-outsider.bind.ws");
    for (const d of doors(f)) {
      const url = `http://${f.host}${d.path}`;
      const method = d.method ?? "GET";
      const headers = { authorization: await nip98(f.stranger, url, method) };
      const resp = await SELF.fetch(url, { method, headers });
      expect(leaks(await resp.text(), f.secrets), `${method} ${d.path} -> ${resp.status}`).toEqual([]);
      if (d.gated) expect(resp.status, d.path).toBe(403);
      if (d.blossom) {
        const withToken = await SELF.fetch(url, { method, headers: { authorization: blossom(f.stranger, d.blossom, d.blossom === "get" ? f.sha : undefined) } });
        expect(withToken.status, `${d.path} with a Blossom ${d.blossom} token`).toBe(403);
        expect(leaks(await withToken.text(), f.secrets)).toEqual([]);
      }
    }
    for (const path of ["/query", "/count"]) {
      const url = `http://${f.host}${path}`;
      const body = [{ authors: [pk(f.eve)] }];
      const resp = await SELF.fetch(url, { method: "POST", headers: { authorization: await nip98Body(f.stranger, url, "POST", body) }, body: JSON.stringify(body) });
      expect(resp.status, path).toBe(403);
      expect(leaks(await resp.text(), f.secrets)).toEqual([]);
    }
    const c = await WS.connect(f.host);
    await c.auth(f.stranger, f.host);
    expect((await c.open("r", { authors: [pk(f.eve)] })).closed).toMatch(/^restricted/);
    expect((await c.count("n", { authors: [pk(f.eve)] })).closed).toMatch(/^restricted/);
    expect(await c.sync("s", { authors: [pk(f.eve)] })).toMatch(/^restricted/);
    expect(leaks(c.frames.join("\n"), f.secrets.filter((s) => s !== pk(f.eve)))).toEqual([]);
  });

  it("answers the member herself at every one of them", async () => {
    const f = await seed("exposure-member.bind.ws");
    const get = async (path: string, auth: string) => {
      const resp = await SELF.fetch(`http://${f.host}${path}`, { headers: { authorization: auth } });
      return { status: resp.status, text: await resp.text() };
    };
    const url = (path: string) => `http://${f.host}${path}`;
    // Her file, with a Blossom get token and with NIP-98.
    let r = await get(`/${f.sha}`, blossom(f.eve, "get", f.sha));
    expect(r.status).toBe(200);
    expect(r.text).toBe("eve's quarterly numbers");
    r = await get(`/${f.sha}`, await nip98(f.eve, url(`/${f.sha}`)));
    expect(r.status).toBe(200);
    // A get token naming another blob does not open this one.
    expect((await get(`/${f.sha}`, blossom(f.eve, "get", "ab".repeat(32)))).status).toBe(401);
    r = await get(`/list/${pk(f.eve)}`, blossom(f.eve, "list"));
    expect(r.status).toBe(200);
    expect(r.text).toContain(f.sha);
    r = await get(`/.well-known/nostr.json`, await nip98(f.eve, url(`/.well-known/nostr.json`)));
    expect(JSON.parse(r.text).names.evelynq7).toBe(pk(f.eve));
    // Her name resolves for anyone: she published that address herself.
    expect(JSON.parse((await get(`/.well-known/nostr.json?name=evelynq7`, "")).text).names.evelynq7).toBe(pk(f.eve));
    for (const v of VIEWS) {
      r = await get(`/view/${v.name}`, await nip98(f.eve, url(`/view/${v.name}`)));
      expect([200, 404], `${v.name} -> ${r.status} ${r.text}`).toContain(r.status);
    }
    r = await get(`/people`, await nip98(f.eve, url(`/people`)));
    expect(JSON.parse(r.text).people.map((m: any) => m.pubkey)).toContain(pk(f.eve));
    const c = await WS.connect(f.host);
    await c.auth(f.eve, f.host);
    expect((await c.open("r", { authors: [pk(f.eve)] })).events.map((e) => e.id)).toEqual([f.noteId]);
  });

  it("closes the subscriptions a tightened read rule no longer admits", async () => {
    const host = "exposure-tighten.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const bystander = await WS.connect(host);
    expect((await bystander.open("feed", { kinds: [1] })).closed).toBe("");
    const signer = await WS.connect(host);
    expect((await signer.open("nc", { kinds: [24133] })).closed).toBe("");
    await rpc(host, owner, "setpolicy", { reads: "members" });
    const closed = await bystander.expect("CLOSED");
    expect(closed[1]).toBe("feed");
    expect(closed[2]).toMatch(/^auth-required/);
    // The signer's 24133-only subscription stays open, and a fresh probe shows nothing else is queued for it.
    expect((await signer.open("probe", { kinds: [24133] })).closed).toBe("");
    // A stored note published after the change never reaches the bystander.
    const member = generateSecretKey();
    await rpc(host, owner, "allowpubkey", pk(member));
    const m = await WS.connect(host);
    expect((await m.ok(ev(member, 1, "after"))).ok).toBe(true);
    expect((await bystander.open("again", { kinds: [1] })).closed).toMatch(/^auth-required/);
    expect(bystander.frames.filter((x) => x.includes('"EVENT"'))).toEqual([]);
  });

  it("files follow the other two read rules the same way: anyone, then any signature", async () => {
    const host = "exposure-rules.bind.ws";
    const owner = generateSecretKey();
    const stranger = generateSecretKey();
    await rpc(host, owner, "claim");
    const body = new TextEncoder().encode("a public file");
    const sha = bytesToHex(sha256(body));
    await SELF.fetch(`http://${host}/upload`, { method: "PUT", headers: { authorization: blossom(owner, "upload", sha), "content-type": "text/plain" }, body });
    // Anyone: a public link by hash, cacheable.
    let resp = await SELF.fetch(`http://${host}/${sha}`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("cache-control")).toContain("public");
    expect((await SELF.fetch(`http://${host}/list/${pk(owner)}`)).status).toBe(200);
    // Signed in: any valid signature, member or not; no signature is 401; not for shared caches.
    await rpc(host, owner, "setpolicy", { reads: "auth" });
    expect((await SELF.fetch(`http://${host}/${sha}`)).status).toBe(401);
    resp = await SELF.fetch(`http://${host}/${sha}`, { headers: { authorization: blossom(stranger, "get", sha) } });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("cache-control")).toContain("no-store");
    expect((await SELF.fetch(`http://${host}/list/${pk(owner)}`, { headers: { authorization: blossom(stranger, "list") } })).status).toBe(200);
    // A token for the wrong action, or a malformed one, is refused with the reason rather than served as a stranger.
    resp = await SELF.fetch(`http://${host}/${sha}`, { headers: { authorization: blossom(stranger, "upload", sha) } });
    expect(resp.status).toBe(401);
    expect(resp.headers.get("x-reason")).toMatch(/not for get/);
    expect((await SELF.fetch(`http://${host}/${sha}`, { headers: { authorization: "Nostr nonsense" } })).status).toBe(401);
  });

  it("copies files between names on this host only from a relay that lets anyone read", async () => {
    const host = "exposure-copy.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    const { env } = await import("cloudflare:test");
    const stub = env.RELAY.getByName("exposure-copy");
    expect(Array.isArray(await stub.listBlobs([]))).toBe(true);
    await rpc(host, owner, "setpolicy", { reads: "members" });
    expect(await stub.listBlobs([])).toMatch(/^auth-required/);
    expect(await stub.listBlobs([pk(generateSecretKey())])).toMatch(/^restricted/);
    expect(Array.isArray(await stub.listBlobs([pk(owner)]))).toBe(true);
  });
});
