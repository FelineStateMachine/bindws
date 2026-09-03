// Jobs: work the relay does on its own between requests, driven by the
// alarm one round at a time so it survives the object sleeping. Two kinds:
// pull (fetch what another relay has and this one lacks, see pull.ts) and
// push (rebroadcast what this relay holds to other relays). A job runs
// once or on a standing interval. Awake time is metered, so a job costs
// fuel, which is the right signal for work nobody asked a client for.
import { hasTag, isPrivate, now, type Event } from "./event.ts";
import type { Filter } from "./filter.ts";
import { Socket, dial, checkPullURL, runPullRound, type PullFilter, type PullJob, type PullResult } from "./pull.ts";
import type { Relay } from "./relay.ts";

export type JobKind = "pull" | "push";
export type JobLabel = "pull" | "backfill" | "push" | "replica";
export const EVERY = [0, 1, 6, 24] as const; // hours; 0 runs once

export interface JobResult {
  finishedAt: number;
  error: string;
  rounds: number;
  stored: number;
  skipped: number;
  blobs: number;
  sent: number;
  refused: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  label: JobLabel;
  relays: string[]; // sources for a pull, targets for a push
  filter: PullFilter;
  every: number; // hours; 0 once
  createdAt: number;
  nextRun: number; // unix seconds; 0 when a once job has finished
  running: boolean;
  startedAt: number;
  // Progress of the current run.
  rounds: number;
  failures: number;
  relayIndex: number; // pull: which source is being synced
  cursor: number; // push: last sequence number forwarded, kept across runs
  stored: number;
  skipped: number;
  blobs: number;
  sent: number;
  refused: number;
  last: JobResult | null;
}

export const MAX_STANDING = 5;
export const MAX_JOBS = 20;
const KEEP_FINISHED = 10;
const PUSH_BATCH = 200;
const PUSH_PER_TARGET = 50;
const PUSH_TIMEOUT_MS = 15_000;
const REFUSALS_PER_TARGET = 5;

const hex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export type JobSpec = Omit<Job, "id" | "createdAt" | "nextRun">;

// checkJob validates a job request. Returns the job's fields or a reason.
export function checkJob(raw: unknown, relay: Relay): JobSpec | string {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = r.kind === "pull" || r.kind === "push" ? r.kind : null;
  if (!kind) return "invalid: kind must be pull or push";
  const label: JobLabel = kind === "pull" && (r.label === "backfill" || r.label === "replica") ? r.label : kind;
  const list = Array.isArray(r.relays) ? r.relays : [];
  const relays: string[] = [];
  for (const u of list) {
    if (typeof u !== "string") return "invalid: relays must be URLs";
    const url = u.trim();
    const bad = checkPullURL(url, relay.slug, relay.domain);
    if (bad) return kind === "push" ? bad.replace("pull from itself", "push to itself") : bad;
    if (!relays.includes(url)) relays.push(url);
  }
  if (relays.length === 0) return "invalid: at least one relay is needed";
  if (relays.length > 10) return "invalid: at most ten relays per job";
  const f = (r.filter && typeof r.filter === "object" ? r.filter : {}) as Record<string, unknown>;
  const filter: PullFilter = {};
  if (Array.isArray(f.authors) && f.authors.length) {
    if (!f.authors.every(hex64) || f.authors.length > 50) return "invalid: authors must be up to fifty hex pubkeys";
    filter.authors = [...new Set(f.authors as string[])];
  }
  if (Array.isArray(f.kinds) && f.kinds.length) {
    if (!f.kinds.every((k) => Number.isInteger(k) && (k as number) >= 0 && (k as number) <= 65535) || f.kinds.length > 50) return "invalid: kinds must be up to fifty integers";
    filter.kinds = [...new Set(f.kinds as number[])];
  }
  if (f.since !== undefined && f.since !== null && f.since !== 0) {
    if (!Number.isInteger(f.since) || (f.since as number) < 0) return "invalid: since must be a unix time";
    filter.since = f.since as number;
  }
  const every = r.every === undefined ? 0 : Number(r.every);
  if (!(EVERY as readonly number[]).includes(every)) return "invalid: every must be 0, 1, 6 or 24 hours";
  if (kind === "push" && relay.settings.policy.reads === "members" && filter.kinds?.some(isPrivate)) return "restricted: a members-only relay does not rebroadcast private kinds";
  return { kind, label, relays, filter, every, running: false, startedAt: 0, rounds: 0, failures: 0, relayIndex: 0, cursor: 0, stored: 0, skipped: 0, blobs: 0, sent: 0, refused: 0, last: null };
}

