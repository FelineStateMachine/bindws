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

## Identity

Name, description, icon and contact appear in your relay's public information document, which clients read.

Join terms are shown to people who open an invite link. The public directory switch decides whether `/people` lists your members to visitors.

**Export configuration** downloads rules, identity, members, bans, kind rules and retention as one file. **Import** replaces those lists on any relay you own. Events, files and the owner are never touched.

**Transfer ownership** hands the relay to a member you pick. You stay on as a moderator. The relay's key, events, files and fuel do not change. You type the relay's name to confirm.

**Delete relay** removes everything and returns the name to unclaimed. You type the relay's name to confirm.

## Storage

What is taking space and what to do about it.

- A bar shows bytes by kind. Totals list events, files and index overhead.
- The **By kind** table has one row per kind present, with a count, size and oldest event.
- **Keep for** sets a retention rule in days. Events older than the rule are refused on arrival and swept once a day. Leave it blank to keep forever. The **everything else** row sets a default for kinds without their own rule.
- **Purge** deletes a kind older than a number of days, now. Zero means all of them.
- Kinds marked **required** are never expired or purged: profiles, contact lists, relay lists, zap receipts and the roster. The relay depends on them.
- **Files** lists uploads with sizes and a delete button.
- **Pull from a relay** copies what another relay has and this one lacks, by NIP-77 sync. It runs in the background and the line under it follows along. Running it again fetches only what is new. Files come along from relays on this host. Bans and kind rules apply to what arrives; the write rule does not. The other relay has to let anyone read.
- **Browse recent events** at the bottom shows the feed with delete and ban actions.

## Health

Time since the last event, open connections, fuel status and a breakdown of kinds over the last 30 days. Below it, the usage meters and the list of zaps received.
