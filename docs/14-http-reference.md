---
title: HTTP reference
audience: integrator
---

# HTTP reference

Every path the worker and a relay answer. Paths are on `https://<name>.bind.ws` unless marked apex. One read rule covers every door that shows events, files, names or presence: where the auth column says "the read rule", a relay whose reads are *anyone* answers without a signature, one whose reads are *signed in* takes any valid signature, and one whose reads are *members* takes a member's. Auth column: "NIP-98" is a signed request (see [Scripts and agents](13-scripts-and-agents.md)); "Blossom" is a kind 24242 token in the Authorization header; "none" is public. JSON errors carry `{ "error": "<prefix>: reason" }`; Blossom and NIP-96 errors also set an `X-Reason` header.

Any request with `Accept: application/nostr+json` answers the NIP-11 document, whatever the path. A websocket upgrade on any path opens the relay. A blocked address is refused with 403 on the socket and on the doors that write, read or serve files; the page, NIP-11 and management stay open.

## Apex

| Path | Method | Auth | Answers | Status |
|---|---|---|---|---|
| `/` | GET | none | the landing page | 200 |
| `/lease` | POST | NIP-98 optional | `{ name, url, console, expires_at, days, holder?, claim }`; a signature reserves the claim for that key | 201; 401 bad signature; 429 rate limited, five a minute per address, 60 overall; 503 no free name |
| `/favicon.svg` | GET | none | the icon | 200 |

## Relay page and information

| Path | Method | Auth | Answers | Status |
|---|---|---|---|---|
| `/` | GET | none | the console, one page for visitors and owner alike | 200 |
| `/` | GET with `Accept: application/nostr+json` | none | NIP-11: rules, limits, retention, `self`, `lease` while leased, `succession_pending` while warning | 200 |
| `/` | POST, `content-type: application/nostr+json+rpc` | NIP-98 | NIP-86 management, `{ result }` or `{ error }` | 200; 400 invalid; 401 bad signature; 403 not allowed; 409 conflict |
| `/people` | GET | none | `{ public, self, host, people }`, the members when the directory is public | 200 |
| `/terms` | GET | none | the join terms as a page | 200; 404 none set |
| `/signer.js` | GET | none | the NIP-46 client bundle, cached a week | 200 |
| `/favicon.svg` | GET | none | the icon | 200 |
| any | OPTIONS | none | CORS preflight | 200 |

## Bridge

Signed with NIP-98 over the exact URL, method and body. Same gates as a socket: the signer's bans, the read rule and the write rules apply, and the address is rate limited at four times the per-connection allowance.

| Path | Method | Body | Answers | Status |
|---|---|---|---|---|
| `/events` | POST | one signed event | `{ event_id, accepted, message }` | 200 accepted; 400 refused, the message says why |
| `/query` | POST | a non-empty list of filters | the events, newest first, up to the relay's query limit | 200; 400 bad filter; 403 read rule |
| `/count` | POST | a non-empty list of filters | `{ count }` | 200; 400; 403 |

## Files: Blossom

| Path | Method | Auth | Answers | Status |
|---|---|---|---|---|
| `/upload` | HEAD | Blossom `upload` | whether an upload with the `X-SHA-256`, `X-Content-Type` and `X-Content-Length` headers would be accepted | 200; 400 bad headers; 401; 403 the write gate; 411 no length; 413 too big |
| `/upload` | PUT | Blossom `upload` | the descriptor with `nip94` tags | 200 exists; 201 stored; 400; 401; 403 gate or a removed hash; 413 |
| `/mirror` | PUT | Blossom `upload` | copies the blob at `{ "url": ... }` from another server, the descriptor | 200 exists; 201 stored; 400; 401; 403; 409 hash mismatch with the token; 413; 502 origin failed |
| `/report` | PUT | none, the body is a signed kind 1984; the reporter must pass the read rule | files a report for each `x` tag the relay holds | 200; 400 bad event or older than an hour; 401 reporter must sign in under a read rule; 403 unclaimed relay, banned reporter or reporter not admitted by the read rule; 404 no such blob |
| `/list/<pubkey>` | GET | the read rule: none while reads are open, else Blossom `list` or NIP-98 | that uploader's descriptors | 200; 400 bad pubkey; 401; 403 |
| `/<sha256>[.ext]` | GET, HEAD | the read rule: none while reads are open, else Blossom `get` or NIP-98 | the blob, ranges honoured; not cacheable by shared caches when gated | 200; 206; 401; 403; 404 |
| `/<sha256>` | DELETE | Blossom `delete` | removes it; the uploader or the owner | 204; 400 token names another blob; 401; 403; 404 |

## Files: NIP-96

The same bucket and file list through the NIP-96 shape. Answers are `{ status, message, ... }` and errors set `X-Reason`.

