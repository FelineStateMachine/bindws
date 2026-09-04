// A websocket client for the Durable Object tests: NIP-01 over an upgrade
// through the Worker, with the frames queued so a test reads them in order.
import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { Event } from "nostr-tools/pure";
import { ev } from "./relay.ts";

export class WS {
  private queue: any[][] = [];
  private waiters: ((m: any[]) => void)[] = [];
  private n = 0;
  challenge = "";
  closed: { code: number; reason: string } | null = null;
  frames: string[] = []; // every frame received, for leak checks
  constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      this.frames.push(e.data as string);
      const m = JSON.parse(e.data as string);
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
    });
  }
  // connect opens a socket, from an address when one is given, and reads the
  // AUTH challenge.
  static async connect(host: string, ip?: string): Promise<WS> {
    const c = await WS.tryConnect(host, ip);
    if (!c) throw new Error(`${host} refused the upgrade`);
    return c;
  }
  // tryConnect is connect for a socket the relay may refuse: null then.
  static async tryConnect(host: string, ip?: string): Promise<WS | null> {
    const headers: Record<string, string> = { upgrade: "websocket" };
    if (ip) headers["cf-connecting-ip"] = ip;
    const resp = await SELF.fetch(`http://${host}/`, { headers });
    if (!resp.webSocket) return null;
    const c = new WS(resp.webSocket);
    c.challenge = (await c.expect("AUTH"))[1];
    return c;
  }
  send(...m: unknown[]) {
    this.ws.send(JSON.stringify(m));
  }
  raw(s: string) {
    this.ws.send(s);
  }
  recv(): Promise<any[]> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((res) => this.waiters.push(res));
  }
  // recvOr resolves null when nothing arrives within ms.
  recvOr(ms: number): Promise<any[] | null> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((res) => {
      this.waiters.push(res);
      setTimeout(() => {
        const i = this.waiters.indexOf(res);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          res(null);
        }
      }, ms);
    });
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
  // auth proves a key over the socket.
  async auth(sk: Uint8Array, host: string) {
    this.send("AUTH", ev(sk, 22242, "", [["relay", "ws://" + host], ["challenge", this.challenge]]));
    const m = await this.expect("OK");
    expect(m[2], m[3]).toBe(true);
  }
  // query is a one-shot subscription: unique id, closed after EOSE so it
  // never leaks live pushes into a later query. The events and "" on EOSE,
  // or the CLOSED reason.
  async query(filter: unknown) {
    const id = "q" + ++this.n;
    const r = await this.open(id, filter);
    if (!r.closed) this.send("CLOSE", id);
    return r;
  }
  // req is query for a subscription that must be accepted: the events.
  async req(filter: unknown): Promise<Event[]> {
    const r = await this.query(filter);
    if (r.closed) throw new Error(r.closed);
    return r.events;
  }
  // open subscribes under a given id and stays subscribed: the stored events
  // and "" on EOSE, or the CLOSED reason.
  async open(id: string, ...filters: unknown[]) {
    this.send("REQ", id, ...filters);
    const events: Event[] = [];
    const held: any[][] = []; // frames for other subscriptions, kept in order
    const done = (closed: string) => {
      this.queue.unshift(...held);
      return { events, closed };
    };
    for (;;) {
      const m = await this.recv();
      if (m[0] === "EVENT" && m[1] === id) events.push(m[2]);
      else if (m[0] === "EOSE" && m[1] === id) return done("");
      else if (m[0] === "CLOSED" && m[1] === id) return done(m[2] as string);
      else if (m[0] === "EVENT" || m[0] === "CLOSED") held.push(m);
      else throw new Error(JSON.stringify(m));
    }
  }
  // count asks for a COUNT: the number and "" or the CLOSED reason.
  async count(filter: unknown, id = "c" + ++this.n) {
    this.send("COUNT", id, filter);
    const m = await this.recv();
    return m[0] === "COUNT" ? { count: m[2].count as number, closed: "" } : { count: -1, closed: m[2] as string };
  }
  // sync opens a NIP-77 reconciliation and returns the NEG-ERR reason, or "".
  async sync(id: string, filter: unknown) {
    this.send("NEG-OPEN", id, filter, "61");
    const m = await this.recv();
    return m[0] === "NEG-ERR" ? (m[2] as string) : "";
  }
}
