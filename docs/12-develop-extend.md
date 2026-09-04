---
title: Develop and extend
audience: developer
---

# Develop and extend

## Layout

```
src/
  index.ts      worker entry: hostname → object, POST /lease
  edge.ts       what the edge provides, with and without Cloudflare: the client's address, the lease limit, the hostname map
  names.ts      valid names, reserved names, lease names
  pull.ts       copy another relay in: NIP-77 as the initiator, one round per connection
  jobs.ts       the alarm's job list: pulls, backfills, rebroadcasts, once or standing
  relay.ts      the Durable Object: sockets, the alarm, members and bans, jobs, usage
  gates.ts      the write gate and the read gate
  routes.ts     the HTTP doors, in the order they are tried, each saying whether a blocked address may use it
  nip11.ts      the information document and the supported-NIP list
  succession.ts an heir and a dead-man's switch
  kinds.ts      every event kind the relay treats specially, by NIP
  store.ts      SQLite schema and queries
  settings.ts   policy, members, bans, kind rules, retention, export/import
  roles.ts      who may do what: owner, moderator; one table for NIP-86 and NIP-29
  groups.ts     NIP-29, one group per relay: joins, leaves, moderation events
  audit.ts      the moderation log: one row per change from manage.ts or groups.ts
  presets.ts    the templates as one-click presets, some with a standing pull
  config.ts     the configuration document: parse, plan, apply, export
  manage.ts     NIP-86 methods over NIP-98
  domains.ts    custom hostnames: the Cloudflare client and the KV mapping
  dumps.ts      scheduled JSONL dumps to R2
  notify.ts     NIP-17 messages from the relay to its owner
  pages.ts      notes and articles as pages, the Atom feed
  card.ts       the status card, signed and as SVG
  qr.ts         a QR encoder for the card and the console
  fuel.ts       meters, prices, receipts, LNURL
  identity.ts   relay keypair and NIP-43 roster
  nip66.ts      the relay's NIP-66 discovery record about itself
  blossom.ts    BUD-01/02/04/06/08/09 on R2
  nip96.ts      NIP-96 door to the same bucket and table
  bridge.ts     HTTP bridge
  invites.ts    invite codes and the invite page
  nip05.ts      names
  ratelimit.ts  token buckets
  negentropy.ts hll.ts event.ts filter.ts
  dashboard.ts  the console's page, from the three files in console/
  console/      console.html, console.css, console.js: the console as written
  gen/signer.ts generated: the NIP-46 client library the console loads from /signer.js
  gen/templates.ts generated from relay-templates/
  landing.ts    the apex, rendered from config
  ui.ts         the shared look
test/
  unit/         pure functions on node: the QR encoder, bolt11 amounts, the edge
  object/       Durable Object tests in workerd, one file per feature or module
  helpers/      the socket client, the management call, media tokens, the QR reader
  conformance/  black-box suite for any relay URL, one file per NIP, files included
relay-templates/      one relay configuration per template, the presets the console offers
relay-config.schema.json  the configuration file's schema, served at the apex
scripts/
  build/   build-signer.mjs signer-entry.js   bundle nostr-tools for the console's remote signing
           build-console.mjs                  fold src/console into src/gen/console.ts
           build-templates.mjs                fold relay-templates/ into src/gen/templates.ts
  check/   check-console.mjs check-celld.mjs check-config.mjs   run by npm run typecheck; check-config also checks any file
  dev/     dev-signer.mjs seed.mjs stage.mjs junk.mjs shot.mjs zaptest.mjs   for a dev relay
  ops/     margin.mjs                         fuel prices against Cloudflare's rates, weekly in CI
           relay.mjs                          check, plan, push or pull a relay's configuration file
wrangler.jsonc        the Worker on Cloudflare
wrangler.celld.jsonc  the same Worker on celld (docs/16)
```

## Run the tests

```
npm test                  # unit and Durable Object tests
npm run typecheck
npm run test:conformance  # against RELAY_URL, default ws://127.0.0.1:7447
```

The conformance suite needs a claimed relay. Against a dev server:

```
CLAIM=1 RELAY_URL=ws://dev.localhost:8787 npm run test:conformance
```

CI runs typecheck and the object tests on every push; the conformance suite against the Worker on `celld dev` is a separate workflow run on demand ([Hosting without Cloudflare](16-hosting-without-cloudflare.md)). Work lands on `main` directly, in small commits that each typecheck on their own; a red check on `main` is fixed forward with the next commit.

