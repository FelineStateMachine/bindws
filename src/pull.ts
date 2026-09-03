// Pull: this relay fetches what another relay has and it lacks. One round
// is one connection: reconcile with NIP-77, take a bounded batch of the
// missing events, and, for a relay on this host, a batch of its files.
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
}
export interface PullResult extends PullJob {
  finishedAt: number;
  error: string;
}

const ROUND_EVENTS = 500;
const ROUND_BLOBS = 20;
const IDS_PER_REQ = 100;
const MAX_ITEMS = 100_000;
const MESSAGE_TIMEOUT_MS = 20_000;

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
  private queue: unknown[][] = [];
  private waiters: { res: (m: unknown[]) => void; rej: (e: Error) => void }[] = [];
  private closed: Error | null = null;

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      let m: unknown;
      try {
        m = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      const w = this.waiters.shift();
      if (w) w.res(m);
      else this.queue.push(m);
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

  recv(): Promise<unknown[]> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.res !== ok);
        rej(new Error("the relay stopped answering"));
      }, MESSAGE_TIMEOUT_MS);
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
export async function runPullRound(relay: Relay, job: PullJob): Promise<{ more: boolean; error: string }> {
  job.rounds++;
  let sock: Socket | null = null;
  try {
    sock = new Socket(await dial(relay, job.url));
    const need = await reconcile(relay, sock, job.filter ?? {});
    const want = need.slice(0, ROUND_EVENTS);
    for (let i = 0; i < want.length; i += IDS_PER_REQ) await fetchEvents(relay, sock, want.slice(i, i + IDS_PER_REQ), job);
    let more = need.length > want.length;
    if (!more && !job.filter) {
      // Files come along on a whole-relay pull; a filtered pull is about events.
      const local = localName(new URL(job.url), relay.domain);
      if (local) more = await copyBlobs(relay, local, job);
    }
    return { more, error: "" };
  } catch (err) {
    return { more: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    sock?.close();
  }
}

// reconcile runs NIP-77 as the initiator over the filter and returns the
// ids the other side has that we do not.
async function reconcile(relay: Relay, sock: Socket, filter: PullFilter): Promise<string[]> {
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
  for (;;) {
    const m = await sock.recv();
    if (m[0] === "NEG-ERR" && m[1] === id) throw new Error("sync refused: " + String(m[2]));
    if (m[0] !== "NEG-MSG" || m[1] !== id) continue; // AUTH challenges, notices
    const r = neg.reconcile(hexToBytes(String(m[2])));
    need.push(...r.need);
    if (r.reply === null) break;
    sock.send("NEG-MSG", id, bytesToHex(r.reply));
  }
  sock.send("NEG-CLOSE", id);
  return need;
}

// fetchEvents asks for a batch by id and stores what checks out. Signatures
// are verified, bans and kind rules apply, the write policy does not: the
// owner asked for these.
async function fetchEvents(relay: Relay, sock: Socket, ids: string[], job: PullJob) {
  const sub = "pull-" + job.stored + "-" + job.skipped;
  sock.send("REQ", sub, { ids });
  for (;;) {
    const m = await sock.recv();
    if (m[0] === "EOSE" && m[1] === sub) break;
    if (m[0] === "CLOSED" && m[1] === sub) throw new Error("query refused: " + String(m[2]));
    if (m[0] !== "EVENT" || m[1] !== sub) continue;
    const e = m[2] as Event;
    const f = job.filter;
    const outside = !!f && ((f.authors?.length && !f.authors.includes(e.pubkey)) || (f.kinds?.length && !f.kinds.includes(e.kind)) || (f.since && e.created_at < f.since));
    if (validate(e) || !ids.includes(e.id) || outside || !relay.settings.kindAllowed(e.kind)) {
      job.skipped++;
      continue;
    }
    const r = relay.accept(e, null);
    if (r.stored) {
      job.stored++;
      relay.broadcast(e);
    } else if (r.msg !== ERR_DUPLICATE) job.skipped++;
  }
  sock.send("CLOSE", sub);
}

// copyBlobs brings over a batch of the other relay's files. Returns true
// when more remain.
async function copyBlobs(relay: Relay, srcName: string, job: PullJob): Promise<boolean> {
  const rows: Blob[] = await relay.relays.getByName(srcName).listBlobs();
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
