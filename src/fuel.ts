// Fuel: quotas on what a relay costs to run, topped up by zaps. Four things
// are metered and priced, each mirroring a line on the Cloudflare bill:
// events stored (SQLite), media stored (R2), time awake (Durable Object
// duration) and rows written. Traffic is metered but free, as it is for us.
// Every relay gets a free monthly allowance of each; beyond it, usage burns
// sats credited by NIP-57 zap receipts that arrive at the relay itself as
// ordinary events. Receipts are
// the ledger: signed by the lightning provider, stored like any event, and
// re-validated by the same rules whenever the balance is computed.
import { sha256 } from "@noble/hashes/sha2.js";
import { tag, tagValues, validate, type Event } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";

export interface FuelConfig {
  lightningAddress: string; // "" disables top-ups (allowances still apply)
  servicePubkey: string; // recipient pubkey zap requests must name
  // Free per relay per month.
  freeEventsMB: number; // SQLite: events, tags, search index
  freeMediaMB: number; // R2: Blossom blobs
  freeActiveHours: number; // wall-clock time the object is awake
  freeRowsWritten: number; // SQLite rows written
  // Beyond the allowances. Each tracks what Cloudflare bills for the same
  // thing, so the prices in wrangler.jsonc are set from those rates.
  satsPerGBMonthEvents: number;
  satsPerGBMonthMedia: number;
  satsPerActiveHour: number;
  satsPerMillionRows: number;
}

export function fuelConfig(env: Record<string, unknown>): FuelConfig {
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    lightningAddress: typeof env.LIGHTNING_ADDRESS === "string" ? env.LIGHTNING_ADDRESS : "",
    servicePubkey: typeof env.SERVICE_PUBKEY === "string" ? env.SERVICE_PUBKEY.toLowerCase() : "",
    freeEventsMB: num("FREE_EVENTS_MB", 100),
    freeMediaMB: num("FREE_MEDIA_MB", 1024),
    freeActiveHours: num("FREE_ACTIVE_HOURS", 100),
    freeRowsWritten: num("FREE_ROWS_WRITTEN", 1_000_000),
    satsPerGBMonthEvents: num("SATS_PER_GB_MONTH_EVENTS", 400),
    satsPerGBMonthMedia: num("SATS_PER_GB_MONTH_MEDIA", 30),
    satsPerActiveHour: num("SATS_PER_ACTIVE_HOUR", 11),
    satsPerMillionRows: num("SATS_PER_MILLION_ROWS", 2000),
  };
}

