---
title: Relay configuration
audience: user
---

# Relay configuration

Your relay's page at `https://<name>.bind.ws/` is the console. Sign in with your extension to see the owner tabs: People, Rules, Identity, Storage and Health.

Everything on these tabs is also available to scripts as signed JSON-RPC calls (NIP-86). The page is a client of that same API.

## People

The member list is one table. Each row is a pubkey, a role, an optional name, a note and how the person joined.

Three things read that table: the write rule, the signed roster your relay publishes and the NIP-05 names at `you@<name>.bind.ws`.

- **Add** a member by pubkey or npub. Give them a name and a note if you like.
- **Invite** with a link. Choose how long the link lives and how many people can use it.
- **Ban** a pubkey. Their events are refused and their open connections are closed.
- **Block an address.** An IP address, v4 or v6, gets no socket and no write or read door; its open connections are closed. The page, the relay information and management stay reachable, so you can undo a block on your own address. Addresses churn, so blocks are not part of the exported configuration.
- **Reports** filed against people or events arrive here. Resolve each one by dismissing it, deleting the event or banning the author.
- **Limits**, two small inputs per member, for the owner only. *Keep for* is a keep-for rule in days for that person's events, on top of the kind rules: older events are refused on arrival and swept once a day, never profiles, contact lists or the relay's own records. *Cap* is the most that person may have stored, in KB; the event that would cross it is refused. Neither applies to the owner.
- **Members invite members**, the small form under the invites. *Hops deep* is how far from you the tree may reach: 1 means only people you added or invited may invite, 2 lets their invitees invite too. *Each* is how many live invites one member may hold. Zero hops turns it off, which is the default. The member list is drawn as that tree, with who invited whom, and removing or banning someone with invitees asks whether to remove everyone under them as well. Moderators, and everyone under a moderator, stay.
- **Role** is *member* or *moderator*, set from the selector next to the pubkey. A moderator can add and remove members, ban, delete events, mint invites and resolve reports, here or from a group-aware client. They cannot touch the owner, other moderators, rules, identity, storage or fuel.

Removing a member ends their live subscriptions when reads are members-only.

A moderator who signs in on the relay's page sees the People tab and the recent-events browser, nothing else.

## Rules

Who can do what, and how much.

| Rule | Choices |
|---|---|
| Writes | anyone, members, only me |
| Reads | anyone, signed in, members |
| Proof of work | minimum bits an event must carry, 0 to disable |
| Timestamp window | how far in the future an event may be dated |
| Query limits | max events per query, max subscriptions per connection |
| Rate limits | events and queries per minute, per connection; an address gets four times that across all its connections |
| Upload size | largest file in megabytes, up to 95 |
| Kinds | allow list and block list by kind number |

An empty allow list means every kind. Blocks always win.

The per-address limit is what stops a client from opening many sockets to multiply its allowance. It also serves as the HTTP bridge's rate limit, which has no socket to meter. Address buckets live in memory and reset when the relay sleeps.

### Presets

Above the rules form, one button per preset sets writes, reads, the directory, the kind rules and the keep-for rules together. Limits, identity, people and bans stay. **Default** is what a fresh claim has. **Outbox** is only you writing, anyone reading, private kinds refused. **Inbox** takes notes, replies, reactions, comments, reports and zaps from anyone and keeps them 90 days. **Private** is only you writing and only members reading, every kind, forever. **Chat** is the members-only group: private messages, chat and threads, directory hidden. Your own profile and lists always land, whatever the kind rules say. Names are cheap, so one name per role is the way to run all four.

