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

A relay is in one of three states. Unclaimed: no owner, no lease, writes refused. Leased: no owner yet, `policy.lease` holds an expiry and, optionally, the one pubkey that may claim; reads and writes are open, management is refused except `claim`. Claimed: an owner. A lease is handed out by `POST /lease` on the apex (`index.ts`), which tries memorable names from `names.ts` until one is unclaimed and calls the object's `lease` method over RPC. A claim on a leased relay converts it in place and clears the lease; the events, files and the 14-day retention rule stay until the owner resets the rules.

The constructor runs schema setup inside `blockConcurrencyWhile`, then handles fetches. Websockets use the hibernation API. Per-connection state (NIP-42 challenge, authenticated pubkeys, open subscriptions) is stored on the socket with `serializeAttachment`, so it survives hibernation. Negentropy sessions are in memory only and end with `closed:` when the object sleeps.

## Storage

SQLite tables: `events`, `tags` (single-letter tags only), an FTS5 `search` table keyed by row id, `vanished` tombstones, plus settings tables. Two platform details shape the SQL:

- Statements take at most 100 bound parameters, so id and author lists bind as one JSON parameter expanded with `json_each`.
- There are no PRAGMAs, so cascading deletes are triggers.

Only kinds that carry prose go into the search index: profiles, notes, threads, comments, highlights, articles and wiki pages.

Blobs live in R2 under `<name>/<sha256>`. Their descriptors live in the relay's database, so they count toward storage and appear in the console. Two doors lead to the same bucket and table: Blossom (`blossom.ts`) and NIP-96 (`nip96.ts`), a thin adapter that reuses the Blossom store, gate and URLs. Descriptors and NIP-96 answers carry the NIP-94 tags the relay can vouch for without decoding the file: `url`, `m`, `x`, `ox` and `size`. Blob reports (BUD-09) go into the `reports` table with the sha256 in `target_event` and the uploader in `target_pubkey`; resolving one with delete removes the blob and puts its hash on the banned id list, which every upload door checks.

## Alarm

One alarm per object, at most a day out, sooner if a NIP-40 expiry is due or a lease expires. It flushes usage counters, charges storage, applies retention rules and sweeps expired events. A lease past its expiry is torn down whole, which returns the name to unclaimed.

NIP-46 traffic (kind 24133) is ephemeral, never stored and encrypted end to end, so it passes the ownership and write gates, and a subscription to it alone passes the read gate. That lets the relay carry a remote signer's session for the console, including for someone about to claim it. Bans and the per-connection rate limit still apply.

The alarm also drives pulls (`pull.ts`). `pullfrom` records a job and wakes the alarm; each round opens one websocket to the source, reconciles with NIP-77 as the initiator, fetches a bounded batch of the missing ids, verifies signatures, and stores them through the normal write path minus the client policy. Sources on this host are dialled through their object stub and their files copied in R2 by prefix. Rounds repeat until nothing is missing, so a pull survives the object sleeping, and a second pull only fetches the difference.

## Fuel

Meters accumulate in memory and flush to a monthly `usage` row in batches. Time awake is estimated the way Cloudflare bills it: a wake costs the idle window (about 10 seconds) once, and each later message costs the gap since the previous one, capped at that window.

Credits come from NIP-57 receipts. A receipt is validated (provider signature, service pubkey, embedded zap request naming this relay, invoice amount) and recorded once in `credits`. Receipts are stored as ordinary events, so the ledger is the relay's own data.

## Identity

On claim, the object generates a keypair, advertised as `self` in NIP-11. Everything the relay vouches for is signed with it and derived from one place, the `members` table and the policy, by one function, `publishMembership`: the NIP-43 roster (13534, roles named only when there is one) and its deltas (8000, 8001), the NIP-29 put-user and remove-user records (9000, 9001), the group's state (39000-39003), the NIP-43 role definitions (33534) and the relay's own kind 0 profile, re-signed only when name, description or icon changed. Every path that touches membership or roles goes through that function, so the roster and the group cannot drift. All but the profile are NIP-70 protected, with strictly increasing timestamps.

NIP-43's own join and leave requests (28934 with a `claim` tag, 28936) are handled next to their NIP-29 counterparts; they are ephemeral, so the answer is the OK message and nothing is stored.

## Groups and roles

Every relay is one NIP-29 group (`src/groups.ts`). The group id is the relay's name. An event with an `h` tag for any other id is refused; events without one are ordinary relay events. The group's flags are derived from the rules: `private` is reads set to members, `restricted` and `closed` are writes not open. The identity signs the group's state as addressable events, kind 39000 metadata, 39001 admins, 39002 members (only while the directory is public), 39003 roles, on the same strictly increasing clock as the roster, and republishes them on every membership, role or rule change. Membership changes also produce relay-signed 9000 put-user and 9001 remove-user records next to the NIP-43 deltas. All of these are protected kinds.

Joins (9021, with an optional invite `code`), leaves (9022) and the moderation kinds 9000, 9001, 9002, 9005 and 9009 are applied before the write policy and gated by role instead. Unsupported moderation kinds are refused with `unsupported:`. Timeline `previous` references, pins, subgroups and livekit are not implemented.

`src/roles.ts` is the one permission table, used by the NIP-86 methods and the NIP-29 events alike:

| Role | May |
|---|---|
| owner | everything, including rules, identity, storage, config, pull, transfer, delete |
| moderator | read stats and lists, add and edit plain members, ban, delete events, invites, reports |

Moderators cannot act on the owner or on each other; only the owner appoints or removes moderators. `transferowner` hands the relay to a member and leaves the old owner as a moderator; the identity key and fuel do not change.

## Management

`src/manage.ts` implements NIP-86 over NIP-98. The console is a client of it. `verifyNIP98` is a local implementation: kind 27235, 60-second window, `u` matches host and path, method matches, payload hash matches.

`listeventsneedingmoderation` is a view over the reports queue: one entry per open reported thing, an event id or a blob hash, with the report's type and words as the reason. `blockip`, `unblockip` and `listblockedips` work on the client's address, which the worker stamps on every forwarded request as `x-relay-ip` from Cloudflare's `cf-connecting-ip`, never read from a client header. The address is kept in the socket's state and in the HTTP doors' virtual connection. Per-address token buckets sit beside the per-connection ones at four times the allowance, and are the bridge's only rate limit.

## Protocol surface

NIP-01, 09, 11, 13, 17/59 private kinds, 29, 40, 42, 45 with HLL, 50, 56, 62, 67, 70, 77, 86, 98, plus NIP-05, NIP-43, NIP-57, NIP-96 with NIP-94, and Blossom BUD-01/02/04/06/08/09. `test/conformance` is a black-box suite that runs against any relay URL.
