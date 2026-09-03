// The relay card: something a name can be linked to from a profile.
//
//   GET /card.json   the facts: name, owner, members, rules, fuel, naddr
//   GET /card.nostr  the same facts as a kind 30078 signed by the relay key
//   GET /card.svg    an open graph sized picture with a QR of the naddr
//   GET /qr.svg      any short text as a QR, for the console
//
// Cards are public and cached for five minutes. Unclaimed and leased relays
// get a smaller card that says so.
import { naddrEncode } from "nostr-tools/nip19";
import { svg as qrSVG, encode as qrEncode } from "./qr.ts";
import { KIND_GROUP_METADATA } from "./identity.ts";
import { escapeHTML } from "./ui.ts";
import type { Relay } from "./relay.ts";

export const KIND_APP_DATA = 30078;
export const CARD_D = "bind.ws/card";
export const QR_MAX_BYTES = 512;
const CACHE = "public, max-age=300";

export interface Card {
  name: string;
  state: "unclaimed" | "leased" | "claimed";
  url: string; // wss
  console: string;
  claim?: string;
  expires_at?: number;
  description?: string;
  icon?: string;
  owner?: string;
  self?: string;
  members?: number; // only when the directory is public
  reads?: "open" | "auth" | "members";
  writes?: "open" | "allowlist" | "owner";
  fuel?: "allowance" | "burning" | "out";
  naddr?: string;
  signed_url?: string;
  image?: string;
}

export function cardData(relay: Relay, host: string): Card {
  const p = relay.settings.policy;
  const s = relay.settings;
  const url = relay.relayURL(host);
  const web = relay.webURL(host);
  const base = { name: p.name || relay.slug, url, console: web + "/" };
  if (s.isUnclaimed()) return { ...base, state: "unclaimed", claim: web + "/" };
  if (s.isLeased()) return { ...base, state: "leased", expires_at: p.lease?.until, claim: web + "/" };
  const f = relay.fuelStatus();
  const over = f.eventBytes > f.freeEventBytes || f.mediaBytes > f.freeMediaBytes || f.activeMs > f.freeActiveMs || f.rowsWritten > f.freeRowsWritten;
  const self = relay.identity.pubkey;
  const card: Card = {
    ...base,
    state: "claimed",
    description: p.description,
    owner: p.owner,
    reads: p.reads,
    writes: p.writes,
    fuel: f.outOfFuel ? "out" : over ? "burning" : "allowance",
    signed_url: web + "/card.nostr",
    image: web + "/card.svg",
  };
  if (p.icon) card.icon = p.icon;
  if (self) {
    card.self = self;
    card.naddr = naddrEncode({ kind: KIND_GROUP_METADATA, pubkey: self, identifier: relay.slug, relays: [url] });
  }
  if (p.directoryPublic) card.members = s.members().length;
  return card;
}

export function card(relay: Relay, req: Request): Response {
  const url = new URL(req.url);
  const headers = (type: string) => ({ "content-type": type, "cache-control": CACHE, "access-control-allow-origin": "*" });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: headers("application/json") });
  if (url.pathname === "/qr.svg") {
    const text = url.searchParams.get("text") ?? "";
    const bytes = new TextEncoder().encode(text);
    if (bytes.length === 0) return json({ error: "invalid: text is required" }, 400);
    if (bytes.length > QR_MAX_BYTES) return json({ error: `invalid: at most ${QR_MAX_BYTES} bytes` }, 413);
    return new Response(qrSVG(bytes, { margin: 2 }), { headers: headers("image/svg+xml") });
  }
  const data = cardData(relay, url.host);
  if (url.pathname === "/card.json") return json(data);
  if (url.pathname === "/card.nostr") {
    if (data.state !== "claimed") return json({ error: "restricted: this relay has no owner to sign for it" }, 404);
    return json(relay.identity.sign(KIND_APP_DATA, [["d", CARD_D]], JSON.stringify(data)));
  }
  if (url.pathname === "/card.svg") return new Response(cardSVG(data), { headers: headers("image/svg+xml") });
  return new Response("not found", { status: 404 });
}

