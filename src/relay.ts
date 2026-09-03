// The relay: one Durable Object per name, holding its SQLite database and
// its live websockets (hibernating while idle). Protocol handling mirrors
// relay.go; policy is per relay and owner-managed (see manage.ts).
import { DurableObject } from "cloudflare:workers";
import { sha256 } from "@noble/hashes/sha2.js";
import { KIND_AUTH, KIND_VANISH, difficulty, expiration, hasTag, isPrivate, now, tagValues, validate, canonical, type Event } from "./event.ts";
import { match, parseFilter, type Filter } from "./filter.ts";
import { hllOffset } from "./hll.ts";
import { Negentropy, bytesToHex, hexToBytes } from "./negentropy.ts";
import { ERR_DUPLICATE, ERR_TOO_BIG, Store, type Access } from "./store.ts";
import { Settings, isReplaceable, isProtected } from "./settings.ts";
import { manage } from "./manage.ts";
import { dashboard } from "./dashboard.ts";
import { Fuel, fuelConfig, fetchLnurl, requestInvoice, type Fetcher, type LnurlParams } from "./fuel.ts";
import { Identity } from "./identity.ts";
import { Bucket } from "./ratelimit.ts";
import { bridge } from "./bridge.ts";
import { blossom, blobBytes, isBlobPath } from "./blossom.ts";
import { claimFromProfile, nip05Document } from "./nip05.ts";
import { checkInvite, claimInvite, invitePage } from "./invites.ts";
import { verifyNIP98 } from "./manage.ts";
import { FAVICON_SVG } from "./ui.ts";

export interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  MEDIA: R2Bucket;
  DOMAIN: string;
  DEV_RELAY: string;
  // Fuel (see fuel.ts); all optional.
  LIGHTNING_ADDRESS?: string;
  SERVICE_PUBKEY?: string;
  FREE_EVENTS_MB?: string;
  FREE_MEDIA_MB?: string;
  FREE_ACTIVE_HOURS?: string;
  FREE_ROWS_WRITTEN?: string;
  SATS_PER_GB_MONTH_EVENTS?: string;
  SATS_PER_GB_MONTH_MEDIA?: string;
  SATS_PER_ACTIVE_HOUR?: string;
  SATS_PER_MILLION_ROWS?: string;
}

export const SUPPORTED_NIPS = [1, 5, 9, 11, 13, 17, 40, 42, 45, 50, 56, 59, 62, 67, 70, 77, 86, 98];
export const KIND_REPORT = 1984;
export const SOFTWARE = "https://bind.ws";
export const VERSION = "0.1.0";
export const MAX_MESSAGE = 128 * 1024;
const FAVICON = FAVICON_SVG;
const MAX_SYNC = 100_000;

// ConnState is everything about a websocket that must survive hibernation.
interface ConnState {
  challenge: string;
  host: string; // Host header, for NIP-42 relay-tag checks
  authed: string[];
  subs: Record<string, Filter[]>;
}

const FLUSH_BYTES = 256 * 1024;
const LNURL_TTL = 24 * 3600;
// How long Cloudflare keeps an idle object awake before hibernating it.
const IDLE_GRACE_MS = 10_000;

