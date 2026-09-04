---
title: Costs and margins
audience: developer
---

# Costs and margins

What a relay costs the host, what fuel charges for it, and how to keep the two apart as the bitcoin price moves. The numbers come from one script:

```
npm run margin                     # today's price
npm run margin -- --btc 60000      # a price you pick
npm run margin -- --relays 5000    # the deployment at that size
```

It prints markdown and exits with code 1 when any priced line is under the target margin. A GitHub Actions workflow runs it every Monday, puts the tables in the run summary and opens or refreshes one issue when a line is under target.

## The model

Fuel prices four things because Cloudflare bills four things: SQLite storage, R2 storage, Durable Object duration and rows written. Each fuel price is a sats figure in `wrangler.jsonc`. Each Cloudflare price is a dollar figure on their pricing pages, copied into the script with the date it was checked. The bitcoin price joins the two.

For a line with cost `c` dollars per unit and price `p` sats per unit at `B` dollars per bitcoin, revenue per unit is `p / 1e8 * B` and margin is `1 - c / revenue`. The margin target is 33% of revenue, which is a 1.5x markup on cost. The floor is 20%. Under the target the weekly run flags it; under the floor, reprice.

Because prices are in sats and costs in dollars, margins move with the exchange rate on their own. A rising bitcoin widens them. A falling one narrows them, and the script prints, for each line, the bitcoin price under which the target no longer holds and the price under which the floor breaks.

## The lines, checked Sept. 3, 2026

At $81,500 per bitcoin:

| Line | Cloudflare | Fuel | Margin | Target holds above |
|---|---|---|---|---|
| Events stored | $0.20 per GB-month | 400 sats | 39% | $74,600 |
| Files stored | $0.015 per GB-month | 30 sats | 39% | $74,600 |
| Time awake | $0.0058 per hour | 11 sats | 36% | $78,200 |
| Rows written | $1.00 per million | 2,000 sats | 39% | $74,600 |

Time awake is an hour of a Durable Object held in memory at 128 MB, which Cloudflare bills as 460.8 GB-seconds. Hibernating objects are not billed, which is why an idle relay costs nothing.

## The free tier

A relay that spends its whole allowance costs the host about $0.87 a month. Time awake is most of it. Storage is nearly free at these sizes. The rows allowance was a million until Sept. 2026, which made it $1.00 of a $1.61 tier; it came down to 250,000, about 15 times what a personal relay writes, because rows are the one line Cloudflare charges real money per unit.

| Allowance | Amount | Cost |
|---|---|---|
| Events stored | 100 MB | $0.02 |
| Files stored | 1 GB | $0.015 |
| Time awake | 100 hours | $0.58 |
| Rows written | 250,000 | $0.25 |

Few relays get near the allowance. A typical personal relay, 20 MB of events, 100 MB of files, eight hours awake and 100,000 rows a month, costs about 15 cents once the plan's included quotas are used up, and those quotas cover the first few dozen relays outright.

## The deployment

The script projects a fleet from two shapes, a typical relay and a heavy one that passes its allowances and pays fuel, at a chosen share of heavy relays. At 1,000 relays and 5% heavy, the Cloudflare bill is about $420 a month, fuel brings in about $280, and the gap is the free tier. Rows written are the largest line on the bill, then duration, then object requests, which nobody pays for because traffic is free to relays.

Two things follow. The free tier is a cost the paid relays and the host share, and its size is the lever: `FREE_ROWS_WRITTEN` is the expensive allowance. And the unpriced lines, requests above all, are real; the 33% target exists to absorb them, which is why the target is not lower.

## Weekly

The workflow is `.github/workflows/margin.yml`. Read the summary. When a line is flagged:

1. Run the script locally to see the suggested prices for the target at today's rate.
2. Change the `SATS_PER_*` values in `wrangler.jsonc`. The comment above them records the rate they were set at; update it.
3. Deploy. Fuel meters are unchanged; only the price of what is over the allowance moves, from the next charge.

Prices go up when bitcoin falls. When it rises, do nothing until a line has sat above twice the target for a month, then bring it down. Relay owners see prices on the front page and on their Fuel section, so every change is visible the moment it deploys.
