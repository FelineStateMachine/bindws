---
title: Architecture
audience: developer
---

# Architecture

One Cloudflare Worker, one Durable Object per relay name, SQLite inside each object and R2 beside it.

```
client ──wss/https──▶ worker ──host→object──▶ durable object "<name>"
                        │ KV: custom host → name    ├ sqlite: events, tags, search, members, rules, jobs, usage
                        │                           ├ sockets: live subscriptions (hibernating)
                        │                           ├ alarm: sweep, retention, fuel, dumps, jobs, succession
                        │                           ├ r2: blobs and dumps under <name>/
                        │                           └ outbound sockets: pulls, pushes, notifications
```

## Routing and states

`src/index.ts` maps the hostname to a name. `<name>.<domain>` goes to the object `getByName(name)`. The apex serves the landing page and `POST /lease`. Reserved names and invalid names redirect to the apex. Any other hostname is looked up in the `HOSTS` KV namespace, which maps a custom hostname to a relay name, with a one-minute cache per isolate; a miss is cached too. In `wrangler dev`, `<name>.localhost` plays the same role. The worker stamps every forwarded request with `x-relay-name` and with `x-relay-ip` from Cloudflare's `cf-connecting-ip`, overwriting anything a client sent.

A relay is in one of three states:

| State | Owner | Writes | Management |
|---|---|---|---|
| unclaimed | none | refused | `claim` only |
| leased | none, `policy.lease` holds an expiry and an optional holder | open to all, kept 14 days | `claim` only, by the holder if one is set |
| claimed | a pubkey | by the rules | by role |

A lease comes from `POST /lease`, which tries memorable names from `names.ts` until one is unclaimed and calls the object's `lease` method over RPC. A claim on a leased relay converts it in place and clears the lease; the events, files and the 14-day retention rule stay until the owner resets the rules. A lease past its expiry is torn down whole by the alarm, which returns the name to unclaimed.

Custom hostnames (`domains.ts`) are registered with Cloudflare for SaaS from the object, through the `fetcher` seam the lightning code also uses, and written to KV only after Cloudflare accepted them. Up to three per relay, never two relays for one hostname. They survive transfer and die with the relay.

## The object

`src/relay.ts` is the `Relay` class. It owns:

- **Store** (`store.ts`): the event tables and queries.
- **Settings** (`settings.ts`): policy, members, bans, kind rules, retention, invites, reports, blocked addresses, succession.
- **Fuel** (`fuel.ts`): usage meters, credits, prices.
- **Identity** (`identity.ts`): the relay's own keypair and everything it signs.

