---
title: Architecture
audience: developer
---

# Architecture

One Cloudflare Worker, one Durable Object per relay name, SQLite inside each object and R2 beside it.

```
client ──wss/https──▶ worker ──host→object──▶ durable object "<name>"
                                               ├ sqlite: events, tags, search, members, rules, usage
                                               ├ sockets: live subscriptions (hibernating)
                                               ├ alarm: daily sweep, retention, fuel
                                               └ r2: blobs by sha256
```

## Routing

`src/index.ts` maps the hostname to a name. `<name>.bind.ws` goes to the object `getByName(name)`. The apex serves the landing page. Reserved names and invalid names redirect to the apex. In `wrangler dev`, `<name>.localhost` plays the same role.

## The object

`src/relay.ts` is the `Relay` class. It owns:

- **Store** (`store.ts`): the event tables and queries.
- **Settings** (`settings.ts`): policy, members, bans, kind rules, retention, invites, reports.
- **Fuel** (`fuel.ts`): usage meters, credits, prices.
- **Identity** (`identity.ts`): the relay's own keypair and the NIP-43 roster.

The constructor runs schema setup inside `blockConcurrencyWhile`, then handles fetches. Websockets use the hibernation API. Per-connection state (NIP-42 challenge, authenticated pubkeys, open subscriptions) is stored on the socket with `serializeAttachment`, so it survives hibernation. Negentropy sessions are in memory only and end with `closed:` when the object sleeps.

## Storage

SQLite tables: `events`, `tags` (single-letter tags only), an FTS5 `search` table keyed by row id, `vanished` tombstones, plus settings tables. Two platform details shape the SQL:

- Statements take at most 100 bound parameters, so id and author lists bind as one JSON parameter expanded with `json_each`.
- There are no PRAGMAs, so cascading deletes are triggers.

Only kinds that carry prose go into the search index: profiles, notes, threads, comments, highlights, articles and wiki pages.

Blobs live in R2 under `<name>/<sha256>`. Their descriptors live in the relay's database, so they count toward storage and appear in the console.

## Alarm

One alarm per object, at most a day out, sooner if a NIP-40 expiry is due. It flushes usage counters, charges storage, applies retention rules and sweeps expired events.

## Fuel

Meters accumulate in memory and flush to a monthly `usage` row in batches. Time awake is estimated the way Cloudflare bills it: a wake costs the idle window (about 10 seconds) once, and each later message costs the gap since the previous one, capped at that window.

Credits come from NIP-57 receipts. A receipt is validated (provider signature, service pubkey, embedded zap request naming this relay, invoice amount) and recorded once in `credits`. Receipts are stored as ordinary events, so the ledger is the relay's own data.

## Identity

On claim, the object generates a keypair, advertised as `self` in NIP-11. It signs the member roster (kind 13534) and its deltas (8000, 8001), all NIP-70 protected, with strictly increasing timestamps.

## Management

`src/manage.ts` implements NIP-86 over NIP-98. The console is a client of it. `verifyNIP98` is a local implementation: kind 27235, 60-second window, `u` matches host and path, method matches, payload hash matches.

## Protocol surface

NIP-01, 09, 11, 13, 17/59 private kinds, 40, 42, 45 with HLL, 50, 56, 62, 67, 70, 77, 86, 98, plus NIP-05, NIP-43, NIP-57 and Blossom BUD-01/02. `test/conformance` is a black-box suite that runs against any relay URL.
