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
  relay.ts      the Durable Object: sockets, policy, fuel plumbing, NIP-11
  store.ts      SQLite schema and queries
  settings.ts   policy, members, bans, kind rules, retention, export/import
  roles.ts      who may do what: owner, moderator; one table for NIP-86 and NIP-29
  groups.ts     NIP-29, one group per relay: joins, leaves, moderation events
  audit.ts      the moderation log: one row per change from manage.ts or groups.ts
  presets.ts    rule bundles, one click each, some with a standing pull
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
  dashboard.ts  the console, one HTML file as three strings
  gen/signer.ts generated: the NIP-46 client library the console loads from /signer.js
  landing.ts    the apex, rendered from config
  ui.ts         the shared look
test/
  *.test.ts     Durable Object tests in workerd, one file per feature
  conformance/                               black-box suite for any relay URL, files included
scripts/
  dev-signer.mjs seed.mjs junk.mjs zaptest.mjs shot.mjs
  build-signer.mjs signer-entry.js   bundle nostr-tools for the console's remote signing
  check-celld.mjs                    wrangler.celld.jsonc stays in step with wrangler.jsonc
wrangler.jsonc        the Worker on Cloudflare
wrangler.celld.jsonc  the same Worker on celld (docs/16)
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

CI runs typecheck and the object tests on every push, and, in a second job, the conformance suite against the Worker on `celld dev` ([Hosting without Cloudflare](16-hosting-without-cloudflare.md)). Work lands on `main` directly, in small commits that each typecheck on their own; a red check on `main` is fixed forward with the next commit.

The entry module `src/index.ts` exports the handler and the object and nothing else: workerd refuses an exported constant there, and the test pool does not, so a helper that tests import lives in its own module.

## Add a management method

1. Add the name to `METHODS` in `src/manage.ts` and the action it needs to `METHOD_ACTIONS` in `src/roles.ts`; a method without an action is refused for everyone.
2. Add a `case` in the switch. Use `num(i)` and `str(i)` for parameters. Return `reply({ result })` or `reply({ error }, 400)`.
3. If it changes state that other code caches, update `Settings` and its in-memory sets.
4. If the console should call it, add the control to `dashboard.ts` and a handler in its script.
5. Cover it in `test/adopt.test.ts` with the `rpc` helper. If it can show a member, an event or a file, ask `Settings.mayRead` (or `mayList` for names and counts) with what `whoAsks` found in the header, and add the path to the door walk in `test/exposure.test.ts`, which knocks on every path as a stranger and as a signed-in non-member and fails on anything of a member's that comes back.

## Add a NIP

Most NIPs land as their own module, wired in from `relay.ts` with one import and one route or one call. That is the pattern to follow:

| NIP | Module | Wired from |
|---|---|---|
| 29 groups | `groups.ts` | the write gate in `relay.ts`, before the client policy |
| 43 roster | `identity.ts` | `publishMembership` in `relay.ts` |
| 66 discovery | `nip66.ts` | `publishDiscovery` in `relay.ts`, from `publishMembership` and the alarm |
| 46 transport | one kind in the write gate and the read gate | `relay.ts` |
| 86 methods | `manage.ts` with `roles.ts` | the RPC route |
| 96 files | `nip96.ts` over `blossom.ts` | one path line in `fetch` |
| 11 extras | `settings.ts` fields, `info()` | `relay.ts` |

A NIP that changes the query surface touches `store.ts`. Add the number to `SUPPORTED_NIPS` only when the NIP says relays advertise it, with a word in the comment there for the less obvious ones. Add a conformance test in `test/conformance` so the behavior is checked from outside, and a Durable Object test next to the feature's file in `test/`.

## The signer bundle

The console has no build step, but remote signing needs NIP-44 and secp256k1, which browsers do not ship. `scripts/signer-entry.js` imports the pieces of nostr-tools the console uses and `npm run build:signer` bundles them with esbuild into `src/gen/signer.ts`, a string the relay serves at `/signer.js`. The console loads it only when someone picks a remote signer. The generated file is committed; `npm run typecheck` fails when it is stale.

## The console

`src/dashboard.ts` holds CSS, markup and script as JSON string literals on single lines. Edit with a script that decodes, changes and re-encodes them; a raw newline inside a literal breaks the file, and the source keeps non-ASCII as `\uXXXX` escapes, so the encoder must too. Keep the script re-runnable with asserts on its anchors: when several changes land in parallel, the second one re-applies its script on top of the first. The shared shell in `ui.ts` provides fonts, colors, buttons, inputs and the sticker vocabulary; keep new pages inside it.

To look at what you changed: `npm run dev`, then `node scripts/dev-signer.mjs`, open `http://<name>.localhost:8787/`, paste the `window.nostr` snippet from that script into the devtools console, and sign in or claim. Playwright's CLI can drive the same loop: open the page, inject the snippet with `eval`, click, screenshot at a phone width and at a desktop width. `scripts/shot.mjs` renders a page over the Chrome debugging protocol when Playwright is not around.

Rules that hold across pages: no middle dots, no purposeless subtext, tables scroll inside their card on narrow screens, decorative elements are not selectable, a multi-field form uses the labelled grid rather than one row of inputs, and the copy above a block is one sentence.

## Screenshots

`node scripts/shot.mjs <url> <out.png> [width] [height]` renders a page with phone or desktop emulation over the Chrome debugging protocol and prints the layout's scroll width, which should equal the viewport width.

## Pull requests

Branch from `main`, push, open a pull request. CI must pass. Squash merge is the only merge mode; branches are deleted on merge.
