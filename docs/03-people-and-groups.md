---
title: People and groups
audience: user
---

# People and groups

Your relay's member list is one table: a pubkey, a role, an optional name, a note and how each person joined. Three things read it: the write rule, the signed roster the relay publishes and the names at `you@<name>.bind.ws`.

## Members

On the People tab, paste a pubkey or npub in the top row to add someone. Give them a name and a note if you like.

A name makes the person reachable as `name@<name>.bind.ws` (NIP-05). Set it in their row, or they put that address in the name field of their own profile and the relay picks it up.

Two limits sit in each row, for the owner only. **Keep for** is a keep-for rule in days for that person's events: older events are refused on arrival and swept once a day, never their profile, contact list or the relay's own records. **Cap** is the most that person may have stored, in kilobytes. The event that would cross it is refused. Neither applies to the owner.

Removing a member ends their live subscriptions when reads are members-only.

## Guests

A members-only relay does not have to be silent to everyone else. On the Rules tab, **Open to anyone** lists kinds a stranger may write regardless of the write rule, reactions and zap receipts being the usual ones, and a switch lets anyone reply to a member's note or comment. A reply is one hop: answering a guest's reply is not answering a member. Everything else still applies to guests, bans and blocked words first.

**Members and their follows** is the wider door: the write rule that admits every pubkey in a member's contact list, one hop from the member list. It rebuilds itself as lists arrive and members come and go.

## Invites

**New invite link** mints a link that lives one hour to 30 days, three days by default, and takes as many people as you allow, or any number if you leave the count at zero. The person opens it, reads the join terms, signs once and becomes a member.

The **Joining** block holds the join terms, shown before someone accepts an invite and published at `/terms`. Its switch decides whether visitors see the people directory at `/people`, in the group's member list, in the card's member count and in the NIP-05 listing at `/.well-known/nostr.json` without a name. A lookup by name still answers, since the member put that address in their own profile.

### Members invite members

Off by default. Under the invites, set how many hops from you the tree may reach and how many live invites each member may hold. One hop means the people you added or invited may invite; two hops lets their invitees invite too. A member then sees a **Your invites** section on the relay's page.

The member list is drawn as that tree, with who invited whom. Removing or banning someone with invitees asks whether to remove everyone under them as well. Moderators, and everyone under a moderator, stay.

## Moderators

Set a member's role to *moderator* from the selector in their row. A moderator can add and edit plain members, ban, delete events, mint invites and resolve reports, from the relay's page or from a group-aware client. They cannot touch the owner or other moderators, and rules, identity, data and fuel stay with you. Only the owner appoints or removes moderators.

A moderator who signs in on the relay's page sees the People and Moderation tabs, nothing else. What the Moderation tab holds is in [Relay configuration](01-relay-configuration.md#moderation).

## Keeping order

Three tools for the noise a bigger relay attracts, all on the Rules and Moderation tabs. **Blocked words** refuse any content that contains one, as a plain word or a pattern, in the content and, when you switch it on, in the tags, from anyone but you and your moderators. **Ban and erase** removes a person together with everything they wrote and uploaded. **Hide after N reports** takes an event out of view once that many different people have reported it, until a moderator looks. The [configuration guide](01-relay-configuration.md) has the details.

## Groups in clients

Your relay is also a group (NIP-29), one group per relay, so clients that understand groups, such as Flotilla, Chachi, 0xchat and Coracle, show it as a community: name and picture, who is in it, a join button and moderation. The group id is the relay's name.

The group follows your rules. Members-only reads make the group private. Anything but open writes makes it closed, so joining needs an invite code; with open writes, a join request is accepted at once. A member may leave from their client. Moderators act from their client with the same limits as on the page.

Moderators can pin up to 20 events or addresses for the group, from the Moderation tab or with a pin list event (kind 9010) from a group client. The relay publishes the list as a signed record (kind 39005) that clients show at the top of the group.

The group's address is on the Identity tab under **Share**. See [Your relay on the web](05-your-relay-on-the-web.md#the-card-and-the-group-address).

## Hand it over

On the Owner tab, **Transfer ownership** gives the relay to a member you pick. You stay on as a moderator. The relay's key, events, files and fuel do not change. There is no undo.

## If you lose your key

Keys get lost. On the Owner tab, under **If I lose my key**, name a member as your heir and choose how long you can be away: 90, 180 or 365 days.

The relay records when you last signed in. Any signed action counts: a console visit, a post, a signed request. If you stay away past the delay, the relay writes to you at once and then once a week for 30 days, in your inbox here and on your DM relays, and its public information document (NIP-11) carries a `succession_pending` date. Any signed action calls it off.

After the 30 days the relay hands itself to the heir the same way **Transfer ownership** does, tells you both and clears the plan. If the heir leaves the relay first, the plan is dropped and you are told. Naming an heir switches on the matching notification; see [Relay configuration](01-relay-configuration.md#health).
