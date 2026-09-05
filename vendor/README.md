# Vendored dependencies

`ntig-0.4.0.tgz` is the Git engine and conditional R2 WAL used by GRASP.
The lockfile pins the archive integrity. `ntig-source-0.4.0.tar.gz` preserves
the complete source and tests for the same build; neither artifact depends
on a sibling checkout or a public package registry publication.

| Fact | Value |
|---|---|
| Source base commit | `caa8258e6cf6ec3220b89312d66860258e096f0f` |
| Source snapshot | Working tree with GRASP extension changes; `SOURCE-SNAPSHOT.json` records every source file's SHA-256 |
| Package SHA-256 | `f66b5bcbf2730a6ec5007d532da4db36a33515dce45d6e2ffaabcc4fe5889775` |
| Source archive SHA-256 | `91fe9917fb575b32671bc43e3e1c6d3e64fde803253092ee62646b1fd7591fb4` |
| Source repository | [FelineStateMachine/ntig](https://github.com/FelineStateMachine/ntig) |
| License | MIT, included in both archives |
| Supplied package toolchain | Node 26.8.1, npm 11.19.0 |
| Library build | `npm ci --ignore-scripts`, then `npm run build:library` in the extracted source |
| Package build | `npm pack` in the extracted source |
| Backend checks | `npm run check`, `npm run format:check`, `npm run pack:check` |

The 0.4.0 snapshot is not represented as a published source commit. The
source archive and its per-file manifest identify the exact reviewed bytes.
Rebuilding the extracted snapshot produces identical tar entries and metadata;
the gzip envelope can differ. The uncompressed tar SHA-256 is
`f5bff1aaa7ee167396429a35ee0723b7f7eefaf893871f52c9dedd3ab03ebb25`. The package checksum above and the lockfile pin
the exact installed archive.

The source's `docs/INTEGRATION.md` describes the exported contracts, failure
semantics, cost counters and current limits. Backend work stays in that
repository; a dependency update records versioned archives and the lockfile
integrity after its checks and bindws's integration checks pass.

New and existing repositories remain in format 1, whose 128-transaction
limit also stops timed ref deletion. Bindws hides expired unknown PR refs
even when physical cleanup cannot advance. Installing 0.4.0 does not migrate
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

The 0.3.0 package and source remain preserved alongside the earlier archives.
Version 0.4.0 adds bounded outbound Smart HTTP fetch and strengthens
`createPrRepository`: unknown uploads require explicit opt-in, public deletion
is refused, and metadata reads enforce accepted PR authority. Bindws opts in
only behind its quotas and fixed expiry bookkeeping. No repository migration
or garbage collection runs during this dependency update. The host's event
sync and archive previews remain default-off and unadvertised; see
[GRASP hosting](../docs/22-grasp-01-git-hosting.md).
