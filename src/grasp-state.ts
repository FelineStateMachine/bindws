// GRASP's accepted Nostr authority and purgatory. Git refs remain in ntig;
// these tables record only visibility, cleanup deadlines and billed objects.
import { now, tag, tagValues, type Event } from "./event.ts";
import { KIND_REPO, KIND_REPO_STATE, KIND_GIT_PR, KIND_GIT_PR_UPDATE } from "./kinds.ts";
import { featureOn } from "./settings.ts";
import { parseRepositoryAnnouncement, parseRepositoryState, recursiveMaintainers, latestState, serviceListed, gitRepositoryPath, relatedRepositoryCoordinates, repositoryCoordinate, type RepositoryAnnouncement } from "./grasp-policy.ts";
import { npubEncode } from "nostr-tools/nip19";
import type { Relay } from "./relay.ts";

export const MAX_REPOSITORIES = 16;
export const PURGATORY_SECONDS = 1800;
export const PR_REF_SECONDS = 1200;
export const GRASP_SCHEMA = `
CREATE TABLE IF NOT EXISTS grasp_hosted (id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS grasp_pending (id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE, until INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS grasp_removed AFTER DELETE ON events BEGIN DELETE FROM grasp_pending WHERE id=old.id; DELETE FROM grasp_hosted WHERE id=old.id; END;
CREATE TABLE IF NOT EXISTS grasp_tick (id INTEGER PRIMARY KEY CHECK(id=1), coordinate TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grasp_pr_refs (repo TEXT NOT NULL, ref TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(repo,ref));
CREATE TABLE IF NOT EXISTS grasp_objects (key TEXT PRIMARY KEY, owner TEXT NOT NULL, size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grasp_git_sync (id TEXT PRIMARY KEY, due INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS grasp_event_sync (id TEXT PRIMARY KEY, source TEXT NOT NULL, scope TEXT NOT NULL, windows TEXT NOT NULL, live_since INTEGER NOT NULL, due INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS grasp_event_sync_due ON grasp_event_sync(due,id);
CREATE TABLE IF NOT EXISTS grasp_sync_status (id INTEGER PRIMARY KEY CHECK(id=1), partial INTEGER NOT NULL DEFAULT 0);
`;

