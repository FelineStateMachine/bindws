---
title: Relay configuration
audience: user
---

# Relay configuration

Your relay's page at `https://<name>.bind.ws/` is the console. Sign in with your extension to see the owner tabs: People, Moderation, Rules, Identity, Data, Health and Owner.

Everything on these tabs is also available to scripts as signed JSON-RPC calls (NIP-86). The page is a client of that same API.

## People

The member list is one table. Each row is a pubkey, a role, an optional name, a note and how the person joined.

Three things read that table: the write rule, the signed roster your relay publishes and the NIP-05 names at `you@<name>.bind.ws`.

- **Add** a member by pubkey or npub. Give them a name and a note if you like.
- **Invite** with a link. Choose how long the link lives and how many people can use it.
- **Limits**, two inputs per member for the owner: a keep-for in days and a cap in kilobytes. See [People and groups](03-people-and-groups.md#members).
- **Members invite members**, the small form under the invites: how many hops from you the tree reaches and how many live invites each member may hold. Zero hops turns it off. See [People and groups](03-people-and-groups.md#members-invite-members).
- **Role** is *member* or *moderator*, set from the selector next to the pubkey. What a moderator may do is in [People and groups](03-people-and-groups.md#moderators).

Removing a member ends their live subscriptions when reads are members-only.

Join terms are shown to people who open an invite link, and published at `/terms` as the relay's terms of service. The public directory switch decides whether `/people` lists your members to visitors.

A moderator who signs in on the relay's page sees People and Moderation, nothing else.

## Moderation

Keeping order. Reports never show in the feed.

- **Reports** filed against people or events arrive here. Resolve each one by dismissing it, deleting the event or banning the author.
- **Ban** a pubkey. Their events are refused and their open connections are closed.
- **Block an address.** An IP address, v4 or v6, gets no socket and no write or read door; its open connections are closed. The page, the relay information and management stay reachable, so you can undo a block on your own address. Addresses churn, so blocks are not part of the exported configuration.
- **Recent events** shows the feed with delete and ban actions.

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

Four more presets make single-purpose names: **Media** (members upload files; the only events accepted are profiles and Blossom server lists), **Search replica** (a read-only copy of another relay's searchable kinds, refreshed every six hours), **Articles** (long-form and profiles only, mirrored daily from a source if one is given) and **DM inbox** (anyone drops gift wraps, only members read). The replica presets take a source relay URL in the field next to the buttons; applying a preset again replaces the standing pull rather than adding one, and applying a preset with no source removes it. The pull appears in the Jobs table on the Data tab.

## Identity

Name, description, icon and contact appear in your relay's public information document, which clients read. The relay also keeps a profile of its own, signed with its own key, made from the name, description and icon, so it shows up like a person in clients that look one up.

Banner is a wide image for the same document. Posting policy and privacy policy are links to pages you host elsewhere; both must be https. Tags, languages and countries are short lists that tell relay directories what the relay is about: topic words, language codes such as `en` or `pt-BR`, and two-letter country codes.

**Your own domain** puts the relay under a hostname you control: add it, create the CNAME shown, **Check** until it reads live, **Remove** to take it down. At most three per relay, never part of the exported configuration. See [Your relay on the web](05-your-relay-on-the-web.md#your-own-domain).

### Tell your clients

One row per list that names relays: relay list, DM inbox, search relays and Blossom servers. **Check** finds your newest copy, **Add me** publishes a merged list with this relay first and **Remove me** publishes it without. See [Getting started](00-getting-started.md#tell-your-clients).

## Data

What is here, what moves, and what leaves.

- A bar shows bytes by kind. Totals list events, files and index overhead.
- The **By kind** table has one row per kind present, with a count, size and oldest event.
- **Keep for** sets a retention rule in days. Events older than the rule are refused on arrival and swept once a day. Leave it blank to keep forever. The **everything else** row sets a default for kinds without their own rule.
- **Purge** deletes a kind older than a number of days, now. Zero means all of them.
- Kinds marked **required** are never expired or purged: profiles, contact lists, relay lists, zap receipts and the roster. The relay depends on them.
- **Files** lists uploads with sizes and a delete button.
- **Jobs** is work the relay does on its own in small rounds: pulls, standing mirrors, fetch my history and rebroadcasts, with run-now and remove per job. See [Data and names](04-data-and-names.md#jobs).

- **Dumps** writes every event as one JSONL file daily or weekly and keeps the newest few. **Dump now** writes one on the spot. Downloads are signed requests. See [Data and names](04-data-and-names.md#dumps).

- **Fork this relay** leases a new name, copies this relay into it and reserves the claim for a key. One fork an hour. See [Data and names](04-data-and-names.md#fork-this-relay).

## Health

Time since the last event, open connections, fuel status and a breakdown of kinds over the last 30 days. Below it, the usage meters and the list of zaps received.

**Notifications.** Four switches, all off until you turn them on: a report arrives, fuel runs low, a pull finishes, the handover clock is running (this one switches itself on when you name an heir). The relay writes you a NIP-17 private message with its own key, sealed and gift wrapped, stored here as your inbox and pushed to the relays in your kind 10050 when this relay holds one. **Send a test message** proves the path end to end. Only the owner can read these; the catch-all keep-for rule leaves gift wraps alone, though a rule set on kind 1059 itself still applies. Fuel is reported once when it turns low and then once a day while it stays low.

## Owner

The relay as a thing you hold.

**Export configuration** downloads rules, identity, members, bans, kind rules and retention as one file. **Import** replaces those lists on any relay you own. Events, files and the owner are never touched.

**Transfer ownership** hands the relay to a member you pick. You stay on as a moderator. The relay's key, events, files and fuel do not change. You type the relay's name to confirm.

**Delete relay** removes everything and returns the name to unclaimed. You type the relay's name to confirm.

### If I lose my key

Name a member as your heir and a delay of 90, 180 or 365 days of silence. Past it the relay warns you for 30 days, then hands itself to the heir. See [People and groups](03-people-and-groups.md#if-you-lose-your-key).
