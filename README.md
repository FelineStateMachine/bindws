# bind.ws

Relay on demand. Sign once, and it's yours.

One Cloudflare Worker routes `wss://<name>.bind.ws` to a Durable Object per name; each object holds that relay's SQLite database and its live websockets, hibernating while idle so an unused relay costs nothing. Claiming a name is one signature with a nostr key, and the relay's own page at `https://<name>.bind.ws/` is the owner's console.

```
npm install
npm run dev              # wrangler dev on http://127.0.0.1:8787
npm test                 # Durable Object tests (policy, management, expiry, routing) in workerd
npm run test:conformance # protocol suite against RELAY_URL (default ws://127.0.0.1:7447)
npm run deploy
```

## What a relay does

NIP-01, 09, 11, 13, 17/59 private kinds, 40, 42, 45 with HLL, 50 search on FTS5, 62, 67, 70, 77 negentropy, plus NIP-86 management. `test/conformance` is a black-box suite that runs against any relay URL.

## The apex

`https://bind.ws/` is one page: the system drawn as it is, three notes beside it, and a datasheet of interfaces, limits, metering and protocol. Limits and prices are read from the same config the relay runs on (`wrangler.jsonc` and the policy defaults), so the page cannot drift from the service.

## Names, claiming, policy

- Names are 3 to 32 lowercase letters, digits or hyphens; a reserved list keeps `www`, `api` and friends. Anything else redirects to the apex.
- A relay starts unclaimed: it answers queries (there is nothing to read) and refuses writes with `restricted:` pointing at its page. The first NIP-98-signed `claim` call makes that pubkey the owner. Later claims by others get 403; the owner's own re-claim is idempotent.
- The owner sets policy through NIP-86 (`setpolicy` and the standard ban/allow/kind methods): who may write (anyone, members, only me), whether reads need NIP-42, minimum proof of work, timestamp window, query limits, plus name, description, icon and contact for NIP-11. Bans on pubkeys and events, and kind allow/block lists, apply on top.
- The relay's page has a front of house for everyone (connect, people, fuel, NIP-11 behind a disclosure) and, for the owner, five tabs organized by job: People (members, invites, bans, reports), Rules, Identity, Storage, Health. It is a client of exactly the NIP-86 API, signing with a NIP-07 extension. `scripts/dev-signer.mjs` stands in for an extension during local browser testing. All pages share one look from `src/ui.ts`.

## What every relay offers beyond the websocket

- **HTTP bridge.** `POST /events`, `POST /query` and `POST /count` under NIP-98, arrays in and arrays out, with the signer treated exactly like a NIP-42-authenticated socket. For scripts, serverless functions and agents that don't want a long-lived connection.
- **People, one record.** A member is a row: pubkey, role, an optional name, a note, and how they joined (claimed, invite, added, profile). Three things read that table: the write policy's member list, the NIP-43 roster the relay signs (kind 13534 with 8000/8001 deltas, NIP-70 protected, strictly increasing timestamps), and `/.well-known/nostr.json`, so a member with the name `alice` is `alice@<name>.bind.ws`. Members claim a name in their kind 0 profile; the owner edits names and notes inline. `GET /people` is the public directory, on by default and switchable off. Relays created before this model migrate on first load.
- **Invite links.** The owner mints codes (`createinvite` with a TTL, a use count and a note) and shares `https://<name>.bind.ws/invite/<code>`. The page shows the relay's join terms and joins the visitor with one NIP-98 signature via `POST /api/invites/claim`, which is deliberately open to non-members.
- **A relay identity.** On claim the relay generates its own keypair, advertised as NIP-11 `self`; it signs the roster and anything else only the relay can vouch for.
- **Members-only reads.** `reads: "members"` serves only the member list. Removing a member ends their live subscriptions with a `restricted:` reason; banning closes their socket outright.
- **Blossom media.** `PUT /upload`, `GET /<sha256>[.ext]`, `HEAD`, `DELETE`, and `GET /list/<pubkey>` per BUD-01 and BUD-02, authorized by kind 24242 events. Blobs live in R2 under `<name>/<sha256>`; descriptors live in the relay's database so uploads count toward fuel storage and the owner can see and remove them. Uploads follow the write policy; reads are public by hash.
- **Rate limits.** Per-connection token buckets for events and queries (`eventsPerMinute`, `reqsPerMinute`), refused with `rate-limited: quota exceeded; retry in Ns`, the hint clients already parse.
- **Portable configuration.** `exportconfig` returns rules, identity, members, bans and kind rules as one JSON document; `importconfig` replaces those lists on any relay you own, never touching events, files, or the owner. Export before a teardown, import to rebuild elsewhere.
- **Teardown.** `deleterelay` takes the relay's name typed by hand, then closes every connection, deletes every event, file, member, invite, setting and the relay key, and returns the name to unclaimed. The danger block at the bottom of the Identity tab is the only place that calls it.
- **Storage you can see and shed.** The Storage tab sizes the relay by kind: count, bytes, oldest, with a stacked bar of what weighs most, plus files and the index overhead. Each kind takes a keep-for rule (`setretention`, in days) enforced at write time and by the daily sweep, with an "everything else" rule that spares other replaceable kinds unless they get their own. Kinds the relay itself depends on, profiles, contact and relay lists, zap receipts and the roster, are always kept: no rule, no purge, marked green in the console. Rules are advertised in NIP-11 `retention` and travel with the configuration. `purgekind` deletes a kind older than N days on the spot. The recent-events feed is still there for finding one thing, behind a disclosure.
- **A moderation queue.** Kind 1984 reports are filed for the owner and never served. The dashboard resolves each with ban (author and event), delete, or dismiss.

