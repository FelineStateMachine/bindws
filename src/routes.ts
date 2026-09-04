// The HTTP doors of a relay, in the order they are tried. A door marked
// gated writes or reads events or files, so a blocked address is refused at
// it; the page, NIP-11 and management stay reachable, so an owner who
// blocked their own address can undo it. The websocket upgrade is the one
// door relay.ts answers itself, before this table.
import { grasp, isGitPath } from "./grasp.ts";
import type { Relay } from "./relay.ts";
import { featureOn, type Feature } from "./settings.ts";
import { now } from "./event.ts";
import { manage } from "./manage.ts";
import { bridge } from "./bridge.ts";
import { nip11 } from "./nip11.ts";
import { nip05Document } from "./nip05.ts";
import { isWebAddressRequest, webAddress } from "./nipad.ts";
import { verifyNIP98, whoAsks } from "./auth.ts";
import { checkInvite, claimInviteRequest, invitePage, termsPage } from "./invites.ts";
import { dumpDownload } from "./dumps.ts";
import { serveView } from "./views.ts";
import { importUpload } from "./imports.ts";
import { blossom, isBlobPath } from "./blossom.ts";
import { nip96 } from "./nip96.ts";
import { fuelInvoice } from "./fuel.ts";
import { card } from "./card.ts";
import { isPagePath, pages } from "./pages.ts";
import { dashboard } from "./dashboard.ts";
import { SIGNER_JS } from "./gen/signer.ts";
import { FAVICON_SVG } from "./ui.ts";

export interface Route {
  // when says whether this door answers the request.
  when: (url: URL, req: Request) => boolean;
  // A door that writes or reads events or files: refused to a blocked address.
  gated?: true;
  // The feature the door belongs to; switched off, the door is not there.
  feature?: Feature;
  answer: (relay: Relay, req: Request, url: URL) => Response | Promise<Response>;
}

