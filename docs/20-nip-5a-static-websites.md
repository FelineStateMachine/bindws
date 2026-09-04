---
title: NIP-5A static websites
audience: user
---

# NIP-5A static websites

Status: `draft` and `optional` upstream. bind.ws follows [`5A.md` at
commit 5d6b432267d4046464490b1923b96844ac4559d0](https://raw.githubusercontent.com/nostr-protocol/nips/5d6b432267d4046464490b1923b96844ac4559d0/5A.md),
last checked 2026-09-04.

## Use a relay as a site host

NIP-5A stores a website as a signed Nostr event. Each `path` tag maps an
absolute filename to the SHA-256 hash of a file on Blossom. The relay stores
the event and files, then serves the site from a single-label hostname.

| Kind | Address | Purpose |
|---|---|---|
| 15128 | `https://<npub>.bind.ws` | author's root site |
| 35128 | `https://<pubkeyB36><dTag>.bind.ws` | named site |
| 5128 | `https://v<snapshotIdB36>.bind.ws` | manifest snapshot |

Publish with an existing NIP-5A client such as nsyte or nsite-cli. The relay
does not provide a publishing CLI. A path must be an absolute filename with
an extension and a lowercase 64-character SHA-256 hash. The optional `x` tag
is checked against the order-independent aggregate of the `path` tags.

The `pubkeyB36` and `snapshotIdB36` portions encode the 32-byte value in
lowercase base36 and are exactly 50 characters wide. This fixed width keeps
leading zero bytes, resolving the draft's conflict between "no padding" and
"always exactly 50 characters." Kind 34128 is deprecated by NIP-5A and is not
hosted by the NIP-5A site door; generic relay event policy may still accept it.

Directories select `index.html`: `/` selects `/index.html`, and `/blog/`
selects `/blog/index.html`. A missing path selects the site's `/404.html` when
present and otherwise returns 404. A missing manifest, missing file, hash
mismatch, unavailable blob, or failed remote fetch returns a plain 404.
Responses forward the stored content type and length, use the blob hash as the ETag,
and verify the blob before serving it. `Cache-Control: no-transform` keeps
intermediaries from changing the verified representation or its validators.

The relay's Rules > Reads setting applies to sites. Open reads make a site
public; signed-in and members-only reads require the same admission as the
relay's other read doors. Site hosting is enabled by default and can be
switched off under the `sites` feature. NIP-40 `expiration` and the relay's
retention policy determine lifetime.

Snapshots copy the source `path` tags, carry one matching aggregate `x` tag
and one `a` tag naming the source. Copies retain their immediate parent in
`a` and their lineage origin in `A`.

## Sign-in

When your relay's read rule admits everyone, site requests are public. When
the rule requires sign-in, a browser GET that accepts HTML receives a NIP-07
sign-in page. The page creates a five-minute challenge and asks your browser
signer to sign kind 22242 with the site origin and challenge. It then posts
that event as JSON to `/.well-known/nsite/auth`, with an exact NIP-98 proof for
the POST URL, method and body.

After verification, your relay signs a host-only `__Host-nsite` cookie. The
cookie is Secure, HttpOnly, SameSite=Lax, and lasts seven days. Every site
request checks the cookie against the current read rule. API clients can use
an exact NIP-98 Authorization header directly. Passwords are not part of the
site protocol.

## Relay additions

The NIP-11 information document exposes an `nsites` object while site hosting
is enabled:

```json
{
  "host": "bind.ws",
  "kinds": [15128, 35128, 5128],
  "root": "https://<npub>.bind.ws",
  "named": "https://<pubkeyB36><dTag>.bind.ws",
  "snapshot": "https://v<snapshotIdB36>.bind.ws"
}
```

The relay keeps a KV index from each site label to the relay holding its
manifest. It also mirrors missing blobs into its own bucket when
`sites.mirror` is on (the default), checking hashes before storing them.
Mirroring is one job per manifest. It tries up to ten `server` tags from the
manifest and then up to ten servers from the author's kind 10063. Sources
must be public HTTPS URLs (or a local sibling relay), redirects are checked
again, credentials are never forwarded, and the size cap is the smaller of
the relay's `maxBlobMB` and 32 MiB. Bad hashes, failed checks, and oversized
files are never stored. Remote bytes and served bytes appear in the traffic meters but have no fuel
price. Stored mirrors share the file allowance; request work contributes to
the relay's estimated awake-time meter.

If mirroring is disabled, the site door still proxies a cache miss using the
same checks and cap. A file is retried at most three times; a failed job stops
and can be rerun. Deleting or replacing a manifest stops its pending mirror
work. A local R2 blob is also available through the relay's implicit Blossom
provider, so a manifest need not contain server tags.

Sites have their own origin. A site hostname reaches only the site door and
does not expose the relay console, websocket, management methods or Blossom
API. A custom domain may be pointed at a relay or one of its sites from the
owner's domain controls; the same read rule remains in force. The management
calls are `adddomain(host, site?)` and `setdomainsite(host, site?)`, where an
omitted or empty site selects the relay itself. `listdomains` returns the
selected site label. The console offers relay, root, named-site and snapshot
destinations.

The edge mapping may remain cached for up to 60 seconds. The local record
checks that the selected site still exists before it serves a request, so a
stale mapping cannot serve a removed target.

Manifest replacements coalesce into one index write per hostname in each
outbox batch. The route stays present while a throttled write waits for a
retry; replacing a manifest does not delete and recreate its hostname.

## Deliberate limits

Supporting Nostr clients can resolve a hosted site URL through
[NIP-AD web addresses](23-nip-ad-web-addresses.md). Discovery maps existing
site paths to the live manifest under the same site authentication and read
rules, with the hosting relay as its hint. Custom site domains retain their
site origin; discovery does not open the hosting relay's other HTTP doors.

bind.ws advertises `5A` in `supported_nips` when sites are enabled and the
owner opts into lettered NIP identifiers (or enables relay push). Numeric
entries keep their JSON number type. `nsites` remains available while sites
are enabled, including in the default numeric-only mode. Some clients reject
lettered entries; see [NIP-11 identifier compatibility](26-nip11-compatibility.md).
`5A` is a literal identifier, never decimal 90.

The implementation tracks upstream changes to the label grammar, aggregate
hash, snapshot and copy tags, and the status of kind 34128. If those change,
the parser, host templates and this document must change together.
