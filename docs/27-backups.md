---
title: backups and fresh-relay restore
audience: user
---

`backupnow` creates a private, portable archive containing the relay configuration, signed events, hosted site and media blobs, and hosted Git objects. The archive records the source relay identity public key, but never includes its private key. A fresh target generates a new relay identity and publishes new authority records after restore. The archive is bounded at 8 MiB and 12,000 objects because JSON parsing, base64 expansion and integrity copies share the Worker heap. Every byte has a SHA-256 entry hash and the archive has a manifest hash.

`listbackups` lists archives and `deletebackup` removes one. An owner downloads an archive from `/backups/<id>` with the same NIP-98 storage authorization used for dumps.

To restore, claim no name on a fresh relay. POST the downloaded archive to `/backups/restore` with NIP-98 authorization by the owner key recorded in the manifest. Restore verifies the archive, checks every event and object, then applies configuration, events, blobs, and Git data. A claimed or non-empty target is refused. Fuel credits, credentials, push registrations, dumps, and transient jobs are not backup data.

POST the same archive to `/backups/preview` first to receive the source identity, counts, configuration and fresh-target check without changing the target.