## Add a management method

1. Add an entry to `METHODS` in `src/manage.ts`: the action it needs (`roles.ts`), `reads: true` if it changes nothing, and `run`. The handler takes what it uses from the call: `str(i)` and `num(i)` for parameters, `s` for settings, `reply({ result })` or `reply({ error }, 400)` to answer. `supportedmethods`, the permission check and the moderation log read the same entry.
2. A method a moderator may call names an action in the moderator's set in `roles.ts`; anything else is the owner's.
3. If it changes state that other code caches, update `Settings` and its in-memory sets.
4. If the console should call it, add the control to `src/console/console.html` and a handler in `console.js`.
5. Cover it in the `test/object` file for its feature, with `rpc` from `test/helpers/relay.ts`. If it can show a member, an event or a file, ask `Settings.mayRead` (or `mayList` for names and counts) with what `whoAsks` found in the header, and add the path to the door walk in `test/object/exposure.test.ts`, which knocks on every path as a stranger and as a signed-in non-member and fails on anything of a member's that comes back.

## Add a NIP

Most NIPs land as their own module, wired in with one import and one row in `routes.ts` or one call from `relay.ts`. That is the pattern to follow:

| NIP | Module | Wired from |
|---|---|---|
| 29 groups | `groups.ts` | `acceptGroup` in `relay.ts`, after the write gate (`gates.ts`) |
| 43 roster | `identity.ts` | `publishMembership` in `relay.ts` |
| 66 discovery | `nip66.ts` | `publishDiscovery` in `relay.ts`, from `publishMembership` and the alarm |
| 46 transport | one kind in the write gate and the read gate | `gates.ts` |
| 86 methods | `manage.ts` with `roles.ts` | the RPC route |
| 96 files | `nip96.ts` over `blossom.ts` | one row in `routes.ts` |
| 11 extras | `settings.ts` fields, `nip11.ts` | the NIP-11 row in `routes.ts` |

A NIP that changes the query surface touches `store.ts`. Add the number to `SUPPORTED_NIPS` in `nip11.ts` only when the NIP says relays advertise it, with a word in the comment there for the less obvious ones. Add a file named after the NIP in `test/conformance` so the behavior is checked from outside, and a Durable Object test in `test/object`, named after the module it exercises; a NIP number names a test file only where the feature has no other name (`nip05`, `nip11`, `nip66`).

## The signer bundle

Remote signing needs NIP-44 and secp256k1, which browsers do not ship. `scripts/build/signer-entry.js` imports the pieces of nostr-tools the console uses and `npm run build:signer` bundles them with esbuild into `src/gen/signer.ts`, a string the relay serves at `/signer.js`. The console loads it only when someone picks a remote signer. The generated file is committed; `npm run typecheck` fails when it is stale.

## The console

The console is three ordinary files in `src/console`: `console.html` (the body), `console.css` and `console.js`. `npm run build:console` folds them into `src/gen/console.ts`, the strings the relay serves; `npm run dev` runs it first, and `npm run typecheck` fails when the generated file is stale. It is a generated module rather than a text-module rule in `wrangler.jsonc` because celld deploy refuses a config with `rules`. `scripts/check/check-console.mjs` runs the script's synchronous start against a stub document, so a handler wired above the helper it calls fails typecheck instead of a live page. The shared shell in `ui.ts` provides fonts, colors, buttons, inputs and the sticker vocabulary; keep new pages inside it.

To look at what you changed: `npm run dev`, then `node scripts/dev/dev-signer.mjs`, open `http://<name>.localhost:8787/`, paste the `window.nostr` snippet from that script into the devtools console, and sign in or claim. Playwright's CLI can drive the same loop: open the page, inject the snippet with `eval`, click, screenshot at a phone width and at a desktop width. `scripts/dev/shot.mjs` renders a page over the Chrome debugging protocol when Playwright is not around.

Rules that hold across pages: no middle dots, no purposeless subtext, tables scroll inside their card on narrow screens, decorative elements are not selectable, a multi-field form uses the labelled grid rather than one row of inputs, and the copy above a block is one sentence.

## Screenshots

`node scripts/dev/shot.mjs <url> <out.png> [width] [height]` renders a page with phone or desktop emulation over the Chrome debugging protocol and prints the layout's scroll width, which should equal the viewport width.

## Pull requests

Branch from `main`, push, open a pull request. CI must pass. Squash merge is the only merge mode; branches are deleted on merge.
