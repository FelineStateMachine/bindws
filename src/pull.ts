// Pull: bounded history import uses NIP-77 when available and ordinary
// NIP-01 queries otherwise. Query windows survive between alarm rounds;
// their completion is best effort, since a relay may silently cap results.
// The alarm calls rounds until nothing is missing (see jobs.ts), so a pull
// survives the object sleeping, and running it again only fetches what is
// new. An optional filter narrows the reconciliation: authors for a
// backfill of the owner's own history, kinds, since.
import { sha256 } from "@noble/hashes/sha2.js";
import { validate, now, type Event } from "./event.ts";
import type { Filter } from "./filter.ts";
import { Negentropy, bytesToHex, hexToBytes } from "./negentropy.ts";
import { ERR_DUPLICATE } from "./store.ts";
import { validName } from "./names.ts";
import type { Blob } from "./blossom.ts";
import type { Relay } from "./relay.ts";

export interface PullFilter {
  authors?: string[];
  kinds?: number[];
  since?: number;
}

export interface PullJob {
  url: string;
  startedAt: number;
  rounds: number;
  stored: number;
  skipped: number;
  blobs: number;
  failures: number;
  filter?: PullFilter;
  progress?: PullProgress;
}
export interface PullProgress {
  mode: "negentropy" | "query";
  status: "pending" | "running" | "complete" | "best-effort" | "partial" | "refused" | "failed";
  windows?: { since: number; until: number }[];
  pages: number;
  failures: number;
  error: string;
  warning: string;
  partial: boolean;
}
export interface PullSource extends PullProgress {
  url: string;
  stored: number;
  skipped: number;
  blobs: number;
}
export const newPullProgress = (): PullProgress => ({ mode: "negentropy", status: "pending", pages: 0, failures: 0, error: "", warning: "", partial: false });
export interface PullSocket {
  send(...msg: unknown[]): void;
  recv(timeout?: number): Promise<unknown[]>;
  close(): void;
}
export type PullConnect = (relay: Relay, url: string) => Promise<PullSocket>;
const connectPull: PullConnect = async (relay, url) => new Socket(await dial(relay, url));
export interface PullResult extends PullJob {
  finishedAt: number;
  error: string;
}

const ROUND_EVENTS = 500;
const ROUND_BLOBS = 20;
const IDS_PER_REQ = 100;
const MAX_ITEMS = 100_000;
const MESSAGE_TIMEOUT_MS = 20_000;
export const QUERY_PAGE = 500;
const QUERY_PAGES = 2048;
const ROUND_MESSAGES = 4096;
const ROUND_MS = 25_000;

// localName is the relay name when the URL is one of ours, else "".
export function localName(url: URL, domain: string): string {
  const host = url.hostname.toLowerCase();
  const d = domain.toLowerCase();
  let name = "";
  if (host.endsWith("." + d)) name = host.slice(0, -(d.length + 1));
  else if (host.endsWith(".localhost")) name = host.slice(0, -".localhost".length);
  return validName(name) && !name.includes(".") ? name : "";
}

// checkPullURL returns "" or a reason the URL cannot be pulled from.
export function checkPullURL(raw: string, self: string, domain: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid: not a URL";
  }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") return "invalid: the URL must start with wss:// or ws://";
  if (localName(u, domain) === self) return "invalid: a relay cannot pull from itself";
  return "";
}

// dial opens a websocket to a relay. Our own relays are reached through
// their object directly, which also works in wrangler dev and tests.
export async function dial(relay: Relay, raw: string): Promise<WebSocket> {
  const u = new URL(raw);
  const local = localName(u, relay.domain);
  const headers: Record<string, string> = { upgrade: "websocket" };
  let resp: Response;
  if (local) resp = await relay.relays.getByName(local).fetch("https://" + u.host + "/", { headers: { ...headers, "x-relay-name": local } });
  else resp = await fetch(u.href.replace(/^ws/, "http"), { headers });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`relay did not accept a websocket (${resp.status})`);
  ws.accept();
  return ws;
}

