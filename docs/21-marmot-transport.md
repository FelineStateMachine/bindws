---
title: Marmot transport
audience: developer
---

# Marmot transport

Marmot relays carry MLS bytes in two Nostr event kinds. Kind `30443` publishes
an account's KeyPackage as an addressable event. Kind `445` carries an opaque
encrypted group message and routes it with one `h` tag containing the random
32-byte group id. The relay checks the signed envelope and leaves MLS
verification to clients.

The transport is off on a fresh relay. An owner enables it with the Marmot
template or `setpolicy` with `{"features":{"marmot":true}}`. The template
also allows kinds `10002`, `10050`, `1059`, `30443` and `445`, which are the
account relay list, inbox list, gift wrap, KeyPackage and group message paths.

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
