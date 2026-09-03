<p align="center"><img src="docs/img/wordmark.svg" alt="bind.ws" width="320"></p>
<p align="center">Relay on demand. Sign once, and it's yours.</p>

Every name under bind.ws is a nostr relay. Claim one with your nostr key, point any client at `wss://<name>.bind.ws` and it's yours: members, invites, names, media, search, sync and an HTTP door for scripts, all from the relay's own page. An idle relay costs nothing. A busy one pays its way with zaps.

It runs on Cloudflare Workers with one Durable Object per name, SQLite inside it and R2 beside it.

<p align="center"><img src="docs/img/relay.png" alt="A relay's page: connect, people, fuel" width="720"></p>

## Docs

**For users**

- [Getting started](docs/00-getting-started.md): claim a name, connect a client, invite people, leave.
- [Relay configuration](docs/01-relay-configuration.md): the console, tab by tab.
- [Understanding fuel](docs/02-understanding-fuel.md): what is measured, what is free, what a zap buys.

**For developers**

- [Architecture](docs/10-architecture.md): worker, object, storage, alarm, fuel, identity.
- [Hosting bind.ws](docs/11-hosting-bindws.md): run your own on your own domain.
- [Develop and extend](docs/12-develop-extend.md): layout, tests, adding methods and NIPs.

## Quick start

```
npm install
npm run dev      # http://<name>.localhost:8787
npm test
npm run deploy
```

## License

MIT
