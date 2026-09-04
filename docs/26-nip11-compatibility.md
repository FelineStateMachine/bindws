---
title: NIP-11 identifier compatibility
audience: developer
---

# NIP-11 identifier compatibility

## Wire contract

bind.ws preserves the existing numeric `supported_nips` array by default.
`policy.letteredNips: true` opts into mixed numbers and lettered strings.
`features.push: true` also activates mixed output because NIP-9a requires
literal `9a` advertisement. Disabling both restores numeric-only output.
Existing numbers never become strings or hexadecimal conversions.

| Capability | Numeric-only mode | Mixed mode |
| --- | --- | --- |
| Existing numeric NIPs | Existing numbers and feature gates | Same numbers and gates |
| NIP-43 | `43` when relay identity exists | Same |
| NIP-5A | `nsites` while sites are enabled | Also `"5A"` while sites are enabled |
| NIP-9a | Push is off | `"9a"` while push is enabled |
| NIP-AD | Discovery endpoint remains available | `"AD"`; homepage discovery has no feature toggle |

Turning off sites removes `5A` and `nsites`, not `AD`: AD's page and site
mappings follow their feature/read gates, while its relay homepage mapping
remains implemented. NIP-AD is present in the main-branch baseline for this advertisement change.
GRASP keeps `supported_grasps`; Marmot and Blossom are separate protocol
families. None becomes an invented decimal NIP. In particular `5A` is not 90.

The [current NIP-11](https://github.com/nostr-protocol/nips/blob/656cecc7c0a815b6a2b218d3b5d6f078b3f4dbab/11.md#supported-nips)
still specifies integers. [PR 2218](https://github.com/nostr-protocol/nips/pull/2218)
is open at the checked revision
[`b4bad62ad44a900d6800e83c1f83549f2f705c33`](https://github.com/coracle-social/nips/blob/b4bad62ad44a900d6800e83c1f83549f2f705c33/11.md#supported-nips)
(2026-09-04). It proposes string identifiers and normalization of historical
integers. Mixed output is a deliberate transitional choice, not a claim that
the current integer-only specification has already changed.

## Concrete parser evidence

The following source revisions were inspected on 2026-09-04. Source behavior
is distinguished from testing a complete released application.

| Client/library | Evidence | Mixed vs all strings |
| --- | --- | --- |
| Installed nostr-tools 2.25.1 | [fetchRelayInformation](https://github.com/nbd-wtf/nostr-tools/blob/v2.25.1/nip11.ts) returns `response.json()` without validating or normalizing the array; its TypeScript declaration says `number[]`. An injected-response run of the installed implementation accepted both arrays. | Mixed `[1,11,77,"9a"]` preserves `.includes(77)`. All strings makes that numeric lookup false. Neither array is rejected by this fetch helper itself. |
| Amethyst | [Model at a22bc0d](https://github.com/vitorpamplona/amethyst/blob/a22bc0db14364a3192a69581d08631bfd4f82e04/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip11RelayInfo/Nip11RelayInformation.kt) uses a custom [FlexibleIntListSerializer](https://github.com/vitorpamplona/amethyst/blob/a22bc0db14364a3192a69581d08631bfd4f82e04/quartz/src/commonMain/kotlin/com/vitorpamplona/quartz/nip11RelayInfo/FlexibleIntListSerializer.kt): it reads each JSON primitive as text. Its serializer emits numeric identifiers as numbers and nonnumeric identifiers as strings. | Explicit parser support for numbers, strings and mixed arrays. This is stronger evidence than the model's `List<String>` declaration alone. |
| Damus | [RelayMetadata at 2ad6f02](https://github.com/damus-io/damus/blob/2ad6f02372b842def26ed193e027eebea0d5f111/damus/Core/Nostr/Relay.swift#L126) has `supported_nips: [Int]?`. [fetch_relay_metadata](https://github.com/damus-io/damus/blob/2ad6f02372b842def26ed193e027eebea0d5f111/damus/Features/Timeline/Models/HomeModel.swift#L1183) uses `JSONDecoder().decode(RelayMetadata.self, from: data)`. | Both mixed and all-string arrays fail this metadata decode. The integer-only Swift decoder shape was reproduced locally. This does not establish that WebSocket connectivity fails; the [negentropy path](https://github.com/damus-io/damus/blob/2ad6f02372b842def26ed193e027eebea0d5f111/damus/Core/Nostr/RelayConnection.swift#L306) tolerates a metadata fetch failure with `try?`. |
| Coracle / Welshman | [Coracle manifest at 544fe55](https://github.com/coracle-social/coracle/blob/544fe559e234942fec0e889cd6edcd8b7b1cf6e2/package.json) and [Welshman net 0.8.15 declaration](https://unpkg.com/@welshman/net@0.8.15/dist/util/src/Relay.d.ts) use string identifiers; the PR author reports support. | A declaration and maintainer report establish intent, not proof that every numeric lookup normalizes mixed input. No full-client run was performed. |
| Flotilla | [Fixtures at 801568d](https://gitea.coracle.social/coracle/flotilla/src/commit/801568d59091c05c87c2a49ff6ffa195bac1a0be/e2e/specs/settings.spec.ts) use string NIP arrays; the PR author reports support. | Evidence for string-array use, not an independent full-client mixed-array test. |
| Primal web | [Package at c96ee21](https://github.com/PrimalHQ/primal-web-app/blob/c96ee211043c6fee8a8b7c431746aab06392f765/package.json) uses nostr-tools 2.23.1. The inspected direct NIP-11 use reads a premium server version. | General relay capability handling remains unverified. A dependency version alone does not prove rejection or compatibility. |
| Rust nostr crate | [Pinned struct and decoder test](https://github.com/nostrdevkit/nostr/blob/0c6fad2ac8ce934747096953f6dba355e3532614/nostr/src/nips/nip11.rs) derives serde `Deserialize` with `Option<Vec<u16>>`. Its test rejects an array containing a string. | Both arrays containing `"9a"` and all-string arrays fail the integer decoder. This is a specific parser, not a claim about every Rust client. |
| Go fork inspected | [frnandu/go-nostr at fc34d8e](https://github.com/frnandu/go-nostr/blob/fc34d8e7a8c21647abe83c34a1bc731dae0a734e/nip11/types.go) uses `SupportedNIPs []any`. | The array field permits mixed values. Older `[]int` examples must not be used as evidence about this revision. Semantic numeric comparison still depends on the caller. |

The PR author also reports Zooid support; its parser was not independently
verified. These are representative libraries and clients, including clients
linked by bind.ws, not a universal compatibility certification. TypeScript
`number[]`, fixtures, or an `.includes(number)` test alone are not evidence
that a JSON document will be rejected at runtime.

## Why mixed output

All-string output changes every existing numeric capability lookup and still
fails strict integer decoders. Mixed output keeps numeric consumers working
where they accept arbitrary JSON values, including the installed nostr-tools
fetch helper. It cannot protect Damus metadata or strict serde decoding from
a lettered entry. The explicit numeric-only default prevents the existing,
default-on sites feature from unexpectedly changing every relay's wire type.

Operators who need strict-client metadata compatibility leave both push and
`letteredNips` off. Owners who need callback delivery accept the draft
advertisement tradeoff; other relay protocols remain usable according to each
client's handling of metadata failures. The console and
[NIP-9a relay push](25-nip-9a-relay-push.md) document this choice.
