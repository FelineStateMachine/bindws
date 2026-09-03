// The apex page: what bind.ws is, drawn as the system it is, with the
// datasheet under it. Every number comes from the same config the relay runs
// on, so the page cannot drift from the service.
import { MAX_MESSAGE, VERSION, type Env } from "./relay.ts";
import { leaseDays } from "./names.ts";
import { fuelConfig } from "./fuel.ts";
import { DEFAULT_POLICY } from "./settings.ts";
import { page, escapeHTML } from "./ui.ts";

const REPO = "https://github.com/FelineStateMachine/bindws";

const CSS = `
main { max-width: 68rem; padding-top: 2rem; }
.head { text-align: center; margin: 2rem 0 2.5rem; }
.head h1 { font-size: clamp(3rem, 8vw, 4.4rem); }
.head p { margin: 1rem auto 0; color: var(--ink-2); font-size: 1.1rem; }
.head .try { display: flex; gap: .8rem; align-items: center; justify-content: center; flex-wrap: wrap; margin-top: 1.4rem; font-size: 15px; }
.head .try .btn { box-shadow: 3px 3px 0 var(--ink); }
.map { display: grid; grid-template-columns: 1.25fr 1fr; gap: 2.5rem; align-items: start; }
.map > * { min-width: 0; }
.map .box { background: var(--paper); border: 2px solid var(--ink); border-radius: 12px; padding: 1rem; box-shadow: 4px 4px 0 var(--ink); }
svg { width: 100%; height: auto; display: block; user-select: none; -webkit-user-select: none; }
svg text { font: 12px var(--mono); fill: var(--ink); } svg text.k { fill: var(--forest); font-weight: 500; } svg text.d { fill: var(--ink-3); font-size: 11px; }
svg .n { fill: var(--paper); stroke: var(--ink); stroke-width: 2; } svg .sh { fill: var(--ink); } svg .e { stroke: var(--ink); stroke-width: 1.6; fill: none; }
.notes h3 { margin: 0 0 .3rem; font: 500 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
.notes p { margin: 0 0 1.2rem; color: var(--ink-2); max-width: 30rem; font-size: 15px; } .notes p b { color: var(--ink); }
.sheet h2 { font: 500 12px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; margin: 3rem 0 .6rem; display: flex; align-items: center; gap: .6rem; }
.sheet h2::after { content: ""; flex: 1; height: 1.5px; background: var(--ink); margin: 0; width: auto; border-radius: 0; transform: none; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font: 500 11px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); padding: .2rem .6rem .4rem 0; }
td { padding: .35rem .6rem .35rem 0; border-top: 1px solid var(--line); vertical-align: top; color: var(--ink-2); }
td:first-child { color: var(--ink); font-family: var(--mono); font-size: 13px; white-space: nowrap; } td.r, th.r { text-align: right; font-family: var(--mono); white-space: nowrap; color: var(--ink); }
.desc { color: var(--ink-2); max-width: 40rem; margin: .6rem 0 0; }
.foot { margin-top: 4rem; padding-top: 1rem; border-top: 1.5px solid var(--ink); font: 13px var(--mono); display: flex; justify-content: space-between; } .foot a { text-decoration: none; color: var(--ink-2); } .foot a:hover { color: var(--ink); }
::selection { background: var(--sun); color: var(--ink); }
@media (max-width: 60rem) { .map { grid-template-columns: 1fr; } }
@media (max-width: 44rem) {
  main { padding: 1.2rem 1rem 3rem; }
  table, tbody, tr, td { display: block; width: 100%; } thead { display: none; }
  tr { border-top: 1.5px solid var(--ink); padding: .6rem 0 .5rem; } tr:first-child { border-top: 0; }
  td { border: 0; padding: .12rem 0; display: grid; grid-template-columns: 6.5rem 1fr; gap: .6rem; align-items: baseline; text-align: left; white-space: normal; }
  td::before { content: attr(data-th); font: 500 10px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
  td:first-child { display: block; font-size: 14px; color: var(--ink); padding-bottom: .3rem; white-space: normal; } td:first-child::before { content: none; }
  td.r { text-align: left; } .sheet h2 { margin-top: 2.2rem; }
}
`;

