# Vendored dependencies

`nostrwal-0.1.0.tgz` is the Git engine and conditional R2 WAL used by GRASP.
The lockfile pins the archive integrity. `nostrwal-source.tar.gz` preserves
the complete source and tests for the same build; neither artifact depends
on a sibling checkout or a public package registry publication.

| Fact | Value |
|---|---|
| Source commit | `7ebd06a4d7d3e1cffccd52d9bf0a329e968f8b8b` |
| Source branch | `feat/bootstrap` in the independent nostrwal repository |
| License | ISC, included in both archives |
| Library build | `npm ci`, then `npm run build:library` in the extracted source |
| Package build | `npm pack` in the extracted source |
| Backend checks | `npm run check`, `npm run format:check` |

The source's `docs/INTEGRATION.md` describes the exported contracts, failure
semantics, cost counters and current limits. Backend work stays in that
repository; a dependency update replaces both archives and the lockfile
integrity after its checks and bindws's integration checks pass.

The backend's 128-transaction limit also stops timed ref deletion. Bindws
hides expired unknown PR refs even when physical cleanup cannot advance.
Retained packs and orphan writes remain charged until relay teardown.
