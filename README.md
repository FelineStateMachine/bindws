<p align="center"><img src="docs/img/wordmark.svg" alt="bind.ws" width="320"></p>
<p align="center">Relay on demand. Sign once, and it's yours.</p>

Every name under bind.ws is a nostr relay. Claim one with your nostr key, point any client at `wss://<name>.bind.ws` and it's yours. An idle relay costs nothing. A busy one pays its way with zaps.

Not ready to pick a name? Ask for one:

```
curl -X POST https://bind.ws/lease
```

That answers with a relay at a memorable name, open to anyone for 14 days. Claim it before then and it stays, events and all.

<p align="center"><img src="docs/img/relay.png" alt="A relay's page: connect, people, fuel" width="720"></p>

## What a name gives you

- **A relay.** The standard protocol plus search, counts, sync, expiry, deletion, proof of work and an HTTP door for scripts. Works with every client.
- **A community.** Members, invite links, an invite tree, moderators, a signed roster and one NIP-29 group per relay, so group-aware clients show it as a place.
- **A site.** Notes and articles as pages with link previews, an Atom feed, and a card with a QR of the group address.
- **A file host.** Blossom and NIP-96 on the same bucket, with mirroring, pre-flight checks and file reports.
- **A console.** Seven tabs on the relay's own page, signed by a browser extension or a remote signer app on a phone. Presets set up an outbox, an inbox, a private relay, a chat, a search replica or a media host in one click.
- **Jobs.** Pull another relay in, keep a standing mirror, fetch your own history from your relay list, rebroadcast to other relays, and dump everything to a file on a schedule.
- **Your own domain.** `wss://relay.example.com` onto your relay with one CNAME.
- **Succession.** Name an heir. If your key goes silent, the relay warns you for a month and then hands itself over.

<p align="center"><img src="docs/img/console.png" alt="The console's People tab" width="720"></p>

It runs on Cloudflare Workers with one Durable Object per name, SQLite inside it and R2 beside it.

## Docs

**For users**

- [Getting started](docs/00-getting-started.md): try one, claim a name, connect, invite.
- [Relay configuration](docs/01-relay-configuration.md): the console, tab by tab.
- [Understanding fuel](docs/02-understanding-fuel.md): what is measured, what is free, what a zap buys.
- [People and groups](docs/03-people-and-groups.md): members, invites, moderators, groups, handing over.
- [Data and names](docs/04-data-and-names.md): jobs, dumps, presets, forks, leaving.
- [Your relay on the web](docs/05-your-relay-on-the-web.md): pages, feed, card, custom domain, media.

**For scripts and agents**

- [Scripts and agents](docs/13-scripts-and-agents.md): a relay end to end with a key and curl, and every management method.
- [HTTP reference](docs/14-http-reference.md): every path, method, auth and answer.

**For developers**

- [Architecture](docs/10-architecture.md): routing, the object, storage, alarm, jobs, identity, groups.
- [Hosting bind.ws](docs/11-hosting-bindws.md): run your own on your own domain.
- [Develop and extend](docs/12-develop-extend.md): layout, tests, adding methods and NIPs, the console.
- [Costs and margins](docs/15-costs-and-margins.md): what a relay costs the host, what fuel charges, the weekly check against the bitcoin price.

## Quick start

```
npm install
npm run dev      # http://<name>.localhost:8787
npm test
npm run deploy
```

## Protocol surface

NIP-01, 05, 09, 11, 13, 17, 29, 40, 42, 43, 45, 46 transport, 50, 56, 57, 59, 62, 67, 70, 77, 86, 94, 96, 98, and Blossom BUD-01, 02, 04, 06, 08, 09.

## License

MIT