const MAP = `<svg viewBox="0 0 640 470" role="img" aria-label="how a request reaches a relay on bind.ws">
<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1c1b18"/></marker></defs>
<rect class="sh" x="24" y="24" width="110" height="34" rx="10"/><rect class="n" x="20" y="20" width="110" height="34" rx="10"/><text class="" x="75.0" y="41.0" text-anchor="middle">damus</text><rect class="sh" x="154" y="24" width="110" height="34" rx="10"/><rect class="n" x="150" y="20" width="110" height="34" rx="10"/><text class="" x="205.0" y="41.0" text-anchor="middle">amethyst</text><rect class="sh" x="284" y="24" width="110" height="34" rx="10"/><rect class="n" x="280" y="20" width="110" height="34" rx="10"/><text class="" x="335.0" y="41.0" text-anchor="middle">nostrudel</text><rect class="sh" x="414" y="24" width="110" height="34" rx="10"/><rect class="n" x="410" y="20" width="110" height="34" rx="10"/><text class="" x="465.0" y="41.0" text-anchor="middle">a script</text>
<path class="e" d="M75 54v26M205 54v26M335 54v26M465 54v26"/><path class="e" d="M75 80H465"/><path class="e" d="M270 80v34" marker-end="url(#ar)"/>
<text class="d" x="282" y="104">wss, https</text>
<text class="k" x="270" y="132" text-anchor="middle">wss://kitchen.bind.ws</text>
<path class="e" d="M270 138v22" marker-end="url(#ar)"/>
<rect class="sh" x="204" y="164" width="140" height="34" rx="10"/><rect class="n" x="200" y="160" width="140" height="34" rx="10"/><text class="k" x="270.0" y="181.0" text-anchor="middle">worker</text><text class="d" x="350" y="181">host -&gt; object</text>
<path class="e" d="M270 194v26" marker-end="url(#ar)"/>
<rect class="sh" x="114" y="224" width="320" height="136" rx="14"/><rect class="n" x="110" y="220" width="320" height="136" rx="14"/>
<text class="k" x="126" y="244">durable object "kitchen"</text>
<text x="126" y="270">sqlite    events, tags, search, rules</text>
<text x="126" y="290">sockets   live subscriptions</text>
<text x="126" y="310">alarm     sweep, retention, fuel</text>
<text x="126" y="338" class="k">hibernates when idle</text>
<path class="e" d="M270 356v26" marker-end="url(#ar)"/>
<rect class="sh" x="224" y="390" width="100" height="34" rx="10"/><rect class="n" x="220" y="386" width="100" height="34" rx="10"/><text class="k" x="270.0" y="407.0" text-anchor="middle">r2</text><text class="d" x="330" y="407">blobs by sha256</text>
<text class="k" x="600" y="266" text-anchor="end">zap</text><text class="d" x="600" y="250" text-anchor="end">kind 9735</text><path class="e" d="M556 262H432" marker-end="url(#ar)"/>
<text class="k" x="600" y="330" text-anchor="end">leave</text><text class="d" x="600" y="314" text-anchor="end">nip-77</text><path class="e" d="M432 326H556" marker-end="url(#ar)"/>
</svg>`;

const NOTES = `<div class="notes">
<h3 id="o">durable object</h3><p>Each name has one object. The object holds the SQLite database and the relay's open sockets. The <b>owner</b> is the pubkey that signed the first <b>claim</b>. After the claim, all management is done via NIP-86 calls signed by that key. The relay page is a client of this API. The object leaves memory between frames. An idle relay has no cost.</p>
<h3 id="l">lease</h3><p>A lease is a relay at a name picked for you, open to everyone, for a fixed number of days. <b>POST /lease</b> returns one; no key needed. A claim before it expires keeps it, events and files included. After that, the object is wiped and the name is free again.</p>
<h3 id="f">fuel</h3><p>The relay measures four values: events stored, files stored, hours awake, rows written. Each value is a line on the hosting bill. Traffic is free. Below the allowance, you owe nothing. Above the allowance, a zap to the relay adds balance. The zap receipt is the record.</p>
<h3 id="x">leave</h3><p>NIP-77 sync copies all events to a different relay. Nothing on bind.ws is proprietary. You do not move anything else.</p>
</div>`;

const PROTOCOL: [string, string][] = [
  ["01", "Publish, subscribe, and query events. All clients use this."],
  ["09", "Delete your own events."],
  ["11", "The relay describes itself: limits, retention, owner, payment."],
  ["13", "The owner can require proof of work on events."],
  ["40", "Events with an expiration tag are removed at that time."],
  ["42", "Clients prove their key. Needed for private kinds and members-only reads."],
  ["45", "Count events without downloading them."],
  ["50", "Full-text search on notes, articles, profiles and comments."],
  ["17, 59", "Private messages are sent only to the sender and the recipient."],
  ["62", "Request to vanish: the relay deletes all your events and refuses older ones."],
  ["70", "Protected events are accepted only from their author, over an authenticated socket."],
  ["77", "Sync events with a different relay, in either direction."],
  ["86", "Manage the relay with signed JSON-RPC calls."],
  ["98", "Sign an HTTP request with your key. Used by claim, management, and the HTTP endpoints."],
  ["05", "Members with a name are you@name.bind.ws."],
  ["43", "The relay signs and publishes its member list."],
  ["57", "Zaps to the relay add fuel. The receipt is stored on the relay."],
  ["Blossom", "Upload and fetch files by hash on the same host. Check an upload before sending it, or mirror a file from a URL."],
];

