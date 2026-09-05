# Vendored dependencies

`ntig-0.5.0.tgz` supplies Git pack validation, Smart HTTP and Nostr repository
policy wrappers. Bindws stores Git objects, refs and retry receipts in its
relay Durable Object's SQLite database. The package's R2 adapters remain
available to other ntig consumers; bindws does not use them for Git storage.

This is a bindws-local extension of the preserved 0.4.0 source snapshot,
not a claim that version 0.5.0 has been published upstream. The extension
adds indexed object metadata and selective object reads to the repository
contract, forwards them through the Nostr policy wrappers, and resolves
thin-pack bases on demand. Object counts, graph edges and decoded bytes
remain bounded before payload reads.

| Fact | Value |
|---|---|
| Source repository | [FelineStateMachine/ntig](https://github.com/FelineStateMachine/ntig) |
| Source base | Preserved `ntig-source-0.4.0.tar.gz`, based on `caa8258e6cf6ec3220b89312d66860258e096f0f` with indexed reader extension changes |
| Local extension commit | `1b2ea13880e9217bd240f3a32f9cdde05ab60e92` |
| Source archive | `ntig-source-0.5.0.tar.gz`; `SOURCE-SNAPSHOT.json` records the source file hashes |
| Package SHA-256 | `c0c2490987ea48215ae435ab138925179a0cb6a7557c51808c8859a20c20a00b` |
| Source archive SHA-256 | `1701de439e7d4b00dd75984907046a796c5a8f8ff9b53c990a8b707b0b7c0dae` |
| License | MIT, included in both archives |
| Supplied toolchain | Node 26.8.1, npm 11.19.0 |
| Library build | `npm ci --ignore-scripts`, then `npm run build:library` in the extracted source |
| Package build | `npm pack` in the extracted source |
| Library checks | `npm run check`, `npm run format:check`, `npm run pack:check` |

The lockfile pins the installed package archive. The complete source and tests
are preserved beside it, so the build needs neither a sibling checkout nor a
registry publication. The source's `docs/INTEGRATION.md` describes the exported
contracts. Its WAL and checkpoint documentation concerns the library's R2
backend, not bindws's SQLite storage.

Earlier versioned archives remain as source provenance. Installing this
package performs no data migration. Bindws's current storage limits and
admission rules are in [GRASP-01 Git hosting](../docs/22-grasp-01-git-hosting.md).
