// Fuel prices against what Cloudflare bills, at today's bitcoin price.
//
//   node scripts/margin.mjs                 tables, markdown
//   node scripts/margin.mjs --btc 77000     at a given price
//   node scripts/margin.mjs --target 0.4    a different margin target
//   node scripts/margin.mjs --relays 500    the deployment projection at that count
//
// Exit code 1 when a priced line sits below the target margin, so a weekly
// run can raise a flag. Cloudflare rates are list prices for Workers Paid,
// copied from the pricing pages on the date noted; revisit them with the
// prices in wrangler.jsonc.
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"] : [])).filter((x) => x.length));
const TARGET = Number(args.target ?? 0.33); // margin on revenue: 0.33 is a 1.5x markup
const FLOOR = Number(args.floor ?? 0.2); // below this, reprice now

// Cloudflare list prices, Workers Paid, USD. Checked 2026-09-03 against
// developers.cloudflare.com/{durable-objects/platform,r2,workers/platform}/pricing.
const CF = {
  base: 5, // per month, the plan itself
  doRequestsPerM: 0.15, doRequestsIncluded: 1e6, // HTTP, RPC, websocket messages, alarms
  doDurationPerMGBs: 12.5, doDurationIncluded: 400_000, doMemoryGB: 0.128,
  rowsWrittenPerM: 1.0, rowsWrittenIncluded: 50e6,
  rowsReadPerM: 0.001, rowsReadIncluded: 25e9,
  sqlGBMonth: 0.2, sqlIncludedGB: 5,
  r2GBMonth: 0.015, r2IncludedGB: 10,
  r2ClassAPerM: 4.5, r2ClassAIncluded: 1e6, r2ClassBPerM: 0.36, r2ClassBIncluded: 10e6,
  workerRequestsPerM: 0.3, workerRequestsIncluded: 10e6,
  kvReadsPerM: 0.5, kvReadsIncluded: 10e6,
};

// The relay's own numbers, from wrangler.jsonc (comments stripped).
const cfg = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
const v = cfg.vars;
const num = (k) => Number(v[k]);
const GBS_PER_HOUR = 3600 * CF.doMemoryGB; // 460.8 GB-s per hour awake at 128 MB

async function btcPrice() {
  if (args.btc) return Number(args.btc);
  for (const [url, pick] of [
    ["https://mempool.space/api/v1/prices", (j) => j.USD],
    ["https://api.coinbase.com/v2/prices/BTC-USD/spot", (j) => Number(j.data.amount)],
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const p = pick(await r.json());
      if (p > 0) return p;
    } catch {
      /* next source */
    }
  }
  throw new Error("no bitcoin price; pass --btc");
}

const btc = await btcPrice();
const usdToSats = (usd) => (usd / btc) * 1e8;
const satsToUsd = (s) => (s / 1e8) * btc;
const pct = (x) => (x * 100).toFixed(0) + "%";
const money = (x) => (x < 0 ? "-" : "") + "$" + (Math.abs(x) < 0.1 ? Math.abs(x).toFixed(4) : Math.abs(x).toFixed(2));
const amount = (x, unit) => (unit === "GB" && x < 1 ? `${Math.round(x * 1024)} MB` : `${x} ${unit}`);
const n = (x) => Math.round(x).toLocaleString("en-US");

// The four priced lines: what one unit costs us, what we charge.
const lines = [
  { name: "events stored", unit: "GB-month", cost: CF.sqlGBMonth, price: num("SATS_PER_GB_MONTH_EVENTS"), key: "SATS_PER_GB_MONTH_EVENTS", free: num("FREE_EVENTS_MB") / 1024, freeUnit: "GB" },
  { name: "files stored", unit: "GB-month", cost: CF.r2GBMonth, price: num("SATS_PER_GB_MONTH_MEDIA"), key: "SATS_PER_GB_MONTH_MEDIA", free: num("FREE_MEDIA_MB") / 1024, freeUnit: "GB" },
  { name: "time awake", unit: "hour", cost: (GBS_PER_HOUR / 1e6) * CF.doDurationPerMGBs, price: num("SATS_PER_ACTIVE_HOUR"), key: "SATS_PER_ACTIVE_HOUR", free: num("FREE_ACTIVE_HOURS"), freeUnit: "hours" },
  { name: "rows written", unit: "million", cost: CF.rowsWrittenPerM, price: num("SATS_PER_MILLION_ROWS"), key: "SATS_PER_MILLION_ROWS", free: num("FREE_ROWS_WRITTEN") / 1e6, freeUnit: "million" },
];
for (const l of lines) {
  l.costSats = usdToSats(l.cost);
  l.revenue = satsToUsd(l.price);
  l.margin = 1 - l.cost / l.revenue;
  l.floorBtc = (l.cost * 1e8) / (l.price * (1 - TARGET)); // the price at which margin falls to the target
  l.repriceBtc = (l.cost * 1e8) / (l.price * (1 - FLOOR));
  l.suggest = Math.ceil(usdToSats(l.cost) / (1 - TARGET));
}

