// A name is a site as well as a relay. Notes render at /e/<id>, articles at
// /a/<d> (the owner's) or /a/<author>/<d>, njump style, with Open Graph
// tags so links unfurl, and /feed.xml is an Atom feed of both. Only when
// anyone may read: a members-only relay renders nothing here.
import * as nip19 from "nostr-tools/nip19";
import { escapeHTML, page } from "./ui.ts";
import { now, tagValues, type Event } from "./event.ts";
import type { Filter } from "./filter.ts";
import type { Access } from "./store.ts";
import type { Relay } from "./relay.ts";

const PUBLIC: Access = { pubkeys: [] }; // never private kinds
const KINDS = [1, 30023];
const FEED_LIMIT = 50;
const HEX64 = /^[0-9a-f]{64}$/;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i;
const CACHE = "public, max-age=300";

export function isPagePath(path: string): boolean {
  return path === "/feed.xml" || path.startsWith("/e/") || path.startsWith("/a/");
}

export function pages(relay: Relay, req: Request): Response {
  const url = new URL(req.url);
  const origin = relay.relayURL(url.host).replace(/^ws/, "http");
  // Public relays, leased ones included, have pages; unclaimed ones have nothing to show.
  if (relay.settings.isUnclaimed()) return nothing(relay, "Nobody has claimed this relay yet.");
  if (relay.settings.policy.reads !== "open") return nothing(relay, "This relay's events are for its members.");
  if (url.pathname === "/feed.xml") return feed(relay, url, origin);
  const parts = url.pathname.split("/").filter(Boolean);
  let e: Event | null = null;
  if (parts[0] === "e" && parts.length === 2 && HEX64.test(parts[1])) e = one(relay, { ids: [parts[1]], kinds: KINDS, tags: {} });
  else if (parts[0] === "a" && parts.length === 2) e = one(relay, { kinds: [30023], authors: [relay.settings.policy.owner], tags: { d: [decodeURIComponent(parts[1])] } });
  else if (parts[0] === "a" && parts.length === 3) {
    const author = pubkeyOf(parts[1]);
    if (author) e = one(relay, { kinds: [30023], authors: [author], tags: { d: [decodeURIComponent(parts[2])] } });
  }
  if (!e) return nothing(relay, "Nothing by that name here.");
  return new Response(render(relay, e, origin), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": CACHE } });
}

function nothing(relay: Relay, why: string): Response {
  const body = `<main><h1>Not here</h1><p class="lead">${escapeHTML(why)}</p><footer class="pg"><p><a href="/">${escapeHTML(relay.settings.policy.name || relay.slug)}</a></p></footer></main>`;
  return new Response(page("not here", body, PAGE_CSS), { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": CACHE } });
}

function one(relay: Relay, f: Filter): Event | null {
  const r = relay.store.query({ ...f, limit: 1 }, PUBLIC, 1, now());
  return r.rows[0] ? (JSON.parse(r.rows[0]) as Event) : null;
}

function list(relay: Relay, f: Filter, limit: number): Event[] {
  return relay.store.query({ ...f, limit }, PUBLIC, limit, now()).rows.map((r) => JSON.parse(r) as Event);
}

function pubkeyOf(s: string): string {
  if (HEX64.test(s)) return s;
  try {
    const d = nip19.decode(s);
    if (d.type === "npub") return d.data;
    if (d.type === "nprofile") return d.data.pubkey;
  } catch {
    /* not bech32 */
  }
  return "";
}

// ---- what a thing is called ----

function firstLine(s: string): string {
  return s.trim().split("\n")[0].trim();
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

export function titleOf(e: Event): string {
  if (e.kind === 30023) return tagValues(e, "title")[0] || firstLine(e.content) || "untitled";
  return clip(firstLine(e.content) || "a note", 80);
}

export function summaryOf(e: Event): string {
  if (e.kind === 30023) {
    const s = tagValues(e, "summary")[0];
    if (s) return clip(s, 200);
  }
  return clip(e.content.replace(/https?:\/\/\S+/g, "").replace(/nostr:\S+/g, ""), 200);
}

function imageOf(e: Event): string {
  if (e.kind === 30023) {
    const i = tagValues(e, "image")[0];
    if (i) return i;
  }
  const m = /https?:\/\/[^\s<>"']+/g;
  let x: RegExpExecArray | null;
  while ((x = m.exec(e.content))) if (IMAGE_RE.test(x[0])) return x[0];
  return "";
}

function authorOf(relay: Relay, pubkey: string): string {
  const k0 = one(relay, { kinds: [0], authors: [pubkey], tags: {} });
  if (k0) {
    try {
      const p = JSON.parse(k0.content) as { name?: unknown; display_name?: unknown };
      const n = (typeof p.display_name === "string" && p.display_name.trim()) || (typeof p.name === "string" && p.name.trim());
      if (n) return n;
    } catch {
      /* bad profile */
    }
  }
  const m = relay.settings.member(pubkey);
  if (m?.name) return m.name;
  return nip19.npubEncode(pubkey).slice(0, 12) + "…";
}

function pathOf(relay: Relay, e: Event): string {
  if (e.kind === 30023) {
    const d = tagValues(e, "d")[0] ?? "";
    return e.pubkey === relay.settings.policy.owner ? `/a/${encodeURIComponent(d)}` : `/a/${nip19.npubEncode(e.pubkey)}/${encodeURIComponent(d)}`;
  }
  return `/e/${e.id}`;
}

function nostrURI(relay: Relay, e: Event, wsURL: string): string {
  if (e.kind === 30023) return "nostr:" + nip19.naddrEncode({ kind: e.kind, pubkey: e.pubkey, identifier: tagValues(e, "d")[0] ?? "", relays: [wsURL] });
  return "nostr:" + nip19.neventEncode({ id: e.id, author: e.pubkey, kind: e.kind, relays: [wsURL] });
}

// ---- content ----

// renderText escapes, links URLs, inlines images, and turns nostr:
// references into links here when the target is on this relay.
export function renderText(relay: Relay, text: string): string {
  const re = /(https?:\/\/[^\s<>"']+)|nostr:([a-z0-9]+)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += escapeHTML(text.slice(last, m.index));
    if (m[1]) {
      const u = m[1].replace(/[.,;:!?)\]]+$/, "");
      const trail = m[1].slice(u.length);
      out += IMAGE_RE.test(u) ? `<img src="${escapeHTML(u)}" alt="" loading="lazy">` : `<a href="${escapeHTML(u)}" rel="noopener nofollow">${escapeHTML(u)}</a>`;
      out += escapeHTML(trail);
    } else out += nostrLink(relay, m[2]);
    last = re.lastIndex;
  }
  out += escapeHTML(text.slice(last));
  return out
    .split(/\n{2,}/)
    .map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>")
    .join("");
}

function nostrLink(relay: Relay, bech: string): string {
  const uri = "nostr:" + bech;
  const label = escapeHTML(bech.slice(0, 12) + "…");
  try {
    const d = nip19.decode(bech);
    if (d.type === "note" || d.type === "nevent") {
      const id = d.type === "note" ? d.data : d.data.id;
      const e = one(relay, { ids: [id], kinds: KINDS, tags: {} });
      if (e) return `<a href="${pathOf(relay, e)}">${escapeHTML(titleOf(e))}</a>`;
    } else if (d.type === "naddr" && d.data.kind === 30023) {
      const e = one(relay, { kinds: [30023], authors: [d.data.pubkey], tags: { d: [d.data.identifier] } });
      if (e) return `<a href="${pathOf(relay, e)}">${escapeHTML(titleOf(e))}</a>`;
    } else if (d.type === "npub" || d.type === "nprofile") {
      const pk = d.type === "npub" ? d.data : d.data.pubkey;
      return `<a href="${escapeHTML(uri)}">@${escapeHTML(authorOf(relay, pk))}</a>`;
    }
  } catch {
    /* not a reference */
  }
  return `<a href="${escapeHTML(uri)}">${label}</a>`;
}

const PAGE_CSS = `
main { max-width: 44rem; padding-top: 6vh; }
.who { display: flex; align-items: center; gap: .6rem; color: var(--ink-2); margin-bottom: 1rem; } .who b { color: var(--ink); }
h1 { font-size: clamp(2rem, 6vw, 3.2rem); margin: .2rem 0 1rem; }
article { font-size: 1.05rem; line-height: 1.6; } article p { margin: 0 0 1rem; overflow-wrap: anywhere; }
article img { max-width: 100%; border-radius: 12px; border: 2px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); display: block; margin: .6rem 0; }
.hero { max-width: 100%; border-radius: 14px; border: 2px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); margin: 0 0 1.2rem; display: block; }
pre { white-space: pre-wrap; word-break: break-all; font: 12px var(--mono); background: var(--butter); border: 2px solid var(--ink); border-radius: 10px; padding: .8rem; }
.open { display: inline-flex; gap: .5rem; margin: 1.2rem 0; }
`;

function render(relay: Relay, e: Event, origin: string): string {
  const host = new URL(origin).host;
  const wsURL = relay.relayURL(host);
  const title = titleOf(e);
  const summary = summaryOf(e);
  const image = imageOf(e);
  const author = authorOf(relay, e.pubkey);
  const canonical = origin + pathOf(relay, e);
  const site = relay.settings.policy.name || relay.slug;
  const when = new Date(e.created_at * 1000).toISOString().slice(0, 10);
  const uri = nostrURI(relay, e, wsURL);
  const head = [
    `<meta property="og:site_name" content="${escapeHTML(site)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${escapeHTML(title)}">`,
    `<meta property="og:description" content="${escapeHTML(summary)}">`,
    `<meta property="og:url" content="${escapeHTML(canonical)}">`,
    image ? `<meta property="og:image" content="${escapeHTML(image)}">` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeHTML(title)}">`,
    `<meta name="twitter:description" content="${escapeHTML(summary)}">`,
    image ? `<meta name="twitter:image" content="${escapeHTML(image)}">` : "",
    `<meta name="author" content="${escapeHTML(author)}">`,
    `<link rel="canonical" href="${escapeHTML(canonical)}">`,
    `<link rel="alternate" type="application/atom+xml" title="${escapeHTML(site)}" href="${escapeHTML(origin)}/feed.xml">`,
  ]
    .filter(Boolean)
    .join("\n");
  const hue = (parseInt(e.pubkey.slice(0, 2), 16) * 360) / 256;
  const heading = e.kind === 30023 ? `<h1>${escapeHTML(title)}</h1>` + (image ? `<img class="hero" src="${escapeHTML(image)}" alt="">` : "") : "";
  const body = `<main class="post">
  <header class="who"><i class="av" style="--h:${hue.toFixed(0)}deg"></i><b>${escapeHTML(author)}</b><span>${when}</span><span class="muted">on ${escapeHTML(site)}</span></header>
  ${heading}
  <article>${renderText(relay, e.content)}</article>
  <p class="open"><a class="btn" href="${escapeHTML(uri)}">Open in a nostr client</a></p>
  <details class="disclosure"><summary>Raw event</summary><pre>${escapeHTML(JSON.stringify(e, null, 2))}</pre></details>
  <footer class="pg"><p><a href="/">${escapeHTML(site)}</a></p><a href="/feed.xml">feed</a></footer>
</main>`;
  return page(`${title} - ${site}`, body, PAGE_CSS, head);
}

// ---- feed ----

function feed(relay: Relay, url: URL, origin: string): Response {
  const kindsParam = url.searchParams.get("kinds");
  const kinds = kindsParam ? kindsParam.split(",").map((k) => parseInt(k, 10)).filter((k) => KINDS.includes(k)) : KINDS;
  const author = url.searchParams.get("author") ?? "";
  const f: Filter = { kinds: kinds.length ? kinds : KINDS, tags: {} };
  if (HEX64.test(author)) f.authors = [author];
  const events = list(relay, f, FEED_LIMIT);
  const site = relay.settings.policy.name || relay.slug;
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const entries = events.map((e) => {
    const link = origin + pathOf(relay, e);
    const id = e.kind === 30023 ? `${e.kind}:${e.pubkey}:${tagValues(e, "d")[0] ?? ""}` : e.id;
    return `<entry>
  <id>urn:nostr:${escapeHTML(id)}</id>
  <title>${escapeHTML(titleOf(e))}</title>
  <link href="${escapeHTML(link)}"/>
  <updated>${iso(e.created_at)}</updated>
  <author><name>${escapeHTML(authorOf(relay, e.pubkey))}</name></author>
  <summary>${escapeHTML(summaryOf(e))}</summary>
  <content type="text">${escapeHTML(e.content)}</content>
</entry>`;
  });
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${escapeHTML(site)}</title>
<subtitle>${escapeHTML(relay.settings.policy.description)}</subtitle>
<id>${escapeHTML(origin)}/</id>
<link href="${escapeHTML(origin)}/"/>
<link rel="self" href="${escapeHTML(origin + url.pathname + url.search)}"/>
<updated>${iso(events[0]?.created_at ?? now())}</updated>
${entries.join("\n")}
</feed>`;
  return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": CACHE } });
}