// Socket turns a websocket into a queue of parsed messages.
export class Socket {
  private queue: { message: unknown[]; size: number }[] = [];
  private waiters: { res: (m: unknown[]) => void; rej: (e: Error) => void }[] = [];
  private closed: Error | null = null;
  private queuedBytes = 0;

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const raw = typeof e.data === "string" ? e.data : "";
      if (raw.length > 4 * 1024 * 1024 || this.queue.length >= 2048 || this.queuedBytes + raw.length > 16 * 1024 * 1024) {
        end("relay response exceeded the import buffer limit");
        this.close();
        return;
      }
      let m: unknown;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      const w = this.waiters.shift();
      if (w) w.res(m);
      else { this.queue.push({ message: m, size: raw.length }); this.queuedBytes += raw.length; }
    });
    const end = (why: string) => {
      this.closed = new Error(why);
      for (const w of this.waiters.splice(0)) w.rej(this.closed);
    };
    ws.addEventListener("close", (e) => end("connection closed" + (e.reason ? ": " + e.reason : "")));
    ws.addEventListener("error", () => end("connection failed"));
  }

  send(...msg: unknown[]) {
    this.ws.send(JSON.stringify(msg));
  }

  recv(timeout = MESSAGE_TIMEOUT_MS): Promise<unknown[]> {
    const m = this.queue.shift();
    if (m) { this.queuedBytes -= m.size; return Promise.resolve(m.message); }
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.res !== ok);
        rej(new Error("the relay stopped answering"));
      }, Math.max(1, Math.min(MESSAGE_TIMEOUT_MS, timeout)));
      const ok = (m: unknown[]) => {
        clearTimeout(timer);
        res(m);
      };
      this.waiters.push({ res: ok, rej: (e) => (clearTimeout(timer), rej(e)) });
    });
  }

  close() {
    try {
      this.ws.close(1000, "done");
    } catch {
      /* already closed */
    }
  }
}

