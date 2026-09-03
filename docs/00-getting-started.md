---
title: Getting started
audience: user
---

# Getting started

bind.ws gives you a nostr relay at a name you choose. You claim it with your nostr key. There is no account, password or email.

You need a nostr key and something that signs with it: a browser extension such as Alby, nos2x or Nostash, or a remote signer app such as Amber or nsec.app, which the relay's page connects to (NIP-46). Any nostr client works with the relay once it exists.

## Claim a name

1. Open `https://<name>.bind.ws/` in your browser. Names are three to 32 lowercase letters, digits or hyphens.
2. If the page says the relay is unclaimed, click **Claim**. Your extension asks you to sign one request.
3. The page becomes your relay's console. You are the owner.

If the page shows someone else's name, the relay is taken. Pick another.

## From a phone

No extension is needed. Open the relay's page, choose **Use a remote signer**, and tap **Open in your signer app**. The app asks you to approve the connection and the page continues where you left off, claiming or signing in. On a computer, paste the `bunker://` URL your signer app gives you instead. The relay itself carries the signer traffic, so this works on a relay nobody has claimed yet.

The page remembers the connection until you sign out.

## Try one first

Not ready to pick a name? Click **Try one now** on the front page, or ask for one from a script:

```
curl -X POST https://bind.ws/lease
```

You get a relay at a memorable name, such as `wss://brave-otter.bind.ws`. Anyone can read and write to it for 14 days. Then everything on it is deleted and the name is freed. Its page says when.

To keep it, open its page and click **Claim** before it expires. The relay converts in place: the events and files stay, and you are the owner. The page then offers to switch to the default rules, since a temporary relay lets anyone write and keeps events for 14 days only.

If you sign the request with your key (NIP-98), only that key can claim the relay. Agents and scripts with a key get a relay that nobody else can take from them.

To keep the events but not the name, claim the name you want and pull the temporary relay into it. See [Bring events in](#bring-events-in).

## Connect a client

Add the relay URL to your client's relay list:

```
wss://<name>.bind.ws
```

That is all. The relay speaks the standard protocol, so Damus, Amethyst, noStrudel, Coracle and the rest need no special setup. Your notes, reactions and profile land on your relay the moment you publish.

## Tell your clients

A relay only helps once your clients know about it. On the Identity tab, **Tell your clients** has one row per list: your relay list (NIP-65), your DM inbox (NIP-17), your search relays and your Blossom servers. Each row fetches the newest copy of that list from this relay and a few well-known indexers, puts this relay first, and asks you to sign the result once. The merged list is sent here, to the relays it names, and to the indexers, so nothing you had listed is lost. **Remove me** publishes the list without this relay.

## Invite people

A new relay accepts writes from its members only. To add someone:

- **Invite link.** On the People tab, mint an invite. Share the link. The person opens it, signs once and becomes a member.
- **Add by key.** Paste a pubkey or npub on the People tab.

To let anyone write, set **Rules > Writes** to *anyone*. To let only yourself write, set it to *only me*.

## Moderators

On the People tab, set a member's role to *moderator*. A moderator can add and remove members, ban, delete events, mint invites and work the reports queue, from the relay's page or from a group-aware client. Rules, identity, storage and fuel stay with you.

## Hand it over

On the Identity tab, **Transfer ownership** gives the relay to a member. You stay on as a moderator. The relay's key, events, files and fuel do not change.

## Groups in clients

Your relay is also a NIP-29 group, one group per relay, so clients that understand groups (Flotilla, Chachi, 0xchat, Coracle) show it as a community: name and picture, who is in it, a join button and moderation. The group id is the relay's name. Who may read and write follows your Rules tab: members-only reads make the group private, and anything but open writes makes it closed, so joining needs an invite code.

## Names

Members can have a name at your relay, such as `alice@<name>.bind.ws`. Set it on the People tab, or a member sets it in their profile's NIP-05 field. Clients show the name next to the person.

The relay has a profile of its own, made from the name, description and icon on the Identity tab, so it appears like a person where clients show relays.

## Media

Your relay stores images and files too. Clients that support Blossom upload to `https://<name>.bind.ws` and get a link by hash. A client can ask first whether an upload would be accepted, and can have the relay copy a file from another server by URL instead of uploading it again. Set the maximum upload size on the Rules tab.

Clients that speak NIP-96 instead find the same store through `/.well-known/nostr/nip96.json`. The two doors share one bucket and one file list, so a file uploaded through either is served, listed and deleted through both, and every answer carries the file's NIP-94 tags.

To report a file, send a signed NIP-56 report that names its hash to `PUT /report`. It lands in the owner's reports queue next to reported events. Deleting a reported file also blocks its hash, so it cannot be uploaded again.

## Scripts

If you write scripts, the relay has an HTTP door. Sign a request with your key (NIP-98) and post to `/events`, `/query` or `/count`. No websocket needed.

## Bring events in

Any relay that lets you read can be copied into yours. On the Storage tab, under **Pull from a relay**, enter its URL. Your relay syncs with it (NIP-77) and fetches what it lacks, in the background. Run it again later and only new events come over. Files come along when the other relay is on bind.ws.

Your bans and kind rules apply to what arrives. Your write rule does not: you asked for these events.

## Leave

Your data is yours. Any relay that supports sync (NIP-77) can pull everything from your relay:

```
nak sync -a <your-pubkey> wss://<name>.bind.ws wss://<other-relay>
```

## What it costs

Nothing until you pass the free allowance. See [Understanding fuel](02-understanding-fuel.md).
