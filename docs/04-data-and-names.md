---
title: Data and names
audience: user
---

# Data and names

What your relay holds, how it moves and how a name can do one job.

## What is stored

The Data tab shows bytes by kind, the files people uploaded and a keep-for rule per kind. Kinds the relay depends on, such as profiles, contact lists, relay lists, zap receipts and the roster, are never expired or purged. The controls are in [Relay configuration](01-relay-configuration.md#data).

## Jobs

A job is work the relay does on its own, one small round at a time, so it keeps going while the relay sleeps between rounds. The **Jobs** table on the Sync tab lists each job with its relays, filter, schedule and last result, with run-now and remove. A job that fails three rounds in a row stops and says why.

A job runs once, or every hour, six hours or day. Up to five standing jobs and 20 jobs in all per relay. Your bans and kind rules apply to what arrives. Your write rule does not: you asked for these events.

**Pull** copies what another relay has and yours lacks, by sync (NIP-77). Run it again and only new events come over. Files come along when the other relay is on bind.ws and the pull has no filter. With an interval, a pull is a standing mirror that keeps your name in step with the other relay. The other relay has to let anyone read.

**Fetch my history** pulls your own events from every relay in your relay list, if a client has published that list here. Or give it relays to fetch from, separated by commas.

**Rebroadcast** sends what your relay holds to other relays. Choose kinds and a window in days, or leave both blank for everything. As a standing job it forwards only what arrived since the last run. A target that refuses five events in a row is left alone for that round. Events that only their author may publish are never sent, and a members-only relay never sends private messages.

## Import a file

The reverse of a dump. Under **Import a file** on the Data tab, pick a JSONL of events, one per line, such as a dump from another bind.ws relay or a strfry export, or a JSON array. Up to 64 MB. The relay keeps the file next to your uploads and reads it back as a job, a slice at a time, so a large file survives the relay sleeping. Every event's signature is checked; your bans and kind rules apply; your write rule does not, since you asked for these. The Jobs table shows how many were stored, how many the relay already had and how many were skipped. When the job is done the file is deleted. While it exists it counts as a file for fuel.

## Dumps

Under **Dumps**, choose daily or weekly and how many to keep, seven by default. The relay writes every event as one JSONL file and keeps the newest few. **Dump now** writes one on the spot. Each file lists its event count and size, with download and delete. Downloading takes your signature; the files are never a public link.

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

Each preset is a file in the repository's `relay-templates/` folder: a relay configuration with the rules sections only, which is also what a file of your own looks like ([Scripts and agents](13-scripts-and-agents.md#the-configuration-file)). A preset that names features sets them too.

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

Or download a dump.

Event sync and JSONL dumps do not contain site files or Git packs. An unfiltered
bind.ws pull can copy Blossom files, but it does not copy GRASP repositories.
Copy site blobs through Blossom and clone Git repositories separately before
leaving. Pending GRASP events remain outside normal event queries until their
Git data arrives. A relay fork does not replace these separate file and Git
backups.

## What it spends

Jobs wake the relay, so they spend awake time on every run. Pulled events count as events stored and rows written. Dumps count as files stored. See [Understanding fuel](02-understanding-fuel.md).
