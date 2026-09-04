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

If you sign the request with your key (NIP-98, a signed request), only that key can claim the relay.

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

The relay's page has a shortcut for each app: open the **Connect** fold, under **Open it in an app**. Relay apps such as Jumble, Coracle and Flotilla open the relay as a place, and 0xchat opens its group. Feed apps such as Primal, Damus, Amethyst, Nostur and YakiHonne have no relay pages, so their button opens the owner's profile with this relay attached as the hint; add the relay in the app's settings from there. Two QR codes carry the same links to a phone.

## Your relay lists

Clients learn where to find you from lists you sign and publish: your relay list, your DM inbox, your search relays and your file servers. A new relay is not on any of them yet. On the Identity tab, **Your relay lists** has one row per list. **Check** reads your newest copy from here and from a few indexers. **Add this relay** puts this relay at the front and, with one signature, publishes the list back to every relay it names. Everything already on the list stays.

## Invite people

A fresh relay lets anyone write. To keep it to your people, set **Rules > Writes** to *members*. Then, on the People tab:

- **New invite link** mints a link. The person opens it, signs once and becomes a member.
- Paste a pubkey or npub in the top row to add someone directly.

Members can have a name at your relay, such as `alice@<name>.bind.ws`. Set it in their row, or they set it in their profile.

## From a file

Everything the console sets can live in a file in your own repository: the rules, the features, the kinds and keep-for rules, the members, the bans. From a checkout of the [repository](https://github.com/FelineStateMachine/bindws), pull the relay as it is, edit the file, see what applying it would change, then apply:

```
export RELAY_SK=<your key, hex or nsec>
npm run relay pull wss://<name>.bind.ws relay.json
npm run relay plan relay.json wss://<name>.bind.ws
npm run relay push relay.json wss://<name>.bind.ws
```

The file has a schema, so an editor checks it as you type, and `plan` never touches the relay. A template from the repository's `relay-templates/` folder is a good start: `10-quiet.jsonc` is a small private relay with every costly feature off. See [Scripts and agents](13-scripts-and-agents.md#the-configuration-file).

## What it costs

Nothing until the relay passes its monthly free allowance. Past that, use is paid in sats, and anyone can zap the relay to top it up. See [Understanding fuel](02-understanding-fuel.md).

## Where next

- [Relay configuration](01-relay-configuration.md): the console, tab by tab.
- [People and groups](03-people-and-groups.md): invites, moderators, groups in clients, handing the relay over.
- [Data and names](04-data-and-names.md): pulls, mirrors, dumps, presets and forks.
- [Scripts and agents](13-scripts-and-agents.md): the relay from a key and curl, and as a file.
- [Your relay on the web](05-your-relay-on-the-web.md): pages, the feed, the card, your own domain and media.
