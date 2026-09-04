---
title: GRASP-01 Git hosting
audience: user
---

# GRASP-01 Git hosting

GRASP-01 gives a relay an optional Git Smart HTTP door. A repository owner
publishes the NIP-34 repository announcement and its current state on the
relay; the relay serves the Git objects that belong to that accepted state.
The Nostr relay remains the source of authorization and discussion events.

This document tracks the GRASP-01 specification at [commit
f35b4f9a4ed2f0aaaf46926e4b1733c79e21b377](https://github.com/DanConwayDev/grasp/tree/f35b4f9a4ed2f0aaaf46926e4b1733c79e21b377),
checked on 2026-09-04. The implementation is bounded to the core service. It
does not claim GRASP-02 proactive sync,
GRASP-03 discussion sync, GRASP-05 archive, GRASP-06 alternative PR hosting or
GRASP-08 private repositories.

## Turn it on

The `grasp` feature is off unless the owner enables it. The **Git repositories** preset
turns on open reads and the GRASP Git door. The repository still applies its
ordinary fuel, storage and event rules, and the information document lists
the exact acceptance criteria. The relay advertises `GRASP-01` in
`supported_grasps` only while the feature is on and reads are open, because
GRASP-01's Git service is public.

The [relay templates](../relay-templates/README.md) include a GRASP template
for a relay whose public purpose is hosting NIP-34 repositories. A template
does not add members, bans or addresses. The owner supplies those separately
when the relay's event policy requires them.

## Announce a repository

The repository owner publishes a kind 30617 event with a `d` identifier,
`clone` URLs and `relays` URLs. An announcement that hosts a repository
here must list this service in both lists. A companion announcement
from an already recognized maintainer may omit those service tags because the
repository is already hosted here. The service URL is the relay's HTTPS Git
endpoint and its WebSocket relay URL. The identifier is percent-encoded in the
Git path:

```
/<npub>/<percent-encoded-identifier>.git
```

The relay accepts the announcement only after its normal signature, ban,
fuel, size and event policy checks. A malformed identifier, URL or maintainer
key is refused. A repository's `private` tag does not make a private Git door;
private repository hosting is GRASP-08 and remains outside this feature.

The accepted announcement's address is
`30617:<owner-pubkey>:<identifier>`. NIP-34 issues, patches, pull requests and
updates that refer to an accepted address can be stored by the normal relay
rules. An event that has no accepted repository relationship remains subject
to the ordinary policy.

## Publish a state

The repository maintainer publishes a kind 30618 event with the same `d`
identifier, a `HEAD` tag and the complete `refs/heads/*` and `refs/tags/*` map.
The [NIP-34 HEAD tag](https://github.com/nostr-protocol/nips/blob/master/34.md#repository-state-announcements)
uses `["HEAD", "ref: refs/heads/main"]`; a bare branch path is refused.
The latest valid state is selected by NIP-34 addressable-event ordering among
the owner and the recursive maintainer set. The recursive set starts at the
owner and follows the maintainer announcements for that repository, with
bounded depth and membership limits.

The Git door accepts a normal branch or tag update only when each changed ref
and the requested HEAD agree with the accepted state. Unchanged refs remain
untouched, so a push does not need to repeat the entire state map. The state
event therefore authorizes the bytes a push makes visible; a maintainer
signature alone does not authorize an arbitrary branch. A state with no HEAD
represents an unborn repository. A pending state keeps the previously
materialized branch and HEAD in the Git repository, so a stock clone still
checks out the prior branch. The repository moves to the new HEAD when the
new tip's objects arrive.

## Pull requests and purgatory

Promotion checks for relevant pending events before loading Git packs. An
empty queue or another repository's pending work does not trigger that read.
A retried Git write still completes any pending promotion left by an earlier
successful publication; expiry and authority are checked again after reads.

A pull request or update can name a Git ref as
`refs/nostr/<event-id>`. The event ID is checked as a 64-character lowercase
hex value. The relay can hold the event and the Git data while it waits for
the other half of the pair. Until both are present, the event is not served
from the normal read path and the response explains
`purgatory: won't be served until git data arrives`. Unresolved entries expire
after 30 minutes.

The relay accepts every syntactically valid `refs/nostr/<event-id>` push,
including one whose Nostr event has not arrived yet. It rejects a ref whose
known event names a different tip. A pending PR ref that has no accepted PR
or PR update with a matching `c` tag is hidden and eligible for cleanup after
20 minutes. The cleanup window limits abandoned uploads and does not implement
the broader archive or sync behavior of later GRASP documents.

## Git HTTP

Your relay's **Connect** section includes a copyable `git clone` example with
its own hostname, the repository owner's npub and repository name.
**Open in app** opens this relay's repositories in
[GitWorkshop](https://gitworkshop.dev/), alongside a copyable relay URL.
Both Git connections stay hidden when Git hosting is unavailable.

The Git door is unauthenticated when the relay's reads are open. It serves
Git Smart HTTP at the repository path and returns a repository page or a 404
for a path that is not hosted. Upload-pack advertises and serves
`allow-reachable-sha1-in-want`, `allow-tip-sha1-in-want` and `filter`, including
`blob:none` and `tree:0` requests. Receive-pack applies the accepted state,
maintainer and `refs/nostr` rules before storing anything.

The relay root, Git repository page and protocol responses include the GRASP
CORS headers. `OPTIONS` returns 204. GET and POST are the allowed methods;
`Content-Type`, `Authorization`, `Git-Protocol` and `X-Git-Request-Id` are
allowed request headers. The NIP-5A site origins remain isolated from relay
events and repository data.

The Worker depends on the `ntig` package, whose source and package artifact
are recorded in [Vendored dependencies](../vendor/README.md). Its object-store seam validates pack
structure, deltas, object dependencies, trees and commits before publication.
The hard limits are:

| Scope | Limit | What it controls |
|---|---:|---|
| Relay | 16 repositories, 320 MiB Git storage | accepted repositories and billed retained Git objects across the relay |
| Repository | 4 MiB per pack, 16 MiB packed history | one upload and the aggregate packed history read into memory |
| Repository | 1,024 refs, 4,096 objects | ref maps and verified object graphs |
| Format 1 | 128 transactions | legacy WAL replay |
| Format 2 | 128 unique packs, 2 MiB manifest | explicitly migrated repository metadata |

ntig 0.3.0 reads both formats, but installing it leaves existing roots alone
and new repositories still use format 1. Bindws exposes no checkpoint action
or scheduled migration. The backend's explicit `checkpoint()` upgrade is
one-way: every reader and writer must support format 2 before an isolated
repository is migrated. Versions 0.1.x cannot read the upgraded root.
Migration retains old data and receipts; it does not reclaim storage. Bulk
construction publishes the final receipt-index nodes without storing each
intermediate index from the migration. Existing roots are unchanged.

Format-2 ref advertisements read the root and manifest without downloading
packs. They retain the same accepted HEAD and hidden PR rules. Full clone,
fetch and push still load the stored packs; selective object reads,
compaction, orphan collection, large-pack streaming and production capacity
measurements remain follow-up work. Once a format-1 repository reaches its
transaction limit, all further Git writes are refused, including
the timed cleanup transaction. An expired unknown PR ref therefore stays
hidden when cleanup cannot commit, while immutable WAL history keeps its old
object bytes billed until the relay is torn down. The same retention behavior
applies when a ref is cleaned after its 20-minute window.

Each Git HTTP request reuses immutable object bytes within its existing
authority fence. The read session retains at most 2 MiB of payload and 512
entries; larger objects are read normally. Roots are never cached, every
write still passes through storage reservations, and each new request
rechecks authority. The session closes on return or error. This bounds the
cache, not total request memory, and does not skip Git validation or pending
promotion.

The owner can request `gitstorage <repository-owner-hex> <identifier>` through
the management API to compare physical Git objects with quota reservations.
The report breaks storage down by object class and distinguishes current-root
references, unreferenced objects and unknown keys. Unreferenced bytes are not
safe-to-delete bytes: readers and unpublished writes can still need them.
The scan does not change roots, reservations or stored objects.

Scans run manually with fixed read limits and a 60-second cooldown per live
relay instance. A restart resets that cooldown. A limit, corrupt dependency or
changed root returns an error rather than a partial report. Git requests,
event writes and configuration changes receive a retry response while a scan
owns the relay. See [HTTP reference](14-http-reference.md) for the method and
[Costs and margins](15-costs-and-margins.md) for its host costs and limits.

## Information document and limits

When GRASP is on and reads are open, NIP-11 includes:

| Field | Meaning |
|---|---|
| `supported_grasps` | `GRASP-01` for this service |
| `repo_acceptance_criteria` | the required NIP-34 announcement, relay listing, maintainer and state checks, plus ordinary relay policy |
| `curation` | omitted unless the owner applies curation beyond generic spam, bans or fuel rules |

NIP-11 does not list GRASP-02, GRASP-03, GRASP-05, GRASP-06 or GRASP-08. A
relay's regular read rule still governs the Nostr side, and turning GRASP off
removes its Git door and advertisement without changing the NIP-5A site
origins.

## Limits under load

One Git operation runs at a time for a relay. The operation fence also blocks
relay-side event and control mutations while a Git transaction reads or
writes its object graph. This bounds Worker memory and keeps the WAL root and
the relay's authority view from changing underneath one operation.

Git requests consume the relay's normal address rate limits. A busy fence or
rate limit answers `429` with a retry reason. Fuel exhaustion, an unclaimed
relay, a restricted read rule or a repository limit answers a `restricted:`
response. A caller retries after the stated condition clears; it does not
assume that a rejected receive-pack changed refs.

## What this does not promise

GRASP-01 does not synchronize repositories between relays, fetch Git data
hourly, host private repositories, accept PRs for an unannounced repository,
or preserve an archive after ordinary retention. Those behaviors belong to
the later GRASP specifications and need separate storage and policy work.
The repository's Git object store is an implementation detail; clients rely on
the NIP-34 events and the GRASP HTTP contract, not on a particular backend.

See [Your relay on the web](05-your-relay-on-the-web.md) for the user-facing
site and domain doors, [Architecture](10-architecture.md) for the Worker and
Durable Object boundaries, and [HTTP reference](14-http-reference.md) for the
exact request paths and statuses.