let out = [];
out.push(`# Fuel margins at $${n(btc)} per bitcoin`, "");
out.push(`Target margin ${pct(TARGET)} of revenue (a ${(1 / (1 - TARGET)).toFixed(2)}x markup). Reprice when a line falls under ${pct(FLOOR)}.`, "");
out.push("| Line | Cloudflare cost | Cost in sats | Our price | Margin | Target holds while BTC is above | Price for target today |");
out.push("|---|---|---|---|---|---|---|");
for (const l of lines) {
  const flag = l.margin < FLOOR ? " REPRICE" : l.margin < TARGET ? " low" : "";
  out.push(`| ${l.name} | ${money(l.cost)} per ${l.unit} | ${n(l.costSats)} sats | ${n(l.price)} sats | ${pct(l.margin)}${flag} | $${n(l.floorBtc)} | ${n(l.suggest)} sats |`);
}
out.push("");

// The free tier: what a relay that uses all of its allowance costs us.
const freeCost = lines.reduce((a, l) => a + l.free * l.cost, 0);
out.push("## The free tier", "");
out.push("A relay that spends its whole monthly allowance costs, before the plan's included quotas absorb any of it:", "");
out.push("| Allowance | Amount | Cost to us |");
out.push("|---|---|---|");
for (const l of lines) out.push(`| ${l.name} | ${amount(l.free, l.freeUnit)} | ${money(l.free * l.cost)} |`);
out.push(`| total | | ${money(freeCost)} (${n(usdToSats(freeCost))} sats) |`, "");
const coveredHours = CF.doDurationIncluded / GBS_PER_HOUR;
out.push(`The plan includes ${n(coveredHours)} awake hours, ${n(CF.rowsWrittenIncluded / 1e6)} million rows written, ${CF.sqlIncludedGB} GB of SQLite and ${CF.r2IncludedGB} GB of R2 a month before anything is billed. That covers about ${n(coveredHours / num("FREE_ACTIVE_HOURS"))} relays' worth of awake time, ${n(CF.rowsWrittenIncluded / num("FREE_ROWS_WRITTEN"))} relays' worth of rows, ${n(CF.sqlIncludedGB / (num("FREE_EVENTS_MB") / 1024))} relays' worth of events and ${n(CF.r2IncludedGB / (num("FREE_MEDIA_MB") / 1024))} relays' worth of files, if every relay used its whole allowance. Most do not.`, "");

// Lines nobody pays for: requests, reads, R2 operations, KV. Absorbed by margin.
out.push("## What is not priced", "");
out.push("Traffic is free to relays, but Cloudflare bills these. They come out of the margin on the four lines above.", "");
out.push("| Line | Cloudflare cost | Included per month |");
out.push("|---|---|---|");
out.push(`| Durable Object requests (every websocket message, HTTP request and alarm) | $${CF.doRequestsPerM} per million | ${n(CF.doRequestsIncluded)} |`);
out.push(`| Worker requests | $${CF.workerRequestsPerM} per million | ${n(CF.workerRequestsIncluded)} |`);
out.push(`| rows read | $${CF.rowsReadPerM} per million | ${n(CF.rowsReadIncluded / 1e9)} billion |`);
out.push(`| R2 writes (class A) | $${CF.r2ClassAPerM} per million | ${n(CF.r2ClassAIncluded)} |`);
out.push(`| R2 reads (class B) | $${CF.r2ClassBPerM} per million | ${n(CF.r2ClassBIncluded)} |`);
out.push(`| KV reads (custom domains) | $${CF.kvReadsPerM} per million | ${n(CF.kvReadsIncluded)} |`);
out.push(`| the plan | $${CF.base} | |`, "");

