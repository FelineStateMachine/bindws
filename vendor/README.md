# Vendored dependencies

`ntig-0.2.0.tgz` is the Git engine and conditional R2 WAL used by GRASP.
The lockfile pins the archive integrity. `ntig-source.tar.gz` preserves
the complete source and tests for the same build; neither artifact depends
on a sibling checkout or a public package registry publication.

| Fact | Value |
|---|---|
| Source commit | `f6346eb54ce12f54b1c5a18fdd4d3e16220b4feb` |
| Package SHA-256 | `dcfba370518014a0dace1960e13782748965d2479d46d264fdbe0cf0745b153b` |
| Source archive SHA-256 | `ab5552da34bd2dbf3e751c794949d891a5fca8ec1c17ea8d5d845b1636009eff` |
| Source branch | `main` in [FelineStateMachine/ntig](https://github.com/FelineStateMachine/ntig) |
| License | MIT, included in both archives |
| Library build | `npm ci`, then `npm run build:library` in the extracted source |
| Package build | `npm pack` in the extracted source |
| Backend checks | `npm run check`, `npm run format:check` |

Rebuilding the preserved source with Node 26.8.1 and npm 11.19.0 produces
identical tar entries and metadata. The uncompressed tar SHA-256 is
`2c0acfc94c300c59ba73cac4c83185ea0b1b7f939cecf565cfc2f69eb4952fad`;
gzip bytes can differ across toolchains. The supplied package checksum above
and the lockfile pin the exact installed archive.

The source's `docs/INTEGRATION.md` describes the exported contracts, failure
semantics, cost counters and current limits. Backend work stays in that
repository; a dependency update replaces both archives and the lockfile
integrity after its checks and bindws's integration checks pass.

New and existing repositories remain in format 1, whose 128-transaction
limit also stops timed ref deletion. Bindws hides expired unknown PR refs
even when physical cleanup cannot advance. Installing 0.2.0 does not migrate
roots. The source's `docs/CHECKPOINTS.md` describes the explicit one-way
`checkpoint()` upgrade: every reader and writer must be upgraded first,
and 0.1.x cannot read a format-2 root. Bindws exposes no migration endpoint
or scheduled migration. Retained packs, receipts, manifests and orphan
writes remain charged until relay teardown.
