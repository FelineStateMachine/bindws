// Relay-signed notifications. The relay has a keypair, so it can write its
// owner a NIP-17 private message: a kind 14 rumour, sealed and gift wrapped
// with the relay's key (NIP-59, NIP-44). The wrap is stored here, which is
// the owner's inbox on their own relay, and pushed to the relays in the
// owner's kind 10050 when this relay holds one. No email, no webhook.
import { now, tagValues, type Event } from "./event.ts";
import { dial } from "./pull.ts";
import type { Relay } from "./relay.ts";
import { viewRowsSince } from "./views.ts";
import type { FuelStatus } from "./fuel.ts";

export type NotifyKind = "reports" | "fuel" | "jobs" | "succession" | "digest" | "test";
export interface NotifySettings {
  reports: boolean;
  fuel: boolean;
  jobs: boolean;
  succession: boolean; // the dead-man's switch warnings and the handover
  digest: boolean; // one message a week on how the relay is doing
}
export const DIGEST_DAYS = 7;

const KIND_DM = 14;
export const KIND_WRAP = 1059;
const PUSH_RELAYS = 3;
const PUSH_TIMEOUT_MS = 4000;
// Below this balance, while past an allowance, fuel counts as low.
const LOW_SATS = 2000;

// notifySettings validates a policy patch's notify object. Missing keys keep
// their current value.
export function notifySettings(raw: unknown, cur: NotifySettings): NotifySettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pick = (k: keyof NotifySettings) => (typeof r[k] === "boolean" ? (r[k] as boolean) : cur[k]);
  return { reports: pick("reports"), fuel: pick("fuel"), jobs: pick("jobs"), succession: pick("succession"), digest: pick("digest") };
}

// notify sends the owner (or `to`, a member the relay may address) a message
// of the given kind if that kind is switched on ("test" always sends).
// Returns whether a wrap was stored. A leased relay has no owner to write to.
export async function notify(relay: Relay, kind: NotifyKind, text: string, subject = "your relay", to = ""): Promise<boolean> {
  const p = relay.settings.policy;
  if (p.owner === "" || relay.settings.isLeased()) return false;
  if (kind !== "test" && !p.notify[kind]) return false;
  const recipient = to || p.owner;
  await relay.identity.ensure();
  const t = now();
  const wrap = relay.identity.wrap({ kind: KIND_DM, content: text, tags: [["p", recipient], ["subject", subject]], created_at: t }, recipient);
  const err = relay.store.save(wrap, t);
  if (err) return false;
  relay.broadcast(wrap);
  void pushToInbox(relay, wrap).catch(() => {});
  return true;
}

// pushToInbox forwards the wrap to the owner's DM relays, best effort, a
// few seconds each, never to this relay itself.
async function pushToInbox(relay: Relay, wrap: Event): Promise<void> {
  const rows = relay.store.query({ kinds: [10050], authors: [relay.settings.policy.owner], tags: {}, limit: 1 }, { pubkeys: [], all: true }, 1, now()).rows;
  if (!rows[0]) return;
  const list = JSON.parse(rows[0]) as Event;
  const self = relay.slug + ".";
  const urls = tagValues(list, "relay")
    .map((u) => u.trim())
    .filter((u) => {
      try {
        return /^wss?:$/.test(new URL(u).protocol) && !new URL(u).hostname.startsWith(self);
      } catch {
        return false;
      }
    })
    .slice(0, PUSH_RELAYS);
  await Promise.all(urls.map((u) => pushOne(relay, u, wrap).catch(() => {})));
}

function pushOne(relay: Relay, url: string, wrap: Event): Promise<void> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    const timer = setTimeout(done, PUSH_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      try {
        ws?.close(1000, "done");
      } catch {
        /* already closed */
      }
      resolve();
    }
    dial(relay, url)
      .then((sock) => {
        ws = sock;
        ws.addEventListener("message", (e) => {
          try {
            const m = JSON.parse(String(e.data)) as unknown[];
            if (m[0] === "OK" && m[1] === wrap.id) done();
          } catch {
            /* not for us */
          }
        });
        ws.addEventListener("close", done);
        ws.send(JSON.stringify(["EVENT", wrap]));
      })
      .catch(done);
  });
}