// relaysFromList reads the owner's kind 10002 stored on this relay and
// returns its relays, both markers, without this relay itself.
export function relaysFromList(relay: Relay, pubkey: string): string[] {
  const rows = relay.store.query({ kinds: [10002], authors: [pubkey], tags: {} }, { pubkeys: [], all: true }, 1, now()).rows;
  if (rows.length === 0) return [];
  const e = JSON.parse(rows[0]) as Event;
  const out: string[] = [];
  for (const t of e.tags) {
    if (t[0] !== "r" || typeof t[1] !== "string") continue;
    const url = t[1].trim().replace(/\/+$/, "");
    if (checkPullURL(url, relay.slug, relay.domain)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

// runRound does one round of a job. more: call again for this run.
export async function runRound(relay: Relay, job: Job): Promise<{ more: boolean; error: string }> {
  if (job.kind === "pull") return runPullSourceRound(relay, job);
  return runPushRound(relay, job);
}

// A pull job syncs its sources one after another; each source is a pull
// in the sense of pull.ts, with the job's filter.
async function runPullSourceRound(relay: Relay, job: Job): Promise<{ more: boolean; error: string }> {
  if (job.relayIndex >= job.relays.length) return { more: false, error: "" };
  const sub: PullJob = { url: job.relays[job.relayIndex], startedAt: job.startedAt, rounds: 0, stored: 0, skipped: 0, blobs: 0, failures: 0 };
  if (job.filter.authors || job.filter.kinds || job.filter.since) sub.filter = job.filter;
  const r = await runPullRound(relay, sub);
  job.rounds++;
  job.stored += sub.stored;
  job.skipped += sub.skipped;
  job.blobs += sub.blobs;
  if (r.error) return r;
  if (!r.more) job.relayIndex++;
  return { more: job.relayIndex < job.relays.length, error: "" };
}

// A push round takes the next batch past the cursor and offers it to every
// target. Events nobody else may publish (NIP-70 protected) are skipped, as
// are private kinds on a members-only relay. Refusals are counted; a target
// that refuses several in a row is left alone for the round.
async function runPushRound(relay: Relay, job: Job): Promise<{ more: boolean; error: string }> {
  job.rounds++;
  const f: Filter = { tags: {} };
  if (job.filter.authors) f.authors = job.filter.authors;
  if (job.filter.kinds) f.kinds = job.filter.kinds;
  if (job.filter.since) f.since = job.filter.since;
  const rows = relay.store.after(job.cursor, f, PUSH_BATCH, now());
  if (rows.length === 0) return { more: false, error: "" };
  const membersOnly = relay.settings.policy.reads === "members";
  const events: Event[] = [];
  for (const r of rows) {
    const e = JSON.parse(r.raw) as Event;
    if (hasTag(e, "-") || (membersOnly && isPrivate(e.kind))) {
      job.skipped++;
      continue;
    }
    events.push(e);
  }
  let failed = "";
  let reached = 0;
  for (const url of job.relays) {
    try {
      await pushTo(relay, url, events, job);
      reached++;
    } catch (err) {
      failed = url + ": " + (err instanceof Error ? err.message : String(err));
    }
  }
  if (reached === 0 && events.length) return { more: false, error: failed };
  job.cursor = rows[rows.length - 1].seq;
  return { more: rows.length === PUSH_BATCH, error: "" };
}

async function pushTo(relay: Relay, url: string, events: Event[], job: Job) {
  if (events.length === 0) return;
  const sock = new Socket(await dial(relay, url));
  try {
    let refusedInARow = 0;
    for (let i = 0; i < events.length; i += PUSH_PER_TARGET) {
      const batch = events.slice(i, i + PUSH_PER_TARGET);
      const pending = new Set(batch.map((e) => e.id));
      for (const e of batch) sock.send("EVENT", e);
      const deadline = Date.now() + PUSH_TIMEOUT_MS;
      while (pending.size && Date.now() < deadline) {
        const m = await sock.recv();
        if (m[0] !== "OK" || typeof m[1] !== "string" || !pending.has(m[1])) continue;
        pending.delete(m[1]);
        const msg = String(m[3] ?? "");
        if (m[2] === true || msg.startsWith("duplicate:")) {
          job.sent++;
          refusedInARow = 0;
        } else {
          job.refused++;
          refusedInARow++;
        }
      }
      if (pending.size) {
        job.refused += pending.size;
        throw new Error("the relay stopped answering");
      }
      if (refusedInARow >= REFUSALS_PER_TARGET) return;
    }
  } finally {
    sock.close();
  }
}

// startRun resets the counters of a run. The push cursor is kept so a
// standing push forwards only what arrived since.
export function startRun(job: Job, t: number) {
  job.running = true;
  job.startedAt = t;
  job.rounds = 0;
  job.failures = 0;
  job.relayIndex = 0;
  job.stored = 0;
  job.skipped = 0;
  job.blobs = 0;
  job.sent = 0;
  job.refused = 0;
}

// finishRun closes the current run and schedules the next one.
export function finishRun(job: Job, error: string, t: number) {
  job.last = { finishedAt: t, error, rounds: job.rounds, stored: job.stored, skipped: job.skipped, blobs: job.blobs, sent: job.sent, refused: job.refused };
  job.running = false;
  job.nextRun = job.every > 0 ? t + job.every * 3600 : 0;
}

// pruneFinished drops the oldest finished once jobs beyond a few, so the
// list stays a list.
export function pruneFinished(jobs: Job[]): Job[] {
  const done = jobs.filter((j) => !j.running && j.every === 0 && j.nextRun === 0).sort((a, b) => (b.last?.finishedAt ?? 0) - (a.last?.finishedAt ?? 0));
  const drop = new Set(done.slice(KEEP_FINISHED).map((j) => j.id));
  return jobs.filter((j) => !drop.has(j.id));
}

// pullView presents pull jobs in the shape the first console and tests
// used: the running pull, if any, and the last finished one.
export function pullView(jobs: Job[]): { running: PullJob | null; last: PullResult | null } {
  const pulls = jobs.filter((j) => j.kind === "pull");
  const run = pulls.find((j) => j.running || (j.nextRun > 0 && j.nextRun <= now() && j.every === 0));
  const running: PullJob | null = run ? { url: run.relays[run.relayIndex] ?? run.relays[0], startedAt: run.startedAt, rounds: run.rounds, stored: run.stored, skipped: run.skipped, blobs: run.blobs, failures: run.failures } : null;
  // Latest finished wins; on the same second the job added later wins.
  let done: Job | undefined;
  for (const j of pulls) if (j.last && !j.running && (!done || (j.last.finishedAt >= (done.last as JobResult).finishedAt))) done = j;
  const last: PullResult | null = done && done.last ? { url: done.relays[0], startedAt: done.startedAt, rounds: done.last.rounds, stored: done.last.stored, skipped: done.last.skipped, blobs: done.last.blobs, failures: 0, finishedAt: done.last.finishedAt, error: done.last.error } : null;
  return { running, last };
}

export function newJobID(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
