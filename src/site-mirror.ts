// NIP-5A's Blossom lookup, shared by alarm-driven mirroring and a cache
// miss at the site door. Bytes are checked before storage or delivery.
import { sha256 } from "@noble/hashes/sha2.js";
import { blobBlocked, fetchOrigin, readCapped, storeBlob } from "./blossom.ts";
import { now, tagValues, type Event } from "./event.ts";
import { bytesToHex } from "./negentropy.ts";
import { checkSite, manifest, parseSite, siteLabel, sitePaths, siteType } from "./sites.ts";
import { featureOn } from "./settings.ts";
import { localName } from "./pull.ts";
import type { Relay } from "./relay.ts";
import type { Job } from "./jobs.ts";

// Proxy responses are bounded because verification precedes delivery.
// Mirroring has the same ceiling; local R2 serving verifies as a stream.
export const SITE_FETCH_MAX = 32 * 1024 * 1024;
const MAX_SERVERS = 10; // per list, so author servers always get a turn too

function safeServer(relay: Relay, raw: string): URL | null {
  try {
    const u = new URL(raw);
    const local = localName(u, relay.domain);
    if (u.username || u.password || u.hash || (u.protocol !== "https:" && !(local && u.protocol === "http:"))) return null;
    if (local === relay.slug) return null; // our own files were already checked
    if (!local && (u.port && u.port !== "443" || /^\[|^[\d.]+$/.test(u.hostname) || !u.hostname.includes(".") || /\.(localhost|local|internal)$/.test(u.hostname))) return null;
    return u;
  } catch { return null; }
}
function servers(relay: Relay, e: Event): string[] {
  const raw = relay.store.query({ authors: [e.pubkey], kinds: [10063], tags: {} }, { pubkeys: [] }, 1, now()).rows[0];
  const author = raw ? tagValues(JSON.parse(raw) as Event, "server") : [];
  return [...new Set([...tagValues(e, "server").slice(0, MAX_SERVERS), ...author.slice(0, MAX_SERVERS)])];
}

export async function remoteSiteBlob(relay: Relay, e: Event, mapping: string[]): Promise<{ bytes: Uint8Array; type: string; length: string | null } | null> {
  if (!featureOn(relay.settings.policy, "sites") || relay.fuelStatus().outOfFuel || blobBlocked(relay, mapping[2])) return null;
  const max = Math.min(SITE_FETCH_MAX, relay.settings.policy.maxBlobMB * 1024 * 1024);
  for (const server of servers(relay, e)) {
    const origin = safeServer(relay, server);
    if (!origin) continue;
    origin.pathname = origin.pathname.replace(/\/$/, "") + "/" + mapping[2];
    origin.search = "";
    let target: URL | null = origin;
    // Redirect targets go through the same checks. No caller credentials
    // are forwarded to a server or a sibling relay.
    for (let redirects = 0; target && redirects <= 3; redirects++) {
      let response: Response | string;
      try {
        response = await fetchOrigin(relay, target.href, { redirect: "manual", headers: { "accept-encoding": "identity" }, signal: AbortSignal.timeout(5000) });
        if (typeof response === "string") break;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          target = location ? safeServer(relay, new URL(location, target).href) : null;
          continue;
        }
        if (!response.ok || (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity")) { await response.body?.cancel(); break; }
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) { await response.body?.cancel(); break; }
        const bytes = await readCapped(response.body, max);
        if (bytes === "too big") { relay.meterBytes(max, 0); break; }
        relay.meterBytes(bytes.length, 0);
        if ((length !== null && Number(length) !== bytes.length) || bytesToHex(sha256(bytes)) !== mapping[2]) break;
        const type = response.headers.get("content-type") ?? (length === null ? siteType(mapping[1]) : "");
        return { bytes, type, length };
      } catch { break; }
    }
  }
  return null;
}

// queueMirrors drains the SQL queue, which survives full jobs and hibernation.
// Turning mirroring off discards pending work; proxy reads still work.
export async function queueMirrors(relay: Relay): Promise<void> {
  if (!featureOn(relay.settings.policy, "sites") || !relay.settings.policy.features.sites.mirror) {
    relay.sql.exec(`DELETE FROM site_mirror_queue`);
    return;
  }
  const rows = relay.sql.exec<{ event_id: string }>(`SELECT event_id FROM site_mirror_queue LIMIT 10`).toArray();
  for (const row of rows) {
    const raw = relay.store.query({ ids: [row.event_id], tags: {} }, { pubkeys: [] }, 1, now()).rows[0];
    const e = raw ? JSON.parse(raw) as Event : null;
    if (e && !checkSite(e)) {
      const jobs = await relay.jobs();
      if (!jobs.some((j) => j.kind === "mirror" && j.site === e.id)) {
        const job = await relay.addChecked({ kind: "mirror", label: "mirror", site: e.id, relays: servers(relay, e), filter: {}, every: 0, running: false, startedAt: 0, rounds: 0, failures: 0, relayIndex: 0, cursor: 0, stored: 0, skipped: 0, blobs: 0, sent: 0, refused: 0, last: null });
        if (typeof job === "string") return;
      }
    }
    relay.sql.exec(`DELETE FROM site_mirror_queue WHERE event_id=?`, row.event_id);
  }
}

export async function runMirrorRound(relay: Relay, job: Job): Promise<{ more: boolean; error: string }> {
  job.rounds++;
  if (!featureOn(relay.settings.policy, "sites") || !relay.settings.policy.features.sites.mirror) return { more: false, error: "" };
  const raw = relay.store.query({ ids: [job.site ?? ""], tags: {} }, { pubkeys: [] }, 1, now()).rows[0];
  if (!raw) return { more: false, error: "" }; // deleted, replaced, hidden or expired
  const e = JSON.parse(raw) as Event;
  if (checkSite(e)) return { more: false, error: "invalid manifest" };
  const paths = [...new Map(sitePaths(e).map((t) => [t[2], t])).values()];
  if (job.cursor >= paths.length) return { more: false, error: "" };
  const mapping = paths[job.cursor];
  if (relay.sql.exec(`SELECT 1 FROM blobs WHERE sha256=?`, mapping[2]).toArray().length || blobBlocked(relay, mapping[2])) {
    job.skipped++; job.cursor++;
    return { more: job.cursor < paths.length, error: "" };
  }
  const gate = relay.mayUpload(e.pubkey, `${relay.slug}.${relay.domain}`);
  if (gate) return { more: false, error: gate };
  const remote = await remoteSiteBlob(relay, e, mapping);
  if (!remote) return { more: false, error: "not found: no server returned the verified site file " + mapping[2] };
  const site = parseSite(siteLabel(e));
  if (!site || manifest(relay, site)?.id !== e.id || blobBlocked(relay, mapping[2]) || !featureOn(relay.settings.policy, "sites") || !relay.settings.policy.features.sites.mirror || relay.mayUpload(e.pubkey, `${relay.slug}.${relay.domain}`)) return { more: false, error: "" };
  const { created } = await storeBlob(relay, remote.bytes, remote.type, e.pubkey, now());
  if (created) job.blobs++; else job.skipped++;
  job.cursor++;
  return { more: job.cursor < paths.length, error: "" };
}