export class Relay extends DurableObject<Env> {
  store: Store;
  settings: Settings;
  fuel: Fuel;
  identity: Identity;
  slug = "";
  private states = new Map<WebSocket, ConnState>();
  private syncs = new Map<WebSocket, Map<string, Negentropy>>();
  private buckets = new Map<WebSocket, { events: Bucket; reqs: Bucket }>();
  // Usage counters, flushed to the usage table in batches.
  private meter = { bytesIn: 0, bytesOut: 0, rowsRead: 0, rowsWritten: 0, activeMs: 0 };
  // When the object last did work, for the active-time meter (ms). Zero after a wake.
  private lastActive = 0;
  private lnurl: LnurlParams | null = null;
  // Outbound HTTP to the lightning provider; tests substitute a fake.
  fetcher: Fetcher = (u, i) => fetch(u, i);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    this.settings = new Settings(ctx.storage.sql);
    this.fuel = new Fuel(ctx.storage.sql, fuelConfig(env as unknown as Record<string, unknown>));
    this.identity = new Identity(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.store.init();
      this.settings.load();
      this.fuel.init();
      this.slug = (await ctx.storage.get<string>("slug")) ?? "";
      this.lnurl = (await ctx.storage.get<LnurlParams>("lnurl")) ?? null;
      await this.identity.load();
    });
  }

  get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  get media(): R2Bucket {
    return this.env.MEDIA;
  }

  // meterBytes lets HTTP paths (bridge, media) add to the traffic counters.
  meterBytes(bytesIn: number, bytesOut: number) {
    this.meter.bytesIn += bytesIn;
    this.meter.bytesOut += bytesOut;
  }

  // touch accounts for the object being awake. Cloudflare bills wall-clock
  // time from a wake until the object has been idle for about ten seconds
  // and hibernates, so each piece of work is charged the gap since the last
  // one, capped at that idle window, and a wake is charged the window once.
  private touch() {
    const t = Date.now();
    this.meter.activeMs += this.lastActive === 0 ? IDLE_GRACE_MS : Math.min(t - this.lastActive, IDLE_GRACE_MS);
    this.lastActive = t;
  }

  // ---- relay identity and the NIP-43 roster ----

  // publishRoster signs the current member list as kind 13534 and, when a
  // single change is given, the matching 8000/8001 delta, and fans both out.
  async publishRoster(change?: { added: boolean; pubkey: string }) {
    if (this.settings.policy.owner === "") return;
    await this.identity.ensure();
    const t = now();
    const events: Event[] = [];
    if (change) events.push(this.identity.delta(change.added, change.pubkey));
    events.push(this.identity.roster(this.settings.members(), t));
    for (const e of events) {
      const err = this.store.save(e, t);
      if (!err) this.broadcast(e);
    }
  }

  // setMember edits or adds a person and publishes the roster if membership changed.
  async setMember(pubkey: string, patch: { name?: string | null; note?: string; via?: string }, force = false): Promise<string> {
    const was = this.settings.isAllowed(pubkey);
    const err = this.settings.upsertMember(pubkey, patch, now(), force);
    if (err) return err;
    if (!was) await this.publishRoster({ added: true, pubkey });
    return "";
  }

  async removeMember(pubkey: string): Promise<boolean> {
    if (!this.settings.removeMember(pubkey)) return false;
    if (this.settings.policy.reads === "members") this.evict(pubkey, "restricted: this relay only serves its members", false);
    await this.publishRoster({ added: false, pubkey });
    return true;
  }

  async ban(pubkey: string, reason: string): Promise<void> {
    const was = this.settings.isAllowed(pubkey);
    this.settings.setBan(pubkey, true, reason, now());
    this.evict(pubkey, "blocked: you are banned from this relay", true);
    if (was) await this.publishRoster({ added: false, pubkey });
  }

  // evict closes the door on a pubkey: subscriptions are ended and, for a
  // ban, the socket is closed; hibernating sockets are covered too.
  evict(pubkey: string, reason: string, close: boolean) {
    for (const ws of this.ctx.getWebSockets()) {
      const s = this.state(ws);
      if (!s.authed.includes(pubkey)) continue;
      for (const id of Object.keys(s.subs)) this.send(ws, "CLOSED", id, reason);
      s.subs = {};
      this.persist(ws, s);
      if (close) {
        try {
          ws.close(4403, reason.slice(0, 120));
        } catch {
          /* already closed */
        }
      }
    }
  }

  // virtualConn represents an HTTP caller as if it had authenticated over the socket.
  virtualConn(host: string, pubkey: string): ConnState {
    return { challenge: "", host, authed: [pubkey], subs: {} };
  }

  isMember(pubkey: string): boolean {
    return this.settings.isAllowed(pubkey);
  }

  // mayUpload applies the write policy to Blossom uploads. "" allows.
  mayUpload(pubkey: string, host: string): string {
    const p = this.settings.policy;
    if (p.owner === "") return "restricted: this relay is unclaimed";
    if (this.settings.isBanned(pubkey)) return "blocked: this pubkey is banned from this relay";
    if (p.writes === "owner" && !this.settings.isOwner(pubkey)) return "restricted: only the relay owner may upload here";
    if (p.writes === "allowlist" && !this.settings.isAllowed(pubkey)) return "restricted: this relay only accepts uploads from its members";
    if (this.fuelStatus().outOfFuel) return "restricted: this relay is out of fuel; zap it at https://" + host + "/ to top up";
    return "";
  }

  // teardown deletes everything this relay holds and returns the name to
  // unclaimed. Every socket is closed. Nothing is recoverable afterwards.
  async teardown() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4410, "relay deleted");
      } catch {
        /* already closed */
      }
    }
    let cursor: string | undefined;
    do {
      const list = await this.media.list({ prefix: `${this.slug}/`, cursor });
      if (list.objects.length) await this.media.delete(list.objects.map((o) => o.key));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.states.clear();
    this.syncs.clear();
    this.buckets.clear();
    this.meter = { bytesIn: 0, bytesOut: 0, rowsRead: 0, rowsWritten: 0, activeMs: 0 };
    this.lnurl = null;
    this.store = new Store(this.sql);
    this.settings = new Settings(this.sql);
    this.fuel = new Fuel(this.sql, this.fuel.cfg);
    this.identity = new Identity(this.ctx.storage);
    this.store.init();
    this.settings.load();
    this.fuel.init();
    await this.ctx.storage.put("slug", this.slug);
  }

  async deleteBlob(sha: string) {
    await this.media.delete(`${this.slug}/${sha}`);
    this.sql.exec(`DELETE FROM blobs WHERE sha256=?`, sha);
  }

  // ---- fuel plumbing ----

  tally() {
    const d = this.store.drain();
    this.meter.rowsRead += d.rowsRead;
    this.meter.rowsWritten += d.rowsWritten;
    if (this.meter.bytesIn + this.meter.bytesOut > FLUSH_BYTES || this.meter.rowsRead + this.meter.rowsWritten > 5000) this.flushUsage();
  }

  flushUsage() {
    const m = this.meter;
    if (m.bytesIn + m.bytesOut + m.rowsRead + m.rowsWritten + m.activeMs === 0) return;
    this.meter = { bytesIn: 0, bytesOut: 0, rowsRead: 0, rowsWritten: 0, activeMs: 0 };
    this.fuel.record(now(), m);
    this.store.drain();
  }

  // Events live in the object's SQLite database; media in R2. Priced apart.
  eventBytes(): number {
    return this.store.databaseSize;
  }

  mediaBytes(): number {
    return blobBytes(this.sql);
  }

  fuelStatus() {
    this.flushUsage();
    return this.fuel.status(now(), this.eventBytes(), this.mediaBytes());
  }

  // ensureAlarm keeps a daily tick scheduled for storage charging and usage
  // flushes, without pre-empting a sooner NIP-40 expiry.
  private async ensureAlarm(latest = now() + 86400) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > latest * 1000) await this.ctx.storage.setAlarm(latest * 1000);
  }

  // lnurlParams fetches and caches the provider's LNURL-pay parameters.
  async lnurlParams(): Promise<LnurlParams> {
    const t = now();
    if (this.lnurl && this.lnurl.address === this.fuel.cfg.lightningAddress && t - this.lnurl.fetchedAt < LNURL_TTL) return this.lnurl;
    const p = await fetchLnurl(this.fuel.cfg.lightningAddress, this.fetcher);
    this.lnurl = p;
    await this.ctx.storage.put("lnurl", p);
    return p;
  }

  // acceptReceipt handles a kind 9735 that credits this relay. It stores the
  // receipt regardless of write policy (the provider is nobody's member) and
  // records the credit once. Returns null if the event is not fuel for us.
  private async acceptReceipt(e: Event, host: string): Promise<{ ok: boolean; msg: string; stored: boolean } | null> {
    if (!this.fuel.cfg.lightningAddress || !this.fuel.cfg.servicePubkey || this.settings.policy.owner === "") return null;
    let provider = "";
    try {
      provider = (await this.lnurlParams()).nostrPubkey;
    } catch {
      return null;
    }
    const v = this.fuel.validateReceipt(e, provider, host);
    if (typeof v === "string") {
      console.log(`receipt ${e.id.slice(0, 8)} from ${e.pubkey.slice(0, 8)} not credited: ${v}`);
      return null;
    }
    console.log(`receipt ${e.id.slice(0, 8)} credits ${Math.floor(v.msats / 1000)} sats from ${v.payer.slice(0, 8)}`);
    const err = this.store.save(e, now());
    if (err && err !== ERR_DUPLICATE) return { ok: false, msg: err, stored: false };
    const fresh = this.fuel.credit(e.id, v.msats, v.payer, now());
    await this.ensureAlarm();
    return { ok: true, msg: fresh ? `fuel: credited ${Math.floor(v.msats / 1000)} sats` : ERR_DUPLICATE, stored: !err };
  }

  // claimInviteRequest joins the NIP-98 signer through an invite code. It is
  // open to non-members by design; that is what an invite is for.
  private async claimInviteRequest(req: Request): Promise<Response> {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    const body = await req.text();
    const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, body);
    if (typeof auth === "string") return json({ error: auth }, 401);
    let code = "";
    try {
      code = String((JSON.parse(body) as { code?: unknown }).code ?? "");
    } catch {
      return json({ error: "invalid: body is not JSON" }, 400);
    }
    if (this.settings.policy.owner === "") return json({ error: "invite_invalid" }, 403);
    if (this.settings.isBanned(auth.pubkey)) return json({ error: "blocked: this pubkey is banned from this relay" }, 403);
    if (this.settings.isAllowed(auth.pubkey)) return json({ status: "already_member", role: this.settings.isOwner(auth.pubkey) ? "owner" : "member" });
    const r = claimInvite(this.sql, code, now());
    if (r !== "ok") return json({ error: r }, 403);
    this.settings.upsertMember(auth.pubkey, { via: "invite " + code.slice(0, 8) }, now());
    await this.publishRoster({ added: true, pubkey: auth.pubkey });
    return json({ status: "joined", role: "member" });
  }

  // fuelInvoice turns a signed zap request into an invoice via the provider.
  private async fuelInvoice(req: Request): Promise<Response> {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    if (!this.fuel.cfg.lightningAddress || !this.fuel.cfg.servicePubkey) return json({ error: "unsupported: this service does not take zaps" }, 400);
    let body: { zapRequest?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid: body is not JSON" }, 400);
    }
    const zr = body.zapRequest as Event;
    const bad = validate(zr);
    if (bad) return json({ error: bad }, 400);
    if (zr.kind !== 9734) return json({ error: "invalid: zap request must be kind 9734" }, 400);
    if (tagValues(zr, "p")[0] !== this.fuel.cfg.servicePubkey) return json({ error: "invalid: zap request must name the service pubkey" }, 400);
    const host = new URL(req.url).host.toLowerCase();
    const relays = zr.tags.filter((t) => t[0] === "relays").flatMap((t) => t.slice(1));
    if (!relays.some((r) => hostOf(r) === hostOf("ws://" + host))) return json({ error: "invalid: zap request must list this relay in its relays tag" }, 400);
    const msats = Number(tagValues(zr, "amount")[0]);
    if (!Number.isInteger(msats) || msats < 1000) return json({ error: "invalid: amount tag must be at least 1000 msats" }, 400);
    try {
      const params = await this.lnurlParams();
      if (!params.allowsNostr || !params.nostrPubkey) return json({ error: "unsupported: the lightning provider does not support zaps" }, 502);
      if (msats < params.minSendable || (params.maxSendable && msats > params.maxSendable)) return json({ error: `invalid: amount must be between ${params.minSendable} and ${params.maxSendable} msats` }, 400);
      const invoice = await requestInvoice(params, zr, msats, this.fetcher);
      return json({ invoice, providerPubkey: params.nostrPubkey, msats });
    } catch (err) {
      return json({ error: "error: " + (err instanceof Error ? err.message : String(err)) }, 502);
    }
  }

  async fetch(req: Request): Promise<Response> {
    this.touch();
    const name = req.headers.get("x-relay-name");
    if (name && name !== this.slug) {
      this.slug = name;
      await this.ctx.storage.put("slug", name);
    }
    const url = new URL(req.url);
    // Relays claimed before identities existed get theirs on first contact.
    if (this.settings.policy.owner && !this.identity.pubkey) await this.publishRoster();
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return this.acceptWebSocket(req);
    if (req.headers.get("accept")?.includes("application/nostr+json")) {
      return Response.json(this.info(url.host), {
        headers: { "content-type": "application/nostr+json", "access-control-allow-origin": "*" },
      });
    }
    if (req.method === "POST" && req.headers.get("content-type")?.includes("application/nostr+json+rpc")) return manage(this, req);
    if (req.method === "POST" && (url.pathname === "/events" || url.pathname === "/query" || url.pathname === "/count")) return bridge(this, req);
    if (url.pathname === "/.well-known/nostr.json") {
      return Response.json(nip05Document(this.settings, url.searchParams.get("name"), this.relayURL(url.host)), { headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/people" && req.method === "GET") {
      const p = this.settings.policy;
      const people = p.owner && p.directoryPublic ? this.settings.members().map((m) => ({ pubkey: m.pubkey, role: m.role, name: m.name })) : [];
      return Response.json({ public: p.directoryPublic, self: this.identity.pubkey, host: url.host, people }, { headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname.startsWith("/invite/") && req.method === "GET") {
      const code = url.pathname.slice(8);
      const status = this.settings.policy.owner === "" ? "invite_invalid" : checkInvite(this.sql, code, now());
      return new Response(invitePage(this.settings.policy.name || this.slug, url.host, code, status, this.settings.policy.joinTerms), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/join-policy" && req.method === "GET") {
      return Response.json({ terms: this.settings.policy.joinTerms }, { headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/api/invites/claim" && req.method === "POST") return this.claimInviteRequest(req);
    if (url.pathname === "/upload" || url.pathname.startsWith("/list/") || isBlobPath(url.pathname)) return blossom(this, req);
    if (url.pathname === "/fuel" && req.method === "GET") {
      return Response.json({ ...this.fuelStatus(), credits: this.fuel.recentCredits() }, { headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/fuel/invoice" && req.method === "POST") return this.fuelInvoice(req);
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, accept", "access-control-allow-methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/") return new Response(dashboard(), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    return new Response("not found", { status: 404 });
  }

  connections(): number {
    return this.ctx.getWebSockets().length;
  }

  // relayURL is how this relay is addressed for a given Host header.
  relayURL(host: string): string {
    const secure = host.endsWith("." + this.env.DOMAIN) || host === this.env.DOMAIN;
    return (secure ? "wss://" : "ws://") + host;
  }

  info(host: string) {
    const p = this.settings.policy;
    const doc: Record<string, unknown> = {
      name: p.name || this.slug,
      description: p.description,
      supported_nips: SUPPORTED_NIPS,
      software: SOFTWARE,
      version: VERSION,
      limitation: {
        max_message_length: MAX_MESSAGE,
        max_subscriptions: p.maxSubs,
        max_limit: p.maxLimit,
        default_limit: p.maxLimit,
        max_subid_length: 64,
        auth_required: p.reads === "auth",
        payment_required: false,
        restricted_writes: p.writes !== "open" || p.owner === "",
        created_at_upper_limit: p.maxFuture || undefined,
        min_pow_difficulty: p.minPow || undefined,
      },
    };
    if (p.icon) doc.icon = p.icon;
    if (p.contact) doc.contact = p.contact;
    const retention = this.settings.listRetention().map((r) => (r.kind === null ? { time: r.days * 86400 } : { kinds: [r.kind], time: r.days * 86400 }));
    if (retention.length) doc.retention = retention;
    if (this.fuel.cfg.lightningAddress && this.fuel.cfg.servicePubkey && host) {
      const f = this.fuel.status(now(), this.eventBytes(), this.mediaBytes());
      (doc.limitation as Record<string, unknown>).payment_required = f.outOfFuel;
      doc.payments_url = "https://" + host + "/";
    }
    if (p.owner) doc.pubkey = p.owner;
    if (host) doc.self_url = this.relayURL(host);
    if (this.identity.pubkey) {
      doc.self = this.identity.pubkey;
      doc.supported_nips = [...SUPPORTED_NIPS, 43];
    }
    return doc;
  }

  // ---- websockets ----

  private acceptWebSocket(req: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const state: ConnState = { challenge: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), host: new URL(req.url).host, authed: [], subs: {} };
    server.serializeAttachment(state);
    this.ctx.acceptWebSocket(server);
    this.states.set(server, state);
    // NIP-42: offer a challenge up front.
    server.send(JSON.stringify(["AUTH", state.challenge]));
    return new Response(null, { status: 101, webSocket: client });
  }

  private state(ws: WebSocket): ConnState {
    let s = this.states.get(ws);
    if (!s) {
      s = (ws.deserializeAttachment() as ConnState) ?? { challenge: "", host: "", authed: [], subs: {} };
      this.states.set(ws, s);
    }
    return s;
  }

  // persist writes the connection state back to the socket so it survives
  // hibernation. Returns false if it no longer fits the attachment limit.
  private persist(ws: WebSocket, s: ConnState): boolean {
    try {
      ws.serializeAttachment(s);
      return true;
    } catch {
      return false;
    }
  }

  private send(ws: WebSocket, ...msg: unknown[]) {
    this.raw(ws, JSON.stringify(msg));
  }

  private raw(ws: WebSocket, text: string) {
    this.meter.bytesOut += text.length;
    try {
      ws.send(text);
    } catch {
      // closed; the close handler cleans up
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.touch();
    if (typeof message !== "string") {
      this.send(ws, "NOTICE", "error: binary frames are not supported");
      return;
    }
    this.meter.bytesIn += message.length;
    if (message.length > MAX_MESSAGE) {
      this.send(ws, "NOTICE", "error: message too large");
      return;
    }
    let arr: unknown[];
    try {
      arr = JSON.parse(message);
      if (!Array.isArray(arr) || arr.length < 1) throw new Error();
    } catch {
      this.send(ws, "NOTICE", "error: could not parse message");
      return;
    }
    const s = this.state(ws);
    try {
      await this.dispatch(ws, s, arr);
    } finally {
      this.tally();
    }
  }

  private bucket(ws: WebSocket) {
    let b = this.buckets.get(ws);
    if (!b) {
      b = { events: new Bucket(this.settings.policy.eventsPerMinute), reqs: new Bucket(this.settings.policy.reqsPerMinute) };
      this.buckets.set(ws, b);
    }
    return b;
  }

  private async dispatch(ws: WebSocket, s: ConnState, arr: unknown[]) {
    const typ = arr[0];
    const p = this.settings.policy;
    switch (typ) {
      case "EVENT": {
        if (arr.length < 2) return this.send(ws, "NOTICE", "error: EVENT needs an event");
        const limited = this.bucket(ws).events.take(p.eventsPerMinute);
        if (limited) {
          const id = (arr[1] as { id?: unknown })?.id;
          return this.send(ws, "OK", typeof id === "string" ? id : "", false, limited);
        }
        return this.handleEvent(ws, s, arr[1]);
      }
      case "REQ":
      case "COUNT": {
        if (arr.length < 3) return this.send(ws, "NOTICE", `error: ${typ} needs an id and at least one filter`);
        const limited = this.bucket(ws).reqs.take(p.reqsPerMinute);
        if (limited) return this.send(ws, "CLOSED", typeof arr[1] === "string" ? arr[1] : "", limited);
        return this.handleReq(ws, s, typ, arr[1], arr.slice(2));
      }
      case "CLOSE":
        if (typeof arr[1] === "string" && s.subs[arr[1]]) {
          delete s.subs[arr[1]];
          this.persist(ws, s);
        }
        return;
      case "AUTH":
        if (arr.length < 2) return this.send(ws, "NOTICE", "error: AUTH needs an event");
        return this.handleAuth(ws, s, arr[1]);
      case "NEG-OPEN":
      case "NEG-MSG":
      case "NEG-CLOSE":
        if (arr.length < 2) return this.send(ws, "NOTICE", `error: ${typ} needs a subscription id`);
        return this.handleSync(ws, s, typ, arr[1], arr.slice(2));
      default:
        this.send(ws, "NOTICE", "error: unknown message type " + String(typ));
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.states.delete(ws);
    this.syncs.delete(ws);
    this.buckets.delete(ws);
    this.flushUsage();
  }

  async webSocketError(ws: WebSocket) {
    this.states.delete(ws);
    this.syncs.delete(ws);
    this.buckets.delete(ws);
  }

  // ---- EVENT ----

  private async handleEvent(ws: WebSocket, s: ConnState, raw: unknown) {
    const reason = validate(raw);
    const e = raw as Event;
    if (reason) {
      this.send(ws, "OK", typeof e?.id === "string" ? e.id : "", false, reason);
      return;
    }
    const r = await this.acceptAny(e, s);
    this.send(ws, "OK", e.id, r.ok, r.msg);
    if (r.stored) this.broadcast(e);
  }

  // acceptAny routes the special kinds (zap receipts, NIP-56 reports) and
  // falls back to the ordinary write path. Callers broadcast when stored.
  async acceptAny(e: Event, conn: ConnState): Promise<{ ok: boolean; msg: string; stored: boolean }> {
    if (e.kind === 9735) {
      const r = await this.acceptReceipt(e, conn.host);
      if (r) return r;
    }
    if (e.kind === KIND_REPORT) return this.acceptReport(e);
    return this.accept(e, conn);
  }

  // acceptReport files a NIP-56 report in the moderation queue. It is never
  // stored as an event or served: reports are for the owner, not the feed.
  private acceptReport(e: Event): { ok: boolean; msg: string; stored: boolean } {
    if (this.settings.policy.owner === "") return { ok: false, msg: "restricted: this relay is unclaimed", stored: false };
    if (this.settings.isBanned(e.pubkey)) return { ok: false, msg: "blocked: this pubkey is banned from this relay", stored: false };
    const p = tagValues(e, "p")[0] ?? "";
    const et = e.tags.find((t) => t[0] === "e");
    const pt = e.tags.find((t) => t[0] === "p");
    const type = et?.[2] ?? pt?.[2] ?? "";
    if (!/^[0-9a-f]{64}$/.test(p)) return { ok: false, msg: "invalid: report needs a p tag", stored: false };
    this.sql.exec(
      `INSERT OR IGNORE INTO reports(id,reporter,target_pubkey,target_event,type,content,at) VALUES(?,?,?,?,?,?,?)`,
      e.id, e.pubkey, p, et?.[1] ?? "", type.slice(0, 32), e.content.slice(0, 2000), e.created_at,
    );
    return { ok: true, msg: "info: report received", stored: false };
  }

  // accept runs the write-side rules and stores the event. conn is null for
  // host-side publishes (the dashboard), which skip client policy.
  accept(e: Event, conn: ConnState | null): { ok: boolean; msg: string; stored: boolean } {
    const p = this.settings.policy;
    const t = now();
    const no = (msg: string) => ({ ok: false, msg, stored: false });
    if (e.kind === KIND_AUTH) return no("blocked: kind 22242 is only accepted inside an AUTH message");
    if (p.maxFuture > 0 && e.created_at > t + p.maxFuture) return no("invalid: event creation date is too far off from the current time");
    const exp = expiration(e);
    if (exp > 0 && exp <= t) return no("invalid: event has already expired");
    if (this.settings.isBanned(e.pubkey)) return no("blocked: this pubkey is banned from this relay");
    if (this.settings.isEventBanned(e.id)) return no("blocked: this event is banned from this relay");
    if (conn) {
      if (p.owner === "") return no("restricted: this relay is unclaimed; open https://" + conn.host + "/ to claim it");
      const f = this.fuelStatus();
      if (f.outOfFuel) {
        return no(f.enabled ? "restricted: this relay is out of fuel; zap it at https://" + conn.host + "/ to top up" : "restricted: this relay has reached its storage or traffic limit");
      }
      if (!this.settings.kindAllowed(e.kind)) return no("blocked: this relay does not accept kind " + e.kind);
      const keep = this.settings.retentionDays(e.kind);
      if (keep > 0 && e.created_at < t - keep * 86400) return no(`blocked: this relay keeps kind ${e.kind} for ${keep} days and this event is older`);
      if (p.writes === "owner" && !this.settings.isOwner(e.pubkey)) return no("restricted: only the relay owner may publish here");
      if (p.writes === "allowlist" && !this.settings.isAllowed(e.pubkey)) return no("restricted: this relay only accepts events from its members");
      if (p.minPow > 0) {
        const d = difficulty(e);
        if (d.difficulty < p.minPow) return no(`pow: difficulty ${d.difficulty} is less than ${p.minPow}`);
        if (d.target > 0 && d.target < p.minPow) return no(`pow: committed target ${d.target} is less than ${p.minPow}`);
      }
      if (hasTag(e, "-") && !conn.authed.includes(e.pubkey)) return no("auth-required: this event may only be published by its author");
    }
    if (e.kind === KIND_VANISH) {
      const host = conn?.host ?? "";
      const targets = tagValues(e, "relay").some((v) => v === "ALL_RELAYS" || (host !== "" && hostOf(v) === hostOf("ws://" + host)));
      if (!targets) return no("blocked: this relay is not named in the vanish request");
      this.store.vanish(e.pubkey, e.created_at);
      return { ok: true, msg: "", stored: false };
    }
    const err = this.store.save(e, t);
    if (err === ERR_DUPLICATE) return { ok: true, msg: err, stored: false };
    if (err) return no(err);
    if (exp > 0) this.scheduleSweep(exp);
    else this.ensureAlarm();
    if (e.kind === 0 && conn) claimFromProfile(this.settings, e.content, e.pubkey, conn.host, t);
    return { ok: true, msg: "", stored: true };
  }

  private scheduleSweep(at: number) {
    this.ctx.storage.getAlarm().then((cur) => {
      if (cur === null || cur > at * 1000) return this.ctx.storage.setAlarm(at * 1000 + 500);
    });
  }

  async alarm() {
    this.touch();
    const t = now();
    this.flushUsage();
    this.fuel.chargeStorage(t, this.eventBytes(), this.mediaBytes());
    this.store.drain();
    this.sweepRetention(t);
    const next = this.store.sweepExpired(t);
    let at = t + 86400;
    if (next > 0 && next < at) at = next;
    await this.ctx.storage.setAlarm(at * 1000 + 500);
  }

  // sweepRetention applies the owner's keep-for rules. Returns how many
  // events were shed.
  sweepRetention(t: number): number {
    const rules = this.settings.listRetention();
    let gone = 0;
    const own = rules.filter((r) => r.kind !== null).map((r) => r.kind as number);
    for (const r of rules) {
      if (r.kind !== null) gone += this.store.purge(r.kind, t - r.days * 86400);
      else gone += this.store.purge(null, t - r.days * 86400, [...own, ...this.store.kindStats().map((k) => k.kind).filter((k) => isReplaceable(k) || isProtected(k))]);
    }
    return gone;
  }

  private canSee(s: ConnState, e: Event): boolean {
    if (!isPrivate(e.kind)) return true;
    if (s.authed.includes(e.pubkey)) return true;
    return tagValues(e, "p").some((p) => s.authed.includes(p));
  }

  broadcast(e: Event) {
    const raw = canonical(e);
    for (const ws of this.ctx.getWebSockets()) {
      const s = this.state(ws);
      if (!this.canSee(s, e)) continue;
      for (const [id, filters] of Object.entries(s.subs)) {
        if (filters.some((f) => match(f, e))) {
          this.raw(ws, `["EVENT",${JSON.stringify(id)},${raw}]`);
          break;
        }
      }
    }
  }

  // ---- REQ / COUNT ----

  private parseFilters(rawFilters: unknown[]): Filter[] | string {
    const filters: Filter[] = [];
    for (const rf of rawFilters) {
      const f = parseFilter(rf);
      if (typeof f === "string") return "invalid: bad filter: " + f;
      filters.push(f);
    }
    return filters;
  }

  // allowFilters returns a CLOSED reason, or "" plus whether an EOSE "auth"
  // hint applies because private kinds were silently filtered out.
  allowFilters(s: ConnState, filters: Filter[]): { reason: string; authHint: boolean } {
    const authed = s.authed.length > 0;
    const reads = this.settings.policy.reads;
    if (reads !== "open" && !authed) return { reason: "auth-required: this relay requires authentication", authHint: false };
    if (reads === "members" && !s.authed.some((pk) => this.settings.isAllowed(pk))) return { reason: "restricted: this relay only serves its members", authHint: false };
    if (authed) return { reason: "", authHint: false };
    let authHint = false;
    for (const f of filters) {
      if (!f.kinds || f.kinds.length === 0) {
        authHint = true;
        continue;
      }
      const priv = f.kinds.filter(isPrivate).length;
      if (priv === f.kinds.length) return { reason: "auth-required: private kinds are only served to their recipients", authHint: false };
      if (priv > 0) authHint = true;
    }
    return { reason: "", authHint };
  }

  private handleReq(ws: WebSocket, s: ConnState, verb: string, rawID: unknown, rawFilters: unknown[]) {
    if (typeof rawID !== "string" || rawID === "" || rawID.length > 64) return this.send(ws, "NOTICE", "error: bad subscription id");
    const id = rawID;
    const filters = this.parseFilters(rawFilters);
    if (typeof filters === "string") return this.send(ws, "CLOSED", id, filters);
    const { reason, authHint } = this.allowFilters(s, filters);
    if (reason) return this.send(ws, "CLOSED", id, reason);
    const who: Access = { pubkeys: s.authed };
    const t = now();
    const p = this.settings.policy;

    if (verb === "COUNT") {
      const result: Record<string, unknown> = {};
      if (filters.length === 1 && hllOffset(filters[0]) >= 0) {
        const r = this.store.countHLL(filters[0], who, hllOffset(filters[0]), t);
        result.count = r.count;
        result.hll = r.hll;
      } else result.count = this.store.count(filters, who, t);
      return this.send(ws, "COUNT", id, result);
    }

    if (!s.subs[id] && Object.keys(s.subs).length >= p.maxSubs) return this.send(ws, "CLOSED", id, "error: too many subscriptions");
    s.subs[id] = filters;
    if (!this.persist(ws, s)) {
      delete s.subs[id];
      this.persist(ws, s);
      return this.send(ws, "CLOSED", id, "error: subscription filters are too large");
    }
    const seen = new Set<string>();
    let complete = true;
    for (const f of filters) {
      const r = this.store.query(f, who, p.maxLimit, t);
      complete = complete && !r.more;
      for (const raw of r.rows) {
        const probe = JSON.parse(raw) as { id: string };
        if (seen.has(probe.id)) continue;
        seen.add(probe.id);
        this.raw(ws, `["EVENT",${JSON.stringify(id)},${raw}]`);
      }
    }
    const hints = [complete ? "finish" : "more"];
    if (authHint) hints.push("auth");
    this.send(ws, "EOSE", id, hints);
  }

  // ---- AUTH (NIP-42) ----

  private handleAuth(ws: WebSocket, s: ConnState, raw: unknown) {
    const reason = validate(raw);
    const e = raw as Event;
    if (reason) return this.send(ws, "OK", typeof e?.id === "string" ? e.id : "", false, reason);
    const t = now();
    const fail = (msg: string) => this.send(ws, "OK", e.id, false, msg);
    if (e.kind !== KIND_AUTH) return fail("invalid: auth event must be kind 22242");
    if (Math.abs(t - e.created_at) > 600) return fail("invalid: auth event created_at is too far from the current time");
    if (tagValues(e, "challenge")[0] !== s.challenge) return fail("invalid: auth challenge does not match");
    if (hostOf(tagValues(e, "relay")[0] ?? "") !== hostOf("ws://" + s.host)) return fail("invalid: auth relay tag does not name this relay");
    if (!s.authed.includes(e.pubkey)) s.authed.push(e.pubkey);
    this.persist(ws, s);
    this.send(ws, "OK", e.id, true, "");
  }

  // ---- NIP-77 ----

  private handleSync(ws: WebSocket, s: ConnState, verb: string, rawID: unknown, rest: unknown[]) {
    if (typeof rawID !== "string" || rawID === "" || rawID.length > 64) return this.send(ws, "NOTICE", "error: bad subscription id");
    const id = rawID;
    let sessions = this.syncs.get(ws);
    if (!sessions) {
      sessions = new Map();
      this.syncs.set(ws, sessions);
    }
    let sess = sessions.get(id);
    let msgHex = "";
    if (verb === "NEG-CLOSE") {
      sessions.delete(id);
      return;
    }
    if (verb === "NEG-OPEN") {
      if (rest.length < 2) return this.send(ws, "NEG-ERR", id, "error: NEG-OPEN needs a filter and a message");
      const f = parseFilter(rest[0]);
      if (typeof f === "string") return this.send(ws, "NEG-ERR", id, "invalid: bad filter: " + f);
      const { reason } = this.allowFilters(s, [f]);
      if (reason) return this.send(ws, "NEG-ERR", id, reason);
      if (!sessions.has(id) && sessions.size >= this.settings.policy.maxSubs) return this.send(ws, "NEG-ERR", id, "blocked: too many open syncs");
      const items = this.store.syncItems(f, { pubkeys: s.authed }, MAX_SYNC, now());
      if (items === "too big") return this.send(ws, "NEG-ERR", id, ERR_TOO_BIG, MAX_SYNC);
      sess = new Negentropy(items, sha256);
      sessions.set(id, sess);
      msgHex = typeof rest[1] === "string" ? rest[1] : "";
    } else {
      if (!sess) return this.send(ws, "NEG-ERR", id, "closed: no such sync, send NEG-OPEN first");
      msgHex = typeof rest[0] === "string" ? rest[0] : "";
    }
    if (!/^([0-9a-f]{2})*$/i.test(msgHex)) return this.send(ws, "NEG-ERR", id, "invalid: message is not hex");
    try {
      const { reply } = sess.reconcile(hexToBytes(msgHex));
      this.send(ws, "NEG-MSG", id, bytesToHex(reply ?? new Uint8Array()));
    } catch (err) {
      sessions.delete(id);
      this.send(ws, "NEG-ERR", id, "invalid: " + (err instanceof Error ? err.message : String(err)));
    }
  }
}

// hostOf lower-cases the hostname of a URL, ignoring scheme, port and path.
export function hostOf(s: string): string {
  try {
    return new URL(s.trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}
