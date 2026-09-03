// Worker entry: maps <name>.<DOMAIN> to that relay's Durable Object, serves
// the apex, and forwards everything else untouched (websocket upgrades
// included) so the object can answer.
import { Relay, type Env } from "./relay.ts";
import { landing } from "./landing.ts";
import { FAVICON_SVG } from "./ui.ts";

export { Relay };

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
export const RESERVED = new Set(["www", "api", "admin", "app", "mail", "relay", "relays", "gateway", "static", "cdn", "status", "docs", "help", "support", "abuse", "root", "ns1", "ns2", "smtp", "imap", "ftp"]);

export function validName(name: string): boolean {
  return NAME_RE.test(name) && name.length >= 3 && !RESERVED.has(name);
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