export const FUEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  month          TEXT PRIMARY KEY,
  bytes_in       INTEGER NOT NULL DEFAULT 0,
  bytes_out      INTEGER NOT NULL DEFAULT 0,
  rows_read      INTEGER NOT NULL DEFAULT 0,
  rows_written   INTEGER NOT NULL DEFAULT 0,
  storage_msats  INTEGER NOT NULL DEFAULT 0,
  storage_day    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS credits (
  id     TEXT PRIMARY KEY,
  msats  INTEGER NOT NULL,
  payer  TEXT NOT NULL,
  at     INTEGER NOT NULL
);
`;

const MB = 1024 * 1024;
const GB = 1024 * MB;
const HOUR_MS = 3600_000;

export const monthOf = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 7);
export const dayOf = (unix: number) => Math.floor(unix / 86400);

export type Usage = {
  month: string;
  bytes_in: number;
  bytes_out: number;
  rows_read: number;
  rows_written: number;
  active_ms: number;
  storage_msats: number;
  storage_day: number;
};

export interface FuelStatus {
  enabled: boolean;
  lightningAddress: string;
  servicePubkey: string;
  month: string;
  // The four things that cost something, each with its allowance.
  eventBytes: number;
  freeEventBytes: number;
  mediaBytes: number;
  freeMediaBytes: number;
  activeMs: number;
  freeActiveMs: number;
  rowsWritten: number;
  freeRowsWritten: number;
  // Metered for the owner's information; not priced.
  bytesOut: number;
  bytesIn: number;
  rowsRead: number;
  creditedMsats: number;
  chargedMsats: number;
  balanceMsats: number;
  outOfFuel: boolean;
  rates: { satsPerGBMonthEvents: number; satsPerGBMonthMedia: number; satsPerActiveHour: number; satsPerMillionRows: number };
}

export class Fuel {
  constructor(private sql: SqlStorage, public cfg: FuelConfig) {}

  init() {
    this.sql.exec(FUEL_SCHEMA);
    // Relays created before active time was metered.
    try {
      this.sql.exec(`ALTER TABLE usage ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // column exists
    }
  }

  private usageRow(month: string): Usage {
    this.sql.exec(`INSERT OR IGNORE INTO usage(month) VALUES(?)`, month);
    return this.sql.exec<Usage>(`SELECT * FROM usage WHERE month=?`, month).one();
  }

  // record adds usage counters to the current month.
  record(now: number, d: { bytesIn?: number; bytesOut?: number; rowsRead?: number; rowsWritten?: number; activeMs?: number }) {
    const month = monthOf(now);
    this.sql.exec(`INSERT OR IGNORE INTO usage(month) VALUES(?)`, month);
    this.sql.exec(
      `UPDATE usage SET bytes_in=bytes_in+?, bytes_out=bytes_out+?, rows_read=rows_read+?, rows_written=rows_written+?, active_ms=active_ms+? WHERE month=?`,
      d.bytesIn ?? 0, d.bytesOut ?? 0, d.rowsRead ?? 0, d.rowsWritten ?? 0, d.activeMs ?? 0, month,
    );
  }

  // chargeStorage bills storage beyond the allowances once per day, pro rata.
  chargeStorage(now: number, eventBytes: number, mediaBytes: number) {
    const u = this.usageRow(monthOf(now));
    const day = dayOf(now);
    if (u.storage_day === day) return;
    const days = u.storage_day === 0 ? 1 : Math.min(day - u.storage_day, 31);
    const overEvents = Math.max(0, eventBytes - this.cfg.freeEventsMB * MB);
    const overMedia = Math.max(0, mediaBytes - this.cfg.freeMediaMB * MB);
    const perMonth = (overEvents / GB) * this.cfg.satsPerGBMonthEvents + (overMedia / GB) * this.cfg.satsPerGBMonthMedia;
    const msats = Math.round(perMonth * 1000 * (days / 30));
    this.sql.exec(`UPDATE usage SET storage_msats=storage_msats+?, storage_day=? WHERE month=?`, msats, day, u.month);
  }

  // meteredMsats prices a month's active time and row writes beyond the allowances.
  private meteredMsats(u: Usage): number {
    const overActive = Math.max(0, u.active_ms - this.cfg.freeActiveHours * HOUR_MS);
    const overRows = Math.max(0, u.rows_written - this.cfg.freeRowsWritten);
    return Math.round((overActive / HOUR_MS) * this.cfg.satsPerActiveHour * 1000 + (overRows / 1_000_000) * this.cfg.satsPerMillionRows * 1000);
  }

  status(now: number, eventBytes: number, mediaBytes: number): FuelStatus {
    const u = this.usageRow(monthOf(now));
    const credited = this.sql.exec<{ n: number | null }>(`SELECT sum(msats) AS n FROM credits`).one().n ?? 0;
    let charged = 0;
    for (const row of this.sql.exec<Usage>(`SELECT * FROM usage`)) charged += row.storage_msats + this.meteredMsats(row);
    const balance = credited - charged;
    const freeEventBytes = this.cfg.freeEventsMB * MB;
    const freeMediaBytes = this.cfg.freeMediaMB * MB;
    const freeActiveMs = this.cfg.freeActiveHours * HOUR_MS;
    const over = eventBytes > freeEventBytes || mediaBytes > freeMediaBytes || u.active_ms > freeActiveMs || u.rows_written > this.cfg.freeRowsWritten;
    return {
      enabled: this.cfg.lightningAddress !== "" && this.cfg.servicePubkey !== "",
      lightningAddress: this.cfg.lightningAddress,
      servicePubkey: this.cfg.servicePubkey,
      month: u.month,
      eventBytes,
      freeEventBytes,
      mediaBytes,
      freeMediaBytes,
      activeMs: u.active_ms,
      freeActiveMs,
      rowsWritten: u.rows_written,
      freeRowsWritten: this.cfg.freeRowsWritten,
      bytesOut: u.bytes_out,
      bytesIn: u.bytes_in,
      rowsRead: u.rows_read,
      creditedMsats: credited,
      chargedMsats: charged,
      balanceMsats: balance,
      outOfFuel: over && balance <= 0,
      rates: {
        satsPerGBMonthEvents: this.cfg.satsPerGBMonthEvents,
        satsPerGBMonthMedia: this.cfg.satsPerGBMonthMedia,
        satsPerActiveHour: this.cfg.satsPerActiveHour,
        satsPerMillionRows: this.cfg.satsPerMillionRows,
      },
    };
  }

  // credit records a validated receipt once. Returns false if already known.
  credit(receiptId: string, msats: number, payer: string, now: number): boolean {
    return this.sql.exec(`INSERT OR IGNORE INTO credits(id,msats,payer,at) VALUES(?,?,?,?)`, receiptId, msats, payer, now).rowsWritten > 0;
  }

  recentCredits(limit = 20) {
    return this.sql.exec<{ id: string; msats: number; payer: string; at: number }>(`SELECT * FROM credits ORDER BY at DESC LIMIT ?`, limit).toArray();
  }

  // validateReceipt checks a kind 9735 event against NIP-57 appendix F for
  // this relay: signed by the provider, naming the service pubkey, carrying
  // a signed zap request that lists this relay, with an invoice whose amount
  // matches. Returns the credit or a reason.
  validateReceipt(e: Event, providerPubkey: string, relayHost: string): { msats: number; payer: string } | string {
    if (e.kind !== 9735) return "not a zap receipt";
    if (!providerPubkey || e.pubkey !== providerPubkey) return "receipt not signed by the lightning provider";
    if (tag(e, "p") !== this.cfg.servicePubkey) return "receipt is not for this service";
    let req: Event;
    try {
      req = JSON.parse(tag(e, "description"));
    } catch {
      return "receipt description is not a zap request";
    }
    if (validate(req) !== "" || req.kind !== 9734) return "embedded zap request is invalid";
    if (tag(req, "p") !== this.cfg.servicePubkey) return "zap request is not for this service";
    const relays = req.tags.filter((t) => t[0] === "relays").flatMap((t) => t.slice(1));
    if (!relays.some((r) => hostOfURL(r) === relayHost.toLowerCase())) return "zap request does not name this relay";
    const msats = bolt11Msats(tag(e, "bolt11"));
    if (msats <= 0) return "invoice has no amount";
    const asked = Number(tag(req, "amount"));
    if (asked > 0 && asked !== msats) return "invoice amount does not match the zap request";
    return { msats, payer: req.pubkey };
  }
}

