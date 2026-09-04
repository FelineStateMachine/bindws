# Vendored dependencies

`ntig-0.2.1.tgz` is the Git engine and conditional R2 WAL used by GRASP.
The lockfile pins the archive integrity. `ntig-source.tar.gz` preserves
the complete source and tests for the same build; neither artifact depends
on a sibling checkout or a public package registry publication.

| Fact | Value |
|---|---|
| Source commit | `de3dc0b2a9151973d555658f3e75b0c5669426e8` |
| Package SHA-256 | `0f2ceab406cd40935ec96ba53a0a03835de2e8611792f4a0c137d596c81a2f05` |
| Source archive SHA-256 | `24d9b27856d034e88662168a156f7ff01302012e85809381ff98fb7f373021d1` |
| Source branch | `main` in [FelineStateMachine/ntig](https://github.com/FelineStateMachine/ntig) |
| License | MIT, included in both archives |
| Supplied package toolchain | Node 22.22.3, npm 10.9.8 |
| Library build | `npm ci`, then `npm run build:library` in the extracted source |
| Package build | `npm pack` in the extracted source |
| Backend checks | `npm run check`, `npm run format:check` |

Rebuilding the preserved source with Node 26.8.1 and npm 11.19.0 produces
identical tar entries and metadata. The uncompressed tar SHA-256 is
`f1ad28f92b7ac0ebad4487d3cdd6cabb1a7477f965e3ce883dae47c00a4f9804`;
gzip bytes can differ across toolchains. The supplied package checksum above
and the lockfile pin the exact installed archive.

The source's `docs/INTEGRATION.md` describes the exported contracts, failure
semantics, cost counters and current limits. Backend work stays in that
repository; a dependency update replaces both archives and the lockfile
integrity after its checks and bindws's integration checks pass.

New and existing repositories remain in format 1, whose 128-transaction
limit also stops timed ref deletion. Bindws hides expired unknown PR refs
even when physical cleanup cannot advance. Installing 0.2.1 does not migrate
roots. The source's `docs/CHECKPOINTS.md` describes the explicit one-way
`checkpoint()` upgrade: every reader and writer must be upgraded first,
and 0.1.x cannot read a format-2 root. Bindws exposes no migration endpoint
or scheduled migration. Retained packs, receipts, manifests and orphan
writes remain charged until relay teardown.
