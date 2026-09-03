---
title: Getting started
audience: user
---

# Getting started

bind.ws gives you a nostr relay at a name you choose. You claim it with your nostr key. There is no account, password or email.

You need a nostr key and something that signs with it: a browser extension such as Alby, nos2x or Nostash, or a signer app such as Amber or nsec.app on your phone. Any nostr client works with the relay once it exists.

## Try one

Not sure about a name yet? Click **Try one now** on the front page, or ask from a script:

```
curl -X POST https://bind.ws/lease
```

You get a relay at a memorable name, such as `wss://brave-otter.bind.ws`. Anyone can read and write to it for 14 days. Then everything on it is deleted and the name is freed. Its page says when.

To keep it, open its page and click **Claim this relay** before then. The events and files stay, and you are the owner. The page then offers to switch to the default rules, since a temporary relay keeps events for 14 days only.

If you sign the request with your key (a signed request, NIP-98), only that key can claim the relay.

## Claim a name

1. Open `https://<name>.bind.ws/`. Names are three to 32 lowercase letters, digits or hyphens.
2. If the page says nobody owns the relay, click **Claim this relay**. Your extension asks you to sign once.
3. The page becomes your relay's console. You are the owner.

If the page shows someone else's name, the relay is taken. Pick another.

## From a phone

No extension is needed. Open the relay's page, choose **Use a remote signer** and tap **Open in your signer app**. The app asks you to approve the connection, and the page continues where you left off. On a computer, paste the `bunker://` URL your signer app gives you and click **Connect**.

The relay carries the signer traffic itself, so this works on a relay nobody has claimed yet. The page remembers the connection until you sign out.

## Connect a client

Add the relay URL to your client's relay list:

```
wss://<name>.bind.ws
```

That is all. The relay speaks the standard protocol, so Damus, Amethyst, noStrudel, Coracle and the rest need no special setup. Your notes, reactions and profile land on your relay the moment you publish.

## Tell your clients

Clients find your relay through the lists you publish: your relay list, your DM inbox, your search relays and your Blossom servers. On the Identity tab, **Tell your clients** has one row per list. **Check** finds your newest copy here and on a few indexers. **Add me** puts this relay first, asks you to sign once and publishes the merged list here, to the relays it names and to the indexers. Nothing you had listed is lost.

## Invite people

A fresh relay lets anyone write. To keep it to your people, set **Rules > Writes** to *members*. Then, on the People tab:

- **New invite link** mints a link. The person opens it, signs once and becomes a member.
- Paste a pubkey or npub in the top row to add someone directly.

Members can have a name at your relay, such as `alice@<name>.bind.ws`. Set it in their row, or they set it in their profile.

## What it costs

Nothing until the relay passes its monthly free allowance. Past that, use is paid in sats, and anyone can zap the relay to top it up. See [Understanding fuel](02-understanding-fuel.md).

## Where next

- [Relay configuration](01-relay-configuration.md): the console, tab by tab.
- [People and groups](03-people-and-groups.md): invites, moderators, groups in clients, handing the relay over.
- [Data and names](04-data-and-names.md): pulls, mirrors, dumps, presets and forks.
- [Your relay on the web](05-your-relay-on-the-web.md): pages, the feed, the card, your own domain and media.