function hostOfURL(s: string): string {
  try {
    return new URL(s).host.toLowerCase();
  } catch {
    return "";
  }
}

// bolt11Msats reads the amount from an invoice's human-readable part:
// ln<currency><digits><multiplier>. Returns 0 when absent or malformed.
export function bolt11Msats(invoice: string): number {
  const s = invoice.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (!s.startsWith("ln") || sep < 0) return 0;
  const hrp = s.slice(2, sep);
  const m = /^(bcrt|bc|tbs|tb)(\d+)([munp])?$/.exec(hrp);
  if (!m) return 0;
  const digits = BigInt(m[2]);
  const exp = { m: 3n, u: 6n, n: 9n, p: 12n }[m[3] ?? ""] ?? 0n;
  // amount in BTC = digits * 10^-exp; msats = BTC * 10^11
  if (exp <= 11n) return Number(digits * 10n ** (11n - exp));
  const scaled = digits * 10n ** 11n;
  const div = 10n ** exp;
  return scaled % div === 0n ? Number(scaled / div) : 0;
}

// LNURL-pay parameters for a lightning address, per LUD-16 and NIP-57.
export interface LnurlParams {
  address: string; // which lightning address these belong to
  callback: string;
  minSendable: number;
  maxSendable: number;
  nostrPubkey: string;
  allowsNostr: boolean;
  fetchedAt: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchLnurl(lightningAddress: string, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<LnurlParams> {
  const [user, domain] = lightningAddress.split("@");
  if (!user || !domain) throw new Error("bad lightning address");
  const resp = await fetcher(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`lnurl: HTTP ${resp.status}`);
  const j = (await resp.json()) as Record<string, unknown>;
  if (typeof j.callback !== "string") throw new Error("lnurl: no callback");
  return {
    address: lightningAddress,
    callback: j.callback,
    minSendable: Number(j.minSendable) || 1000,
    maxSendable: Number(j.maxSendable) || 0,
    nostrPubkey: typeof j.nostrPubkey === "string" ? j.nostrPubkey.toLowerCase() : "",
    allowsNostr: j.allowsNostr === true,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

// requestInvoice asks the provider for an invoice carrying the zap request.
export async function requestInvoice(params: LnurlParams, zapRequest: Event, msats: number, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<string> {
  const u = new URL(params.callback);
  u.searchParams.set("amount", String(msats));
  u.searchParams.set("nostr", JSON.stringify(zapRequest));
  const resp = await fetcher(u.toString(), { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`lnurl callback: HTTP ${resp.status}`);
  const j = (await resp.json()) as Record<string, unknown>;
  if (typeof j.pr !== "string") throw new Error(typeof j.reason === "string" ? j.reason : "lnurl callback returned no invoice");
  return j.pr;
}

export function zapRequestHash(req: Event): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(req))));
}

export { tagValues };
