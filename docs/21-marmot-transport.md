---
title: Marmot transport
audience: user
---

# Marmot transport

Status: `adopted` by [Marmot commit 4a2bc65f8db5866cec3b2a127dedb37818eaf207](https://github.com/marmot-protocol/marmot/tree/4a2bc65f8db5866cec3b2a127dedb37818eaf207), last checked 2026-09-04.

Marmot relays carry MLS bytes in two Nostr event kinds. Kind `30443` publishes
an account's KeyPackage as an addressable event. Kind `445` carries an opaque
encrypted group message and routes it with one `h` tag containing the random
32-byte group id. The relay checks the signed envelope and leaves MLS
verification to clients.

The transport is off on a fresh relay. You enable it with **Marmot**,
**Marmot members** or `setpolicy` with `{"features":{"marmot":true}}`.
Both templates allow kinds `10002`, `10050`, `1059`, `30443` and `445`, which are the
account relay list, inbox list, gift wrap, KeyPackage and group message paths.

Choose **Marmot** for public opaque transport: anyone can publish, including
group envelopes without account authentication. Choose **Marmot members**
when you admit the publishers. Add their account npubs on the People tab;
their clients authenticate with NIP-42 before publishing group envelopes.
Both templates keep encrypted messages publicly readable and retain the
recipient checks on gift wraps. Relay membership controls who writes; your
clients control who belongs to an MLS group and holds its decryption keys.

**Marmot members** charges each envelope against its authenticated account's
member limits. Both templates use the relay owner's existing fuel allowance
and balance for storage and metered work; neither sets a new price or cap.
Other feature settings stay as they are.

Kind `445` uses a fresh ephemeral author, so that author is not a membership
identity. An open relay may accept it anonymously. A relay with an allowlist,
web of trust or owner-only write rule requires the socket to authenticate an
account that can write. That account's member limits apply to the envelope.
Per-connection and per-address event limits, bans, proof of work, fuel and the
ordinary kind allow and block rules still apply.

The `h` exception is limited to kind `445`. NIP-29 events continue to use the
relay slug and a foreign slug remains blocked. Gift wraps remain private under
the existing NIP-59 party checks. The relay does not unwrap kind `1059`, infer
the kind `444` rumor inside it, or try to decrypt kind `445`.

The implementation validates the exact required tag cardinality. KeyPackage
events require the `d`, `mls_protocol_version`, `i`, four MLS id-list tags and
the account identity proof component. Group messages require one lowercase
64-character `h` value and allow only an optional NIP-40 expiration tag.
Content is padded standard base64 and remains opaque after this check.
