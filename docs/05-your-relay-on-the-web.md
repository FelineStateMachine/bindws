---
title: Your relay on the web
audience: user
---

# Your relay on the web

Every name is a site as well as a relay. This guide covers what a browser, a link preview or a media client gets from `https://<name>.bind.ws`.

## Pages and the feed

A note has a page at `/e/<id>`. An article has one at `/a/<d>` when it is yours, or `/a/<npub>/<d>` for anyone's. Pages carry the tags link previews need, so a link to your relay unfurls in chat apps and on social sites. References to other notes and people become links when the target is on this relay.

`/feed.xml` is an Atom feed of the relay's newest 50 notes and articles. Add `?kinds=30023` for articles only, `?kinds=1` for notes only or `?author=<hex>` for one person.

Pages and the feed exist only while **Rules > Reads** is *anyone*. On a members-only relay they answer 404, so nothing leaks. Both are cached for five minutes.

## The card and the group address

Every relay has a card. `/card.svg` is a picture with the name, who may read and write, the fuel state and a QR code of the group address. `/card.json` has the same facts as data, and `/card.nostr` is the same facts signed by the relay's own key. A relay nobody has claimed, or a temporary one, gets a card that says so.

On the Identity tab, **Share** shows the card, the group address with **Copy naddr**, its QR code and **Copy embed** for a snippet to put on a profile or a page. Group-aware clients open that address as your relay's community. Cards refresh every five minutes.

## Your own domain

Your relay can answer at a hostname you own, such as `wss://relay.example.com`. On the Identity tab, under **Your own domain**, enter the hostname and click **Add**. The page shows one record to create at your DNS: a CNAME from your hostname to the address it gives you. It also shows an optional TXT record that activates the hostname before you switch the CNAME, for a move with no gap.

Once the record resolves, the certificate is issued on its own. **Check** asks where it stands; the hostname is live when both it and its certificate read active. **Remove** deletes the hostname and its certificate. Up to three hostnames per relay. Everything else stays the same: same events, same members, same console, reachable by either name. Hostnames survive a transfer and are removed with the relay.

This needs the host to have switched custom domains on. If they have not, the block says so.

## Media

Your relay stores images and files too. Who may upload follows the write rule: anyone, members or only you. The largest upload is set on the Rules tab, 25 MB by default and up to 95. Files count as files stored for fuel.

Clients that speak Blossom upload to `https://<name>.bind.ws` and get a link by hash. A client can ask first whether an upload would be accepted, and can have the relay copy a file from another server by URL instead of uploading it again.

Clients that speak NIP-96 instead find the same store through `/.well-known/nostr/nip96.json`. The two doors share one bucket and one file list, so a file uploaded through either is served, listed and deleted through both. Every answer carries the file's metadata tags (NIP-94).

## Reporting a file

Send a signed report (NIP-56) that names the file's hash to `PUT /report`. It lands in the reports queue on the Moderation tab next to reported events. Deleting a reported file also blocks its hash, so it cannot be uploaded again through either door.

## Scripts

The relay has an HTTP door for scripts. Sign a request with your key (NIP-98) and post to `/events`, `/query` or `/count`. No websocket needed. The full path for scripts and agents, from leasing a relay to pulling history, is in [Scripts and agents](13-scripts-and-agents.md).
