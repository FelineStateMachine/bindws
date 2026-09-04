---
title: NIP-9a relay push
audience: developer
---

# NIP-9a relay push

bind.ws implements opt-in relay-to-callback delivery for community and inbox
notifications, Git activity and automation hooks. A callback can bridge to a
mobile notification service. bind.ws does not provide device registration,
FCM, APNs or Web Push infrastructure.

The implementation pins [proposal 2194](https://github.com/nostr-protocol/nips/pull/2194)
to [5a908b8dc5190a46eac47992cba5ba6d8e7fc094](https://github.com/coracle-social/nips/blob/5a908b8dc5190a46eac47992cba5ba6d8e7fc094/9a.md),
checked 2026-09-04. This is an unmerged draft; clients should periodically
resync their registrations and follow proposal changes.

## Enable delivery

The host operator sets `PUSH_CALLBACK_ORIGINS` to a JSON array of trusted,
public HTTPS origins in the selected Wrangler or celld environment. The
shipped value is `"[]"`, so no endpoint receives requests by default:

```json
"PUSH_CALLBACK_ORIGINS": "[\"https://push.example.com\"]"
```

The relay owner enables push and selects origins using the console's
Features settings, `setpolicy`, or a relay configuration:

```json
{
  "format": "bind.ws/relay-config/2",
  "policy": {
    "features": { "push": true },
    "pushCallbacks": ["https://push.example.com"]
  }
}
```

Both origin lists must authorize a callback. Owners cannot expand the host's
list. Entries are exact HTTPS origins without paths, credentials or wildcard
hosts; callback registrations supply the path and query. Only public DNS
names on port 443 are accepted. IP literals, local names, fragments and
redirects are refused. The host operator must trust the endpoint's operator
and DNS control and keep it publicly routed: the origin allowlist is the
SSRF boundary, not a DNS preflight that could race a later resolution. A host
must not approve arbitrary tenant-controlled origins or callback services
that proxy arbitrary destinations. No credentials or cookies are attached.

The existing templates keep push off. Templates with kind allowlists must
also allow kind `30390` before members can register. Outgoing traffic and
background work use the relay's fuel budget; queue storage is part of its
SQLite storage.

## Register and receive

The owner or a current member authenticates with NIP-42 and publishes a
signed addressable event. The HTTP bridge can instead authenticate the same
author using NIP-98. Ordinary relay write and kind restrictions still apply.

```json
{
  "kind": 30390,
  "content": "",
  "tags": [
    ["d", "community-inbox"],
    ["relay", "wss://community.bind.ws/"],
    ["filter", "{\"kinds\":[1,1111],\"#p\":[\"<recipient pubkey>\"]}"],
    ["ignore", "{\"#t\":[\"muted-topic\"]}"],
    ["callback", "https://push.example.com/opaque-secret-token"],
    ["include_event"]
  ]
}
```

For Git activity, filters can select accepted repository state or
collaboration events, for example `{"kinds":[30618,1617,1621]}`. Events held
pending Git admission do not trigger delivery until accepted. Filters match
new events only; registration does not backfill history. Multiple `filter`
tags are ORed, and any matching `ignore` suppresses delivery.

The callback receives `POST`, `Content-Type: application/json`:

```json
{
  "id": "<event id>",
  "relay": "wss://community.bind.ws/",
  "event": { "id": "<event id>", "pubkey": "...", "kind": 1 }
}
```

The actual `event` is the complete signed Nostr event and is present only
when the registration contains `include_event`. A receiver should verify
included signatures, treat URL tokens as secrets, and deduplicate by relay,
registration destination and event ID. The payload itself has no separate
relay signature. An ID-only notification still reveals an event's existence,
so it uses the same read authorization as full-event delivery.

## Privacy and revocation

Kind 30390 is author-only regardless of feature state. Authenticated authors
can read their own registrations through REQ, COUNT, NIP-77 and the HTTP
bridge, subject to the relay's current read rule. A `p` tag grants no access.
The relay owner has no special read override for another author's callbacks.
Registrations are excluded from shared dashboard views, dumps, forks and
rebroadcast jobs. Config exports contain origin policy, never registration
callback paths. Clients must export or resync their own registrations.

Every callback attempt rechecks the current registration, membership, bans,
write/read rules, callback approvals and target event visibility. Removing a
member deletes their registrations. Changing callback approval or read/write
policy cancels queued work. Hiding/deleting an event, replacing or
deleting a registration, or disabling push prevents later delivery. An
already dispatched HTTP request cannot be recalled. A `404` removes the
registration. NIP-09 deletions and NIP-62 vanish requests remove it through the
normal event store. The queue holds event and registration IDs, not copies
that could outlive deletion.

## Bounds and retries

Delivery runs from the existing Durable Object alarm, after publication has
returned. Queue persistence precedes external I/O. Delivery is best effort:
finite queues and retries can lose notifications, and ambiguous responses
can produce duplicates. Receivers must not assume exactly-once delivery.

| Limit | Value |
| --- | --- |
| Registrations | 32 per relay, 4 per author, 8 KiB UTF-8 each |
| Filters | 8 matching and 8 ignore filters; standard event fields/tag filters |
| Pending deliveries | 256 references, 24-hour expiry |
| Alarm batch | 4 attempts, 5 seconds per HTTP request |
| Retries | 4 total attempts; 30, 120 and 600 seconds between failures |
| Deduplication | 2,048 terminal outcomes, at most 7 days |
| Event input | Stored JSON up to 1 MiB characters; larger imported/HTTP events are skipped |
| Payload | 4 MiB plus 4 KiB envelope allowance; complete event when included |

Timeouts, network failures, 429 and 5xx responses retry; other non-2xx
responses end that delivery. Redirects are never followed. Attempts are
reserved durably before HTTP starts, so a crash also consumes an attempt.
A `404` deletes the registration. Response bodies are canceled unread.
Queue saturation drops new work instead of delaying event acceptance.
No successful registration promises unlimited delivery or an indefinitely
retained event payload. `include_event` always carries the full event for
accepted deliveries; ID-only callbacks can reduce traffic. `search`, `limit`
and unknown filter fields are rejected rather than silently broadened.

NIP-11 keeps existing identifiers numeric and includes literal `9a` while
push is enabled. The same mode includes enabled `5A` and implemented `AD`.
Some clients reject mixed arrays; see
[NIP-11 identifier compatibility](26-nip11-compatibility.md). Disable push
and `letteredNips` to restore numeric-only advertisement.

## Validation

The workerd object tests use a controlled callback receiver and injected
fetch boundary; they do not POST to public notification services. They cover
registration, asynchronous delivery, authorization changes, privacy across
read/export paths, callback failures, deletion and queue bounds. This proves
the relay payload and lifecycle contract, not interoperability with every
mobile push service. The callback service remains application infrastructure.