The constructor runs schema setup inside `blockConcurrencyWhile`, then handles fetches. Websockets use the hibernation API. Per-connection state (NIP-42 challenge, authenticated pubkeys, open subscriptions, the filters of open syncs, the client's address) is stored on the socket with `serializeAttachment`, so it survives hibernation. A negentropy session's item list is in memory only; the next NEG-MSG after a wake reads it again from the store by the remembered filter, asking the read rule again first, so a sync carries on across a sleep. A socket whose attachment is over its limit keeps the session in memory alone, and that one ends with `closed:` when the object sleeps.

The write path is one gate plus the client policy. The gate refuses malformed, expired, banned and out-of-context events (an `h` tag for another group) and, for client writes, the unclaimed and expired-lease states, fuel and NIP-70. The client policy adds kind rules, retention windows, the write rule, proof of work and per-member caps. Host-side writes, such as pulls and the relay's own records, pass the gate only. Kind 24133, NIP-46 signer traffic, passes everything but bans and rate limits on the way in: it is ephemeral, never stored and encrypted end to end, so the relay can carry a remote signer's session for the console, including for someone about to claim it. On the way out it is a private kind, delivered to a socket authenticated as its sender or its `p` recipient, or to a subscription that names one of those keys in `#p` or `authors`, under any read rule and without AUTH: the payload is encrypted end to end, and signers and their clients hold no key the relay knows. Amber probes a relay this way before it will list it, and Amethyst's bunker listens under a transport key it never authenticates with. A bare subscription to the kind sees nothing, so a members-only relay reveals signer traffic only to someone who already holds the key it is addressed to. A subscription to 24133 alone may be opened under any read rule. The console's remote-signer client answers the challenge with the session's own key.

The read path is one gate too, `Settings.mayRead`, given the pubkeys a caller has proved: on the socket the NIP-42 set, over HTTP whatever `whoAsks` (`auth.ts`) found in the Authorization header, a NIP-98 signature or a Blossom token. REQ, COUNT, NEG-OPEN, the bridge, blob downloads and listings, file reports, the same-host file copy and the members-only views all ask it; the directory switch adds `mayList` for names and counts. Changing the rule runs `enforceReads`, which closes every open subscription the rule no longer admits.

## Storage and media

SQLite tables: `events`, `tags` (single-letter tags only), an FTS5 `search` table keyed by row id, `vanished` tombstones, plus the settings tables and `jobs`, `dumps` and `usage`. Two platform details shape the SQL:

- Statements take at most 100 bound parameters, so id and author lists bind as one JSON parameter expanded with `json_each`.
- There are no PRAGMAs, so cascading deletes are triggers.

Only kinds that carry prose go into the search index: profiles, notes, threads, comments, highlights, articles and wiki pages.

Blobs live in R2 under `<name>/<sha256>`. Their descriptors live in the relay's database, so they count toward storage and appear in the console. Two doors lead to the same bucket and table: Blossom (`blossom.ts`, BUD-01, 02, 04, 06, 08 and 09) and NIP-96 (`nip96.ts`), a thin adapter that reuses the Blossom store, gate and URLs. Descriptors and NIP-96 answers carry the NIP-94 tags the relay can vouch for without decoding the file: `url`, `m`, `x`, `ox` and `size`. Blob reports go into the `reports` table with the sha256 in `target_event` and the uploader in `target_pubkey`; resolving one with delete removes the blob and puts its hash on the banned id list, which every upload door checks.

Per-member caps are checked on the write path from a per-author byte count the store caches; anything that deletes clears the cache.

## The alarm

One alarm per object, at most a day out, sooner if a NIP-40 expiry is due, a lease expires or a job is due. Each tick, in order:

1. Tear down a lease past its expiry, and stop.
2. Run one round of the running or due job, and come back a quarter second later while there is more (see below).
3. Flush usage counters and charge storage past the allowances, pro rata by day.
4. Apply retention: the kind rules, then each member's own keep-for. Sweep NIP-40 expiries.
5. Write a dump when one is due (`dumps.ts`): every event streamed by sequence into a multipart upload under `<name>/dumps/`, recorded in the `dumps` table, counted as media, the newest `dumpsKeep` kept.
6. Notify the owner when fuel turns low, once, then daily while it stays low.
7. Run the succession check.

Succession is the dead-man's switch. `ownerSeenAt` in storage is refreshed by owner-signed actions (management calls, websocket AUTH, bridge requests, stored events), at most hourly. With an heir named, silence past the chosen delay puts a warning record in storage, mirrored in memory so NIP-11 can report `succession_pending`; the owner is notified weekly for 30 days; then `transferOwner` runs, both parties are notified and the handover is logged. Any owner action clears the warning.

## Jobs

`jobs.ts` is a persisted list the alarm runs one round at a time, so work survives the object sleeping. `addjob` records a job and wakes the alarm. Three failed rounds in a row end a run with the reason. A once job is done after its run; a standing job runs again every one, six or 24 hours, and the daily alarm is never set past the next run. Five standing jobs and 20 in all, 10 relays per job.

A pull round (`pull.ts`) opens one websocket to the source, reconciles with NIP-77 as the initiator over the job's filter (authors, kinds, since), fetches a bounded batch of the missing ids, verifies signatures and stores them through the gate. Sources on this host are dialled through their object stub and, on a whole-relay pull, their files copied in R2 by prefix. A pull job syncs its sources in turn, so a backfill is a pull with the owner as author from the relays in their kind 10002.

A push round takes the next batch past a sequence cursor kept on the job, offers it to every target, counts OKs (a `duplicate:` counts as sent) and leaves a target alone for the round after five refusals in a row. The cursor survives sleeps and runs, so a standing push forwards only what arrived since. NIP-70 protected events are never pushed, nor private kinds from a members-only relay.

A fork (`forkrelay`) is built from three things that exist: it leases a name through the same `lease` method the apex uses, reserved for the holder; calls `adoptFrom` on the new object, an RPC method HTTP cannot reach, which copies the plain members and adds a once pull from this relay's public URL with the optional filter; and returns the console URL to hand over. One fork an hour per relay.

## Identity and signed records

On claim, the object generates a keypair, advertised as `self` in NIP-11. Everything the relay vouches for is signed with it and derived from one place, the `members` table and the policy, by one function, `publishMembership`:

| Record | Kind | When |
|---|---|---|
| NIP-43 roster and its deltas | 13534, 8000, 8001 | membership change |
| NIP-29 put-user, remove-user | 9000, 9001 | membership change |
| group metadata, admins, members, roles | 39000 to 39003 | membership, role or rule change |
| NIP-43 role definitions | 33534 | same |
| the relay's own profile | 0 | name, description or icon changed |

Every path that touches membership or roles goes through that function, so the roster and the group cannot drift. All but the profile are NIP-70 protected, with strictly increasing timestamps, and all are protected from retention. NIP-43's join and leave requests (28934 with a `claim` tag, 28936) are handled next to their NIP-29 counterparts; they are ephemeral, so the answer is the OK message and nothing is stored.

The card (`card.ts`) is the public face of a name: `/card.json` with name, owner, member count when the directory is public, rules, fuel state and the group naddr; `/card.nostr` as the same facts in a kind 30078 signed by the relay key; `/card.svg` as an Open Graph sized picture; and `/qr.svg` for the console. The naddr comes from nostr-tools' nip19. The QR encoder is `qr.ts`, byte mode at level M up to version 20, with a test that reads symbols back and checks the Reed-Solomon syndromes.

## Groups and roles

Every relay is one NIP-29 group (`groups.ts`). The group id is the relay's name. An event with an `h` tag for any other id is refused; events without one are ordinary relay events. The group's flags are derived from the rules: `private` is reads set to members, `restricted` and `closed` are writes not open. Joins (9021, with an optional invite `code`), leaves (9022) and the moderation kinds 9000, 9001, 9002, 9005 and 9009 are applied before the write policy and gated by role instead. Unsupported moderation kinds are refused with `unsupported:`. Timeline `previous` references, pins, subgroups and livekit are not implemented.

`roles.ts` is the one permission table, used by the NIP-86 methods and the NIP-29 events alike:

| Role | May |
|---|---|
| owner | everything, including rules, identity, storage, config, jobs, transfer, fork, delete |
| moderator | read stats and lists, add and edit plain members, ban, block addresses, delete events, invites, reports |

Moderators cannot act on the owner or on each other; only the owner appoints or removes moderators. `transferowner` hands the relay to a member and leaves the old owner as a moderator; the identity key, hostnames and fuel do not change.

Members inviting members is `invited_by` on the member row, set from the invite's minter on both join doors, and a `memberInvites` rule in policy. `Settings.inviteDepth` walks the chain to the owner; `Settings.subtree` collects a member and everyone under them, stopping at moderators; `removesubtree` removes them all and publishes membership once.

## Management and rate limits

`manage.ts` implements NIP-86 over NIP-98. The console is a client of it. `verifyNIP98` is a local implementation: kind 27235, 60-second window, `u` matches host and path, method matches, payload hash matches when there is a body. Every method except `claim` and `supportedmethods` names an action in `roles.ts`; a method without one is refused for everyone.

`listeventsneedingmoderation` is a view over the reports queue: one entry per open reported thing, an event id or a blob hash, with the report's type and words as the reason. `blockip`, `unblockip` and `listblockedips` work on the address the worker stamped. A blocked address gets no socket and no write, read or upload door, while the page, NIP-11 and management stay reachable so an owner can undo a block on their own address.

Rate limits are token buckets per connection (`ratelimit.ts`) and, beside them, per address at four times the allowance. The address buckets are the HTTP bridge's only limit, live in memory and reset when the object sleeps. The apex caps leases with two rate limiting bindings, per address and overall.

## Presets

`presets.ts` holds the rule bundles: writes, reads, the directory, kind rules and keep-for rules in one go, applied through the same Settings methods the console uses one at a time. Limits, identity, people and bans stay. The `search` and `articles` presets also keep a standing pull labelled `replica` of their kinds from a source relay; applying any preset removes the earlier replica job first, so a name holds at most one. The owner's own replaceable kinds pass the kind rules, so a relay can always hold its owner's lists.

Wiring the relay into the owner's lists (kinds 10002, 10050, 10007, 10063) happens in the console: it fetches the newest copy from this relay over the NIP-98 bridge and from a few indexers over websockets, merges, signs once and publishes to every relay the list names.

## The web surface

`pages.ts` renders kind 1 at `/e/<id>` and kind 30023 at `/a/<d>` (the owner's) or `/a/<author>/<d>` with Open Graph tags, and `/feed.xml` as Atom, newest 50, from the same store query the console uses, with an access of no pubkeys so private kinds can never appear. Every page path answers 404 unless reads are open; an unclaimed relay answers 404 too, a leased one has pages. `nostr:` references become links here when the target is on this relay. Answers are cacheable for five minutes.

`notify.ts` lets the relay write its owner: a kind 14 rumour sealed and gift wrapped with the identity key (NIP-59, NIP-44), stored as the owner's inbox and pushed best effort to up to three relays from the owner's kind 10050 through the pull code's `dial`. Hooks: a report filed through either door, fuel turning low, a job finishing, the succession clock and the test button. Off by default in `policy.notify`; naming an heir switches the succession kind on. The catch-all retention rule skips kind 1059 so the inbox survives it.

The console (`dashboard.ts`) is one page, no build step: markup, styles and script as three string literals. Its signer is NIP-07 when present or a NIP-46 session over the relay itself, using a bundle of nostr-tools served at `/signer.js` and loaded only when someone picks remote signing.

## Views

`src/views.ts` is a registry of folds. Each view names a trigger, an audience and a fold that returns tags and content; hourly views add a fingerprint so nothing is republished when the inputs did not move. The record is a kind 30078 signed by the identity key on the same strictly increasing clock as the group state, `d` = `bind.ws/view/<name>`, stored and broadcast through `emit` like the roster, taken down when the view is switched off, empty, or no longer public. The rows a run wrote are measured around the fold from the store's write counter and kept as the last 60 runs, which the console and the digest read.

Audience decides storage. A public view is stored. A members-only view is never stored, because a stored event is readable by anyone the read rule admits; `GET /view/<name>` folds and signs it on request for a member who proves it with NIP-98. Presence is neither: an ephemeral kind 20078 built from the socket list and a map of recent writers, broadcast when the set changes at most once every 30 seconds, rebuilt from the sockets after a wake since the map does not survive hibernation.

The daily alarm runs daily views once a day and hourly views once an hour. Write-triggered views mark themselves dirty and republish ten seconds later, so a burst republishes once, and the daily run catches whatever a sleep dropped. Retention and purge skip every event the identity key signed, on top of the protected kinds, so views and the other records never expire.

## Protocol surface

NIP-01, 05, 09, 11, 13, 17 and 59 private kinds, 29, 40, 42, 43, 45 with HLL counts, 46 as transport, 50, 56, 57, 62, 67, 70, 77, 86, 94, 96, 98, and Blossom BUD-01, 02, 03 by way of the lists, 04, 06, 08 and 09. `test/conformance` is a black-box suite that runs against any relay URL.
