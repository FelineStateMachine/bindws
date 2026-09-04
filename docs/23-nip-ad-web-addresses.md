---
title: NIP-AD web addresses
audience: user
---

# NIP-AD web addresses

A relay or site URL works in a browser and resolves to a Nostr event in
clients that support NIP-AD. bind.ws follows [proposal 2406](https://github.com/nostr-protocol/nips/pull/2406),
[`AD.md` at b82a9bf66ec9757149b5aa3b3cd36190dd4e6fed](https://github.com/nostr-protocol/nips/blob/b82a9bf66ec9757149b5aa3b3cd36190dd4e6fed/AD.md),
checked 2026-09-04. The proposed text labels itself `final` and `optional`,
but the pull request is still a proposal. Its wire format may change.

## Resolve a URL

A supporting client takes the URL's pathname and requests
`https://<host>/.well-known/nostr.json?path=<encoded-pathname>`. Encode the
pathname as a query parameter, preserving any escapes already in the URL:
`/a/hello%20world` becomes `path=%2Fa%2Fhello%2520world`.

For `https://alice.bind.ws/a/why-relays`, the response has this shape:

```json
{
  "/a/why-relays": {
    "filter": {
      "kinds": [30023],
      "authors": ["<owner-pubkey>"],
      "#d": ["why-relays"],
      "limit": 1
    },
    "relays": ["wss://alice.bind.ws"]
  }
}
```

The client queries the named relay with that filter. A browser opening the
original URL continues to receive the existing page. Notes and articles
also have an "Open in a nostr client" link.

| Browser URL | Nostr counterpart |
|---|---|
| Relay `/` | Relay-signed kind 39000, with the relay identity and group identifier |
| Relay `/e/<id>` | That exact note or article event ID, including its version |
| Relay `/a/<d>` | Owner's current kind 30023 article with that identifier |
| Relay `/a/<author>/<d>` | That author's current article; hex, npub and nprofile authors follow the browser page parser |
| Site `/`, a mapped file or directory | Current kind 15128 or 35128 manifest, or exact kind 5128 snapshot |

All filters include `limit: 1` and explicit relay hints. Address filters
include the full author, kind and, for addressable events, `#d`. Event ID
filters use the full ID. Site hints name the relay holding the manifest,
not the site hostname. Custom domains follow their selected relay or site;
local development retains `ws://` and its port.

## Visibility and errors

Discovery applies the target's existing access rules:

| Target | Rule |
|---|---|
| Relay group | Current read rule; private metadata requires an admitted NIP-98 identity |
| Note or article | Open reads and the `pages` feature; signing does not open private pages |
| Site manifest | `sites` feature, site authentication and the current read rule |
| Removed, expired or moderation-hidden event | No mapping |
| Unclaimed or expired relay | No mapping |

Successful lookups return only the requested path. Unknown paths return
`{}`; discovery does not return the member directory or enumerate paths.
Site paths must appear in the live manifest, directly or as a directory's
`index.html`. A `/404.html` fallback does not give a missing path a mapping.
Discovery reads manifest metadata without fetching or verifying file bytes;
the normal site request still verifies and serves the file.

Private group and site requests return 401 without authentication or 403
for a proved identity the read rule excludes. Site visitors retain the
existing sign-in flow and host-only cookie; API clients can sign the exact
discovery URL with NIP-98. Site-origin discovery never exposes the hosting
relay's NIP-05 names, console, WebSocket, event pages or management methods.
Blocked IP addresses remain blocked.

GET returns JSON, HEAD returns the same status and headers without a body,
and OPTIONS supports discovery preflight without resolving a path.
Discovery responses use CORS and
`Cache-Control: private, no-store` so policy changes are checked each time.
Unsupported methods return 405. Invalid GET or HEAD paths return 400: only one absolute
pathname of at most 4096 characters is accepted, without literal queries,
fragments, whitespace, control characters, backslashes or dot segments.
Percent-encoded spaces and other article identifier characters work when
the pathname is correctly query-encoded. Full URLs are not accepted and
discovery never fetches an external URL.

## Names and capabilities

The existing NIP-05 endpoint keeps its behavior. With `name`, including a
request that also has `path`, it answers the name lookup. Without either
parameter it answers the permitted member directory. Turning off `names`
disables those NIP-05 responses; path discovery remains available. Turning
off `pages` or `sites` removes their respective mappings.

This implementation leaves the NIP-11 `supported_nips` representation
unchanged. Lettered capability advertisement is coordinated separately
with NIP-9a and NIP-5A compatibility work.
