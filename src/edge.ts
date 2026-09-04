// What the edge in front of the Worker provides, and what stands in when it
// is not Cloudflare's: the client's address, the lease door's rate limit,
// the custom hostname map, and the answer to a proxy asking whether a
// hostname belongs here. Hosting without Cloudflare is
// docs/16-hosting-without-cloudflare.md.
import type { Env } from "./relay.ts";
import { Bucket } from "./ratelimit.ts";
import { RESERVED, validName } from "./names.ts";

// Custom domains map to relay names through KV. Looked up once a minute per
// hostname per isolate; a miss is cached too, so an unknown host does not
// cost a read on every request.
const HOST_TTL_MS = 60_000;
const hostCache = new Map<string, { name: string | null; at: number }>();
export async function customHost(env: Pick<Env, "HOSTS">, host: string): Promise<string | null> {
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return hit.name;
  let name: string | null = null;
  try {
    name = env.HOSTS ? await env.HOSTS.get(host) : null;
  } catch {
    name = null;
  }
  if (hostCache.size > 10_000) hostCache.clear();
  hostCache.set(host, { name, at: Date.now() });
  return name;
}

// clientIP is the address the edge saw. On Cloudflare that is
// cf-connecting-ip, which the edge sets and nothing a client sends can
// forge. Elsewhere it is the header CLIENT_IP_HEADER names, written by the
// operator's own proxy; the last address in a comma list is the one that
// proxy appended. An empty CLIENT_IP_HEADER means no address is known, and
// everything keyed by address stands down (relay.ts, ipLimit).
export function clientIP(req: Request, env: Pick<Env, "CLIENT_IP_HEADER">): string {
  const header = env.CLIENT_IP_HEADER ?? "cf-connecting-ip";
  if (header === "") return "unknown";
  const last = (req.headers.get(header) ?? "").split(",").pop()?.trim() ?? "";
  return last || "unknown";
}

// The lease door's width when there is no rate limit binding: the same
// figures as `ratelimits` in wrangler.jsonc, kept per isolate, which on
// one celld node is the whole relay.
export const LEASES_PER_IP_MINUTE = 5;
export const LEASES_PER_MINUTE = 60;
const leaseBuckets = new Map<string, Bucket>();
let leasesAll: Bucket | null = null;

// leaseAllowed spends one lease from the address's allowance and from
// everyone's: Cloudflare's rate limit bindings where they exist, token
// buckets in memory where they do not.
export async function leaseAllowed(env: Pick<Env, "LEASE_LIMIT_IP" | "LEASE_LIMIT_ALL">, ip: string): Promise<boolean> {
  if (env.LEASE_LIMIT_IP && env.LEASE_LIMIT_ALL) {
    const [perIP, all] = await Promise.all([env.LEASE_LIMIT_IP.limit({ key: ip }), env.LEASE_LIMIT_ALL.limit({ key: "all" })]);
    return perIP.success && all.success;
  }
  if (leaseBuckets.size > 10_000) leaseBuckets.clear();
  let b = leaseBuckets.get(ip);
  if (!b) {
    b = new Bucket(LEASES_PER_IP_MINUTE);
    leaseBuckets.set(ip, b);
  }
  leasesAll ??= new Bucket(LEASES_PER_MINUTE);
  const mine = b.take() === "";
  const everyone = leasesAll.take() === "";
  return mine && everyone;
}

// hostnameKnown says whether a hostname is one of ours: the apex, a valid
// or reserved name under it (a reserved one redirects to the apex, which
// needs a certificate too), or a custom hostname in the map. A proxy that
// issues certificates on demand asks this before it asks a certificate
// authority, so a stranger cannot make it request certificates for junk.
export async function hostnameKnown(env: Pick<Env, "DOMAIN" | "HOSTS">, raw: string): Promise<boolean> {
  const host = raw.toLowerCase().replace(/\.$/, "");
  const domain = env.DOMAIN.toLowerCase();
  if (host === domain || host === "www." + domain) return true;
  if (host.endsWith("." + domain)) {
    const name = host.slice(0, -(domain.length + 1));
    return validName(name) || RESERVED.has(name);
  }
  return host !== "" && (await customHost(env, host)) !== null;
}
