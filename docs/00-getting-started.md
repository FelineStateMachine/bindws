---
title: Getting started
audience: user
---

# Getting started

bind.ws gives you a nostr relay at a name you choose. You claim it with your nostr key. There is no account, password or email.

You need a nostr key and a browser extension that signs with it, such as Alby, nos2x or Nostash. Any nostr client works with the relay once it exists.

## Claim a name

1. Open `https://<name>.bind.ws/` in your browser. Names are three to 32 lowercase letters, digits or hyphens.
2. If the page says the relay is unclaimed, click **Claim**. Your extension asks you to sign one request.
3. The page becomes your relay's console. You are the owner.

If the page shows someone else's name, the relay is taken. Pick another.

## Connect a client

Add the relay URL to your client's relay list:

```
wss://<name>.bind.ws
```

That is all. The relay speaks the standard protocol, so Damus, Amethyst, noStrudel, Coracle and the rest need no special setup. Your notes, reactions and profile land on your relay the moment you publish.

## Invite people

A new relay accepts writes from its members only. To add someone:

- **Invite link.** On the People tab, mint an invite. Share the link. The person opens it, signs once and becomes a member.
- **Add by key.** Paste a pubkey or npub on the People tab.

To let anyone write, set **Rules > Writes** to *anyone*. To let only yourself write, set it to *only me*.

## Names

Members can have a name at your relay, such as `alice@<name>.bind.ws`. Set it on the People tab, or a member sets it in their profile's NIP-05 field. Clients show the name next to the person.

## Media

Your relay stores images and files too. Clients that support Blossom upload to `https://<name>.bind.ws` and get a link by hash. Set the maximum upload size on the Rules tab.

## Scripts

If you write scripts, the relay has an HTTP door. Sign a request with your key (NIP-98) and post to `/events`, `/query` or `/count`. No websocket needed.

## Leave

Your data is yours. Any relay that supports sync (NIP-77) can pull everything from your relay:

```
nak sync -a <your-pubkey> wss://<name>.bind.ws wss://<other-relay>
```

## What it costs

Nothing until you pass the free allowance. See [Understanding fuel](02-understanding-fuel.md).
