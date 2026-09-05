# Vendored dependencies

`ntig-0.6.0.tgz` supplies Git pack validation, Smart HTTP and Nostr repository
policy wrappers. Bindws stores Git objects, refs and retry receipts in its
relay Durable Object's SQLite database. The package's R2 adapters remain
available to other ntig consumers; bindws does not use them for Git storage.

This local capacity extension preserves the indexed reader, lazy thin-pack
base resolution and authority behavior from the preserved 0.5.0 source. It
adds configurable transfer limits, streamed indexed downloads, incremental
hashing and the large-push HTTP probe. It includes the sibling checkout's
preexisting development changes; this is not an upstream registry release.

| Fact | Value |
|---|---|
| Source repository | [FelineStateMachine/ntig](https://github.com/FelineStateMachine/ntig) |
| Checkout base | `caa8258e6cf6ec3220b89312d66860258e096f0f`, plus the preserved 0.5.0 behavior and local changes |
| Source commit | [`52145156e06cd1d8e360c067bc0271f85d36dbd9`](https://github.com/FelineStateMachine/ntig/commit/52145156e06cd1d8e360c067bc0271f85d36dbd9) |
| Source archive | `ntig-source-0.6.0.tar.gz`; `SOURCE-SNAPSHOT.json` records the complete source file hashes |
| Package SHA-256 | `7d517c5acd0de2ecca044dc744a5af275ce3710089be698d9d3aa816c1aac94f` |
| Source archive SHA-256 | `9f6818e9e603fd1f383141f8a8a481371a08863fa351fddb5a8a73fc39b8e52a` |
| License | MIT, included in both archives |
| Library build | `npm ci --ignore-scripts`, then `npm run build:library` in the extracted source |
| Package build | `npm pack` in the extracted source |
| Library validation | Typecheck, full tests, package consumer/source-map/reproducibility checks |

The lockfile pins the package archive. The complete source and tests are
preserved beside it, so building requires neither a sibling checkout nor a
registry publication. `docs/INTEGRATION.md` describes the exported contracts.
The library's WAL and checkpoint documentation concerns its R2 backend.

Earlier versioned archives remain as provenance and rollback inputs.
Installing this package performs no data migration. Runtime defaults and
owner-configurable bounds are in [GRASP-01 Git hosting](../docs/22-grasp-01-git-hosting.md).
