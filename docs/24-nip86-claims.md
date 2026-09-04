---
title: NIP-86 membership claims
audience: developer
---

# NIP-86 membership claims

bind.ws implements the claim management methods in [NIPs proposal #2408](https://github.com/nostr-protocol/nips/pull/2408), pinned to [dcf5af03aacd5ca9c70c51448e32f60477f6ac34](https://github.com/nostr-protocol/nips/commit/dcf5af03aacd5ca9c70c51448e32f60477f6ac34), checked on 2026-09-04. The proposal is open. Its [NIP-86 text](https://github.com/nostr-protocol/nips/blob/dcf5af03aacd5ca9c70c51448e32f60477f6ac34/86.md) defines caller-chosen NIP-43 invitation codes, not relay ownership.

## Calls

These methods use the existing signed HTTP management endpoint: `POST /`, content type `application/nostr+json+rpc`, with NIP-98 authentication. [Scripts and agents](13-scripts-and-agents.md#signing-a-request-nip-98) shows signing and RPC helpers. `supportedmethods` includes all three names.

| Method | Parameters | Result |
|---|---|---|
| `listclaims` | `[]` | An array of usable code strings, such as `["friends-2026"]` |
| `createclaim` | `["friends-2026"]` | `true` |
| `deleteclaim` | `["friends-2026"]` | `true` |

The result is wrapped in `{ "result": ... }`. Invalid calls return HTTP 400 with `{ "error": "invalid: ..." }`; an existing code returns a `duplicate:` error. A missing or bad signature returns 401, and insufficient permission returns 403.

For the `rpc` helper in Scripts and agents:

```js
await rpc("createclaim", "friends-2026"); // { result: true }
await rpc("listclaims");                 // { result: ["friends-2026"] }
await rpc("deleteclaim", "friends-2026"); // { result: true }
```

## Existing invitation rules

The proposal does not specify expiry, use limits or a code alphabet. bind.ws keeps its invitation constraints:

| Rule | Behavior |
|---|---|
| Chosen code | Exactly one string, 4 to 64 ASCII letters, digits, dashes or underscores; case-sensitive. An existing record, even expired or exhausted, prevents creation until revoked or cleaned up. |
| Lifetime | Three days from creation, using the existing default. The expiry second itself is still valid. |
| Uses | Unlimited until expiry or revocation, using the existing default. |
| Listing | At most 200 usable codes, newest first with code as the tie breaker. Expired, exhausted and revoked codes are absent. Creator and liveness filters run before the cap. There is no pagination in this proposal. |
| Permission | Owners and moderators manage all codes. Plain members manage only their own codes when `memberInvites.depth` is positive. Creation also requires room in the shared live-invite quota and tree depth. |
| Deletion | Revokes the shared invite record. Owners and moderators receive `true` even if it is absent. Members receive 403 for another person's or an unknown code. |
| Audit | Successful creation and deletion use the normal moderation log, with the method name and code. Listing is not logged. |

`createinvite(ttlSeconds, maxUses, note)` remains the API for a generated code, custom lifetime and use count. `listinvites` keeps its existing detailed records, including expired and exhausted entries, and `revokeinvite` keeps its boolean indicating whether a row existed. Codes created by these methods or NIP-29 kind 9009 appear in `listclaims` while usable; either revocation API invalidates them. All issuance paths count toward the same member quota.

## Joining and compatibility

There is one `invites` table and one member tree. A code created through `createclaim` works with a NIP-43 kind-28934 join request using `["claim", "friends-2026"]`, a NIP-29 join using a `code` tag, or the HTTP invite link `https://<relay>/invite/friends-2026`. Joining records the issuer as `invitedBy`. Existing bans, signature checks and join behavior apply. Revoking a code prevents future joins; it does not remove existing members.

The pinned proposal replaces NIP-43's old kind-28935 invite-request section with NIP-86 `createclaim`. bind.ws did not generate those kind-28935 replies. No legacy issuer is removed or added, and existing invite management and join clients continue to work.

The bind.ws `claim` method still assigns ownership of an unclaimed relay. `createclaim` requires invitation permission on an owned relay and never assigns ownership. No role assignment or broader NIP-29 permission changes are part of these methods.
