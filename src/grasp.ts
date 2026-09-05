// GRASP-01 Smart HTTP on a relay origin. Nostr events authorize changes;
// Repositories publish compressed objects in SQLite. ntig supplies pack
// verification and the Git protocol.
import { createGitHandler, createAcceptedStateRepository, createPrRepository, parseRepositoryPath, repositoryAddress, repositoryStoragePrefix, LimitError, AuthorizationError, type CommitRequest, type GitRepository, type RefUpdate } from "ntig";
import { npubEncode, naddrEncode } from "nostr-tools/nip19";
import { now, tag, type Event } from "./event.ts";
import { KIND_REPO, KIND_REPO_STATE, KIND_GIT_PR, KIND_GIT_PR_UPDATE } from "./kinds.ts";
import { featureOn } from "./settings.ts";
import { page, escapeHTML as esc } from "./ui.ts";
import { relatedRepositoryCoordinates, repositoryCoordinate, type RepositoryAnnouncement } from "./grasp-policy.ts";
import { hostedAnnouncements, repository, repositoryState, requiredObjects, eventRepository, PR_REF_SECONDS } from "./grasp-state.ts";
import type { Relay } from "./relay.ts";
import { syncGitTick } from "./grasp-git-sync.ts";
import { graspSyncTick } from "./grasp-sync.ts";
import { GitSqliteRepository } from "./git-sqlite.ts";
import { sqliteGitBytes, gitSql } from "./git-catalog.ts";
import { gitObjects } from "./git-objects.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "Content-Type, Authorization, Git-Protocol, X-Git-Request-Id" };
export function graspCORS(response: Response, preflight = false): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  if (preflight) { void response.body?.cancel(); return new Response(null, { status: 204, headers }); }
  return new Response(response.body, { status: response.status, headers });
}
const answer = (reason: string, status: number) => new Response(reason, { status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
// isGitPath reserves malformed Git paths too, so every failure has CORS.
export const isGitPath = (url: URL) => /^\/(?:npub|prs\/)/.test(url.pathname) || /\.git(?:\/|$)/.test(url.pathname);

export const gitStoragePrefix = async (relay: Relay, repo: RepositoryAnnouncement, alternativePRs = false) => `${relay.slug}/git/${await repositoryStoragePrefix(repositoryAddress(npubEncode(repo.owner), repo.identifier), alternativePRs)}`;

export type GitBackend = GitSqliteRepository;

// gitRepository binds one repository to the relay SQLite database.
export async function gitRepository(relay: Relay, repo: RepositoryAnnouncement, alternativePRs = false): Promise<GitBackend> {
  const prefix = await gitStoragePrefix(relay, repo, alternativePRs);
  const namespace = prefix.split("/").filter(Boolean).at(-1)!;
  let released: Event[] = [];
  const sql = new GitSqliteRepository({
    sql: relay.sql, repository: namespace,
    transactionSync: work => relay.storage.transactionSync(work),
    meter: counts => relay.meterPush(counts.rowsRead, counts.rowsWritten),
    quota: () => {
      // This callback runs after staging SQL rows in the transaction. A quota
      // failure rolls back publication and its receipt together.
      const fuel = relay.fuel.status(now(), relay.eventBytes(), relay.mediaBytes());
      if (fuel.outOfFuel) throw new LimitError("Relay storage or fuel limit reached");
      const cap = relay.settings.limitsOf(repo.owner)?.cap ?? 0;
      if (cap && sqliteGitBytes(relay, repo.owner, namespace) + relay.store.authorBytes(repo.owner) > cap) throw new LimitError("Repository owner's storage cap reached");
      if (sqliteGitBytes(relay) > 320 * 1024 * 1024) throw new LimitError("Relay Git storage quota reached");
    },
    onCommit: change => {
      gitSql(relay, "INSERT OR IGNORE INTO git_sqlite_catalog(repository,owner,identifier,alternative) VALUES(?,?,?,?)", namespace, repo.owner, repo.identifier, alternativePRs ? 1 : 0);
      const updates = JSON.parse(gitSql<{ updates: string }>(relay, "SELECT updates FROM git_sqlite_receipts WHERE repository=? AND id=?", namespace, change.id).one().updates) as RefUpdate[];
      trackPrRefs(relay, repo, updates, alternativePRs);
      released = releasePending(relay, repo, alternativePRs, oid => sql.hasObjectSync(oid));
    },
    afterCommit: () => { for (const event of released) relay.broadcast(event); released = []; },
  });
  return sql;
}

// prTip distinguishes unknown IDs from known events that cannot authorize
// this repository. Purgatory PRs may authorize their own arriving objects.
function prTip(relay: Relay, repo: RepositoryAnnouncement, id: string): string | null | false {
  const row = gitSql<{ raw: string }>(relay, `SELECT raw FROM events WHERE id=?`, id).toArray()[0];
  if (!row) {
    const timed = gitSql<{ until: number }>(relay, `SELECT until FROM grasp_pr_refs WHERE repo=? AND ref=?`, repositoryCoordinate(repo), `refs/nostr/${id}`).toArray()[0];
    return timed && timed.until <= now() ? false : null;
  }
  const e = JSON.parse(row.raw) as Event;
  if (![KIND_GIT_PR, KIND_GIT_PR_UPDATE].includes(e.kind) || relay.settings.isEventHidden(id) || relay.settings.isEventBanned(id) || relay.settings.isBanned(e.pubkey)) return false;
  const exp = Number(tag(e, "expiration"));
  if (exp && exp <= now()) return false;
  if (eventRepository(relay, e)?.id !== repo.id) return false;
  return /^[0-9a-f]{40}$/.test(tag(e, "c")) ? tag(e, "c") : false;
}

export const prCoordinate = (repo: Pick<RepositoryAnnouncement, "owner" | "identifier">) => `pr:${repo.owner}:${repo.identifier}`;
export const prRepositoryIdentity = (owner: string, identifier: string): RepositoryAnnouncement => ({ id: `pr:${owner}:${identifier}`, owner, identifier, clone: [], relays: [], maintainers: [], private: false });

// alternativePrAddress matches an accepted event's own signer path on this relay.
export function alternativePrAddress(relay: Relay, e: Event, host = ""): RepositoryAnnouncement | null {
  const hosts = new Set([`${relay.slug}.${relay.domain}`, ...(host ? [host] : []), ...relay.settings.policy.customHosts.filter(h => !h.site && h.status === "active").map(h => h.host)]);
  for (const raw of e.tags.filter(t => t[0] === "clone").flatMap(t => t.slice(1))) {
    try {
      const url = new URL(raw);
      if (!hosts.has(url.host) || url.origin !== relay.webURL(url.host) || url.username || url.password || url.search || url.hash) continue;
      const path = parseRepositoryPath(url.pathname);
      if (!path || !path.alternativePRs || path.endpoint !== "root" || path.address.pubkey !== e.pubkey) continue;
      if (!relatedRepositoryCoordinates(e).some(c => c.split(":").slice(2).join(":") === path.address.identifier)) continue;
      return prRepositoryIdentity(e.pubkey, path.address.identifier);
    } catch { /* Another clone tag may name this service. */ }
  }
  return null;
}

// alternativePrTip retains unknown upload deadlines independently of normal repos.
function alternativePrTip(relay: Relay, repo: RepositoryAnnouncement, id: string, host = ""): string | null | false {
  const row = gitSql<{ raw: string }>(relay, `SELECT raw FROM events WHERE id=?`, id).toArray()[0];
  if (!row) {
    const timed = gitSql<{ until: number }>(relay, `SELECT until FROM grasp_pr_refs WHERE repo=? AND ref=?`, prCoordinate(repo), `refs/nostr/${id}`).toArray()[0];
    return timed && timed.until <= now() ? false : null;
  }
  const e = JSON.parse(row.raw) as Event;
  if (![KIND_GIT_PR, KIND_GIT_PR_UPDATE].includes(e.kind) || e.pubkey !== repo.owner || relay.settings.isEventHidden(id) || relay.settings.isEventBanned(id) || relay.settings.isBanned(e.pubkey)) return false;
  const expires = Number(tag(e, "expiration"));
  const pending = gitSql<{ until: number }>(relay, `SELECT until FROM grasp_pending WHERE id=?`, id).toArray()[0];
  if ((expires && expires <= now()) || (pending && pending.until <= now())) return false;
  if (alternativePrAddress(relay, e, host)?.id !== repo.id) return false;
  return /^(?!0{40}$)[0-9a-f]{40}$/.test(tag(e, "c")) ? tag(e, "c") : false;
}

// alternativePrRepository keeps transport policy in ntig and visibility in the relay.
function alternativePrRepository(relay: Relay, repo: RepositoryAnnouncement, wal: GitBackend, host: string): GitRepository {
  const tracked: GitRepository = {
    load: () => wal.load(), loadRefs: () => wal.loadRefs(), lookupRecord: id => wal.lookupRecord(id),
    ...objectMethods(wal),
    commit: async request => {
      return wal.commit(request, () => checkAuthority(relay, repo, request.updates, true, host));
    },
  };
  const authorized = createPrRepository(tracked, { lookupTip: async id => alternativePrTip(relay, repo, id, host), allowUnknownPrRefs: true });
  return {
    load: () => authorized.load(),
    ...objectMethods(authorized),
    lookupRecord: id => authorized.lookupRecord!(id),
    loadRefs: () => authorized.loadRefs!(),
    commit: async request => {
      const receipt = await authorized.commit(request);
      await promote(relay, repo, wal, true);
      return receipt;
    },
  };
}

// objectMethods preserves the indexed path through policy wrappers.
const objectMethods = (repo: GitRepository): Pick<GitRepository, "getObject" | "getObjectInfo"> => repo.getObject && repo.getObjectInfo ? { getObject: oid => repo.getObject!(oid), getObjectInfo: oid => repo.getObjectInfo!(oid) } : {};

// checkAuthority runs again inside SQLite publication after asynchronous decoding.
function checkAuthority(relay: Relay, repo: RepositoryAnnouncement, updates: readonly RefUpdate[], alternative = false, host = "") {
  if (!featureOn(relay.settings.policy, "grasp") || (alternative && !featureOn(relay.settings.policy, "grasp06")) || relay.settings.policy.reads !== "open" || relay.settings.isUnclaimed() || relay.settings.leaseExpired(now()) || relay.settings.isBanned(repo.owner)) throw new AuthorizationError("Repository hosting is unavailable");
  if (!alternative && repository(relay, repo.owner, repo.identifier)?.id !== repo.id) throw new AuthorizationError("Repository announcement changed");
  const state = alternative ? null : repositoryState(relay, repo);
  for (const update of updates) {
    if (/^refs\/nostr\/[0-9a-f]{64}$/.test(update.name)) {
      const tip = alternative ? alternativePrTip(relay, repo, update.name.slice(11), host) : prTip(relay, repo, update.name.slice(11));
      if (update.new === null || tip === false || (tip !== null && tip !== update.new)) throw new AuthorizationError("Pull request authority changed");
    } else if (alternative || !state || (state.refs[update.name] ?? null) !== update.new) throw new AuthorizationError("Repository state changed");
  }
}

// trackPrRefs retains the deadline for an upload whose signed PR arrives later.
function trackPrRefs(relay: Relay, repo: RepositoryAnnouncement, updates: readonly RefUpdate[], alternative = false, host = "") {
  const coordinate = alternative ? prCoordinate(repo) : repositoryCoordinate(repo);
  if (alternative) {
    const existing = gitSql<{ ref: string }>(relay, "SELECT ref FROM grasp_pr_refs WHERE repo=?", coordinate).toArray();
    const namespaces = gitSql<{ n: number }>(relay, "SELECT count(DISTINCT repo) AS n FROM grasp_pr_refs WHERE repo LIKE 'pr:%'").one().n;
    if (!existing.length && namespaces >= 16) throw new LimitError("Alternative PR repository quota reached");
    if (new Set([...existing.map(row => row.ref), ...updates.filter(u => u.new !== null).map(u => u.name)]).size > 1024) throw new LimitError("Alternative PR ref quota reached");
  }
  for (const update of updates) {
    if (!/^refs\/nostr\/[0-9a-f]{64}$/.test(update.name)) continue;
    if (update.new === null) gitSql(relay, "DELETE FROM grasp_pr_refs WHERE repo=? AND ref=?", coordinate, update.name);
    else {
      const tip = alternative ? alternativePrTip(relay, repo, update.name.slice(11), host) : prTip(relay, repo, update.name.slice(11));
      gitSql(relay, "INSERT INTO grasp_pr_refs(repo,ref,until) VALUES(?,?,?) ON CONFLICT(repo,ref) DO NOTHING", coordinate, update.name, typeof tip === "string" ? 0 : now() + PR_REF_SECONDS);
    }
  }
}

const pendingEvents = (relay: Relay) => gitSql<{ raw: string }>(relay, "SELECT raw FROM events JOIN grasp_pending ON grasp_pending.id=events.id WHERE grasp_pending.until>? AND (events.expires=0 OR events.expires>?) LIMIT 1024", now(), now()).toArray().map(row => JSON.parse(row.raw) as Event);
const pendingObjects = (relay: Relay, repo: RepositoryAnnouncement, e: Event, alternative: boolean) => {
  if (relay.settings.isEventHidden(e.id) || relay.settings.isEventBanned(e.id) || relay.settings.isBanned(e.pubkey)) return null;
  const relevant = alternative ? alternativePrTip(relay, repo, e.id) === tag(e, "c") : e.kind === KIND_REPO ? repository(relay, repo.owner, repo.identifier)?.id === e.id : e.kind === KIND_REPO_STATE ? tag(e, "d") === repo.identifier && repositoryState(relay, repo)?.id === e.id : eventRepository(relay, e)?.id === repo.id;
  return relevant ? requiredObjects(relay, e) : null;
};

// releasePending changes event visibility in the same transaction as refs.
function releasePending(relay: Relay, repo: RepositoryAnnouncement, alternative: boolean, hasObject: (oid: string) => boolean): Event[] {
  const released: Event[] = [];
  const present = new Map<string, boolean>();
  for (const event of pendingEvents(relay)) {
    const required = pendingObjects(relay, repo, event, alternative);
    if (!required || !required.every(oid => { if (!present.has(oid)) present.set(oid, hasObject(oid)); return present.get(oid); })) continue;
    if (event.kind === KIND_GIT_PR || event.kind === KIND_GIT_PR_UPDATE) gitSql(relay, "UPDATE grasp_pr_refs SET until=0 WHERE repo=? AND ref=?", alternative ? prCoordinate(repo) : repositoryCoordinate(repo), `refs/nostr/${event.id}`);
    gitSql(relay, "DELETE FROM grasp_pending WHERE id=?", event.id);
    released.push(event);
  }
  return released;
}

// promote finishes event-first arrivals and retries, rechecking authority after reads.
export async function promote(relay: Relay, repo: RepositoryAnnouncement, wal: GitRepository, alternative = false) {
  const pending = pendingEvents(relay).flatMap(e => pendingObjects(relay, repo, e, alternative) ?? []);
  if (!pending.length || !(await (wal.loadRefs ? wal.loadRefs() : wal.load())).sequence) return;
  const objects = await gitObjects(wal);
  const available = new Set<string>();
  for (const oid of new Set(pending)) if (await objects.info(oid)) available.add(oid);
  const released = relay.storage.transactionSync(() => releasePending(relay, repo, alternative, oid => available.has(oid)));
  for (const event of released) relay.broadcast(event);
}

// authorizedRepository applies signed event authority to stored Git refs.
export function authorizedRepository(relay: Relay, repo: RepositoryAnnouncement, wal: GitBackend): GitRepository {
  const checked: GitRepository = {
    load: () => wal.load(), loadRefs: () => wal.loadRefs(), lookupRecord: id => wal.lookupRecord(id),
    ...objectMethods(wal),
    commit: request => wal.commit(request, () => checkAuthority(relay, repo, request.updates)),
  };
  const authorized = createAcceptedStateRepository(checked, {
    lookupState: async () => { const state = repositoryState(relay, repo); return state ? { eventId: state.id, refs: state.refs, head: state.head } : null; },
    lookupPrTip: async (id) => prTip(relay, repo, id),
    allowUnknownPrRefs: true,
  });
  return {
    load: () => authorized.load(),
    ...objectMethods(authorized),
    lookupRecord: id => authorized.lookupRecord!(id),
    loadRefs: () => authorized.loadRefs ? authorized.loadRefs() : authorized.load(),
    commit: async (request: CommitRequest) => {
      const receipt = await authorized.commit(request);
      await promote(relay, repo, wal);
      return receipt;
    },
  };
}

// grasp serves Git only while open reads, admission and fuel permit hosting.
// One in-flight operation bounds memory and fences all relay-side mutations.
export async function grasp(relay: Relay, req: Request, url: URL): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!featureOn(relay.settings.policy, "grasp")) return answer("not found", 404);
  if (relay.settings.policy.reads !== "open") return answer("restricted: public Git hosting requires open reads", 403);
  if (relay.settings.isUnclaimed() || relay.settings.leaseExpired(now())) return answer("restricted: relay is not active", 403);
  const parsed = parseRepositoryPath(url.pathname);
  if (!parsed || (parsed.alternativePRs && !featureOn(relay.settings.policy, "grasp06"))) return answer("not found", 404);
  const repo = parsed.alternativePRs ? prRepositoryIdentity(parsed.address.pubkey, parsed.address.identifier) : repository(relay, parsed.address.pubkey, parsed.address.identifier);
  if (!repo) return answer("not found", 404);
  const limited = relay.ipLimit(req.headers.get("x-relay-ip") || "unknown", req.method === "POST" ? "events" : "reqs");
  if (limited) return answer(limited, 429);
  if (relay.fuelStatus().outOfFuel) return answer("restricted: relay storage or fuel limit reached", 403);
  return relay.repositoryAccess.run("git", async () => {
    try {
      if (parsed.endpoint === "root") {
        if (req.method !== "GET" && req.method !== "HEAD") return answer("invalid: method not allowed", 405);
        const coordinate = naddrEncode({ kind: KIND_REPO, pubkey: repo.owner, identifier: repo.identifier });
        const description = parsed.alternativePRs ? "Alternative pull request storage follows the signer's accepted PR events. Only refs/nostr/&lt;event-id&gt; are served." : "Git storage follows signed Nostr repository state.";
        const link = parsed.alternativePRs ? "" : `<p><a href="nostr:${coordinate}">Open in a Nostr Git client</a></p>`;
        const html = page(repo.identifier, `<h1>${esc(repo.identifier)}</h1><p>${description}</p>${link}<pre>git clone ${esc(relay.webURL(url.host) + parsed.prefix)}</pre>`);
        return new Response(req.method === "HEAD" ? null : html, { headers: { ...CORS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const wal = await gitRepository(relay, repo, parsed.alternativePRs);
      const response = await wal.withReadSession(async (scopedWal) => {
        const handler = createGitHandler(parsed.alternativePRs ? alternativePrRepository(relay, repo, scopedWal, url.host) : authorizedRepository(relay, repo, scopedWal), { prefix: parsed.prefix, authorizePush: () => true, observe: (event) => relay.meterBytes(event.requestBytes, event.responseBytes) });
        return await handler(req);
      });
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return answer(error instanceof LimitError ? "restricted: Git repository limit reached" : "error: Git repository unavailable", error instanceof LimitError ? 413 : 503);
    } finally {
      await relay.ensureAlarm(now() + 60);
    }
  }, () => answer("restricted: relay operation in progress; retry", 429));
}

// graspTick expires purgatory and cleans one repository per alarm. Event
// deletion removes visibility; retained Git objects remain charged until teardown.
export async function graspTick(relay: Relay): Promise<number> {
  gitSql(relay, `DELETE FROM events WHERE id IN (SELECT id FROM grasp_pending WHERE until<=?)`, now());
  const all = hostedAnnouncements(relay);
  const last = gitSql<{ coordinate: string }>(relay, `SELECT coordinate FROM grasp_tick WHERE id=1`).toArray()[0]?.coordinate ?? "";
  const ordered = all.sort((a, b) => repositoryCoordinate(a).localeCompare(repositoryCoordinate(b)));
  const repo = ordered.find((r) => repositoryCoordinate(r) > last) ?? ordered[0];
  if (repo) gitSql(relay, `INSERT OR REPLACE INTO grasp_tick(id,coordinate) VALUES(1,?)`, repositoryCoordinate(repo));
  for (const { repo: coordinate } of gitSql<{ repo: string }>(relay, `SELECT DISTINCT repo FROM grasp_pr_refs`).toArray()) {
    if (!coordinate.startsWith("pr:") && !all.some((r) => repositoryCoordinate(r) === coordinate)) gitSql(relay, `DELETE FROM grasp_pr_refs WHERE repo=?`, coordinate);
  }
  if (repo && featureOn(relay.settings.policy, "grasp") && !relay.fuelStatus().outOfFuel) {
    try {
      const wal = await gitRepository(relay, repo);
      const snapshot = await wal.loadRefs();
      const refs = gitSql<{ ref: string }>(relay, `SELECT ref FROM grasp_pr_refs WHERE repo=? AND until>0 AND until<=?`, repositoryCoordinate(repo), now()).toArray();
      for (const { ref } of refs) {
        const current = snapshot.refs[ref];
        const tip = prTip(relay, repo, ref.slice("refs/nostr/".length));
        if (current && tip !== current) await wal.commit({ id: `expire:${ref.slice(-64)}:${current}`, updates: [{ name: ref, old: current, new: null }] });
        if (tip === current && current) gitSql(relay, `UPDATE grasp_pr_refs SET until=0 WHERE repo=? AND ref=?`, repositoryCoordinate(repo), ref);
        else gitSql(relay, `DELETE FROM grasp_pr_refs WHERE repo=? AND ref=?`, repositoryCoordinate(repo), ref);
      }
      await promote(relay, repo, wal);
    } catch { /* The next bounded alarm retries; retained bytes stay metered. */ }
  }
  if (featureOn(relay.settings.policy, "grasp06") && !relay.fuelStatus().outOfFuel) {
    const expired = gitSql<{ repo: string; ref: string }>(relay, `SELECT repo,ref FROM grasp_pr_refs WHERE repo LIKE 'pr:%' AND until>0 AND until<=? ORDER BY until,repo,ref LIMIT 1`, now()).toArray()[0];
    if (expired) {
      const match = /^pr:([0-9a-f]{64}):(.+)$/u.exec(expired.repo);
      if (match) {
        const pr = prRepositoryIdentity(match[1], match[2]);
        try {
          const wal = await gitRepository(relay, pr, true);
          const current = (await wal.loadRefs()).refs[expired.ref];
          const tip = alternativePrTip(relay, pr, expired.ref.slice(11));
          if (current && tip !== current) await wal.commit({ id: `expire:${expired.ref.slice(-64)}:${current}`, updates: [{ name: expired.ref, old: current, new: null }] });
          if (current && tip === current) gitSql(relay, `UPDATE grasp_pr_refs SET until=0 WHERE repo=? AND ref=?`, expired.repo, expired.ref);
          else gitSql(relay, `DELETE FROM grasp_pr_refs WHERE repo=? AND ref=?`, expired.repo, expired.ref);
          await promote(relay, pr, wal, true);
        } catch { /* Expired uploads stay hidden when cleanup cannot commit. */ }
      }
    }
    // Event-first and Git-first pairs are promoted even without a later push.
    const pending = gitSql<{ raw: string }>(relay, `SELECT raw FROM events JOIN grasp_pending ON grasp_pending.id=events.id WHERE kind IN (?,?) AND grasp_pending.until>? ORDER BY grasp_pending.until LIMIT 16`, KIND_GIT_PR, KIND_GIT_PR_UPDATE, now()).toArray();
    for (const row of pending) {
      const e = JSON.parse(row.raw) as Event;
      const parsed = alternativePrAddress(relay, e);
      if (!parsed) continue;
      try { await promote(relay, parsed, await gitRepository(relay, parsed, true), true); } catch { /* A later alarm retries. */ }
      break;
    }
  }
  const syncAt = await syncGitTick(relay);
  const eventsAt = await graspSyncTick(relay);
  const earliest = gitSql<{ n: number | null }>(relay, `SELECT min(at) AS n FROM (SELECT until AS at FROM grasp_pending UNION ALL SELECT until AS at FROM grasp_pr_refs WHERE until>0)`).one().n;
  const next = Math.min(earliest === null ? Infinity : now() + 60, syncAt || Infinity, eventsAt || Infinity);
  return Number.isFinite(next) ? next : 0;
}
