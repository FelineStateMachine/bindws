// Custom domains: relay.alice.com as a CNAME onto her relay, through
// Cloudflare for SaaS custom hostnames. The worker maps a hostname to a
// relay name through the HOSTS KV namespace (see index.ts); the object keeps
// its hostnames in policy and talks to the Cloudflare API to create, check
// and remove them. Requests on a custom hostname arrive with the same
// x-relay-name header as any other, so nothing inside the object cares
// which door they came through except the URLs it prints, which already
// follow the request host.
import type { Fetcher } from "./fuel.ts";
import type { Relay } from "./relay.ts";
import { parseSite } from "./sites.ts";
import { validName } from "./names.ts";

export interface CustomHost {
  host: string;
  id: string; // Cloudflare's custom hostname id
  // An optional NIP-5A site label served on this hostname. Older entries do
  // not have this field and continue to address the relay itself.
  site?: string;
  at: number; // when last checked
  status: string; // Cloudflare's hostname status, active when it proxies
  sslStatus: string; // certificate status, active when issued
}

export const MAX_CUSTOM_HOSTS = 3;
export const UNSUPPORTED = "unsupported: custom domains are not enabled on this host";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// checkHostname normalises and validates a hostname. Returns the hostname
// or a reason: lowercase labels, two or more of them, not the service
// domain or anything under it, not local, not an address.
export function checkHostname(raw: string, domain: string): { host: string } | { error: string } {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase();
  if (host.length === 0 || host.length > 253) return { error: "invalid: hostname length" };
  if (host.includes(":") || IPV4.test(host)) return { error: "invalid: an address is not a hostname" };
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return { error: "invalid: not a valid hostname" };
  if (/^\d+$/.test(labels[labels.length - 1])) return { error: "invalid: not a valid hostname" };
  if (host === d || host.endsWith("." + d)) return { error: "invalid: names under " + d + " are relays already" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { error: "invalid: that name is local" };
  return { host };
}

// What Cloudflare tells us about a custom hostname, trimmed to what we show.
export interface HostnameState {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string;
  ownership: { name: string; value: string } | null; // TXT pre-validation record
  dcv: { txtName?: string; txtValue?: string; httpUrl?: string; httpBody?: string }[];
}

// Hostnames is the Cloudflare API client for the zone's custom hostnames.
// Certificates use HTTP validation, which Cloudflare completes on its own
// once the customer's CNAME resolves to us, so the owner has one record to
// create. The token needs "SSL and Certificates: Edit" on the zone.
export class Hostnames {
  constructor(private token: string, private zone: string, private fetcher: Fetcher) {}

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const resp = await this.fetcher(`https://api.cloudflare.com/client/v4/zones/${this.zone}/custom_hostnames${path}`, {
      method,
      headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: { success?: boolean; result?: Record<string, unknown> | null; errors?: { code?: number; message?: string }[] } = {};
    try {
      json = await resp.json();
    } catch {
      throw new Error(`Cloudflare answered ${resp.status}`);
    }
    if (!json.success) {
      const e = json.errors?.[0];
      if (method === "DELETE" && (resp.status === 404 || e?.code === 1436)) return null;
      throw new Error(e?.message ? `Cloudflare: ${e.message}` : `Cloudflare answered ${resp.status}`);
    }
    return json.result ?? null;
  }

  async create(hostname: string): Promise<HostnameState> {
    const r = await this.call("POST", "", { hostname, ssl: { method: "http", type: "dv" } });
    if (!r) throw new Error("Cloudflare returned no hostname");
    return parseState(r);
  }

  async get(id: string): Promise<HostnameState | null> {
    const r = await this.call("GET", "/" + id);
    return r ? parseState(r) : null;
  }

  async remove(id: string): Promise<void> {
    await this.call("DELETE", "/" + id);
  }
}

function parseState(r: Record<string, unknown>): HostnameState {
  const ssl = (r.ssl ?? {}) as Record<string, unknown>;
  const ov = (r.ownership_verification ?? null) as { name?: string; value?: string } | null;
  const recs = Array.isArray(ssl.validation_records) ? (ssl.validation_records as Record<string, string>[]) : [];
  return {
    id: String(r.id ?? ""),
    hostname: String(r.hostname ?? ""),
    status: String(r.status ?? "pending"),
    sslStatus: String(ssl.status ?? "pending_validation"),
    ownership: ov && ov.name && ov.value ? { name: ov.name, value: ov.value } : null,
    dcv: recs.map((x) => ({ txtName: x.txt_name, txtValue: x.txt_value, httpUrl: x.http_url, httpBody: x.http_body })),
  };
}

// DomainView is what the console and API callers get.
export interface DomainView {
  host: string;
  site?: string;
  status: string;
  sslStatus: string;
  ready: boolean;
  checkedAt: number;
  records: { type: string; name: string; value: string; note: string }[];
}

function view(h: CustomHost, target: string, state: HostnameState | null): DomainView {
  const records: DomainView["records"] = [{ type: "CNAME", name: h.host, value: target, note: "required; the certificate follows once it resolves" }];
  if (state?.ownership && state.status !== "active") records.push({ type: "TXT", name: state.ownership.name, value: state.ownership.value, note: "optional; activates the hostname before you switch the CNAME" });
  return { host: h.host, site: h.site, status: h.status, sslStatus: h.sslStatus, ready: h.status === "active" && h.sslStatus === "active", checkedAt: h.at, records };
}

function stored(relay: Relay): CustomHost[] {
  return relay.settings.policy.customHosts ?? [];
}

function save(relay: Relay, hosts: CustomHost[]) {
  relay.settings.update({ customHosts: hosts });
}

export interface CustomTarget {
  name: string;
  site?: string;
}

// customTarget reads both the old plain relay name and a mapping with a
// site label, so existing custom domains keep their relay door.
export function customTarget(value: string | null): CustomTarget | null {
  if (!value) return null;
  if (validName(value)) return { name: value };
  try {
    const target = JSON.parse(value) as { name?: unknown; site?: unknown };
    if (typeof target.name !== "string" || !validName(target.name)) return null;
    if (target.site !== undefined && (typeof target.site !== "string" || !parseSite(target.site))) return null;
    return { name: target.name, ...(target.site === undefined ? {} : { site: target.site }) };
  } catch {
    return null;
  }
}

function targetValue(name: string, site?: string): string {
  return site === undefined ? name : JSON.stringify({ name, site });
}

// addDomain registers a hostname with Cloudflare, then maps it in KV and
// remembers it. KV is written only after Cloudflare accepted the hostname.
export async function addDomain(relay: Relay, raw: string, site?: string): Promise<DomainView | string> {
  const api = relay.hostnames;
  const kv = relay.hosts;
  if (!api || !kv) return UNSUPPORTED;
  const c = checkHostname(raw, relay.domain);
  if ("error" in c) return c.error;
  if (site !== undefined && !parseSite(site)) return "invalid: not a valid site hostname";
  const hosts = stored(relay);
  if (hosts.some((h) => h.host === c.host)) return "duplicate: that hostname is already on this relay";
  if (hosts.length >= MAX_CUSTOM_HOSTS) return `restricted: at most ${MAX_CUSTOM_HOSTS} custom domains per relay`;
  const taken = customTarget(await kv.get(c.host));
  if (taken && taken.name !== relay.slug) return "restricted: that hostname points at another relay";
  let state: HostnameState;
  try {
    state = await api.create(c.host);
  } catch (err) {
    return "error: " + (err instanceof Error ? err.message : String(err));
  }
  await kv.put(c.host, targetValue(relay.slug, site));
  const h: CustomHost = { host: c.host, ...(site === undefined ? {} : { site }), id: state.id, at: Math.floor(Date.now() / 1000), status: state.status, sslStatus: state.sslStatus };
  save(relay, [...hosts, h]);
  return view(h, relay.cnameTarget, state);
}

// setDomainSite changes a registered hostname's destination. Its existing
// certificate and DNS records stay valid because only the routing changes.
export async function setDomainSite(relay: Relay, raw: string, site?: string): Promise<DomainView | string> {
  if (!relay.hostnames || !relay.hosts) return UNSUPPORTED;
  const host = raw.trim().toLowerCase();
  const hosts = stored(relay);
  const h = hosts.find((x) => x.host === host);
  if (!h) return "invalid: no such custom domain on this relay";
  if (site !== undefined && !parseSite(site)) return "invalid: not a valid site hostname";
  const taken = customTarget(await relay.hosts.get(host));
  if (taken && taken.name !== relay.slug) return "restricted: that hostname points at another relay";
  await relay.hosts.put(host, targetValue(relay.slug, site));
  const fresh = { ...h, site };
  save(relay, hosts.map((x) => x.host === host ? fresh : x));
  return view(fresh, relay.cnameTarget, null);
}

// checkDomain asks Cloudflare where the hostname stands and remembers it.
export async function checkDomain(relay: Relay, raw: string): Promise<DomainView | string> {
  const api = relay.hostnames;
  if (!api) return UNSUPPORTED;
  const host = raw.trim().toLowerCase();
  const hosts = stored(relay);
  const h = hosts.find((x) => x.host === host);
  if (!h) return "invalid: no such custom domain on this relay";
  let state: HostnameState | null;
  try {
    state = await api.get(h.id);
  } catch (err) {
    return "error: " + (err instanceof Error ? err.message : String(err));
  }
  if (!state) return "error: Cloudflare no longer knows this hostname; remove it and add it again";
  const fresh: CustomHost = { ...h, at: Math.floor(Date.now() / 1000), status: state.status, sslStatus: state.sslStatus };
  save(relay, hosts.map((x) => (x.host === host ? fresh : x)));
  return view(fresh, relay.cnameTarget, state);
}

// removeDomain deletes the hostname at Cloudflare, then the mapping.
export async function removeDomain(relay: Relay, raw: string): Promise<string> {
  const api = relay.hostnames;
  if (!api) return UNSUPPORTED;
  const host = raw.trim().toLowerCase();
  const hosts = stored(relay);
  const h = hosts.find((x) => x.host === host);
  if (!h) return "invalid: no such custom domain on this relay";
  try {
    await api.remove(h.id);
  } catch (err) {
    return "error: " + (err instanceof Error ? err.message : String(err));
  }
  const kv = relay.hosts;
  if (kv && customTarget(await kv.get(host))?.name === relay.slug) await kv.delete(host);
  save(relay, hosts.filter((x) => x.host !== host));
  return "";
}

export function listDomains(relay: Relay): DomainView[] | string {
  if (!relay.hostnames) return UNSUPPORTED;
  return stored(relay).map((h) => view(h, relay.cnameTarget, null));
}

// forgetDomains is teardown's part: best effort, nothing to report to.
export async function forgetDomains(relay: Relay): Promise<void> {
  for (const h of stored(relay)) {
    try {
      if (relay.hostnames) await relay.hostnames.remove(h.id);
    } catch (err) {
      console.log(`custom hostname ${h.host} not removed at Cloudflare: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const kv = relay.hosts;
      if (kv && customTarget(await kv.get(h.host))?.name === relay.slug) await kv.delete(h.host);
    } catch (err) {
      console.log(`custom hostname ${h.host} not removed from KV: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
