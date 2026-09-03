---
title: Understanding fuel
audience: user
---

# Understanding fuel

Your relay is free until it passes a monthly allowance. Past that, use is paid for in sats. Anyone can top up a relay by zapping it.

## What is measured

Four things cost the host money, and those four are measured. Each mirrors a line on the hosting bill.

| Measured | Free each month |
|---|---|
| Events stored | 100 MB |
| Files stored | 1 GB |
| Time awake | 100 hours |
| Rows written | 1 million |

Traffic in and out is free and not counted. The console shows it so you can see what the relay does.

**Time awake** is how long the relay is in memory. It sleeps between messages and wakes when one arrives, so a relay nobody uses is awake for zero hours. A relay with a client connected all day is awake only while messages pass, plus a few seconds after each. Jobs on the Storage tab, pulls, backfills and rebroadcasts, wake the relay on their own and spend this line while they run; a standing job spends it on every run.

**Rows written** is database work. A note costs a few rows. Reactions and other small events cost about the same.

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

When a relay is over an allowance with no balance, it goes read-only. Clients get a clear message when they try to publish. Nothing is deleted. Reading, searching and syncing keep working. One zap lifts the restriction.

## Seeing the numbers

`https://<name>.bind.ws/fuel` is public and returns the meters, allowances, prices, balance and recent zaps as JSON. The Health tab shows the same numbers.