// fuelLow says whether the owner should hear about fuel: out of it, or past
// an allowance with less than a small balance left.
export function fuelLow(f: FuelStatus): boolean {
  if (!f.enabled) return false;
  if (f.outOfFuel) return true;
  const over = f.eventBytes > f.freeEventBytes || f.mediaBytes > f.freeMediaBytes || f.activeMs > f.freeActiveMs || f.rowsWritten > f.freeRowsWritten;
  return over && f.balanceMsats < LOW_SATS * 1000;
}

export function fuelText(relay: Relay, f: FuelStatus): string {
  const sats = Math.floor(f.balanceMsats / 1000);
  const state = f.outOfFuel ? "is out of fuel and read-only" : `is past its free allowance with ${sats} sats left`;
  return `Your relay ${relay.slug} ${state}. Zap it at https://${relay.slug}.${relay.domain}/ to keep it writing.`;
}

// digestText is the week on the relay in a few lines, from what the store,
// the member list, the usage row and the job list already hold. When nothing
// changed it says so in one line.
export async function digestText(relay: Relay, since: number, t: number): Promise<string> {
  const sql = relay.sql;
  const one = (q: string, ...args: unknown[]) => sql.exec<{ n: number | null }>(q, ...args).one().n ?? 0;
  const self = relay.identity.pubkey;
  const joined = one(`SELECT count(*) AS n FROM members WHERE joined_at >= ? AND role <> 'owner'`, since);
  const left = self ? one(`SELECT count(*) AS n FROM events WHERE kind=8001 AND pubkey=? AND created_at >= ?`, self, since) : 0;
  const events = one(`SELECT count(*) AS n FROM events WHERE created_at >= ? AND pubkey <> ? AND kind <> 1059`, since, self);
  const files = one(`SELECT count(*) AS n FROM blobs WHERE uploaded >= ?`, since);
  const reports = one(`SELECT count(*) AS n FROM reports WHERE status='open'`);
  const hidden = one(`SELECT count(*) AS n FROM event_rules WHERE rule='hide'`);
  const jobs = (await relay.jobs()).filter((j) => j.last && j.last.finishedAt >= since);
  const failed = jobs.filter((j) => j.last && j.last.error).length;
  const f = relay.fuelStatus();
  const spent = Math.floor(f.chargedMsats / 1000);
  const balance = Math.floor(f.balanceMsats / 1000);
  const sc = await relay.successionStatus();
  const viewRows = await viewRowsSince(relay, since);
  const lines: string[] = [];
  if (joined || left) lines.push(`People: ${joined} joined${left ? `, ${left} left` : ""}.`);
  if (events || files) lines.push(`Stored: ${events} events${files ? ` and ${files} files` : ""}.`);
  if (jobs.length) lines.push(`Jobs: ${jobs.length} ran${failed ? `, ${failed} failed` : ""}.`);
  if (reports || hidden) lines.push(`Moderation: ${reports} open reports${hidden ? `, ${hidden} events hidden` : ""}.`);
  if (f.enabled) {
    const over = f.eventBytes > f.freeEventBytes || f.mediaBytes > f.freeMediaBytes || f.activeMs > f.freeActiveMs || f.rowsWritten > f.freeRowsWritten;
    if (spent || over || f.outOfFuel) lines.push(`Fuel: ${spent} sats spent this month, ${balance} left${f.outOfFuel ? ", out of fuel" : over ? ", past the free allowance" : ""}.`);
  }
  if (sc.succession && sc.handoverAt) lines.push(`Handover to ${sc.succession.heir.slice(0, 8)} in ${Math.max(0, Math.ceil((sc.handoverAt - t) / 86400))} days unless you sign in.`);
  const days = Math.max(1, Math.round((t - since) / 86400));
  // The views' housekeeping rides along with a week that had news; a quiet week stays quiet.
  if (lines.length && viewRows) lines.push(`Views: ${viewRows} rows written.`);
  return lines.length ? [`The last ${days} days on ${relay.slug}:`, ...lines].join("\n") : `Nothing changed on ${relay.slug} in the last ${days} days.`;
}