| Path | Method | Auth | Answers | Status |
|---|---|---|---|---|
| `/.well-known/nostr/nip96.json` | GET | none | `api_url`, `download_url`, `supported_nips`, content types, the free plan with the size cap | 200 |
| `/nip96` | POST, multipart with a `file` field, optional `size` and `caption` | NIP-98, `payload` is the file's hash | the NIP-94 event in `nip94_event` and the Blossom URL | 200; 400; 401; 403; 413 |
| `/nip96?page=&count=` | GET | NIP-98 | the caller's files | 200; 401 |
| `/nip96/<sha256>` | GET, HEAD | the read rule, as the Blossom path | the blob, same as the Blossom path | 200; 401; 403; 404 |
| `/nip96/<sha256>` | DELETE | NIP-98 | removes it; the uploader or anyone with the storage action | 200; 401; 403; 404 |

## Pages and feed

Only while reads are open. Otherwise every path here answers 404, and an unclaimed relay answers 404 too. Cached five minutes.

| Path | Method | Answers |
|---|---|---|
| `/e/<id>` | GET | a note as a page with Open Graph tags |
| `/a/<d>` | GET | the owner's article with that identifier |
| `/a/<npub or hex>/<d>` | GET | anyone's article |
| `/feed.xml` | GET | Atom, the newest 50 notes and articles; `?kinds=1` or `?kinds=30023` to pick one, `?author=<hex>` for one person |

## Card and QR

| Path | Method | Answers | Status |
|---|---|---|---|
| `/card.json` | GET | `name`, `state`, `url`, `console`; on a claimed relay also `description`, `icon`, `owner`, `self`, `members` when the directory is public, `reads`, `writes`, `fuel`, `naddr`, `nprofile` (the owner with this relay as the hint), `signed_url`, `image`; a lease adds `expires_at` | 200 |
| `/card.nostr` | GET | the same facts as a kind 30078 signed by the relay's key | 200; 404 no owner |
| `/card.svg` | GET | a 600 by 315 picture with the naddr as a QR | 200 |
| `/qr.svg?text=` | GET | any text up to 512 bytes as a QR | 200; 400 empty; 413 too long |

## People, invites and names

| Path | Method | Auth | Answers | Status |
|---|---|---|---|---|
| `/.well-known/nostr.json?name=` | GET | none for a name; the directory switch for the listing without one, else NIP-98 by a member | NIP-05 for the member with that name, with this relay as their relay; without a name, every named member when the directory is public | 200; 401 bad signature |
| `/invite/<code>` | GET | none | the invite page, with the join terms | 200 |
| `/api/join-policy` | GET | none | `{ terms }` | 200 |
| `/api/invites/claim` | POST `{ "code": ... }` | NIP-98 | `{ status: "joined" }` or `{ status: "already_member", role }` | 200; 400; 401; 403 invalid, used up or expired, or banned |

## Dumps

| Path | Method | Auth | Answers | Status |
|---|---|---|---|---|
| `/dumps/<name>.jsonl` | GET | NIP-98 with the storage action | the dump, one event per line | 200; 400 bad name; 401; 403; 404 |

## Fuel

| Path | Method | Auth | Answers | Status |
|---|---|---|---|---|
| `/fuel` | GET | none | meters, allowances, prices and balance; who zapped is in the `stats` management method | 200 |
| `/fuel/invoice` | POST `{ "zapRequest": <kind 9734> }` | none | `{ invoice, providerPubkey, msats }` from the lightning provider | 200; 400 bad request or amount; 502 provider |

## Views

| Path | Method | Auth | Answers | Codes |
|---|---|---|---|---|
| `/view/<name>` | GET | none for a public view; NIP-98 by a member for a members-only one; `zaps`, `moderation`, `calendar`, `articles` and `presence` follow the read rule, `profiles` and `relays` the directory switch | the view's latest signed kind 30078 record as JSON, or presence as a kind 20078 from memory | 200; 401 `auth-required:` when a members-only view is asked for without a signature; 403 when the signer is not a member; 404 when the view is off, unknown, or has not run yet |

Names: `profiles`, `relays`, `calendar`, `moderation`, `articles`, `zaps`, `presence`. The information document lists the ones a relay keeps under `views`, with each one's kind, `d`, trigger and audience.

## Websocket

The relay itself: `wss://<name>.bind.ws`. NIP-01 with 09, 13, 17 and 59 as private kinds, 29 and 43 for the group, 40, 42, 45, 50, 56, 62, 66 as a kind 30166 record signed by the relay about itself, 70 and 77, an `AUTH` challenge on connect, and `EOSE` hints per NIP-67. Kind 24133 passes the write and read rules so a NIP-46 signer or client can use the relay as transport: it is delivered to a socket that has proved a party's key with `AUTH`, or to a subscription that names one in `#p` or `authors`, and never to a bare subscription to the kind.