// wrap breaks text into at most `lines` lines of about `width` characters.
function wrap(text: string, width: number, lines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!w) continue;
    if ((cur + " " + w).trim().length > width) {
      if (cur) out.push(cur);
      cur = w;
      if (out.length === lines) break;
    } else cur = (cur + " " + w).trim();
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length > lines) out.length = lines;
  if (words.join(" ").length > out.join(" ").length && out.length) out[out.length - 1] = out[out.length - 1].replace(/\s?\S*$/, "") + "…";
  return out;
}

// cardSVG is 600 by 315, the open graph size, in the console's colours.
export function cardSVG(c: Card): string {
  const ink = "#1c1b18", paper = "#fffdf9", ink2 = "#625e56", forest = "#2f6b45", sun = "#f2d16b", red = "#b8442f";
  const sans = "Instrument Sans, system-ui, sans-serif", mono = "DM Mono, ui-monospace, monospace";
  const e = escapeHTML;
  const title = wrap(c.name, 22, 1)[0] ?? c.name;
  let lines: string[];
  let facts: string;
  if (c.state === "unclaimed") {
    lines = ["Nobody owns this relay yet.", "Claim it with one signature."];
    facts = "unclaimed";
  } else if (c.state === "leased") {
    const day = c.expires_at ? new Date(c.expires_at * 1000).toISOString().slice(0, 10) : "";
    lines = ["A temporary relay, open to everyone", `until ${day}. Claim it to keep it.`];
    facts = "temporary";
  } else {
    lines = wrap(c.description || "A nostr relay on bind.ws.", 46, 2);
    const parts = [
      c.members !== undefined ? `${c.members} ${c.members === 1 ? "member" : "members"}` : "",
      c.writes === "open" ? "anyone writes" : c.writes === "allowlist" ? "members write" : "owner writes",
      c.reads === "open" ? "anyone reads" : c.reads === "auth" ? "sign in to read" : "members read",
      c.fuel === "out" ? "out of fuel" : c.fuel === "burning" ? "burning sats" : "on free allowance",
    ].filter(Boolean);
    facts = parts.join("  |  ");
  }
  const qr = c.naddr ? qrEncode(c.naddr) : null;
  let qrSVGInner = "";
  if (qr) {
    const cell = 150 / qr.size;
    let d = "";
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y * qr.size + x]) d += `M${(x * cell).toFixed(2)} ${(y * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
    qrSVGInner = `<g transform="translate(418 58)"><rect x="-10" y="-10" width="170" height="170" rx="10" fill="#fff" stroke="${ink}" stroke-width="2"/><path d="${d}" fill="${ink}" shape-rendering="crispEdges"/></g><text x="503" y="248" text-anchor="middle" font-family="${mono}" font-size="11" fill="${ink2}">group naddr</text>`;
  }
  const fuelColor = c.fuel === "out" ? red : c.fuel === "burning" ? sun : forest;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="315" viewBox="0 0 600 315" role="img" aria-label="${e(c.name)} on bind.ws">
<rect width="600" height="315" fill="${paper}"/>
<rect x="6" y="6" width="588" height="303" rx="18" fill="none" stroke="${ink}" stroke-width="3"/>
<circle cx="40" cy="44" r="9" fill="${fuelColor}" stroke="${ink}" stroke-width="2"/>
<text x="58" y="50" font-family="${sans}" font-weight="700" font-size="30" fill="${ink}">${e(title)}</text>
<text x="40" y="96" font-family="${sans}" font-size="17" fill="${ink2}">${e(lines[0] ?? "")}</text>
<text x="40" y="120" font-family="${sans}" font-size="17" fill="${ink2}">${e(lines[1] ?? "")}</text>
<text x="40" y="176" font-family="${mono}" font-size="13" fill="${forest}">${e(facts)}</text>
<text x="40" y="262" font-family="${mono}" font-size="15" fill="${ink}">${e(c.url)}</text>
<text x="40" y="286" font-family="${sans}" font-size="12" fill="${ink2}">a bind.ws relay</text>
${qrSVGInner}
</svg>`;
}
