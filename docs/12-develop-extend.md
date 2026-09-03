---
title: Develop and extend
audience: developer
---

# Develop and extend

## Layout

```
src/
  index.ts      worker entry: hostname → object, POST /lease
  names.ts      valid names, reserved names, lease names
  pull.ts       copy another relay in: NIP-77 as the initiator, one round per connection
  jobs.ts       the alarm's job list: pulls, backfills, rebroadcasts, once or standing
  relay.ts      the Durable Object: sockets, policy, fuel plumbing, NIP-11
  store.ts      SQLite schema and queries
  settings.ts   policy, members, bans, kind rules, retention, export/import
  roles.ts      who may do what: owner, moderator; one table for NIP-86 and NIP-29
  groups.ts     NIP-29, one group per relay: joins, leaves, moderation events
  manage.ts     NIP-86 methods over NIP-98
  fuel.ts       meters, prices, receipts, LNURL
  identity.ts   relay keypair and NIP-43 roster
  blossom.ts    BUD-01/02/04/06/08/09 on R2
  nip96.ts      NIP-96 door to the same bucket and table
  bridge.ts     HTTP bridge
  invites.ts    invite codes and the invite page
  nip05.ts      names
  ratelimit.ts  token buckets
  negentropy.ts hll.ts event.ts filter.ts
  dashboard.ts  the console, one HTML file as three strings
  gen/signer.ts generated: the NIP-46 client library the console loads from /signer.js
  landing.ts    the apex, rendered from config
  ui.ts         the shared look
test/
  relay.test.ts fuel.test.ts adopt.test.ts lease.test.ts groups.test.ts nip11.test.ts nip43.test.ts   Durable Object tests in workerd
  conformance/                               black-box suite for any relay URL
scripts/
  dev-signer.mjs seed.mjs junk.mjs zaptest.mjs shot.mjs
  build-signer.mjs signer-entry.js   bundle nostr-tools for the console's remote signing
```

## Run the tests

```
npm test                  # Durable Object tests
npm run typecheck
npm run test:conformance  # against RELAY_URL, default ws://127.0.0.1:7447
```

The conformance suite needs a claimed relay. Against a dev server:

```
CLAIM=1 RELAY_URL=ws://dev.localhost:8787 npm run test:conformance
```

CI runs typecheck and the object tests on every push and pull request. `main` only takes pull requests with a green check.

## Add a management method

1. Add the name to `METHODS` in `src/manage.ts`.
2. Add a `case` in the switch. Use `num(i)` and `str(i)` for parameters. Return `reply({ result })` or `reply({ error }, 400)`.
3. If it changes state that other code caches, update `Settings` and its in-memory sets.
4. If the console should call it, add the control to `dashboard.ts` and a handler in its script.
5. Cover it in `test/adopt.test.ts` with the `rpc` helper.

## Add a NIP

Relay-side NIPs usually touch three places: `relay.ts` for the message handling, `store.ts` if the query surface changes and `SUPPORTED_NIPS` for the information document. Add a conformance test in `test/conformance` so the behavior is checked from outside.

## The signer bundle

The console has no build step, but remote signing needs NIP-44 and secp256k1, which browsers do not ship. `scripts/signer-entry.js` imports the pieces of nostr-tools the console uses and `npm run build:signer` bundles them with esbuild into `src/gen/signer.ts`, a string the relay serves at `/signer.js`. The console loads it only when someone picks a remote signer. The generated file is committed; `npm run typecheck` fails when it is stale.

## The console

`src/dashboard.ts` holds CSS, markup and script as JSON string literals on single lines. Edit with a script that decodes, changes and re-encodes them; a raw newline inside a literal breaks the file. The shared shell in `ui.ts` provides fonts, colors, buttons, inputs and the sticker vocabulary; keep new pages inside it.

Rules that hold across pages: no middle dots, no purposeless subtext, tables scroll inside their card on narrow screens, decorative elements are not selectable.

## Screenshots

`node scripts/shot.mjs <url> <out.png> [width] [height]` renders a page with phone or desktop emulation over the Chrome debugging protocol and prints the layout's scroll width, which should equal the viewport width.

## Pull requests

Branch from `main`, push, open a pull request. CI must pass. Squash merge is the only merge mode; branches are deleted on merge.