const CORS = { "access-control-allow-origin": "*" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const is = (...paths: string[]) => (url: URL) => paths.includes(url.pathname);
const under = (prefix: string) => (url: URL) => url.pathname.startsWith(prefix);
const get = (when: (url: URL) => boolean) => (url: URL, req: Request) => req.method === "GET" && when(url);
const post = (when: (url: URL) => boolean) => (url: URL, req: Request) => req.method === "POST" && when(url);
export const isManagementRequest = (req: Request) => req.method === "POST" && (req.headers.get("content-type")?.includes("application/nostr+json+rpc") ?? false);

export const ROUTES: Route[] = [
  { when: isGitPath, gated: true, answer: grasp },
  // Explicit path discovery wins over content negotiation, independently
  // of member names. The handler applies each target's visibility policy.
  { when: isWebAddressRequest, gated: true, answer: webAddress },
  // NIP-11, after explicit discovery, by the accept header.
  {
    when: (_, req) => req.headers.get("accept")?.includes("application/nostr+json") ?? false,
    answer: (relay, _, url) => Response.json(nip11(relay, url.host), { headers: { "content-type": "application/nostr+json", ...CORS } }),
  },
  // NIP-86 management, by the content type.
  { when: (_, req) => isManagementRequest(req), answer: manage },
  // The HTTP bridge (bridge.ts).
  { when: post(is("/events", "/query", "/count")), gated: true, answer: bridge },
  // NIP-05 names, under the read rule for whoever asks.
  {
    when: is("/.well-known/nostr.json"),
    feature: "names",
    answer: (relay, req, url) => {
      const who = whoAsks(req, "", null);
      if (typeof who === "string") return json({ error: who }, 401);
      return json(nip05Document(relay.settings, url.searchParams.get("name"), relay.relayURL(url.host), who.pubkeys));
    },
  },
  // The directory, for the console: names and roles when the asker may list them.
  {
    when: get(is("/people")),
    answer: (relay, req, url) => {
      const p = relay.settings.policy;
      const who = whoAsks(req, "", null);
      if (typeof who === "string") return json({ error: who }, 401);
      const listed = p.owner !== "" && relay.settings.mayList(who.pubkeys) === "";
      const people = listed ? relay.settings.members().map((m) => ({ pubkey: m.pubkey, role: m.role, name: m.name })) : [];
      return json({ public: p.directoryPublic, self: relay.identity.pubkey, host: url.host, people });
    },
  },
  // Invites (invites.ts): the terms, the invite page, the join policy, the claim.
  {
    when: get(is("/terms")),
    answer: (relay, _, url) => {
      const terms = relay.settings.policy.joinTerms;
      if (!terms) return new Response("this relay has no terms", { status: 404 });
      return html(termsPage(relay.settings.policy.name || relay.slug, url.host, terms));
    },
  },
  {
    when: get(under("/invite/")),
    answer: (relay, _, url) => {
      const code = url.pathname.slice(8);
      const status = relay.settings.policy.owner === "" ? "invite_invalid" : checkInvite(relay.sql, code, now());
      return html(invitePage(relay.settings.policy.name || relay.slug, url.host, code, status, relay.settings.policy.joinTerms));
    },
  },
  { when: get(is("/api/join-policy")), answer: (relay) => json({ terms: relay.settings.policy.joinTerms }) },
  { when: post(is("/api/invites/claim")), gated: true, answer: claimInviteRequest },
  // Dumps, views, imports (dumps.ts, views.ts, imports.ts).
  { when: get(under("/dumps/")), answer: dumpDownload },
  { when: get(under("/view/")), answer: (relay, req) => serveView(relay, req, verifyNIP98) },
  { when: (url, req) => req.method === "PUT" && url.pathname === "/import", answer: importUpload },
  // Files: Blossom on its paths (blossom.ts), NIP-96 on its own (nip96.ts).
  { when: (url) => is("/upload", "/mirror", "/report")(url) || under("/list/")(url) || isBlobPath(url.pathname), gated: true, feature: "files", answer: blossom },
  { when: (url) => is("/.well-known/nostr/nip96.json", "/nip96")(url) || under("/nip96/")(url), feature: "files", answer: nip96 },
  // Fuel: meters and prices for anyone who might top up (who paid is the
  // owner's, in the stats method), and the invoice door (fuel.ts).
  { when: get(is("/fuel")), answer: (relay) => json(relay.fuelStatus()) },
  { when: post(is("/fuel/invoice")), gated: true, answer: fuelInvoice },
  // The card (card.ts).
  { when: is("/card.json", "/card.nostr", "/card.svg", "/qr.svg"), answer: card },
  // CORS preflight for everything above.
  { when: (_, req) => req.method === "OPTIONS", answer: () => new Response(null, { headers: { ...CORS, "access-control-allow-headers": "authorization, content-type, accept", "access-control-allow-methods": "GET, POST, OPTIONS" } }) },
  // Notes and articles as pages, the feed (pages.ts).
  { when: (url, req) => req.method === "GET" && isPagePath(url.pathname), feature: "pages", answer: pages },
  // The relay's own page (dashboard.ts) and what it loads.
  { when: is("/"), answer: () => html(dashboard()) },
  { when: is("/signer.js"), answer: () => new Response(SIGNER_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=604800, immutable" } }) },
  { when: is("/favicon.svg", "/favicon.ico"), answer: () => new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } }) },
];

// isGated says whether the request is at a door a blocked address may not use.
export function isGated(url: URL, req: Request): boolean {
  return ROUTES.some((r) => r.gated && r.when(url, req));
}

// route answers the request at the first door that takes it, or 404.
export function route(relay: Relay, req: Request, url: URL): Response | Promise<Response> {
  for (const r of ROUTES) {
    if (r.feature && !featureOn(relay.settings.policy, r.feature)) continue;
    if (r.when(url, req)) return r.answer(relay, req, url);
  }
  return new Response("not found", { status: 404 });
}