Four more presets make single-purpose names: **Media** (members upload files; the only events accepted are profiles and Blossom server lists), **Search replica** (a read-only copy of another relay's searchable kinds, refreshed every six hours), **Articles** (long-form and profiles only, mirrored daily from a source if one is given) and **DM inbox** (anyone drops gift wraps, only members read). The replica presets take a source relay URL in the field next to the buttons; applying a preset again replaces the standing pull rather than adding one, and applying a preset with no source removes it. The pull appears in the Jobs table on the Storage tab.

## Identity

Name, description, icon and contact appear in your relay's public information document, which clients read. The relay also keeps a profile of its own, signed with its own key, made from the name, description and icon, so it shows up like a person in clients that look one up.

Banner is a wide image for the same document. Posting policy and privacy policy are links to pages you host elsewhere; both must be https. Tags, languages and countries are short lists that tell relay directories what the relay is about: topic words, language codes such as `en` or `pt-BR`, and two-letter country codes.

Join terms are shown to people who open an invite link, and published at `/terms` as the relay's terms of service. The public directory switch decides whether `/people` lists your members to visitors.

**Export configuration** downloads rules, identity, members, bans, kind rules and retention as one file. **Import** replaces those lists on any relay you own. Events, files and the owner are never touched.

**Transfer ownership** hands the relay to a member you pick. You stay on as a moderator. The relay's key, events, files and fuel do not change. You type the relay's name to confirm.

**Delete relay** removes everything and returns the name to unclaimed. You type the relay's name to confirm.

### If I lose my key

Name a member as your heir and pick the delay: 90, 180 or 365 days. The relay records when you last signed in (any owner-signed action counts, at most once an hour). Past the delay it starts a warning month: a message to you at once and then weekly, and a `succession_pending` date in its NIP-11 document. Any signed action calls the warning off. After the month, the relay transfers itself to the heir the same way **Transfer ownership** does, notifies both of you, and clears the plan. The heir can read the plan's status with the `successionstatus` method; moderators cannot. The plan stays out of exported configuration. If the heir leaves the relay, the plan is dropped and you are told.

### Tell your clients

One row per list that names relays: relay list (kind 10002), DM inbox (10050), search relays (10007), Blossom servers (10063). **Check** looks for your newest copy here and on the indexers. **Add me** merges this relay into it and publishes the signed result here, to the relays the list names and to the indexers; the row shows which accepted it. **Remove me** does the reverse. Lists are never rebuilt from scratch, so what you had stays.

**Notifications.** Four switches, all off until you turn them on: a report arrives, fuel runs low, a pull finishes, the handover clock is running (this one switches itself on when you name an heir). The relay writes you a NIP-17 private message with its own key, sealed and gift wrapped, stored here as your inbox and pushed to the relays in your kind 10050 when this relay holds one. **Send a test message** proves the path end to end. Only the owner can read these; the catch-all keep-for rule leaves gift wraps alone, though a rule set on kind 1059 itself still applies. Fuel is reported once when it turns low and then once a day while it stays low.

- **Fork this relay** leases a new name, copies this relay into it and reserves the claim for a key. Choose a name or take a memorable one, choose who claims it (you by default, or an npub), what to copy (everything, only your events, or a list of kinds) and whether the people come along. The result is the new console URL to hand over; the new name expires like any lease unless it is claimed. One fork an hour.

## Storage

What is taking space and what to do about it.

- A bar shows bytes by kind. Totals list events, files and index overhead.
- The **By kind** table has one row per kind present, with a count, size and oldest event.
- **Keep for** sets a retention rule in days. Events older than the rule are refused on arrival and swept once a day. Leave it blank to keep forever. The **everything else** row sets a default for kinds without their own rule.
- **Purge** deletes a kind older than a number of days, now. Zero means all of them.
- Kinds marked **required** are never expired or purged: profiles, contact lists, relay lists, zap receipts and the roster. The relay depends on them.
- **Files** lists uploads with sizes and a delete button.
- **Jobs** is work the relay does on its own, one round at a time, so it survives the relay sleeping. The table lists each job with its relays, filter, schedule and last result, with run-now and remove. Three forms add jobs. **Pull** copies what another relay has and this one lacks, by NIP-77 sync; running it again fetches only what is new, files come along from relays on this host, and with an interval it is a standing mirror. **Fetch my history** pulls the owner's own events from the relays in their kind 10002 stored here, or from a given list. **Rebroadcast** forwards events matching kinds and a day window to a list of relays, walking the store with a cursor so a standing rebroadcast forwards only what arrived since. Bans and kind rules apply to what arrives; the write rule does not. The other relay has to let anyone read, or write. Events that only their author may publish are never rebroadcast, and a members-only relay never rebroadcasts private kinds. Standing jobs run every hour, six hours or day, five at most. Jobs spend awake time, which fuel counts.

- **Dumps** writes every event as one JSONL file to storage, daily or weekly, and keeps the newest few (seven by default). **Dump now** writes one on the spot. Each file lists its event count and size, with download and delete. Downloading is a signed request; the files are never public. Dumps count as files for fuel.
- **Pull from a relay** copies what another relay has and this one lacks, by NIP-77 sync. It runs in the background and the line under it follows along. Running it again fetches only what is new. Files come along from relays on this host. Bans and kind rules apply to what arrives; the write rule does not. The other relay has to let anyone read.
- **Browse recent events** at the bottom shows the feed with delete and ban actions.

## Health

Time since the last event, open connections, fuel status and a breakdown of kinds over the last 30 days. Below it, the usage meters and the list of zaps received.
