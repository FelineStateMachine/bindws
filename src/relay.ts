// The relay: one Durable Object per name, holding its SQLite database and
// its live websockets (hibernating while idle). Protocol handling mirrors
// relay.go; policy is per relay and owner-managed (see manage.ts).
import { DurableObject } from "cloudflare:workers";
import { sha256 } from "@noble/hashes/sha2.js";
import { difficulty, expiration, hasTag, isPrivate, now, tagValues, validate, canonical, type Event } from "./event.ts";
import { match, parseFilter, type Filter } from "./filter.ts";
import { hllOffset } from "./hll.ts";
import { Negentropy, bytesToHex, hexToBytes } from "./negentropy.ts";
import { discovery } from "./nip66.ts";
import { Audit } from "./audit.ts";
import { ERR_DUPLICATE, ERR_TOO_BIG, Store, type Access } from "./store.ts";
import { Settings, isReplaceable, isProtected, SUCCESSION_WARN_DAYS } from "./settings.ts";
import { manage } from "./manage.ts";
import { Succession } from "./succession.ts";
import { guestPass, readGate, writeGate } from "./gates.ts";
import { dashboard } from "./dashboard.ts";
import { Fuel, fuelConfig, fetchLnurl, requestInvoice, type Fetcher, type LnurlParams } from "./fuel.ts";
import { Identity } from "./identity.ts";
import { Bucket } from "./ratelimit.ts";
import { bridge } from "./bridge.ts";
import { blossom, blobBytes, isBlobPath } from "./blossom.ts";
import { nip96 } from "./nip96.ts";
import { dumpBytes, dumpDue, dumpDownload, writeDump } from "./dumps.ts";
import { importBytes, importUpload } from "./imports.ts";
import { DIGEST_DAYS, digestText } from "./notify.ts";
import { claimFromProfile, nip05Document } from "./nip05.ts";
import { checkInvite, claimInvite, inviteCreator, invitePage, termsPage } from "./invites.ts";
import { verifyNIP98, whoAsks } from "./auth.ts";
import { FAVICON_SVG } from "./ui.ts";
import type { PullFilter, PullJob, PullResult } from "./pull.ts";
import { leaseDays, leaseNames, validName } from "./names.ts";
import { MAX_JOBS, MAX_STANDING, checkJob, finishRun, newJobID, pruneFinished, pullView, runRound, startRun, type Job, type JobSpec } from "./jobs.ts";
import { Hostnames, forgetDomains } from "./domains.ts";
import { groupFacts, handleGroupEvent, isGroupManagement, isNIP43Request } from "./groups.ts";
import { SIGNER_JS } from "./gen/signer.ts";
import { isPagePath, pages } from "./pages.ts";
import { notify, fuelLow, fuelText } from "./notify.ts";
import { card } from "./card.ts";
import { PRESENCE_THROTTLE_S, VIEWS, latestStored, nip11Views, presenceTags, serveView, viewByName, viewD, viewEvent, viewOn, viewStored, type ViewRun } from "./views.ts";
import type { Blob } from "./blossom.ts";
import { KIND_VANISH, KIND_AUTH, KIND_REPORT, KIND_NOSTR_CONNECT, KIND_PRESENCE, KIND_GROUP_MEMBERS, KIND_GROUP_PINS, KIND_RELAY_DISCOVERY } from "./kinds.ts";

export interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  MEDIA: R2Bucket;
  DOMAIN: string;
  DEV_RELAY: string;
  LEASE_DAYS?: string; // how long a temporary relay lives; 14 by default
  // Cloudflare's rate limit bindings; without them (celld) edge.ts keeps
  // token buckets in memory instead.
  LEASE_LIMIT_IP?: RateLimit; // leases per address per minute
  LEASE_LIMIT_ALL?: RateLimit; // leases per minute, everyone together
  // The header the client's address arrives in; cf-connecting-ip if unset,
  // no address at all if empty (edge.ts, clientIP).
  CLIENT_IP_HEADER?: string;
  // Custom domains (see domains.ts): hostname to relay name, and the
  // Cloudflare for SaaS credentials. Without the token the feature is off.
  HOSTS?: KVNamespace;
  CF_API_TOKEN?: string;
  ZONE_ID?: string;
  CNAME_TARGET?: string; // what owners point their CNAME at; customers.<DOMAIN> if unset
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
  // Metrics (optional): a Workers Analytics Engine dataset that takes one
  // data point per usage flush, next to the meter log line (flushUsage).
  METRICS?: AnalyticsEngineDataset;
}

// The less obvious numbers: 43 is added by info() once the relay has an
// identity; 62 is request-to-vanish (store.vanish); 67 is the EOSE hint
// array at the end of the subscription handler; 70 is the "-" tag check in
// gate(); 66 is the discovery record the relay signs about itself
// (publishDiscovery); 77 is negentropy sync (handleSync).
export const SUPPORTED_NIPS = [1, 5, 9, 11, 13, 17, 29, 40, 42, 45, 46, 50, 56, 59, 62, 66, 67, 70, 77, 86, 98];
export const SOFTWARE = "https://bind.ws";
export const VERSION = "0.1.0";
export const MAX_MESSAGE = 1024 * 1024;
const FAVICON = FAVICON_SVG;
const MAX_SYNC = 100_000;
// How long a leased relay keeps everything, so a claim inherits a bounded
// window until the owner resets the rules.
const LEASE_RETENTION_DAYS = 14;
// Forks are owner actions, not rate limited at the apex, so one an hour.
const FORK_INTERVAL = 3600;

// ConnState is everything about a websocket that must survive hibernation.
export interface ConnState {
  challenge: string;
  host: string; // Host header, for NIP-42 relay-tag checks
  ip: string; // the client's address as the worker saw it; "unknown" outside Cloudflare
  authed: string[];
  subs: Record<string, Filter[]>;
  // Open NIP-77 syncs by id, each with its filter: enough to rebuild the
  // session's item list after a wake. Absent on sockets from before.
  syncs?: Record<string, Filter>;
}

const FLUSH_BYTES = 256 * 1024;
// An address gets this many times a connection's per-minute allowance, so a
// few tabs from one place are fine and a swarm of sockets is not.
export const IP_LIMIT_MULTIPLE = 4;

// clientIP is the address the worker stamped on the request (index.ts).
function clientIP(req: Request): string {
  return req.headers.get("x-relay-ip") || "unknown";
}
const LNURL_TTL = 24 * 3600;
// How long Cloudflare keeps an idle object awake before hibernating it.
const IDLE_GRACE_MS = 10_000;