// runPullRound does one round of the job. more: call again. error: the
// round failed and nothing more was learned.
export async function runPullRound(relay: Relay, job: PullJob, connect: PullConnect = connectPull): Promise<{ more: boolean; error: string }> {
  job.rounds++;
  const progress = job.progress ??= newPullProgress();
  progress.status = "running";
  let sock: PullSocket | null = null;
  try {
    sock = await connect(relay, job.url);
    if (progress.mode === "query") return await queryRound(relay, sock, job);
    if (progress.pages >= QUERY_PAGES) {
      progress.status = "partial";
      progress.warning = "Import stopped at its round budget; narrow the filter and run again.";
      return { more: false, error: "" };
    }
    let need: string[];
    try {
      need = await reconcile(relay, sock, job.filter ?? {});
    } catch (err) {
      progress.mode = "query";
      progress.warning = "NIP-77 unavailable: " + reason(err);
      progress.windows = [{ since: job.filter?.since ?? 0, until: job.startedAt }];
      return { more: true, error: "" };
    }
    progress.pages++;
    const storedBefore = job.stored;
    const deadline = Date.now() + ROUND_MS;
    const want = need.slice(0, ROUND_EVENTS);
    for (let i = 0; i < want.length; i += IDS_PER_REQ) await fetchEvents(relay, sock, want.slice(i, i + IDS_PER_REQ), job, deadline);
    let more = need.length > want.length;
    if (want.length && job.stored === storedBefore) {
      progress.partial = true;
      progress.warning = "The source advertises missing events that it did not supply or this relay cannot admit.";
      more = false;
    }
    if (!more && !job.filter) {
      // Files come along on a whole-relay pull; a filtered pull is about events.
      const local = localName(new URL(job.url), relay.domain);
      if (local) more = await copyBlobs(relay, local, job);
    }
    if (!more) progress.status = progress.partial ? "partial" : "complete";
    return { more, error: "" };
  } catch (err) {
    const error = reason(err);
    progress.error = error;
    return { more: false, error };
  } finally {
    sock?.close();
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

// queryRound stores one bounded time window. Full windows divide rather
// than skipping timestamps; a full single second remains explicitly partial.
async function queryRound(relay: Relay, sock: PullSocket, job: PullJob): Promise<{ more: boolean; error: string }> {
  const p = job.progress!;
  const windows = p.windows ??= [{ since: job.filter?.since ?? 0, until: job.startedAt }];
  if (!windows.length) return { more: false, error: "" };
  if (p.pages >= QUERY_PAGES) {
    p.status = "partial";
    p.warning = "Import stopped at the query page budget; narrow the time or author filter and run again.";
    return { more: false, error: "" };
  }
  const window = windows[windows.length - 1];
  const sub = "history";
  const wire = { ...job.filter, ...window, limit: QUERY_PAGE };
  sock.send("REQ", sub, wire);
  const ids = new Set<string>();
  let received = 0;
  let invalid = false;
  let auth = false;
  const deadline = Date.now() + ROUND_MS;
  for (let messages = 0; ; messages++) {
    if (messages >= ROUND_MESSAGES || Date.now() >= deadline) throw new Error(auth ? "auth-required: source needs authentication; no user key is shared for imports" : "source did not complete its query within the import limits");
    let m: unknown[];
    try { m = await sock.recv(deadline - Date.now()); }
    catch (err) { if (auth) throw new Error("auth-required: source needs authentication; no user key is shared for imports"); throw err; }
    if (m[0] === "AUTH") auth = true;
    if (m[0] === "EOSE" && m[1] === sub) break;
    if (m[0] === "CLOSED" && m[1] === sub) throw new Error("query refused: " + String(m[2]).slice(0, 200));
    if (m[0] !== "EVENT" || m[1] !== sub) continue;
    received++;
    if (received > QUERY_PAGE) throw new Error("source exceeded the requested event limit");
    const event = m[2];
    if (validate(event)) { job.skipped++; invalid = true; continue; }
    const e = event as Event;
    if (!matchesPull(e, job.filter) || e.created_at < window.since || e.created_at > window.until || ids.has(e.id)) {
      job.skipped++; invalid = true; continue;
    }
    ids.add(e.id);
    storePulled(relay, e, job);
  }
  sock.send("CLOSE", sub);
  windows.pop();
  p.pages++;
  if (invalid) { p.partial = true; p.warning = "Source returned invalid, duplicate or out-of-filter events; coverage is incomplete."; }
  if (received >= QUERY_PAGE) {
    if (window.since >= window.until) {
      p.partial = true;
      p.warning = "A one-second window reached the result limit; events sharing that timestamp may be missing.";
    } else {
      const middle = window.since + Math.floor((window.until - window.since) / 2);
      windows.push({ since: window.since, until: middle }, { since: middle + 1, until: window.until });
    }
  }
  if (!windows.length) {
    p.status = p.partial ? "partial" : "best-effort";
    if (!p.partial) p.warning = "Query scan finished; the source may silently cap or omit events, so complete history is not guaranteed.";
  }
  return { more: windows.length > 0, error: "" };
}

// matchesPull checks source-supplied events against the requested filter.
function matchesPull(e: Event, f?: PullFilter): boolean {
  return !f || ((!f.authors?.length || f.authors.includes(e.pubkey)) && (!f.kinds?.length || f.kinds.includes(e.kind)) && (f.since === undefined || e.created_at >= f.since));
}

// storePulled applies normal host admission and counts each accepted event.
function storePulled(relay: Relay, e: Event, job: PullJob) {
  if (!relay.settings.kindAllowed(e.kind)) { job.skipped++; markRejected(job); return; }
  const r = relay.accept(e, null);
  if (r.stored) { job.stored++; relay.broadcast(e); }
  else if (r.msg !== ERR_DUPLICATE) { job.skipped++; markRejected(job); }
}

// markRejected preserves admission gaps in the source result.
function markRejected(job: PullJob) {
  if (!job.progress) return;
  job.progress.partial = true;
  job.progress.warning = "Some source events could not be admitted by this relay; coverage is incomplete.";
}

// reconcile runs NIP-77 as the initiator over the filter and returns the
// ids the other side has that we do not.
async function reconcile(relay: Relay, sock: PullSocket, filter: PullFilter): Promise<string[]> {
  const f: Filter = { tags: {} };
  const wire: Record<string, unknown> = {};
  if (filter.authors?.length) f.authors = wire.authors = filter.authors;
  if (filter.kinds?.length) f.kinds = wire.kinds = filter.kinds;
  if (filter.since) f.since = wire.since = filter.since;
  const items = relay.store.syncItems(f, { pubkeys: [], all: true }, MAX_ITEMS, now());
  if (items === "too big") throw new Error("this relay holds too many events to sync");
  const neg = new Negentropy(items, sha256);
  const id = "pull";
  sock.send("NEG-OPEN", id, wire, bytesToHex(neg.initiate()));
  const need: string[] = [];
  const deadline = Date.now() + ROUND_MS;
  for (let messages = 0; ; messages++) {
    if (messages >= ROUND_MESSAGES || Date.now() >= deadline) throw new Error("sync exceeded its round budget");
    const m = await sock.recv(deadline - Date.now());
    if (m[0] === "NEG-ERR" && m[1] === id) throw new Error("sync refused: " + String(m[2]));
    if (m[0] !== "NEG-MSG" || m[1] !== id) continue; // AUTH challenges, notices
    const r = neg.reconcile(hexToBytes(String(m[2])));
    need.push(...r.need);
    if (need.length > MAX_ITEMS) throw new Error("sync result exceeded the import limit");
    if (r.reply === null) break;
    sock.send("NEG-MSG", id, bytesToHex(r.reply));
  }
  sock.send("NEG-CLOSE", id);
  return need;
}

// fetchEvents asks for a batch by id and stores what checks out. Signatures
// are verified, bans and kind rules apply, the write policy does not: the
// owner asked for these.
async function fetchEvents(relay: Relay, sock: PullSocket, ids: string[], job: PullJob, deadline: number) {
  const sub = "pull-" + job.stored + "-" + job.skipped;
  sock.send("REQ", sub, { ids });
  const seen = new Set<string>();
  for (let messages = 0; ; messages++) {
    if (messages >= ROUND_MESSAGES || Date.now() >= deadline) throw new Error("source exceeded its event response budget");
    const m = await sock.recv(deadline - Date.now());
    if (m[0] === "EOSE" && m[1] === sub) break;
    if (m[0] === "CLOSED" && m[1] === sub) throw new Error("query refused: " + String(m[2]));
    if (m[0] !== "EVENT" || m[1] !== sub) continue;
    const e = m[2] as Event;
    if (validate(e) || !ids.includes(e.id) || !matchesPull(e, job.filter) || seen.has(e.id)) {
      job.skipped++;
      markRejected(job);
      continue;
    }
    seen.add(e.id);
    storePulled(relay, e, job);
  }
  sock.send("CLOSE", sub);
  if (seen.size < ids.length && job.progress) {
    job.progress.partial = true;
    job.progress.warning = "The source did not supply all events advertised by its sync response.";
  }
}

// copyBlobs brings over a batch of the other relay's files. Returns true
// when more remain.
async function copyBlobs(relay: Relay, srcName: string, job: PullJob): Promise<boolean> {
  // The source applies its read rule to the copier, who has proved no key
  // (the pull never authenticates), so files come across from an open relay
  // only, the same as its events.
  const rows: Blob[] | string = await relay.relays.getByName(srcName).listBlobs([]);
  if (typeof rows === "string") throw new Error("files refused: " + rows);
  let n = 0;
  for (const b of rows) {
    if (relay.sql.exec(`SELECT 1 FROM blobs WHERE sha256=?`, b.sha256).toArray().length) continue;
    if (n === ROUND_BLOBS) return true;
    const obj = await relay.media.get(`${srcName}/${b.sha256}`);
    if (!obj) continue;
    await relay.media.put(`${relay.slug}/${b.sha256}`, obj.body, { httpMetadata: { contentType: b.type } });
    relay.sql.exec(`INSERT OR IGNORE INTO blobs(sha256,size,type,uploader,uploaded) VALUES(?,?,?,?,?)`, b.sha256, b.size, b.type, b.uploader, b.uploaded);
    relay.meterBytes(b.size, 0);
    job.blobs++;
    n++;
  }
  return false;
}
