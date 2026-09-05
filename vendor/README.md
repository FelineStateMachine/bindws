# Vendored dependencies

`ntig-0.6.1.tgz` supplies Git pack validation, Smart HTTP and Nostr repository
policy wrappers. Bindws stores Git objects, refs and retry receipts in its
relay Durable Object's SQLite database. The package's R2 adapters remain
available to other ntig consumers; bindws does not use them for Git storage.

This local capacity extension preserves the indexed reader, lazy thin-pack
base resolution and authority behavior from the preserved 0.5.0 source. It
adds configurable transfer limits, streamed indexed downloads, incremental
hashing and the large-push HTTP probe. It includes the sibling checkout's
preexisting development changes; this is not an upstream registry release.

Version 0.6.1 adds receive-pack sideband reports for libgit2/ngit and bounded
gzip decoding for native Git's larger fetch negotiations. Plain Git requests
retain their existing framing. Both native Git and libgit2 pushes were checked
against the local handler; the full library suite and package checks passed.

| Fact | Value |
|---|---|
| Source repository | [FelineStateMachine/ntig](https://github.com/FelineStateMachine/ntig) |
| Checkout base | `caa8258e6cf6ec3220b89312d66860258e096f0f`, plus the preserved 0.5.0 behavior and local changes |
| Source commit | [`7b1a517ef9a1f05a412520d15ec5e13c0aea1adb`](https://github.com/FelineStateMachine/ntig/commit/7b1a517ef9a1f05a412520d15ec5e13c0aea1adb) |
| Source archive | `ntig-source-0.6.1.tar.gz`; `SOURCE-SNAPSHOT.json` records the source commit and complete source file hashes |
| Package SHA-256 | `4b61ecd241fa1ce8745e543597aa50e8076c6cc0e2499ff9e15dd91f1a9913eb` |
| Source archive SHA-256 | `4e790e8120d416f24e543ac3384baea8bf70647565a531748ed2d239434528bc` |
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
