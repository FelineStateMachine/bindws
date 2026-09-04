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

Every relay has a card. `/card.svg` is a picture with the name, who may read and write, the fuel state and a QR code of the group address. `/card.json` has the same facts as data, plus the owner's profile address with this relay as the hint, and `/card.nostr` is the same facts signed by the relay's own key. A relay nobody has claimed, or a temporary one, gets a card that says so.

On the Identity tab, **Share** shows the card, the group address with **Copy naddr**, its QR code and **Copy embed** for a snippet to put on a profile or a page. Group-aware clients open that address as your relay's community. Cards refresh every five minutes.

## Your own domain

Your relay can answer at a hostname you own, such as `wss://relay.example.com`. On the Identity tab, under **Your own domain**, enter the hostname and click **Add**. The page shows one record to create at your DNS: a CNAME from your hostname to the address it gives you. It also shows an optional TXT record that activates the hostname before you switch the CNAME, for a move with no gap.

Once the record resolves, the certificate is issued on its own. **Check** asks where it stands; the hostname is live when both it and its certificate read active. **Remove** deletes the hostname and its certificate. Up to three hostnames per relay. Everything else stays the same: same events, same members, same console, reachable by either name. Hostnames survive a transfer and are removed with the relay.

When you add a hostname, the Identity tab lets you choose its destination:
your relay, a root site, a named site or a snapshot. You can change that
choice later. The management calls are `adddomain(host, site?)` and
`setdomainsite(host, site?)`; omit the optional site or send an empty value to
target your relay. `listdomains` returns the selected `site` label.

This needs the host to have switched custom domains on. If they have not, the block says so.

## Static websites

With the **Sites** feature enabled, the relay can host NIP-5A static websites
published by tools such as nsyte and nsite-cli. A root site uses
`https://<npub>.bind.ws`; a named site uses
`https://<pubkeyB36><dTag>.bind.ws`; and a snapshot uses
`https://v<snapshotIdB36>.bind.ws`. Site URLs are separate origins with only
the site door, so they do not open the relay console, websocket or file API.

The site's access follows **Rules > Reads**. Directories use `index.html`,
and a missing path falls back to `/404.html`; a missing manifest or unavailable
file returns 404. The relay verifies each file's hash before serving it. Site
manifests can expire with NIP-40, and the relay's retention rules also apply.
You can point a custom domain at a site from the domain controls. A
missing local blob is fetched from the manifest's public HTTPS servers and
then verified; with mirroring on, that fetch is normally done ahead of the
first visit.

The edge can cache a custom-host mapping for up to 60 seconds. A local site
record validates the selected label before serving it, so a stale mapping
cannot send a custom hostname to a removed site.

When reads require sign-in, a browser visit that accepts HTML shows a NIP-07
sign-in page. Your signer answers a five-minute challenge, and your relay
sets a Secure, HttpOnly, SameSite=Lax `__Host-nsite` cookie for seven days.
Your relay checks that cookie against the read rule on every request. Scripts
send an exact NIP-98 Authorization header instead. Site sign-in uses no
password.

## Git repositories

With the **GRASP-01** feature enabled, your relay can host NIP-34 Git
repositories alongside its sites. A repository owner publishes its
announcement and current refs to the relay, then Git clients use the
percent-encoded path `/<npub>/<identifier>.git`. The relay accepts only the
repository's announced service URLs, and the owner or its recursive
maintainers control the accepted branch and tag state.

The Git door requires open reads and includes cross-origin support. Choosing
signed-in or members-only reads disables public Git access and removes the
GRASP advertisement; it does not create a private Git host. The relay also accepts temporary
`refs/nostr/<event-id>` refs for NIP-34 pull requests while their event and Git
data arrive. Unmatched refs become eligible for cleanup after 20 minutes, and
event or state purgatory expires after 30 minutes. Retained Git bytes remain
in file storage even after a ref is hidden or removed.

GRASP-01 is a bounded Git host. It supports partial clones with
`blob:none` or `tree:0` filters, with pack and repository limits set by the
host's object store. It does not synchronize repositories between relays,
archive them or host private repositories. See [GRASP-01 Git hosting](22-grasp-01-git-hosting.md)
for the protocol and the limits.

## Media

Your relay stores images and files too. Who may upload follows the write rule: anyone, members or only you. The largest upload is set on the Rules tab, 25 MB by default and up to 95. Files count as files stored for fuel.

Files follow the read rule, the same as events. While reads are *anyone*, a file is a public link by hash. Under *signed in* or *members*, a download needs a Blossom `get` token or a signed request from someone the rule admits, the per-uploader list needs the same, and clients that fetch images without signing will not show them from that relay.

Clients that speak Blossom upload to `https://<name>.bind.ws` and get a link by hash. A client can ask first whether an upload would be accepted, and can have the relay copy a file from another server by URL instead of uploading it again.

Clients that speak NIP-96 instead find the same store through `/.well-known/nostr/nip96.json`. The two doors share one bucket and one file list, so a file uploaded through either is served, listed and deleted through both. Every answer carries the file's metadata tags (NIP-94).

## Reporting a file

Send a signed report (NIP-56) that names the file's hash to `PUT /report`. It lands in the reports queue on the Moderation tab next to reported events. Deleting a reported file also blocks its hash, so it cannot be uploaded again through either door.

## Views

A view is a record the relay signs from what it holds, so a client reads one event instead of hundreds. Each is a kind 30078 event by the relay's own key with `d` set to `bind.ws/view/<name>`, listed in the relay's information document under `views`, and served as JSON at `/view/<name>`.

| View | What it holds | How often |
|---|---|---|
| profiles | every member's newest name, picture and address, the owner first | daily, and when the member list changes |
| relays | where the members are: the relays in their relay lists, most shared first | daily |
| calendar | events in the next 30 days from the calendar kinds (NIP-52), with accepted RSVPs counted | hourly, when something changed |
| moderation | this month's counts: bans, reports filed and resolved, events hidden and deleted, addresses blocked | daily |
| articles | the newest 100 long-form posts by address, title and date | when one arrives, and daily |
| zaps | sats received by the top 50 notes and authors here, from stored receipts | hourly, when something changed |
| presence | who has a connection open and who wrote in the last 15 minutes | live, never stored |

Profiles and relays follow the directory switch; calendar, articles, zaps, moderation and presence follow the read rule. A members-only view is never stored, since a stored event is readable by anyone the read rule lets in. It is folded and signed when a member asks for it with a signed request. Presence is an ephemeral event, kind 20078, sent to whoever subscribes to it and answered from memory at `/view/presence`; it is broadcast at most once every 30 seconds.

Views cost rows written, which fuel counts. The Views tab shows what each one wrote on its last run, and the weekly digest adds them up. Any view can be set there to off, on write, hourly or daily; presence is on or off.

## Scripts

The relay has an HTTP door for scripts. Sign a request with your key (NIP-98) and post to `/events`, `/query` or `/count`. No websocket needed. The full path for scripts and agents, from leasing a relay to pulling history, is in [Scripts and agents](13-scripts-and-agents.md).
