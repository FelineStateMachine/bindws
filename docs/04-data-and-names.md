---
title: Data and names
audience: user
---

# Data and names

What your relay holds, how it moves and how a name can do one job.

## What is stored

The Data tab shows bytes by kind, the files people uploaded and a keep-for rule per kind. Kinds the relay depends on, such as profiles, contact lists, relay lists, zap receipts and the roster, are never expired or purged. The controls are in [Relay configuration](01-relay-configuration.md#data).

## Recover a list

The Data tab keeps older versions of your follows, relay lists and bookmarks (kinds 3, 10002, 10003 and 30003). Versions stay private to the publishing key and stay outside event queries, search and ordinary dumps. History starts when a newer version replaces a stored list.

Choose **Restore** to preview added and removed tags and whether the content changed. Your extension or remote signer signs the old contents with a newer timestamp, then the console publishes it through the normal event door. The relay never receives your private key. History keeps at most twelve versions per list, 96 per publishing key and 4,096 per relay. Author deletions and vanish remove matching saved history.

## Jobs

A job is work the relay does on its own, one small round at a time, so it keeps going while the relay sleeps between rounds. The **Jobs** table on the Sync tab lists each job with its relays, filter, schedule and last result, with run-now and remove. A job that fails three rounds in a row stops and says why. A pull retries a failing source three times, then continues with the next source. An explicit refusal skips that source immediately.

A job runs once, or every hour, six hours or day. Up to five standing jobs and 20 jobs in all per relay. Your bans and kind rules apply to what arrives. Your write rule does not: you asked for these events.

**Pull** copies what another relay has and yours lacks. It tries sync (NIP-77) first, then ordinary NIP-01 queries if sync is unavailable. Query progress survives between rounds and relay restarts. Run it again and events already stored are deduplicated. Files come along when the other relay is on bind.ws and the pull has no filter. With an interval, a pull is a standing mirror that keeps your name in step with the other relay. The other relay has to let anyone read.

The Jobs table exposes **Source results** with mode, status, counts and any refusal or coverage warning for each relay. A completed NIP-77 sync is marked complete. Query scans are best effort: relays may silently cap or omit history. Full query windows split by time; a full one-second window is explicitly partial because more events may share its timestamp. Imports stop at 2,048 pages per source and 500 events per query. Narrow the author or time filter and run again if a source reaches a limit. Imports never send your signing key or authenticate on your behalf.

**Fetch my history** pulls your own events from every relay in your relay list, if a client has published that list here. Or give it relays to fetch from, separated by commas.

**Rebroadcast** sends what your relay holds to other relays. Choose kinds and a window in days, or leave both blank for everything. As a standing job it forwards only what arrived since the last run. Each target has its own saved cursor and status, so a failing destination cannot skip history because another succeeded. A target that refuses five events in a row is left alone for that round; unacknowledged history remains available for a later retry. Events that only their author may publish are never sent, and a members-only relay never sends private messages.

## Automatic delivery

Enable **Automatic NIP-65 delivery** on the Rules tab to send newly accepted public events by you and your members to the author's write relays and tagged people's read relays. Routing uses the kind 10002 relay lists already stored here. It is off by default, with eight targets per event and a configurable maximum of one through sixteen.

The Sync tab shows recent event/target results: pending, accepted or rejected, attempts and the last error. Each target gets up to four attempts. The queue holds at most 512 pending deliveries and 1,024 terminal results, kept for at most seven days. A full queue can omit new deliveries. This is best effort and costs fuel. Private kinds, protected events, imports and relay-generated events are excluded. Members-only relays never route automatically. Pending deliveries recheck the current event, membership and routing before sending.

## Import a file

The reverse of a dump. Under **Import a file** on the Data tab, pick a JSONL of events, one per line, such as a dump from another bind.ws relay or a strfry export, or a JSON array. Up to 64 MB. The relay keeps the file next to your uploads and reads it back as a job, a slice at a time, so a large file survives the relay sleeping. Every event's signature is checked; your bans and kind rules apply; your write rule does not, since you asked for these. The Jobs table shows how many were stored, how many the relay already had and how many were skipped. When the job is done the file is deleted. While it exists it counts as a file for fuel.

## Dumps

Under **Dumps**, choose daily or weekly and how many to keep, seven by default. The relay writes every event as one JSONL file and keeps the newest few. **Dump now** writes one on the spot. Each file lists its event count and size, with download and delete. Downloading takes your signature; the files are never a public link.

## Portable backups

On the Data tab, **Create and download** makes a private archive with configuration, signed events, saved list history, hidden and pending state, site/media blobs and Git objects. It also preserves optional GRASP PR expiry rows (`state.prRefs`), including refs with no pending expiry (`until: 0`), so deadlines survive restore. Existing archives can be downloaded or deleted. Restore verifies archive integrity, media hashes, Git object identities and event signatures. Git snapshots preserve compressed objects, refs and retry receipts; their repository identities and object graphs are checked before the database changes. Stored archives count toward fuel. Older archives without `state.prRefs` remain readable.

Open a fresh, unclaimed relay and choose the archive in **Restore a backup**. Sign with the original owner's key, preview its source identity, counts and configuration, then restore. The target must be empty and unleased. Restore stages files before applying the database in one transaction. The source identity is recorded; the target gets a new relay key. Signed site and Git references still name their original URLs, so publish updated service references from your client after moving.

This portable format is for small relays: at most 8 MiB per archive and 12,000 entries, including state records. Memory budgeting can refuse an archive below the wire limit. Larger relays need the separate event dump, configuration export, Blossom download and Git clone paths. Credentials, fuel credits, custom domains, leases, succession, callback registrations, existing dumps/backups and transient jobs are excluded. Configure those again on the target. Owner archives contain private relay data; keep the downloaded file private.

## Presets and one name per job

Names are cheap, so a relay does not have to do everything. On the Rules tab, **Presets** sets writes, reads, the directory, the kind rules and the keep-for rules in one click. Limits, identity, people and bans stay. Your own profile and lists always land, whatever the kind rules say.

| Preset | Writes | Reads | Keeps |
|---|---|---|---|
| default | anyone | anyone | every kind, forever |
| outbox | only you | anyone | public notes and articles, forever; private kinds refused |
| inbox | anyone | anyone | notes, replies, reactions, comments, reports and zaps, 90 days |
| private | only you | members | every kind, forever; directory hidden |
| chat | members | members | private messages and the group's chat, forever; directory hidden |
| media | members upload files | anyone | profiles and Blossom server lists only |
| search | only you | anyone | a copy of another relay's searchable kinds, refreshed every six hours |
| articles | only you | anyone | long-form articles and profiles; mirrored daily from a source if you give one |
| dm | anyone | members | private messages only; directory hidden |
| quiet | members | members | every kind, forever; optional features off |
| site | members | anyone | every kind, forever; site hosting, mirroring and files enabled |
| marmot | anyone | anyone | KeyPackages, encrypted group envelopes, private welcomes and relay lists; Marmot enabled |
| grasp | members publish events | anyone | every kind, forever; GRASP Git hosting enabled |
| marmot-members | members; group writes authenticate | anyone | KeyPackages, encrypted group envelopes, private welcomes and relay lists; Marmot enabled |
| home | members | anyone | every kind, forever; sites, files and Git hosting on, with notes, blog, bookmarks, sites, repos and a photo library shortcut only the owner sees on the Connect fold |

Each preset is a file in the repository's `relay-templates/` folder: a relay configuration with the rules sections only, which is also what a file of your own looks like ([Scripts and agents](13-scripts-and-agents.md#the-configuration-file)). A preset that names features sets them too. A preset may also carry the Connect fold's shortcuts ([Relay configuration](01-relay-configuration.md#connect)): one that does sets them, and one that does not leaves them alone.

The search and articles presets take a source relay URL in the field next to the buttons. Applying one adds a standing pull of its kinds from that source. Applying any preset again replaces that pull rather than adding another, and applying one with no source removes it. The pull appears in the Jobs table.

## Fork this relay

Under **Fork this relay** on the Sync tab, a fork leases a new name, copies this relay into it and reserves the claim for a key.

- **Name**: choose one, or leave it blank for a memorable one.
- **Who claims it**: you by default, or an npub or hex key to hand a community its own relay with its history.
- **What to copy**: everything, only your events or a list of kinds.
- **Copy the people**: bring the plain members along. Moderators and bans stay here.

The result is the new console URL to hand over. The new name is temporary until it is claimed, like any lease. One fork an hour.

## Leave

Your data is yours. A relay that speaks sync can pull the events your read rule exposes:

```
nak sync -a <your-pubkey> wss://<name>.bind.ws wss://<other-relay>
```

Or download a dump or a portable backup.

Event sync and JSONL dumps do not contain site files or Git packs. An unfiltered
bind.ws pull can copy Blossom files, but it does not copy GRASP repositories.
Copy site blobs through Blossom and clone Git repositories separately before
leaving. Pending GRASP events remain outside normal event queries until their
Git data arrives. A relay fork does not replace these separate file and Git
backups.

## What it spends

Jobs wake the relay, so they spend awake time on every run. Pulled events count as events stored and rows written. Dumps count as files stored. See [Understanding fuel](02-understanding-fuel.md).
