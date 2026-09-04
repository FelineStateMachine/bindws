# Vendored dependencies

`ntig-0.3.0.tgz` is the Git engine and conditional R2 WAL used by GRASP.
The lockfile pins the archive integrity. `ntig-source-0.3.0.tar.gz` preserves
the complete source and tests for the same build; neither artifact depends
on a sibling checkout or a public package registry publication.

| Fact | Value |
|---|---|
| Source commit | `caa8258e6cf6ec3220b89312d66860258e096f0f` |
| Package SHA-256 | `c210d4f864d85fdb1fd3f371e4af48eeb2d2803e00dacaac7014ce84019dbe45` |
| Source archive SHA-256 | `326e41622649dc020b068f621453d7ba4da525f43e9af7b8005a588ce119dc9f` |
| Source branch | `main` in [FelineStateMachine/ntig](https://github.com/FelineStateMachine/ntig) |
| License | MIT, included in both archives |
| Supplied package toolchain | Node 22.22.3, npm 10.9.8 |
| Library build | `npm ci`, then `npm run build:library` in the extracted source |
| Package build | `npm pack` in the extracted source |
| Backend checks | `npm run check`, `npm run format:check` |

Rebuilding the preserved source with Node 26.8.1 and npm 11.19.0 produces
identical tar entries and metadata. The uncompressed tar SHA-256 is
`b26512be07bd0dce30d69b290365ed138f7a56059be105dc4c9c1e7081734eba`;
gzip bytes can differ across toolchains. The supplied package checksum above
and the lockfile pin the exact installed archive.

The source's `docs/INTEGRATION.md` describes the exported contracts, failure
semantics, cost counters and current limits. Backend work stays in that
repository; a dependency update records versioned archives and the lockfile
integrity after its checks and bindws's integration checks pass.

New and existing repositories remain in format 1, whose 128-transaction
limit also stops timed ref deletion. Bindws hides expired unknown PR refs
even when physical cleanup cannot advance. Installing 0.3.0 does not migrate
roots. The source's `docs/CHECKPOINTS.md` describes the explicit one-way
`checkpoint()` upgrade: every reader and writer must be upgraded first,
and 0.1.x cannot read a format-2 root. Bindws exposes no migration endpoint
or scheduled migration. Retained packs, receipts, manifests and orphan
writes remain charged until relay teardown.

The prior `ntig-0.2.1.tgz` and `ntig-source.tar.gz` remain as the preserved
0.2.1 package and source. The 0.3.0 release adds bounded read-only inventory
and an R2 listing adapter; it does not migrate repositories or collect data.
Its `docs/INVENTORY.md` defines report classes, limits and the distinction
between current-root references and deletion authority.