function table(heads: string[], rows: string[][], right: number[] = []): string {
  const th = heads.map((h, i) => `<th${right.includes(i) ? ' class="r"' : ""}>${escapeHTML(h)}</th>`).join("");
  const tr = rows.map((r) => "<tr>" + r.map((c, i) => `<td data-th="${escapeHTML(heads[i])}"${right.includes(i) ? ' class="r"' : ""}>${c}</td>`).join("") + "</tr>").join("\n");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

export function landing(req: Request, env: Env): Response {
  const domain = escapeHTML(env.DOMAIN);
  const fuel = fuelConfig(env as unknown as Record<string, unknown>);
  const p = DEFAULT_POLICY;
  const n = (x: number) => x.toLocaleString("en-US");
  const bad = new URL(req.url).searchParams.get("bad");
  const days = leaseDays(env);
  const interfaces = table(["Endpoint", "Protocol", "Auth", "Notes"], [
    [`wss://&lt;name&gt;.${domain}`, "NIP-01, 42, 45, 77", "optional NIP-42", "Sockets hibernate. Negentropy sessions end when the object hibernates."],
    ["GET / (accept nostr+json)", "NIP-11", "none", "limitation, retention, payments_url, self"],
    ["POST /", "NIP-86", "NIP-98, owner", "claim and the management methods"],
    ["POST /lease", "lease", "optional NIP-98", `A temporary relay for ${leaseDays(env)} days. A signature reserves the claim for that key.`],
    ["POST /events /query /count", "HTTP bridge", "NIP-98", "The signer has the same access as an authenticated socket."],
    ["PUT /upload, GET /&lt;sha256&gt;", "Blossom", "kind 24242", "Stored in R2. Counted as files. HEAD /upload checks first; PUT /mirror copies from a URL."],
    ["GET /.well-known/nostr.json", "NIP-05", "none", "Members that have a name."],
    ["GET /fuel, POST /fuel/invoice", "NIP-57", "none", "Gauges are public. The invoice comes from a signed zap request."],
  ]);
  const limits = table(["Parameter", "Default", "Range"], [
    ["name", "3 to 32 of a-z 0-9 -", "some names are reserved"],
    ["max_message_length", `${n(MAX_MESSAGE)} bytes`, "fixed"],
    ["max_subscriptions", String(p.maxSubs), "1 to 200"],
    ["max_limit", String(p.maxLimit), "1 to 5,000"],
    ["eventsPerMinute / reqsPerMinute", `${p.eventsPerMinute} / ${p.reqsPerMinute} per connection`, "set by the owner"],
    ["maxBlobMB", String(p.maxBlobMB), "1 to 95"],
    ["min_pow_difficulty", String(p.minPow), "set by the owner"],
  ], [2]);
  const metering = table(["Line", "Backing cost", "Free / month", "Beyond"], [
    ["events stored", "DO SQLite", `${n(fuel.freeEventsMB)} MB`, `${n(fuel.satsPerGBMonthEvents)} sats/GB-mo`],
    ["files stored", "R2", `${n(fuel.freeMediaMB)} MB`, `${n(fuel.satsPerGBMonthMedia)} sats/GB-mo`],
    ["time awake", "DO duration", `${n(fuel.freeActiveHours)} h`, `${n(fuel.satsPerActiveHour)} sats/h`],
    ["rows written", "SQLite writes", n(fuel.freeRowsWritten), `${n(fuel.satsPerMillionRows)} sats/M`],
    ["traffic, rows read", "no cost", "unlimited", "free"],
  ], [2, 3]);
  const protocol = table(["NIP", "What it does here"], PROTOCOL.map(([a, b]) => [a, b.replace("name.bind.ws", `name.${domain}`)]));
  const body = `<main>
  <div class="head"><h1>${domain.replace(".", "<em>.</em>")}</h1><p>Relay on demand. Sign once, and it's yours.</p>${bad ? `<p class="note">"${escapeHTML(bad)}" is not a valid name. Use 3 to 32 lowercase letters, digits or hyphens.</p>` : ""}
  <p class="try"><button id="try" class="btn pri">Try one now</button><span id="trynote">A relay at a name picked for you, open to anyone for ${days} days. Claim it to keep it.</span></p></div>
  <div class="map"><div class="box">${MAP}</div>${NOTES}</div>
  <div class="sheet">
    <h2>Interfaces</h2>${interfaces}
    <h2>Limits</h2>${limits}
    <h2>Metering</h2>${metering}
    <p class="desc">Below the allowances, you owe nothing. Above an allowance with no balance, the relay is read-only. The relay does not delete data.</p>
    <h2>Protocol</h2>${protocol}
  </div>
  <footer class="foot"><a href="${REPO}">-&gt; github.com/FelineStateMachine/bindws</a><span class="muted">v${VERSION}</span></footer>
</main>
<script>
document.getElementById("try").onclick = async (ev) => {
  const b = ev.target, note = document.getElementById("trynote");
  b.disabled = true; note.textContent = "Finding a name…";
  try {
    const r = await fetch("/lease", { method: "POST" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "no relay today");
    location.href = j.console;
  } catch (e) { note.textContent = e.message; b.disabled = false; }
};
</script>`;
  return new Response(page(env.DOMAIN, body, CSS), { headers: { "content-type": "text/html; charset=utf-8" } });
}
