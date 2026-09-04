---
title: Hosting without Cloudflare
audience: developer
---

# Hosting without Cloudflare

How to run bind.ws on your own machines, with nothing from Cloudflare in the path. The Worker is the same code; [celld](https://celld.dev) runs it, an S3-compatible bucket you own holds everything, and a reverse proxy of yours answers TLS. bind.ws itself runs on Cloudflare ([Hosting bind.ws](11-hosting-bindws.md)); this is the other supported way, and the section at the end says what "supported" means.

## What runs where

celld is Deno's self-hosted, distributed implementation of Durable Objects and Workers, Apache-2.0. Each relay is a cell: a named server with its own SQLite database, replicated into the bucket. Nodes coordinate through the bucket alone, with conditional writes, so there is no control plane and no consensus service. The R2 binding that holds media is served from the same bucket, under `r2/bindws-media/`, and the KV namespace that maps custom hostnames lives there too.

| | On Cloudflare | On celld |
|---|---|---|
| The relay objects | Durable Objects | cells, same code, same SQLite |
| Media, dumps, imports | R2 | the R2 binding on the fleet bucket |
| TLS and names | Universal SSL, wildcard route | your proxy, one of two ways below |
| Custom domains | Cloudflare for SaaS from the console | you map them with `celld kv put` |
| The client's address | `cf-connecting-ip` | the header your proxy sets, `CLIENT_IP_HEADER` |
| The lease door's limit | rate limit bindings | token buckets on the node, the same figures |
| Fuel and zaps | LNURL over outbound fetch | the same |
| Logs | `wrangler tail` | the node's stdout, [telemetry](https://celld.dev/docs/telemetry) |

What does not carry over: the console's custom domain tab says the feature is not enabled, because there is no Cloudflare for SaaS to register hostnames with; the operator maps them by hand instead. The fuel prices in the config were set from Cloudflare's rates; set your own from what your machines cost, or leave `LIGHTNING_ADDRESS` empty and run without top-ups, allowances still apply.

## What you need

- A Linux box, x86-64 or ARM64. Two for celld's default durability posture, which acknowledges a write once a second node holds it; one node works with `CELLD_DURABILITY=bucket`, where every write waits for the bucket instead. Apple Silicon works for development.
- An S3-compatible bucket with conditional writes. celld acquires each cell with `If-None-Match: *` and updates it with `If-Match`, and is not correct on a store without them. Which providers celld qualifies, and which lack the writes, is on its [guarantees page](https://celld.dev/docs/guarantees); `celld diagnose` tests a bucket before you trust it. The steps below use MinIO, the simplest thing to run on the same box, which passes celld's storage test without being qualified for production; use `RELEASE.2025-09-07T16-13-09Z` or later, the release before it answers the conditional create wrongly.
- A domain, with the apex and a wildcard pointed at your proxy.
- A reverse proxy for TLS: Caddy is shown, nginx works the same way.
- Node 22 and the repo's `node_modules`, which carry the esbuild that `celld deploy` needs.

## The bucket

MinIO on the box, as one binary, with a bucket for the fleet:

```
MINIO_ROOT_USER=bindws MINIO_ROOT_PASSWORD=<secret> minio server /var/lib/minio --address 127.0.0.1:9000
mc alias set local http://127.0.0.1:9000 bindws <secret>
mc mb local/bindws-fleet
```

Then tell celld where it is, and let it probe the conditional writes:

```
export AWS_ACCESS_KEY_ID=bindws AWS_SECRET_ACCESS_KEY=<secret> AWS_REGION=us-east-1
export CELLD_BUCKET=s3://bindws-fleet S3_ENDPOINT=http://127.0.0.1:9000
celld diagnose
```

The line to look for is `ok bucket conditional write: create, reject-create, update, reject-stale`. Give the credentials to one fleet only; celld's [security notes](https://celld.dev/docs/security) say why. A managed bucket at a qualified provider takes the same variables with its endpoint and region.

## Configure

`wrangler.celld.jsonc` is the Worker's config for celld: the same code, bindings, migrations and prices as `wrangler.jsonc`, and only the keys celld accepts, since it stops on any other. `node scripts/check-celld.mjs`, part of `npm run typecheck`, fails when the two drift. Edit:

| Setting | Meaning |
|---|---|
| `DOMAIN` | your domain, such as `relays.example` |
| `CLIENT_IP_HEADER` | the header your proxy puts the client's address in: `x-forwarded-for` for Caddy, `x-real-ip` for nginx. Empty means no address is known, and per-address limits and blocks stand down. Set it only behind a proxy that overwrites the header on every request, or a client can name its own address |
| `LIGHTNING_ADDRESS`, `SERVICE_PUBKEY` | as on Cloudflare ([Service key](11-hosting-bindws.md#service-key)) |
| `FREE_*`, `SATS_PER_*` | your allowances and prices |

`ZONE_ID` and `CNAME_TARGET` stay empty. A node can also override any var at start with `CELLD_VAR_<NAME>=value` or a `CELLD_VARS_FILE`, which is where a value you would rather not commit goes.

## Install celld, deploy, run a node

```
curl -fsSL https://celld.dev/install.sh -o install.sh && sh install.sh   # into ~/.local/bin
npm ci
PATH="$PWD/node_modules/.bin:$PATH" celld deploy wrangler.celld.jsonc
```

`celld deploy` bundles the Worker with esbuild and writes it to the bucket; a running node adopts the new version at its next poll, without a restart, so a deploy is the same command again. Then a node:

```
CELLD_DURABILITY=bucket celld --listen 127.0.0.1:8080 --trust-forwarded-headers
```

`--trust-forwarded-headers` lets the proxy's `X-Forwarded-Host` and `X-Forwarded-Proto` set the request's host and scheme, which the relay prints in every URL it hands out; set it only behind your proxy. A second node makes the fleet, and the default durability posture, work: give each a private address peers can reach, `--internal-listen 10.0.0.2:8081 --advertise 10.0.0.2:8081`, on a network of your own or an overlay such as WireGuard, since peer traffic has no TLS of its own. The [celld docs](https://celld.dev/docs) cover the fleet: `celld diagnose --peer`, draining, memory limits, the health path at `/.well-known/celld/health`.

Run it under systemd or whatever keeps your daemons up. Idle relays hibernate in celld as on Cloudflare; `CELLD_MAX_RESIDENT_CELLS` caps how many a node keeps in memory at once.

## TLS and names: the proxy

Every name under the domain is a relay, so the proxy needs a certificate for any name. Two ways:

**Certificates on demand.** Caddy can fetch a certificate the first time a hostname is asked for, and asks the Worker first whether the hostname is one of ours, so a stranger cannot make it fetch certificates for junk. The Worker answers that at `/.well-known/bindws/hostname?domain=<host>`, on any host, with 200 or 404 and no body: the apex, a valid name under the domain, or a custom hostname in the map. A Caddyfile:

```
{
  on_demand_tls {
    ask http://127.0.0.1:8080/.well-known/bindws/hostname
  }
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy 127.0.0.1:8080
}
```

Caddy passes `Host` through and sets `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` on its own, and proxies websockets without more said, so this is the whole file. `CLIENT_IP_HEADER` is `x-forwarded-for`.

**One wildcard certificate.** A certificate for `*.relays.example` and the apex, through the DNS-01 challenge with your DNS provider, covers every name at once and needs no question asked. Caddy does that with a DNS plugin for the provider; certbot does it too. Custom hostnames still need their own certificates, which on-demand issuance gives and a wildcard does not; with a wildcard, add on-demand issuance for hostnames outside the domain, or skip custom domains.

DNS: an `A` or `AAAA` record for the apex and for `*`, both at the proxy.

With nginx, set `proxy_set_header` for `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Real-IP`, and `Upgrade` and `Connection` for the websocket; `CLIENT_IP_HEADER` is `x-real-ip`.

## Custom domains

An owner who wants `relay.example.org` on their relay sends you the hostname and the relay name, and points a CNAME at your proxy. You map it:

```
celld kv put hosts relay.example.org <name>
```

`hosts` is the namespace id in `wrangler.celld.jsonc`. The Worker looks unknown hostnames up in that map, with a minute of cache per isolate, and the on-demand question above says yes for mapped hostnames, so Caddy fetches the certificate on the first visit. `celld kv delete hosts relay.example.org` takes it back; deleting the relay does not, since the object never learns about hostnames mapped this way.

## Local development

```
npm ci
PATH="$PWD/node_modules/.bin:$PATH" celld dev wrangler.celld.jsonc
```

That serves `http://127.0.0.1:9876` as the relay named `DEV_RELAY`, with state in `.celld/dev`, rebuilding on every change; `http://<name>.localhost:9876` is the relay `<name>`, as under `wrangler dev`. No bucket is needed. The black-box suite runs against it:

```
CLAIM=1 RELAY_URL=ws://127.0.0.1:9876 npm run test:conformance
```

## The promise

The `celld` workflow runs the conformance suite against `celld dev` on demand, from the Actions tab or `gh workflow run celld.yml`, and `npm run typecheck` fails when the two configs drift, so this path is checked rather than merely described. Cloudflare is where bind.ws runs and what gets first attention; a celld release that breaks something here may take a little while to be caught up with, and the pinned version in CI says which one is known good. The path is not dropped quietly: removing support for any host takes a notice at the top of this page and in the README first, and the commit that removes it names the last commit that had it, so anyone on that host can stay there.