## Fuel: quotas topped up by zaps

A relay is metered on the four things that cost the operator money, each mirroring a line on the Cloudflare bill, and priced from those rates so paying users cover the hosting and little more:

| metered | backing cost | free per relay per month | beyond it |
|---|---|---|---|
| events stored | Durable Object SQLite | 100 MB | `SATS_PER_GB_MONTH_EVENTS` per GB-month |
| files stored | R2 | 1 GB | `SATS_PER_GB_MONTH_MEDIA` per GB-month |
| time awake | Durable Object duration | 100 hours | `SATS_PER_ACTIVE_HOUR` |
| rows written | SQLite writes | 1,000,000 | `SATS_PER_MILLION_ROWS` |

Traffic in and out and rows read are metered and shown but never priced, since Cloudflare charges nothing for them. Storage is charged daily pro rata by the alarm; time awake and rows accrue as they happen. Time awake is estimated the way Cloudflare bills it: an object stays in memory for about ten seconds after its last piece of work before hibernating, so every wake costs that window and consecutive messages cost the gap between them, capped at the window. The prices in `wrangler.jsonc` carry the cost basis and exchange rate they were set from.

When a relay is over any allowance with no balance it goes read-only: writes get `restricted: out of fuel`, NIP-11 reports `payment_required` with `payments_url` pointing at the relay's page, nothing is deleted.

Top-ups are NIP-57 zaps to the service's lightning address (`LIGHTNING_ADDRESS`) naming the service's nostr pubkey (`SERVICE_PUBKEY`). The relay page signs a kind 9734 zap request with the visitor's extension, listing the relay in its `relays` tag; `POST /fuel/invoice` turns it into an invoice through the provider's LNURL callback (parameters cached a day). The provider then publishes the kind 9735 receipt to the relay itself, where it is validated (provider signature, service pubkey, embedded request naming this relay, invoice amount) and credited once. Receipts are stored as ordinary events, so the ledger is the relay's own data. They are accepted regardless of write policy, since the provider is nobody's member. `GET /fuel` is public: anyone can see a relay's gauges and top it up.

Leaving `LIGHTNING_ADDRESS` empty keeps the allowances as hard limits with no way to raise them.

## Storage layout

Durable Object SQLite: `events`, `tags`, an FTS5 `search` table keyed by the event's row id (only kinds that carry prose are indexed: profiles, notes, threads, comments, highlights, articles and wiki pages), `vanished` tombstones, plus `settings` and rule tables. Two platform details shape the SQL: statements take at most 100 bound parameters, so id and author lists are bound as one JSON parameter and expanded with `json_each`; and there are no PRAGMAs, so cascading deletes are triggers.

Connection state (NIP-42 challenge and authenticated pubkeys, open subscriptions) is stored on each websocket with `serializeAttachment`, so it survives hibernation. Negentropy sessions are in memory only: a sync interrupted by hibernation gets a `closed:` error and the client reopens it.

## Local development

`npm run dev` (`wrangler dev --env dev`, an environment without routes so hostnames pass through) serves `http://<name>.localhost:8787` as the relay called `<name>` (Node, curl and browsers all resolve `*.localhost` to loopback), `http://bind.ws.localhost:8787` as the apex, and anything else as the relay named `dev`. To run the conformance suite against it, claim a dev relay first:

```
CLAIM=1 RELAY_URL=ws://dev.localhost:8787 npm run test:conformance
```

To see the owner console without an extension, run `node scripts/dev-signer.mjs`, open a relay page, and paste the snippet from that file into the devtools console before clicking sign in. `node scripts/seed.mjs <name>` publishes a few events.

## Deploying to bind.ws

`wrangler.jsonc` routes the apex as a custom domain and `*.bind.ws/*` through the zone. The wildcard route needs proxied placeholder DNS records so Cloudflare answers for every subdomain:

| record | name | value | proxy |
|---|---|---|---|
| `AAAA` | `*` | `100::` | on |
| `A` | `*` | `192.0.2.1` | on |

Then `npm run deploy`. Universal SSL covers one level of wildcard, which is all the names use. Nothing else is required: no origin, no certificate management, no servers.