// graspEvents includes purgatory for write authority, but never expired or
// moderated records. A pending signed state authorizes the data it awaits.
export function graspEvents(relay: Relay, kind: number): Event[] {
  return relay.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE kind=? AND (expires=0 OR expires>?) AND NOT EXISTS (SELECT 1 FROM grasp_pending WHERE grasp_pending.id=events.id AND until<=?) ORDER BY created_at DESC,id ASC LIMIT 1025`, kind, now(), now()).toArray().map((r) => JSON.parse(r.raw) as Event).filter((e) => !relay.settings.isEventHidden(e.id) && !relay.settings.isEventBanned(e.id) && !relay.settings.isBanned(e.pubkey));
}
export const announcements = (relay: Relay): RepositoryAnnouncement[] => graspEvents(relay, KIND_REPO).flatMap((e) => { const p = parseRepositoryAnnouncement(e); return p.value ? [p.value] : []; });
export const hostedAnnouncements = (relay: Relay): RepositoryAnnouncement[] => announcements(relay).filter((r) => relay.sql.exec(`SELECT 1 FROM grasp_hosted WHERE id=?`, r.id).toArray().length > 0);
export const repository = (relay: Relay, owner: string, identifier: string) => hostedAnnouncements(relay).find((r) => r.owner === owner && r.identifier === identifier) ?? null;
export function repositoryState(relay: Relay, repo: RepositoryAnnouncement) {
  const states = graspEvents(relay, KIND_REPO_STATE).flatMap((e) => { const p = parseRepositoryState(e); return p.value ? [p.value] : []; });
  return latestState(states, repo.owner, repo.identifier, recursiveMaintainers(repo, announcements(relay)) ?? new Set());
}

// eventRepository finds the repository named by a PR or by its parent PR.
export function eventRepository(relay: Relay, e: Event): RepositoryAnnouncement | null {
  const all = hostedAnnouncements(relay);
  const coordinates = relatedRepositoryCoordinates(e);
  for (const parent of [...tagValues(e, "e"), ...tagValues(e, "E")].slice(0, 16)) {
    const row = relay.sql.exec<{ raw: string }>(`SELECT raw FROM events WHERE id=? AND kind=? AND (expires=0 OR expires>?)`, parent, KIND_GIT_PR, now()).toArray()[0];
    if (row) {
      const parent = JSON.parse(row.raw) as Event;
      if (!relay.settings.isEventHidden(parent.id) && !relay.settings.isEventBanned(parent.id) && !relay.settings.isBanned(parent.pubkey)) coordinates.push(...relatedRepositoryCoordinates(parent));
    }
  }
  return all.find((r) => coordinates.includes(repositoryCoordinate(r))) ?? null;
}

// graspGate validates authority before ordinary storage. Relay write policy,
// bans, proof of work and member quotas continue to apply to these events.
export function graspGate(relay: Relay, e: Event, host: string): string {
  if (!featureOn(relay.settings.policy, "grasp")) return "";
  if (e.kind === KIND_REPO) {
    if (relay.settings.policy.reads !== "open") return "restricted: GRASP-01 hosting requires open reads";
    const p = parseRepositoryAnnouncement(e);
    if (!p.value) return p.error!;
    const r = p.value;
    const origin = relay.webURL(host || `${relay.slug}.${relay.domain}`);
    const listed = serviceListed(r, origin + gitRepositoryPath(npubEncode(e.pubkey), r.identifier), origin.replace(/^http/, "ws"));
    const all = announcements(relay);
    const related = hostedAnnouncements(relay).some((root) => root.owner !== e.pubkey && root.identifier === r.identifier && recursiveMaintainers(root, all)?.has(e.pubkey));
    if (!listed && !related && !featureOn(relay.settings.policy, "grasp05")) return "restricted: repository clone and relays tags must name this service";
    if ((listed || featureOn(relay.settings.policy, "grasp05")) && !repository(relay, r.owner, r.identifier) && hostedAnnouncements(relay).length >= MAX_REPOSITORIES) return `restricted: at most ${MAX_REPOSITORIES} repositories per relay`;
  }
  if (e.kind === KIND_REPO_STATE) {
    const p = parseRepositoryState(e);
    if (!p.value) return p.error!;
    const all = announcements(relay);
    if (!all.some((r) => r.identifier === p.value!.identifier && recursiveMaintainers(r, all)?.has(e.pubkey))) return "restricted: state author is not an accepted repository maintainer";
  }
  if (e.kind === KIND_GIT_PR || e.kind === KIND_GIT_PR_UPDATE) {
    // GRASP-06 permits a contributor to publish a PR before the target
    // repository announcement reaches this relay. Keep the repository
    // coordinate mandatory; the PR namespace will authorize its matching
    // objects once the event is stored.
    const hosted = eventRepository(relay, e);
    if (!hosted && !featureOn(relay.settings.policy, "grasp06")) return "restricted: pull request must name an accepted repository";
    if (!hosted && !relatedRepositoryCoordinates(e).some((c) => {
      const p = c.split(":");
      return p.length >= 3 && p[0] === "30617" && /^[0-9a-f]{64}$/.test(p[1]) && !!p.slice(2).join(":");
    })) return "restricted: pull request must name a repository";
    if (!hosted) {
      const origin = relay.webURL(host || `${relay.slug}.${relay.domain}`);
      const paths = relatedRepositoryCoordinates(e).map(c => origin + "/prs" + gitRepositoryPath(npubEncode(e.pubkey), c.split(":").slice(2).join(":")));
      const listed = e.tags.filter(t => t[0] === "clone").flatMap(t => t.slice(1)).some(raw => { try { const u = new URL(raw); return !u.username && !u.password && paths.includes(u.href.replace(/\/$/u, "")); } catch { return false; } });
      if (!listed) return "restricted: pull request clone must name this service's signer PR path";
    }
    const tips = tagValues(e, "c");
    if (tips.length !== 1 || !/^[0-9a-f]{40}$/.test(tips[0]) || /^0+$/.test(tips[0])) return "invalid: pull request needs one SHA-1 c tag";
  }
  return "";
}

// holdGrasp hides events whose Git objects have not been checked yet. The
// durable row survives restarts and follows NIP-09/40 deletion via its FK.
export function holdGrasp(relay: Relay, e: Event, host: string): boolean {
  if (!featureOn(relay.settings.policy, "grasp") || ![KIND_REPO, KIND_REPO_STATE, KIND_GIT_PR, KIND_GIT_PR_UPDATE].includes(e.kind)) return false;
  if (e.kind === KIND_REPO) {
    const r = parseRepositoryAnnouncement(e).value!;
    const origin = relay.webURL(host || `${relay.slug}.${relay.domain}`);
    const listed = serviceListed(r, origin + gitRepositoryPath(npubEncode(e.pubkey), r.identifier), origin.replace(/^http/, "ws"));
    if (!listed && !featureOn(relay.settings.policy, "grasp05")) return false;
    relay.sql.exec(`INSERT OR REPLACE INTO grasp_hosted(id) VALUES(?)`, e.id);
  }
  relay.sql.exec(`INSERT OR REPLACE INTO grasp_pending(id,until) VALUES(?,?)`, e.id, now() + PURGATORY_SECONDS);
  return true;
}
export const graspVisible = (relay: Relay, id: string) => relay.sql.exec(`SELECT 1 FROM grasp_pending WHERE id=?`, id).toArray().length === 0;
export const graspBytes = (relay: Relay) => relay.sql.exec<{ n: number }>(`SELECT coalesce(sum(size),0) AS n FROM grasp_objects`).one().n;

// requiredObjects returns the tips an event needs before it leaves purgatory.
export function requiredObjects(relay: Relay, e: Event): string[] | null {
  if (e.kind === KIND_REPO_STATE) return Object.values(parseRepositoryState(e).value?.refs ?? {});
  if (e.kind === KIND_GIT_PR || e.kind === KIND_GIT_PR_UPDATE) return [tag(e, "c")];
  const r = parseRepositoryAnnouncement(e).value;
  const state = r && repositoryState(relay, r);
  return state ? Object.values(state.refs) : null;
}