export class Relay extends DurableObject<Env> {
  store: Store;
  settings: Settings;
  fuel: Fuel;
  identity: Identity;
  audit: Audit;
  slug = "";
  private states = new Map<WebSocket, ConnState>();
  private syncs = new Map<WebSocket, Map<string, Negentropy>>();
  private buckets = new Map<WebSocket, { events: Bucket; reqs: Bucket }>();
  // Per-address buckets, in memory only: they reset when the object sleeps.
  private ipBuckets = new Map<string, { events: Bucket; reqs: Bucket }>();
  // Usage counters, flushed to the usage table in batches. The last three
  // are for the meter log line only: events accepted, events refused with
  // an OK false, and REQ or COUNT messages served.
  private meter = { bytesIn: 0, bytesOut: 0, rowsRead: 0, rowsWritten: 0, activeMs: 0, accepted: 0, refused: 0, reqs: 0 };
  // When the object last did work, for the active-time meter (ms). Zero after a wake.
  private lastActive = 0;
  private lnurl: LnurlParams | null = null;
  // Outbound HTTP to the lightning provider and to Cloudflare; tests substitute a fake.
  fetcher: Fetcher = (u, i) => fetch(u, i);
  // The heir and the dead-man's switch (succession.ts).
  succession = new Succession(this);
  // A job round in flight, so overlapping alarms do not run two.
  private working = false;
  // Presence (views.ts): who wrote lately, in memory; the sockets are asked
  // directly. A broadcast is at most one per PRESENCE_THROTTLE_S.
  presenceActive = new Map<string, number>();
  private presenceAt = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  // Write-triggered views wait a moment so a burst republishes once.
  private viewDirty = new Set<string>();
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  // The custom hostnames client, null when the host has not enabled them.
  hostnames: Hostnames | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    this.settings = new Settings(ctx.storage.sql);
    this.fuel = new Fuel(ctx.storage.sql, fuelConfig(env as unknown as Record<string, unknown>));
    this.identity = new Identity(ctx.storage);
    this.audit = new Audit(ctx.storage.sql, () => this.slug);
    this.hostnames = env.CF_API_TOKEN && env.ZONE_ID && env.HOSTS ? new Hostnames(env.CF_API_TOKEN, env.ZONE_ID, (u, i) => this.fetcher(u, i)) : null;
    ctx.blockConcurrencyWhile(async () => {
      this.store.init();
      this.settings.load();
    this.store.hidden = this.settings.hiddenEvents;
      this.fuel.init();
      this.slug = (await ctx.storage.get<string>("slug")) ?? "";
      this.lnurl = (await ctx.storage.get<LnurlParams>("lnurl")) ?? null;
      await this.succession.load();
      await this.identity.load();
    });
  }

  get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // storage is the object's key-value store, for the modules that keep a
  // little state beside the tables.
  get storage(): DurableObjectStorage {
    return this.ctx.storage;
  }

  get media(): R2Bucket {
    return this.env.MEDIA;
  }

  get domain(): string {
    return this.env.DOMAIN;
  }

  // hosts is the custom domain map the worker routes by; absent on a host
  // without the namespace, where hostnames is null too.
  get hosts(): KVNamespace | undefined {
    return this.env.HOSTS;
  }

  get cnameTarget(): string {
    return this.env.CNAME_TARGET || "customers." + this.env.DOMAIN;
  }

  // relays reaches the other objects on this host, for pulls between them.
  get relays(): DurableObjectNamespace<Relay> {
    return this.env.RELAY;
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

  // publishMembership signs everything the relay vouches for from its member
  // list and settings, in one place so the NIP-43 roster and the NIP-29 group
  // can never disagree: the roster (13534) and, for an add or a removal, its
  // 8000/8001 delta; the NIP-29 put-user or remove-user record for each
  // change given (a change without `added` is a role change); the group's
  // metadata, admins, roles and, when the directory is public, members
  // (39000-39003); the NIP-43 role definitions (33534); and the relay's own
  // profile (kind 0) when its name, description or icon changed.
  async publishMembership(...changes: { pubkey: string; added?: boolean }[]) {
    if (this.settings.policy.owner === "") return;
    await this.identity.ensure();
    const t = now();
    const events: Event[] = [];
    for (const c of changes) {
      if (c.added !== undefined) events.push(this.identity.delta(c.added, c.pubkey));
      if (c.added === false) events.push(this.identity.removeUser(this.slug, c.pubkey));
      else events.push(this.identity.putUser(this.slug, c.pubkey, this.rolesOf(c.pubkey)));
    }
    const f = groupFacts(this);
    // A members list that is no longer public is taken down.
    if (f.members === null) {
      for (const r of this.sql.exec<{ id: string }>(`SELECT id FROM events WHERE kind=? AND pubkey=?`, KIND_GROUP_MEMBERS, this.identity.pubkey).toArray()) this.store.deleteEvent(r.id);
    }
    events.push(this.identity.roster(this.settings.members(), t));
    events.push(...this.identity.group(f, t));
    this.emit(events, t);
    this.markView("profiles");
    await this.publishDiscovery();
  }

  // publishDiscovery signs the NIP-66 record the relay keeps about itself
  // (nip66.ts), under its primary name, and only when what it would say has
  // changed: the rules, the kind rules, the identity fields and the fuel
  // state all show in it. Called with the membership records and daily
  // from the alarm, so a change made by a method that publishes nothing
  // else still reaches the record within a day.
  async publishDiscovery() {
    if (this.settings.policy.owner === "") return;
    await this.identity.ensure();
    const d = discovery(this, this.slug + "." + this.domain);
    const fp = JSON.stringify([d.tags, d.content]);
    const row = this.sql.exec<{ created_at: number }>(`SELECT created_at FROM events WHERE kind=? AND pubkey=? ORDER BY created_at DESC LIMIT 1`, KIND_RELAY_DISCOVERY, this.identity.pubkey).toArray()[0];
    if (row && fp === (await this.ctx.storage.get<string>("nip66-fp"))) return;
    const t = now();
    this.emit([this.identity.sign(KIND_RELAY_DISCOVERY, d.tags, d.content, Math.max(t, (row?.created_at ?? 0) + 1))], t);
    await this.ctx.storage.put("nip66-fp", fp);
  }

  // ---- views (views.ts) ----

  // authedNow lists every pubkey with an authenticated socket open.
  authedNow(): string[] {
    const out = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) for (const pk of this.state(ws).authed) out.add(pk);
    return [...out];
  }

  async viewRuns(name: string): Promise<ViewRun[]> {
    return (await this.ctx.storage.get<ViewRun[]>("view-runs:" + name)) ?? [];
  }

  // publishView folds one stored view and writes its record, or takes the
  // record down when the view is off, members-only or empty. The rows the
  // fold wrote are recorded so the console and the digest can say what a
  // view costs.
  async publishView(name: string): Promise<void> {
    const v = viewByName(name);
    if (!v || v.trigger === "live" || this.settings.policy.owner === "") return;
    await this.identity.ensure();
    const self = this.identity.pubkey;
    this.tally();
    const before = this.meter.rowsWritten;
    const takeDown = () => {
      for (const r of this.sql.exec<{ id: string }>(`SELECT e.id FROM events e JOIN tags t ON t.event_id=e.id WHERE e.kind=30078 AND e.pubkey=? AND t.name='d' AND t.value=?`, self, viewD(name)).toArray()) this.store.deleteEvent(r.id);
    };
    if (!viewOn(this, name) || !viewStored(this, v)) takeDown();
    else {
      const fold = v.fold(this);
      if (!fold) takeDown();
      else this.emit([viewEvent(this, v, fold, true)], now());
    }
    this.tally();
    const runs = (await this.viewRuns(name)).slice(-59);
    runs.push({ at: now(), rows: Math.max(0, this.meter.rowsWritten - before) });
    await this.ctx.storage.put("view-runs:" + name, runs);
    if (v.fingerprint) await this.ctx.storage.put("view-fp:" + name, v.fingerprint(this));
  }

  // markView republishes a write-triggered view shortly, once for a burst.
  markView(name: string) {
    if (!viewOn(this, name) || this.settings.policy.owner === "") return;
    this.viewDirty.add(name);
    if (this.viewTimer) return;
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      const names = [...this.viewDirty];
      this.viewDirty.clear();
      void (async () => {
        for (const n of names) {
          try {
            await this.publishView(n);
          } catch (err) {
            console.log("view " + n + " failed: " + (err instanceof Error ? err.message : String(err)));
          }
        }
      })();
    }, 10_000);
  }

  // viewsTick runs the scheduled views: daily ones once a day, hourly ones
  // once an hour and only when their fingerprint moved or nothing is stored.
  private async viewsTick(t: number) {
    if (this.settings.policy.owner === "") return;
    for (const v of VIEWS) {
      if (v.trigger === "live" || !viewOn(this, v.name)) continue;
      const last = (await this.ctx.storage.get<number>("view-at:" + v.name)) ?? 0;
      const period = v.trigger === "hourly" ? 3600 : 86400;
      if (t - last < period - 300) continue;
      await this.ctx.storage.put("view-at:" + v.name, t);
      if (v.fingerprint && viewStored(this, v) && latestStored(this, v.name) !== null) {
        const fp = v.fingerprint(this);
        if (fp === (await this.ctx.storage.get<string>("view-fp:" + v.name))) continue;
      }
      await this.publishView(v.name);
    }
  }

  // notePresence records a writer and broadcasts the presence view when the
  // throttle allows, otherwise once it does.
  notePresence(pubkey?: string) {
    if (pubkey) this.presenceActive.set(pubkey, now());
    if (!this.identity.pubkey || !viewOn(this, "presence") || this.settings.policy.owner === "") return;
    const wait = this.presenceAt + PRESENCE_THROTTLE_S - Date.now() / 1000;
    if (wait <= 0) this.broadcastPresence();
    else if (!this.presenceTimer) {
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null;
        this.broadcastPresence();
      }, wait * 1000);
    }
  }

  private broadcastPresence() {
    this.presenceAt = Date.now() / 1000;
    this.broadcast(this.identity.sign(KIND_PRESENCE, [["d", viewD("presence")], ...presenceTags(this)], ""));
  }

  // publishPins signs the group's pin list (39005); an empty list takes the
  // record down.
  async publishPins() {
    if (this.settings.policy.owner === "") return;
    await this.identity.ensure();
    const tags = this.settings.pins();
    if (tags.length === 0) {
      for (const r of this.sql.exec<{ id: string }>(`SELECT id FROM events WHERE kind=? AND pubkey=?`, KIND_GROUP_PINS, this.identity.pubkey).toArray()) this.store.deleteEvent(r.id);
      return;
    }
    this.emit([this.identity.pins(this.slug, tags)], now());
  }

  private rolesOf(pubkey: string): string[] {
    const r = this.settings.roleOf(pubkey);
    return r && r !== "member" ? [r] : [];
  }

  private emit(events: Event[], t: number) {
    for (const e of events) {
      const err = this.store.save(e, t);
      if (!err) this.broadcast(e);
    }
  }

  // setMember edits or adds a person and publishes the roster if membership changed.
  async setMember(pubkey: string, patch: { name?: string | null; note?: string; via?: string; invitedBy?: string; keepDays?: number; maxBytes?: number }, force = false): Promise<string> {
    const was = this.settings.isAllowed(pubkey);
    const err = this.settings.upsertMember(pubkey, patch, now(), force);
    if (err) return err;
    if (!was) await this.publishMembership({ pubkey, added: true });
    return "";
  }

  async removeMember(pubkey: string): Promise<boolean> {
    if (!this.settings.removeMember(pubkey)) return false;
    if (this.settings.policy.reads === "members") this.evict(pubkey, "restricted: this relay only serves its members", false);
    await this.publishMembership({ pubkey, added: false });
    return true;
  }

  // removeSubtree removes a member and everyone they invited, plain members
  // only (see Settings.subtree), and publishes membership once for all of
  // them. Returns who went.
  async removeSubtree(pubkey: string): Promise<string[]> {
    const gone: string[] = [];
    for (const pk of this.settings.subtree(pubkey)) {
      if (!this.settings.removeMember(pk)) continue;
      if (this.settings.policy.reads === "members") this.evict(pk, "restricted: this relay only serves its members", false);
      gone.push(pk);
    }
    if (gone.length) await this.publishMembership(...gone.map((pk) => ({ pubkey: pk, added: false })));
    return gone;
  }

  // ban refuses a pubkey from now on; with erase, everything they wrote and
  // uploaded goes too, their profile included.
  async ban(pubkey: string, reason: string, erase = false): Promise<void> {
    const was = this.settings.isAllowed(pubkey);
    this.settings.setBan(pubkey, true, reason, now());
    this.evict(pubkey, "blocked: you are banned from this relay", true);
    if (erase) {
      this.store.eraseAuthor(pubkey);
      for (const b of this.sql.exec<{ sha256: string }>(`SELECT sha256 FROM blobs WHERE uploader=?`, pubkey).toArray()) await this.deleteBlob(b.sha256);
    }
    if (was) await this.publishMembership({ pubkey, added: false });
  }

  // evict closes the door on a pubkey: subscriptions are ended and, for a
  // ban, the socket is closed; hibernating sockets are covered too.
  evict(pubkey: string, reason: string, close: boolean) {
    for (const ws of this.ctx.getWebSockets()) {
      const s = this.state(ws);
      if (!s.authed.includes(pubkey)) continue;
      for (const id of Object.keys(s.subs)) this.send(ws, "CLOSED", id, reason);
      s.subs = {};
      this.syncs.delete(ws);
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

  // enforceReads runs after the read rule changed: every open subscription
  // is judged again and the ones the rule no longer admits are closed, so a
  // relay that turned members-only stops feeding the sockets it let in
  // while it was open. Sync sessions go with them.
  enforceReads() {
    for (const ws of this.ctx.getWebSockets()) {
      const s = this.state(ws);
      let changed = false;
      for (const [id, filters] of Object.entries(s.subs)) {
        const { reason } = readGate(this, s, filters);
        if (!reason) continue;
        this.send(ws, "CLOSED", id, reason);
        delete s.subs[id];
        changed = true;
      }
      if (this.settings.mayRead(s.authed)) {
        this.syncs.delete(ws);
        if (s.syncs && Object.keys(s.syncs).length) {
          delete s.syncs;
          changed = true;
        }
      }
      if (changed) this.persist(ws, s);
    }
  }

  // virtualConn represents an HTTP caller as if it had authenticated over the socket.
  virtualConn(host: string, pubkey: string, ip = "unknown"): ConnState {
    void this.succession.seen(pubkey);
    return { challenge: "", host, authed: [pubkey], subs: {}, ip };
  }

  // ---- addresses ----

  // blockIP refuses an address from now on and drops its open sockets.
  blockIP(ip: string, reason: string) {
    this.settings.setIPBlock(ip, true, reason, now());
    for (const ws of this.ctx.getWebSockets()) {
      if (this.state(ws).ip !== ip) continue;
      try {
        ws.close(4403, "blocked: this address is blocked from this relay");
      } catch {
        /* already closed */
      }
    }
  }

  // ipLimit spends one token from the address's bucket. "" allows.
  ipLimit(ip: string, which: "events" | "reqs"): string {
    if (ip === "unknown") return "";
    let b = this.ipBuckets.get(ip);
    if (!b) {
      if (this.ipBuckets.size >= 10_000) this.ipBuckets.clear();
      b = { events: new Bucket(this.settings.policy.eventsPerMinute * IP_LIMIT_MULTIPLE), reqs: new Bucket(this.settings.policy.reqsPerMinute * IP_LIMIT_MULTIPLE) };
      this.ipBuckets.set(ip, b);
    }
    const p = this.settings.policy;
    return b[which].take((which === "events" ? p.eventsPerMinute : p.reqsPerMinute) * IP_LIMIT_MULTIPLE);
  }

  isMember(pubkey: string): boolean {
    return this.settings.isAllowed(pubkey);
  }

  // mayUpload applies the write policy to Blossom uploads. "" allows.
  mayUpload(pubkey: string, host: string): string {
    const p = this.settings.policy;
    if (this.settings.isUnclaimed()) return "restricted: this relay is unclaimed";
    if (this.settings.leaseExpired(now())) return "restricted: this temporary relay has expired";
    if (this.settings.isBanned(pubkey)) return "blocked: this pubkey is banned from this relay";
    const why = this.settings.mayWrite(pubkey);
    if (why) return why.replace("publish here", "upload here").replace("accepts events", "accepts uploads");
    if (this.fuelStatus().outOfFuel) return "restricted: this relay is out of fuel; zap it at https://" + host + "/ to top up";
    return "";
  }

  // teardown deletes everything this relay holds and returns the name to
  // unclaimed. Every socket is closed. Nothing is recoverable afterwards.
  async teardown() {
    await forgetDomains(this);
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
    this.ipBuckets.clear();
    this.meter = { bytesIn: 0, bytesOut: 0, rowsRead: 0, rowsWritten: 0, activeMs: 0, accepted: 0, refused: 0, reqs: 0 };
    this.lnurl = null;
    this.store = new Store(this.sql);
    this.settings = new Settings(this.sql);
    this.fuel = new Fuel(this.sql, this.fuel.cfg);
    this.identity = new Identity(this.ctx.storage);
    this.audit = new Audit(this.sql, () => this.slug);
    this.store.init();
    this.settings.load();
    this.store.hidden = this.settings.hiddenEvents;
    this.fuel.init();
    await this.ctx.storage.put("slug", this.slug);
  }

  async deleteBlob(sha: string) {
    await this.media.delete(`${this.slug}/${sha}`);
    this.sql.exec(`DELETE FROM blobs WHERE sha256=?`, sha);
  }

  // listBlobs is for another relay on this host pulling our files. The
  // caller says which pubkeys it has proved; the read rule decides.
  listBlobs(pubkeys: string[]): Blob[] | string {
    const gate = this.settings.mayRead(pubkeys);
    if (gate) return gate;
    return this.sql.exec<Blob>(`SELECT * FROM blobs ORDER BY uploaded`).toArray();
  }

  // ---- owner presence and succession ----

  // ---- temporary leases ----

  // lease turns an unclaimed relay into a temporary one: open to everyone,
  // everything kept for a bounded window, wiped at `until` unless claimed.
  // holder "" lets anyone claim; a pubkey reserves the claim. Returns "" or
  // a reason.
  async lease(name: string, host: string, until: number, holder: string): Promise<string> {
    if (!this.settings.isUnclaimed()) return "taken";
    if (this.slug !== name) {
      this.slug = name;
      await this.ctx.storage.put("slug", name);
    }
    const day = new Date(until * 1000).toISOString().slice(0, 10);
    this.settings.update({
      lease: { until, holder },
      writes: "open",
      reads: "open",
      name: "",
      description: `Temporary relay. Anyone can read and write here until ${day}; then everything on it is deleted. To keep it, claim it at https://${host}/ (sign once). Or claim a new name and pull from this one.`,
    });
    this.settings.setRetention(null, LEASE_RETENTION_DAYS);
    await this.ensureAlarm(until);
    return "";
  }

  // ---- forking: a new name, this relay's events pulled into it ----

  // forkRelay leases a new name, reserved for `holder`, and has it pull
  // this relay. `people` copies the plain members along. Nothing new in
  // the protocol: a lease, a pull job, a claim. One fork an hour.
  async forkRelay(host: string, opts: { name?: string; holder: string; filter?: PullFilter; people?: boolean }): Promise<{ name: string; url: string; console: string; holder: string; expires_at: number } | string> {
    const t = now();
    const last = (await this.ctx.storage.get<number>("lastFork")) ?? 0;
    if (t - last < FORK_INTERVAL) return `restricted: one fork an hour; the last was ${Math.ceil((t - last) / 60)} minutes ago`;
    const suffix = host.startsWith(this.slug + ".") ? host.slice(this.slug.length) : "." + this.env.DOMAIN;
    const secure = this.relayURL(host).startsWith("wss");
    const until = t + leaseDays(this.env) * 86400;
    if (opts.name && (!validName(opts.name) || opts.name === this.slug)) return "invalid: that is not a usable name";
    const candidates = opts.name ? [opts.name] : [...leaseNames()];
    for (const name of candidates) {
      const newHost = name + suffix;
      const stub = this.relays.getByName(name);
      const err = await stub.lease(name, newHost, until, opts.holder);
      if (err) {
        if (opts.name) return "restricted: that name is taken";
        continue;
      }
      const people = opts.people ? this.settings.members().filter((m) => m.role === "member").map((m) => ({ pubkey: m.pubkey, name: m.name, note: m.note })) : [];
      const adopted = await stub.adoptFrom(this.relayURL(host), opts.filter ?? {}, people, host);
      if (adopted) return adopted;
      await this.ctx.storage.put("lastFork", t);
      return { name, url: (secure ? "wss://" : "ws://") + newHost, console: (secure ? "https://" : "http://") + newHost + "/", holder: opts.holder, expires_at: until };
    }
    return "error: no free name found, try again";
  }

  // adoptFrom is the forked side, reached over RPC only: a fresh lease
  // takes the people and starts pulling from the source.
  async adoptFrom(sourceURL: string, filter: PullFilter, people: { pubkey: string; name: string | null; note: string }[], sourceHost: string): Promise<string> {
    if (!this.settings.isLeased()) return "restricted: only a fresh lease can adopt";
    if (this.store.stats().events > 0) return "restricted: this lease already holds events";
    const day = new Date((this.settings.policy.lease?.until ?? 0) * 1000).toISOString().slice(0, 10);
    this.settings.update({ description: `Forked from ${sourceHost}. Temporary until ${day} unless claimed; then everything on it is deleted. Claim it to keep it.` });
    const t = now();
    for (const m of people) this.settings.upsertMember(m.pubkey, { name: m.name, note: m.note, via: "forked" }, t, true);
    const r = await this.addChecked({ kind: "pull", label: "pull", relays: [sourceURL], filter, every: 0, running: false, startedAt: 0, rounds: 0, failures: 0, relayIndex: 0, cursor: 0, stored: 0, skipped: 0, blobs: 0, sent: 0, refused: 0, last: null });
    return typeof r === "string" ? r : "";
  }

  // ---- jobs: pulls, backfills, rebroadcasts, once or standing ----

  // jobs is the persisted list. A job left from before the list existed
  // is folded in on first read.
  async jobs(): Promise<Job[]> {
    let list = (await this.ctx.storage.get<Job[]>("jobs")) ?? [];
    const old = await this.ctx.storage.get<PullJob>("pull");
    if (old) {
      list = [...list, { id: newJobID(), kind: "pull", label: "pull", relays: [old.url], filter: {}, every: 0, createdAt: old.startedAt, nextRun: now(), running: false, startedAt: old.startedAt, rounds: old.rounds, failures: 0, relayIndex: 0, cursor: 0, stored: old.stored, skipped: old.skipped, blobs: old.blobs, sent: 0, refused: 0, last: null }];
      await this.ctx.storage.delete("pull");
      await this.ctx.storage.delete("lastPull");
      await this.ctx.storage.put("jobs", list);
    }
    return list;
  }

  private async saveJobs(list: Job[]) {
    await this.ctx.storage.put("jobs", list);
  }

  // addJob validates, records and wakes the alarm. Returns the job or a reason.
  async addJob(raw: unknown): Promise<Job | string> {
    const spec = checkJob(raw, this);
    if (typeof spec === "string") return spec;
    return this.addChecked(spec);
  }

  async addChecked(spec: JobSpec): Promise<Job | string> {
    if (this.fuelStatus().outOfFuel) return "restricted: this relay is out of fuel";
    let list = pruneFinished(await this.jobs());
    if (spec.every > 0 && list.filter((j) => j.every > 0).length >= MAX_STANDING) return `restricted: at most ${MAX_STANDING} standing jobs`;
    if (list.length >= MAX_JOBS) return `restricted: at most ${MAX_JOBS} jobs; remove one first`;
    if (spec.kind === "pull" && list.some((j) => j.kind === "pull" && j.every === 0 && (j.running || j.nextRun > 0) && j.relays.join() === spec.relays.join())) return "restricted: a pull from there is already running";
    const job: Job = { ...spec, id: newJobID(), createdAt: now(), nextRun: now() };
    list = [...list, job];
    await this.saveJobs(list);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return job;
  }

  async removeJob(id: string): Promise<boolean> {
    const list = await this.jobs();
    const rest = list.filter((j) => j.id !== id);
    if (rest.length === list.length) return false;
    await this.saveJobs(rest);
    return true;
  }

  // runJob makes a job due now.
  async runJob(id: string): Promise<boolean> {
    const list = await this.jobs();
    const job = list.find((j) => j.id === id);
    if (!job) return false;
    if (!job.running) job.nextRun = now();
    await this.saveJobs(list);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return true;
  }

  // pullStart and pullStatus are the first console's view: one pull at a time.
  async pullStart(url: string): Promise<string> {
    const r = await this.addChecked({ kind: "pull", label: "pull", relays: [url], filter: {}, every: 0, running: false, startedAt: 0, rounds: 0, failures: 0, relayIndex: 0, cursor: 0, stored: 0, skipped: 0, blobs: 0, sent: 0, refused: 0, last: null });
    return typeof r === "string" ? r : "";
  }

  async pullStatus(): Promise<{ running: PullJob | null; last: PullResult | null }> {
    return pullView(await this.jobs());
  }

  // jobsTick runs one round of the job that is due. Returns whether another
  // round is due soon. A few failed rounds in a row end a run with the
  // reason; a standing job tries again at its next interval.
  private async jobsTick(): Promise<boolean> {
    if (this.working) return true;
    const list = await this.jobs();
    const t = now();
    const job = list.find((j) => j.running) ?? list.find((j) => j.nextRun > 0 && j.nextRun <= t);
    if (!job) return false;
    if (!job.running) startRun(job, t);
    this.working = true;
    let r: { more: boolean; error: string };
    try {
      r = await runRound(this, job);
    } finally {
      this.working = false;
    }
    // The job may have been removed while the round ran.
    const fresh = await this.jobs();
    const slot = fresh.findIndex((j) => j.id === job.id);
    if (slot < 0) return fresh.some((j) => j.running || (j.nextRun > 0 && j.nextRun <= now()));
    // A finished run is worth a word to the owner, when they asked for one.
    const finish = (error: string) => {
      finishRun(job, error, now());
      const where = (job.kind === "push" ? "to " : "from ") + job.relays.join(", ");
      const outcome = error ? `failed after ${job.rounds} rounds: ${error}` : job.kind === "push" ? `finished: ${job.sent} events sent${job.refused ? ", " + job.refused + " refused" : ""}` : `finished: ${job.stored} events${job.blobs ? " and " + job.blobs + " files" : ""}${job.skipped ? ", " + job.skipped + " skipped" : ""}`;
      void notify(this, "jobs", `${job.label} ${where} ${outcome}.`, "jobs on " + this.slug);
    };
    if (r.error) {
      job.failures++;
      if (job.failures >= 3) finish(r.error);
    } else {
      job.failures = 0;
      if (!r.more) finish("");
    }
    fresh[slot] = job;
    await this.saveJobs(fresh);
    return fresh.some((j) => j.running || (j.nextRun > 0 && j.nextRun <= now()));
  }

  // nextJobRun is the earliest standing run, or 0.
  private async nextJobRun(): Promise<number> {
    let at = 0;
    for (const j of await this.jobs()) if (j.nextRun > 0 && (at === 0 || j.nextRun < at)) at = j.nextRun;
    return at;
  }

  // ---- fuel plumbing ----

  tally() {
    const d = this.store.drain();
    this.meter.rowsRead += d.rowsRead;
    this.meter.rowsWritten += d.rowsWritten;
    if (this.meter.bytesIn + this.meter.bytesOut > FLUSH_BYTES || this.meter.rowsRead + this.meter.rowsWritten > 5000) this.flushUsage();
  }

  // flushUsage moves the counters to the usage table, and reports the same
  // numbers outward: one JSON line on the console, which Workers Logs and
  // any OTLP logs destination carry with the relay's name in it, and one
  // Analytics Engine data point when the host bound a dataset. Both are
  // deltas since the last flush; a destination sums them.
  flushUsage() {
    const m = this.meter;
    if (m.bytesIn + m.bytesOut + m.rowsRead + m.rowsWritten + m.activeMs === 0) return;
    this.meter = { bytesIn: 0, bytesOut: 0, rowsRead: 0, rowsWritten: 0, activeMs: 0, accepted: 0, refused: 0, reqs: 0 };
    this.fuel.record(now(), m);
    this.store.drain();
    const connections = this.connections();
    console.log(JSON.stringify({ msg: "meter", relay: this.slug, ...m, connections }));
    this.env.METRICS?.writeDataPoint({
      indexes: [this.slug],
      blobs: ["meter"],
      doubles: [m.bytesIn, m.bytesOut, m.rowsRead, m.rowsWritten, m.activeMs, m.accepted, m.refused, m.reqs, connections],
    });
  }

  // Events live in the object's SQLite database; media in R2. Priced apart.
  eventBytes(): number {
    return this.store.databaseSize;
  }

  // Files and dumps both live in R2 and both cost media storage.
  mediaBytes(): number {
    return blobBytes(this.sql) + dumpBytes(this.sql) + importBytes(this.sql);
  }

  fuelStatus() {
    this.flushUsage();
    return this.fuel.status(now(), this.eventBytes(), this.mediaBytes());
  }

  // ensureAlarm keeps a daily tick scheduled for storage charging and usage
  // flushes, without pre-empting a sooner NIP-40 expiry.
  private async ensureAlarm(latest = now() + 86400) {
    const lease = this.settings.policy.lease;
    if (this.settings.isLeased() && lease && lease.until < latest) latest = lease.until;
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
    this.settings.upsertMember(auth.pubkey, { via: "invite " + code.slice(0, 8), invitedBy: inviteCreator(this.sql, code) }, now());
    await this.publishMembership({ pubkey: auth.pubkey, added: true });
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
    if (this.settings.policy.owner && !this.identity.pubkey) await this.publishMembership();
    // A blocked address gets no socket and no door that writes or reads
    // events or files. The page, NIP-11 and management stay reachable, so
    // an owner who blocked their own address can undo it.
    const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const door = upgrade || (req.method === "POST" && (url.pathname === "/events" || url.pathname === "/query" || url.pathname === "/count" || url.pathname === "/api/invites/claim" || url.pathname === "/fuel/invoice")) || url.pathname === "/upload" || url.pathname === "/mirror" || url.pathname === "/report" || url.pathname.startsWith("/list/") || isBlobPath(url.pathname);
    if (door && this.settings.isIPBlocked(clientIP(req))) {
      const msg = "blocked: this address is blocked from this relay";
      return new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "content-type": "application/json", "x-reason": msg, "access-control-allow-origin": "*" } });
    }
    if (upgrade) return this.acceptWebSocket(req);
    if (req.headers.get("accept")?.includes("application/nostr+json")) {
      return Response.json(this.info(url.host), {
        headers: { "content-type": "application/nostr+json", "access-control-allow-origin": "*" },
      });
    }
    if (req.method === "POST" && req.headers.get("content-type")?.includes("application/nostr+json+rpc")) return manage(this, req);
    if (req.method === "POST" && (url.pathname === "/events" || url.pathname === "/query" || url.pathname === "/count")) return bridge(this, req);
    if (url.pathname === "/.well-known/nostr.json") {
      const who = whoAsks(req, "", null);
      if (typeof who === "string") return Response.json({ error: who }, { status: 401, headers: { "access-control-allow-origin": "*" } });
      return Response.json(nip05Document(this.settings, url.searchParams.get("name"), this.relayURL(url.host), who.pubkeys), { headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/people" && req.method === "GET") {
      const p = this.settings.policy;
      const who = whoAsks(req, "", null);
      if (typeof who === "string") return Response.json({ error: who }, { status: 401, headers: { "access-control-allow-origin": "*" } });
      const listed = p.owner !== "" && this.settings.mayList(who.pubkeys) === "";
      const people = listed ? this.settings.members().map((m) => ({ pubkey: m.pubkey, role: m.role, name: m.name })) : [];
      return Response.json({ public: p.directoryPublic, self: this.identity.pubkey, host: url.host, people }, { headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/terms" && req.method === "GET") {
      const terms = this.settings.policy.joinTerms;
      if (!terms) return new Response("this relay has no terms", { status: 404 });
      return new Response(termsPage(this.settings.policy.name || this.slug, url.host, terms), { headers: { "content-type": "text/html; charset=utf-8" } });
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
    if (url.pathname.startsWith("/dumps/") && req.method === "GET") return dumpDownload(this, req);
    if (url.pathname.startsWith("/view/") && req.method === "GET") return serveView(this, req, verifyNIP98);
    if (url.pathname === "/import" && req.method === "PUT") return importUpload(this, req);
    if (url.pathname === "/upload" || url.pathname === "/mirror" || url.pathname === "/report" || url.pathname.startsWith("/list/") || isBlobPath(url.pathname)) return blossom(this, req);
    if (url.pathname === "/.well-known/nostr/nip96.json" || url.pathname === "/nip96" || url.pathname.startsWith("/nip96/")) return nip96(this, req);
    if (url.pathname === "/fuel" && req.method === "GET") {
      // Meters and prices for anyone who might top up; who paid is the
      // owner's, in the stats method.
      return Response.json(this.fuelStatus(), { headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/fuel/invoice" && req.method === "POST") return this.fuelInvoice(req);
    if (url.pathname === "/card.json" || url.pathname === "/card.nostr" || url.pathname === "/card.svg" || url.pathname === "/qr.svg") return card(this, req);
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, accept", "access-control-allow-methods": "GET, POST, OPTIONS" } });
    }
    if (isPagePath(url.pathname) && req.method === "GET") return pages(this, req);
    if (url.pathname === "/") return new Response(dashboard(),{ headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/signer.js") return new Response(SIGNER_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=604800, immutable" } });
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
    return new Response("not found", { status: 404 });
  }

  connections(): number {
    return this.ctx.getWebSockets().length;
  }

  // relayURL is how this relay is addressed for a given Host header.
  relayURL(host: string): string {
    // Everything but local development is behind TLS, custom domains included.
    const h = host.replace(/:\d+$/, "");
    const local = h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]";
    return (local ? "ws://" : "wss://") + host;
  }

  // webURL is the same address for a browser.
  webURL(host: string): string {
    return this.relayURL(host).replace(/^ws/, "http");
  }

  // maxMessage is the socket message cap in bytes: the owner's rule, under the platform's ceiling.
  maxMessage(): number {
    return Math.min(this.settings.policy.maxMessageKB * 1024, MAX_MESSAGE);
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
        max_message_length: this.maxMessage(),
        max_subscriptions: p.maxSubs,
        max_limit: p.maxLimit,
        default_limit: p.maxLimit,
        max_subid_length: 64,
        // True whenever a fresh socket cannot REQ: reads for the authenticated or for members.
        auth_required: p.reads !== "open",
        payment_required: false,
        restricted_writes: p.writes !== "open" || this.settings.isUnclaimed(),
        created_at_upper_limit: p.maxFuture || undefined,
        min_pow_difficulty: p.minPow || undefined,
      },
    };
    if (p.icon) doc.icon = p.icon;
    if (p.banner) doc.banner = p.banner;
    if (p.joinTerms && host) doc.terms_of_service = this.webURL(host) + "/terms";
    if (p.postingPolicy) doc.posting_policy = p.postingPolicy;
    if (p.privacyPolicy) doc.privacy_policy = p.privacyPolicy;
    if (p.tags.length) doc.tags = p.tags;
    if (p.languageTags.length) doc.language_tags = p.languageTags;
    if (p.relayCountries.length) doc.relay_countries = p.relayCountries;
    if (p.contact) doc.contact = p.contact;
    const retention = this.settings.listRetention().map((r) => (r.kind === null ? { time: r.days * 86400 } : { kinds: [r.kind], time: r.days * 86400 }));
    if (retention.length) doc.retention = retention;
    if (this.fuel.cfg.lightningAddress && this.fuel.cfg.servicePubkey && host) {
      const f = this.fuel.status(now(), this.eventBytes(), this.mediaBytes());
      (doc.limitation as Record<string, unknown>).payment_required = f.outOfFuel;
      doc.payments_url = "https://" + host + "/";
    }
    if (p.owner) doc.pubkey = p.owner;
    if (p.succession && this.succession.warn) doc.succession_pending = new Date((this.succession.warn.since + SUCCESSION_WARN_DAYS * 86400) * 1000).toISOString().slice(0, 10);
    if (this.settings.isLeased() && p.lease) doc.lease = { expires_at: p.lease.until, holder: p.lease.holder || undefined, claim_url: host ? "https://" + host + "/" : undefined };
    if (host) doc.self_url = this.relayURL(host);
    if (this.identity.pubkey) {
      doc.self = this.identity.pubkey;
      doc.supported_nips = [...SUPPORTED_NIPS, 43];
      doc.views = nip11Views(this);
    }
    return doc;
  }

  // ---- websockets ----

  private acceptWebSocket(req: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const state: ConnState = { challenge: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), host: new URL(req.url).host, authed: [], subs: {}, ip: clientIP(req) };
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
      s = (ws.deserializeAttachment() as ConnState) ?? { challenge: "", host: "", authed: [], subs: {}, ip: "unknown" };
      if (!s.ip) s.ip = "unknown"; // sockets from before addresses were kept
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
    if (message.length > this.maxMessage()) {
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
        const limited = this.bucket(ws).events.take(p.eventsPerMinute) || this.ipLimit(s.ip, "events");
        if (limited) {
          const id = (arr[1] as { id?: unknown })?.id;
          return this.send(ws, "OK", typeof id === "string" ? id : "", false, limited);
        }
        return this.handleEvent(ws, s, arr[1]);
      }
      case "REQ":
      case "COUNT": {
        if (arr.length < 3) return this.send(ws, "NOTICE", `error: ${typ} needs an id and at least one filter`);
        const limited = this.bucket(ws).reqs.take(p.reqsPerMinute) || this.ipLimit(s.ip, "reqs");
        if (limited) return this.send(ws, "CLOSED", typeof arr[1] === "string" ? arr[1] : "", limited);
        this.meter.reqs++;
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
    this.notePresence();
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
    if (r.ok) this.meter.accepted++;
    else this.meter.refused++;
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
    if (e.kind === KIND_REPORT) return this.acceptReport(e, conn.host);
    if (isGroupManagement(e.kind) && (hasTag(e, "h") || isNIP43Request(e.kind))) return this.acceptGroup(e, conn);
    return this.accept(e, conn);
  }

  // acceptGroup handles NIP-29 joins, leaves and moderation: the common gate,
  // then role checks instead of the write policy, then stored like any event.
  private async acceptGroup(e: Event, conn: ConnState): Promise<{ ok: boolean; msg: string; stored: boolean }> {
    const t = now();
    const reason = writeGate(this, e, conn, t);
    if (reason) return { ok: false, msg: reason, stored: false };
    if (this.sql.exec(`SELECT 1 FROM events WHERE id=?`, e.id).toArray().length) return { ok: true, msg: ERR_DUPLICATE, stored: false };
    const r = await handleGroupEvent(this, e);
    if (!r.ok || !r.stored) return r;
    const err = this.store.save(e, t);
    if (err) return { ok: false, msg: err, stored: false };
    return { ok: true, msg: "", stored: true };
  }

  // acceptReport files a NIP-56 report in the moderation queue. It is never
  // stored as an event or served: reports are for the owner, not the feed.
  private acceptReport(e: Event, host = ""): { ok: boolean; msg: string; stored: boolean } {
    if (this.settings.policy.owner === "") return { ok: false, msg: this.settings.isLeased() ? "restricted: this temporary relay has no owner to report to" : "restricted: this relay is unclaimed", stored: false };
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
    // Enough distinct reporters hide an event until a moderator looks.
    const th = this.settings.policy.reportThreshold;
    const target = et?.[1] ?? "";
    if (th > 0 && /^[0-9a-f]{64}$/.test(target) && !this.settings.isEventHidden(target) && !this.settings.isEventBanned(target)) {
      const n = this.sql.exec<{ n: number }>(`SELECT count(DISTINCT reporter) AS n FROM reports WHERE target_event=? AND status='open'`, target).one().n;
      if (n >= th && this.sql.exec(`SELECT 1 FROM events WHERE id=?`, target).toArray().length) this.settings.setEvent(target, "hide", `${n} reports`, e.created_at);
    }
    const where = host ? `https://${host}/#people` : "the People tab";
    void notify(this, "reports", `New report on ${this.slug}: ${type || "report"} about ${p.slice(0, 8)}${et ? " (event " + et[1].slice(0, 8) + ")" : ""} by ${e.pubkey.slice(0, 8)}.${e.content ? " " + e.content.slice(0, 300) : ""} Review it at ${where}`, "a report on " + this.slug);
    return { ok: true, msg: "info: report received", stored: false };
  }

  // accept runs the write-side rules and stores the event. conn is null for
  // host-side publishes (the dashboard), which skip client policy.
  accept(e: Event, conn: ConnState | null): { ok: boolean; msg: string; stored: boolean } {
    const p = this.settings.policy;
    const t = now();
    const no = (msg: string) => ({ ok: false, msg, stored: false });
    const gate = writeGate(this, e, conn, t);
    if (gate) return no(gate);
    if (e.kind === KIND_NOSTR_CONNECT) return { ok: true, msg: "", stored: true }; // see gate
    const exp = expiration(e);
    if (conn) {
      // The owner's own profile and lists always land, whatever the kind
      // rules say: a relay that refuses its owner's relay list cannot be
      // wired into it.
      if (!this.settings.kindAllowed(e.kind) && !(isReplaceable(e.kind) && this.settings.isOwner(e.pubkey))) return no("blocked: this relay does not accept kind " + e.kind);
      const keep = this.settings.retentionDays(e.kind);
      if (keep > 0 && e.created_at < t - keep * 86400) return no(`blocked: this relay keeps kind ${e.kind} for ${keep} days and this event is older`);
      // The owner's per-member rules: a keep-for window on top of the kind
      // rules, and a cap on stored bytes. Neither touches the owner.
      const lim = this.settings.limitsOf(e.pubkey);
      if (lim) {
        if (lim.keep > 0 && !isProtected(e.kind) && !isReplaceable(e.kind) && e.created_at < t - lim.keep * 86400) return no(`blocked: this relay keeps your events for ${lim.keep} days and this event is older`);
        if (lim.cap > 0 && this.store.authorBytes(e.pubkey) + canonical(e).length > lim.cap) return no(`restricted: you have reached your storage cap of ${Math.max(1, Math.round(lim.cap / 1024))} KB on this relay`);
      }
      const why = this.settings.mayWrite(e.pubkey);
      if (why && !guestPass(this, e)) return no(why);
      if (p.minPow > 0) {
        const d = difficulty(e);
        if (d.difficulty < p.minPow) return no(`pow: difficulty ${d.difficulty} is less than ${p.minPow}`);
        if (d.target > 0 && d.target < p.minPow) return no(`pow: committed target ${d.target} is less than ${p.minPow}`);
      }
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
    if (e.kind === 3) this.settings.noteContacts(e.pubkey);
    this.store.noteSaved(e.pubkey, canonical(e).length, isReplaceable(e.kind));
    if (exp > 0) this.scheduleSweep(exp);
    else this.ensureAlarm();
    if (e.kind === 0 && conn) claimFromProfile(this.settings, e.content, e.pubkey, conn.host, t);
    if (conn) void this.succession.seen(e.pubkey);
    if (conn) this.notePresence(e.pubkey);
    if (e.kind === 30023) this.markView("articles");
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
    // A lease that has run out is wiped whole: the name is free again.
    if (this.settings.leaseExpired(t)) {
      await this.teardown();
      return;
    }
    if (await this.jobsTick()) {
      await this.ctx.storage.setAlarm(Date.now() + 250);
      return;
    }
    this.flushUsage();
    this.fuel.chargeStorage(t, this.eventBytes(), this.mediaBytes());
    this.store.drain();
    this.sweepRetention(t);
    await this.viewsTick(t);
    await this.publishDiscovery();
    // Fuel notice: once when it turns low, then once a day while it stays low.
    if (this.settings.policy.notify.fuel) {
      const low = fuelLow(this.fuelStatus());
      const last = (await this.ctx.storage.get<number>("fuel-low-at")) ?? 0;
      if (low && t - last >= 86400) {
        await this.ctx.storage.put("fuel-low-at", t);
        await notify(this, "fuel", fuelText(this, this.fuelStatus()), "fuel on " + this.slug);
      } else if (!low && last) await this.ctx.storage.delete("fuel-low-at");
    }
    // Succession: the dead-man's switch, checked once a day.
    await this.succession.tick(t);
    // ---- digest: one message a week on how the relay is doing ----
    if (this.settings.policy.notify.digest && this.settings.policy.owner !== "") {
      const last = (await this.ctx.storage.get<number>("lastDigest")) ?? 0;
      if (last === 0) await this.ctx.storage.put("lastDigest", t);
      else if (t - last >= DIGEST_DAYS * 86400 - 3600) {
        await this.ctx.storage.put("lastDigest", t);
        await notify(this, "digest", await digestText(this, last, t), "the week on " + this.slug);
      }
    }
    // ---- end digest ----
    const next = this.store.sweepExpired(t);
    // ---- dumps: a scheduled JSONL of everything, into R2 (dumps.ts) ----
    if (dumpDue(this, t)) {
      try {
        await writeDump(this, t);
      } catch (err) {
        console.log("dump failed: " + (err instanceof Error ? err.message : String(err)));
      }
    }
    // ---- end dumps ----
    let at = t + 86400;
    if (next > 0 && next < at) at = next;
    const lease = this.settings.policy.lease;
    if (this.settings.isLeased() && lease && lease.until < at) at = lease.until;
    const run = await this.nextJobRun();
    if (run > 0 && run < at) at = Math.max(run, t + 1);
    await this.ctx.storage.setAlarm(at * 1000 + 500);
  }

  // sweepRetention applies the owner's keep-for rules. Returns how many
  // events were shed.
  sweepRetention(t: number): number {
    const rules = this.settings.listRetention();
    let gone = 0;
    const own = rules.filter((r) => r.kind !== null).map((r) => r.kind as number);
    for (const r of rules) {
      if (r.kind !== null) gone += this.store.purge(r.kind, t - r.days * 86400, [], this.identity.pubkey);
      else gone += this.store.purge(null, t - r.days * 86400, [...own, ...this.store.kindStats().map((k) => k.kind).filter((k) => isReplaceable(k) || isProtected(k) || k === 1059)], this.identity.pubkey);
    }
    // Per-member keep-for rules, same pass, same exceptions as the catch-all.
    const limited = this.settings.limited();
    if (limited.length) {
      const keepKinds = this.store.kindStats().map((k) => k.kind).filter((k) => isReplaceable(k) || isProtected(k));
      for (const m of limited) gone += this.store.purgeAuthor(m.pubkey, t - m.keep * 86400, keepKinds);
    }
    return gone;
  }

  // canSee decides whether a private kind reaches a socket through the
  // filter that matched it. A socket that has AUTHed as the sender or a
  // recipient always sees it. NIP-46 traffic is also delivered to a filter
  // that names a party's key outright, in "#p" or "authors", under any read
  // rule and without AUTH: the payload is encrypted end to end, and signers
  // and their clients hold no key this relay knows. Amber probes a relay
  // this way before it will list it, and Amethyst's bunker listens under a
  // transport key it never AUTHs with. A bare subscription to the kind
  // still sees nothing.
  private canSee(s: ConnState, e: Event, f: Filter): boolean {
    if (!isPrivate(e.kind)) return true;
    const parties = [e.pubkey, ...tagValues(e, "p")];
    if (parties.some((p) => s.authed.includes(p))) return true;
    if (e.kind !== KIND_NOSTR_CONNECT) return false;
    return [...(f.authors ?? []), ...(f.tags.p ?? [])].some((k) => parties.includes(k));
  }

  broadcast(e: Event) {
    const raw = canonical(e);
    for (const ws of this.ctx.getWebSockets()) {
      const s = this.state(ws);
      for (const [id, filters] of Object.entries(s.subs)) {
        if (filters.some((f) => match(f, e) && this.canSee(s, e, f))) {
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

  private handleReq(ws: WebSocket, s: ConnState, verb: string, rawID: unknown, rawFilters: unknown[]) {
    if (typeof rawID !== "string" || rawID === "" || rawID.length > 64) return this.send(ws, "NOTICE", "error: bad subscription id");
    const id = rawID;
    const filters = this.parseFilters(rawFilters);
    if (typeof filters === "string") return this.send(ws, "CLOSED", id, filters);
    const { reason, authHint } = readGate(this, s, filters);
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
    void this.succession.seen(e.pubkey);
    this.notePresence();
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
    // The responder's side of a sync is the sorted item list and nothing
    // else, and the list comes from the filter. So the filter rides on the
    // socket's attachment with the subscriptions, and a session whose
    // Negentropy object went with the object's memory is rebuilt from it
    // when the next message arrives, rather than ended with closed:.
    const remember = (f: Filter | null) => {
      const next = { ...(s.syncs ?? {}) };
      if (f) next[id] = f;
      else delete next[id];
      if (Object.keys(next).length) s.syncs = next;
      else delete s.syncs;
      // Past the attachment limit the filter stays in memory only, and the
      // session ends when the object sleeps, as every session once did.
      if (!this.persist(ws, s) && f) {
        delete s.syncs![id];
        if (Object.keys(s.syncs!).length === 0) delete s.syncs;
      }
    };
    if (verb === "NEG-CLOSE") {
      sessions.delete(id);
      if (s.syncs?.[id]) remember(null);
      return;
    }
    if (verb === "NEG-OPEN") {
      if (rest.length < 2) return this.send(ws, "NEG-ERR", id, "error: NEG-OPEN needs a filter and a message");
      const f = parseFilter(rest[0]);
      if (typeof f === "string") return this.send(ws, "NEG-ERR", id, "invalid: bad filter: " + f);
      const { reason } = readGate(this, s, [f]);
      if (reason) return this.send(ws, "NEG-ERR", id, reason);
      const open = new Set([...sessions.keys(), ...Object.keys(s.syncs ?? {})]);
      if (!open.has(id) && open.size >= this.settings.policy.maxSubs) return this.send(ws, "NEG-ERR", id, "blocked: too many open syncs");
      const items = this.store.syncItems(f, { pubkeys: s.authed }, MAX_SYNC, now());
      if (items === "too big") return this.send(ws, "NEG-ERR", id, ERR_TOO_BIG, MAX_SYNC);
      sess = new Negentropy(items, sha256);
      sessions.set(id, sess);
      remember(f);
      msgHex = typeof rest[1] === "string" ? rest[1] : "";
    } else {
      const f = s.syncs?.[id];
      if (!sess && f) {
        // A wake since NEG-OPEN. The read rule is asked again with what the
        // socket has proved by now, and the items are read afresh, so the
        // session carries on from the store as it is.
        const { reason } = readGate(this, s, [f]);
        if (reason) {
          remember(null);
          return this.send(ws, "NEG-ERR", id, reason);
        }
        const items = this.store.syncItems(f, { pubkeys: s.authed }, MAX_SYNC, now());
        if (items === "too big") {
          remember(null);
          return this.send(ws, "NEG-ERR", id, ERR_TOO_BIG, MAX_SYNC);
        }
        sess = new Negentropy(items, sha256);
        sessions.set(id, sess);
      }
      if (!sess) return this.send(ws, "NEG-ERR", id, "closed: no such sync, send NEG-OPEN first");
      msgHex = typeof rest[0] === "string" ? rest[0] : "";
    }
    if (!/^([0-9a-f]{2})*$/i.test(msgHex)) return this.send(ws, "NEG-ERR", id, "invalid: message is not hex");
    try {
      const { reply } = sess.reconcile(hexToBytes(msgHex));
      this.send(ws, "NEG-MSG", id, bytesToHex(reply ?? new Uint8Array()));
    } catch (err) {
      sessions.delete(id);
      if (s.syncs?.[id]) remember(null);
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
