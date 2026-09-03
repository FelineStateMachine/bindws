// Worker entry: maps <name>.<DOMAIN> to that relay's Durable Object, serves
// the apex, and forwards everything else untouched (websocket upgrades
// included) so the object can answer.
import { Relay, type Env } from "./relay.ts";
import { landing } from "./landing.ts";
import { FAVICON_SVG } from "./ui.ts";
import { verifyNIP98 } from "./manage.ts";
import { leaseNames, leaseDays, validName } from "./names.ts";
import { now } from "./event.ts";

export { Relay };
export { NAME_RE, RESERVED, validName } from "./names.ts";

// lease hands out a temporary relay at a memorable name: open to everyone
// for a while, wiped after unless claimed. Anyone may ask, no key needed;
// a NIP-98 signature reserves the claim for that key. For scripts, agents
// and the button on the front page alike.
async function lease(req: Request, env: Env, apex: URL): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: cors });
  // Each lease is an object with storage, so the door is narrow: a few per
  // address per minute, and a ceiling for everyone together.
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const [perIP, all] = await Promise.all([env.LEASE_LIMIT_IP.limit({ key: ip }), env.LEASE_LIMIT_ALL.limit({ key: "all" })]);
  if (!perIP.success || !all.success) return json({ error: "rate-limited: too many leases, try again in a minute" }, 429);
  const body = await req.text();
  let holder = "";
  const authz = req.headers.get("authorization");
  if (authz) {
    const auth = verifyNIP98(authz, req.url, req.method, body);
    if (typeof auth === "string") return json({ error: auth }, 401);
    holder = auth.pubkey;
  }
  const days = leaseDays(env);
  const until = now() + days * 86400;
  // wrangler dev serves the apex at <domain>.localhost; relays are <name>.localhost.
  const dev = apex.hostname !== env.DOMAIN.toLowerCase() && apex.hostname !== "www." + env.DOMAIN.toLowerCase();
  const suffix = dev ? ".localhost" + (apex.port ? ":" + apex.port : "") : "." + env.DOMAIN;
  for (const name of leaseNames()) {
    const host = name + suffix;
    const err = await env.RELAY.getByName(name).lease(name, host, until, holder);
    if (err) continue;
    return json({
      name,
      url: (dev ? "ws://" : "wss://") + host,
      console: (dev ? "http://" : "https://") + host + "/",
      expires_at: until,
      days,
      holder: holder || undefined,
      claim: `Open the console or send a NIP-86 "claim" signed with NIP-98 before it expires. Once claimed it is yours for good, events and files included; the console then offers to reset the rules to the defaults.`,
    }, 201);
  }
  return json({ error: "error: no free name found, try again" }, 503);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    const domain = env.DOMAIN.toLowerCase();
    let name: string | null;
    if (host === domain || host === "www." + domain || host === domain + ".localhost") name = null; // apex (<domain>.localhost in wrangler dev)
    else if (host.endsWith("." + domain)) name = host.slice(0, -(domain.length + 1));
    else if (host.endsWith(".localhost")) name = host.slice(0, -".localhost".length); // wrangler dev: <name>.localhost
    else name = env.DEV_RELAY; // wrangler dev without a subdomain, previews, custom hostnames

    if (name === null) {
      if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      if (url.pathname === "/lease" && req.method === "POST") return lease(req, env, url);
      if (url.pathname === "/lease" && req.method === "OPTIONS") {
        return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS" } });
      }
      return landing(req, env);
    }
    if (!validName(name) || name.includes(".")) {
      return Response.redirect(`https://${domain}/?bad=${encodeURIComponent(name)}`, 302);
    }
    const stub = env.RELAY.getByName(name);
    const headers = new Headers(req.headers);
    headers.set("x-relay-name", name);
    return stub.fetch(new Request(req, { headers }));
  },
} satisfies ExportedHandler<Env>;
