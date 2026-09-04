---
title: Understanding fuel
audience: user
---

# Understanding fuel

Your relay is free until it passes a monthly allowance. Past that, use is paid for in sats. Anyone can top up a relay by zapping it.

## What is measured

Four resource lines are measured and priced in fuel. Each mirrors a major line
on the hosting bill, while provider request charges and other deployment costs
remain outside the tenant meter.

| Measured | Free each month |
|---|---|
| Events stored | 100 MB |
| Files stored | 1 GB |
| Time awake | 100 hours |
| Rows written | 250,000 |

Traffic bytes in and out have no fuel price. The console shows them so you can
see what the relay does. The host still pays any provider request or platform
charge attached to moving or storing those bytes.

**Time awake** estimates how long the relay is in memory from its entrypoints.
It can sleep between messages, while alarms and scheduled jobs wake it even
when no client is connected. The meter adds ten seconds after a wake, then
the gap between entrypoints capped at ten seconds. It does not time a whole
long-running job. Jobs on the Sync tab, pulls, backfills, rebroadcasts, Git
requests and site work all wake the relay. The host's actual duration cost
can be higher or lower than this estimate.

Dumps, the JSONL files the Data tab can write on a schedule, live next to uploaded files and count as files stored. What each job and dump does is in [Data and names](04-data-and-names.md).

**Rows written** is database work. A note costs a few rows. Reactions and other small events cost about the same.

The newer doors use these same meters. NIP-5A files mirrored into the relay and
GRASP Git objects are part of **Files stored**; a site cache miss, site mirror,
Git clone or Git push also wakes the relay and can write events or accounting
rows. Marmot KeyPackages and encrypted group envelopes are ordinary stored
events, so they use **Events stored** and **Rows written**. HTTP request and
response bytes are shown as traffic for your information, but traffic has no
fuel price. There is no separate tenant charge for a site, Marmot or GRASP
request. The relay's existing write, read, storage and rate rules still decide
whether the request is admitted.

GRASP allows 4 MiB per pack, 16 MiB packed history and 128 transactions per
repository, with at most 16 repositories and 320 MiB retained Git data per
relay. These limits share the existing file allowance rather than adding a
new one. Signed events wait for their required Git objects before publication.
Deleting a ref or expiring metadata does not reclaim immutable Git history;
those bytes remain in file storage until the relay is deleted. See
[GRASP-01 Git hosting](22-grasp-01-git-hosting.md) for the full limits.

Git file usage includes transaction receipts and retained bookkeeping as
well as packed files. It is not a fixed reservation per repository: the
total grows with its history, including ref-only updates. The Health tab
shows the combined file total, not a breakdown of these Git components.

## Prices past the allowance

| Measured | Price |
|---|---|
| Events stored | 400 sats per gigabyte-month |
| Files stored | 30 sats per gigabyte-month |
| Time awake | 11 sats per hour |
| Rows written | 2,000 sats per million |

Storage is charged daily, in proportion to how far over the allowance the relay is. Time and rows are charged as they happen. The current prices are always on the relay's Fuel section and on the bind.ws front page.

## Topping up

On your relay's page, enter an amount and click **Zap to top up**. Your extension signs a zap request, and the page shows a lightning invoice. Pay it from any lightning wallet. The receipt lands on your relay and credits it within a minute.

You do not have to be the owner. Anyone can zap any relay.

## Running out

When a relay is over an allowance with no balance, it goes read-only. Clients
get a clear message when they try to publish. Nothing is deleted. Ordinary
reading, searching and syncing keep working, while GRASP Git hosting refuses
requests until the balance or allowance permits it. Remote site fetches and
mirroring also stop; already stored site files remain readable under the
relay's read rule. A sufficient top-up lifts the fuel restriction.

## Seeing the numbers

`https://<name>.bind.ws/fuel` is public and returns the meters, allowances, prices, balance and recent zaps as JSON. The Health tab shows the same numbers.

The meters are the relay's view of usage, not a complete provider invoice.
Cloudflare storage and database request charges can include R2 operations, KV
operations and SQLite work that does not map one-for-one to stored bytes or
the rows counted by the relay. The host checks those provider bills separately;
the four fuel lines are the transparent budget shown to you.