// A deployment projection: what N relays cost at a typical shape, and what the paid ones bring in.
const relays = Number(args.relays ?? 1000);
// Websocket messages count as object requests but never reach the Worker, so Worker requests are the HTTP door and page loads only.
const typical = { eventsGB: 0.02, mediaGB: 0.1, hours: 8, rowsM: 0.1, doReqM: 0.3, workerReqM: 0.01, rowsReadM: 5, r2AM: 0.002, r2BM: 0.02 };
const heavy = { eventsGB: 0.5, mediaGB: 3, hours: 200, rowsM: 3, doReqM: 5, workerReqM: 0.2, rowsReadM: 100, r2AM: 0.05, r2BM: 0.5 };
function bill(count, heavyShare) {
  const h = Math.round(count * heavyShare), t = count - h;
  const sum = (k) => t * typical[k] + h * heavy[k];
  const over = (x, inc) => Math.max(0, x - inc);
  const items = {
    "SQLite storage": over(sum("eventsGB"), CF.sqlIncludedGB) * CF.sqlGBMonth,
    "R2 storage": over(sum("mediaGB"), CF.r2IncludedGB) * CF.r2GBMonth,
    "DO duration": (over(sum("hours") * GBS_PER_HOUR, CF.doDurationIncluded) / 1e6) * CF.doDurationPerMGBs,
    "rows written": (over(sum("rowsM") * 1e6, CF.rowsWrittenIncluded) / 1e6) * CF.rowsWrittenPerM,
    "DO requests": (over(sum("doReqM") * 1e6, CF.doRequestsIncluded) / 1e6) * CF.doRequestsPerM,
    "Worker requests": (over(sum("workerReqM") * 1e6, CF.workerRequestsIncluded) / 1e6) * CF.workerRequestsPerM,
    "rows read": (over(sum("rowsReadM") * 1e6, CF.rowsReadIncluded) / 1e6) * CF.rowsReadPerM,
    "R2 operations": (over(sum("r2AM") * 1e6, CF.r2ClassAIncluded) / 1e6) * CF.r2ClassAPerM + (over(sum("r2BM") * 1e6, CF.r2ClassBIncluded) / 1e6) * CF.r2ClassBPerM,
    "the plan": CF.base,
  };
  // Revenue: only heavy relays pass an allowance; charge them for what they use past it.
  const overUse = (k, free, price) => h * Math.max(0, heavy[k] - free) * satsToUsd(price);
  const revenue = overUse("eventsGB", num("FREE_EVENTS_MB") / 1024, num("SATS_PER_GB_MONTH_EVENTS")) + overUse("mediaGB", num("FREE_MEDIA_MB") / 1024, num("SATS_PER_GB_MONTH_MEDIA")) + overUse("hours", num("FREE_ACTIVE_HOURS"), num("SATS_PER_ACTIVE_HOUR")) + overUse("rowsM", num("FREE_ROWS_WRITTEN") / 1e6, num("SATS_PER_MILLION_ROWS"));
  return { items, total: Object.values(items).reduce((a, b) => a + b, 0), revenue, heavy: h };
}
out.push(`## The deployment at ${n(relays)} relays`, "");
out.push(`A typical relay: ${Math.round(typical.eventsGB * 1024)} MB of events, ${Math.round(typical.mediaGB * 1024)} MB of files, ${typical.hours} hours awake, ${typical.rowsM * 1e6 / 1000}k rows written, ${typical.doReqM}M object requests a month. A heavy one: ${heavy.eventsGB * 1024} MB, ${heavy.mediaGB} GB, ${heavy.hours} hours, ${heavy.rowsM}M rows, ${heavy.doReqM}M requests. Heavy relays pass their allowances and pay fuel; typical ones ride free.`, "");
out.push("| Heavy share | Cloudflare bill | Fuel revenue | Net | Per relay |");
out.push("|---|---|---|---|---|");
for (const share of [0, 0.02, 0.05, 0.1]) {
  const b = bill(relays, share);
  out.push(`| ${pct(share)} (${n(b.heavy)} relays) | ${money(b.total)} | ${money(b.revenue)} | ${money(b.revenue - b.total)} | ${money(b.total / relays)} |`);
}
const b5 = bill(relays, 0.05);
out.push("", `Where the bill goes at 5% heavy: ` + Object.entries(b5.items).filter(([, x]) => x > 0.005).sort((a, b) => b[1] - a[1]).map(([k, x]) => `${k} ${money(x)}`).join(", ") + ".", "");

// Repricing guidance.
out.push("## Weekly check", "");
const worst = lines.reduce((a, l) => (l.margin < a.margin ? l : a));
out.push(`The thinnest line is ${worst.name} at ${pct(worst.margin)}. Its target holds while bitcoin stays above $${n(worst.floorBtc)}; under $${n(worst.repriceBtc)} it needs repricing.`, "");
out.push("To reprice at today's rate for the target margin, set in `wrangler.jsonc`:", "");
out.push("```");
for (const l of lines) out.push(`"${l.key}": "${l.suggest}"${l.suggest === l.price ? "" : `   // was ${l.price}`}`);
out.push("```", "");
out.push("Prices only go up in this model when bitcoin falls. When it rises, margins widen on their own, and the same table says by how much; lower them when the margin passes twice the target and the lines have been stable for a month.");

console.log(out.join("\n"));
process.exitCode = lines.some((l) => l.margin < TARGET) ? 1 : 0;
