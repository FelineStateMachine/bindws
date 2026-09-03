---
title: Hosting bind.ws
audience: developer
---

# Hosting bind.ws

How to run your own copy on your own domain. You need a Cloudflare account with Workers Paid, a zone for the domain and `wrangler` logged in.

## Configure

Edit `wrangler.jsonc`:

| Setting | Meaning |
|---|---|
| `DOMAIN` | your domain, such as `relays.example` |
| `DEV_RELAY` | the name used when a request has no subdomain |
| `LIGHTNING_ADDRESS` | where zaps go; leave empty to run without top-ups |
| `SERVICE_PUBKEY` | the nostr pubkey zap requests must name |
| `FREE_*` | monthly allowances per relay |
| `SATS_PER_*` | prices past the allowances |

The prices carry a comment with the Cloudflare rates they were set from. Revisit them when the exchange rate moves.

Point `routes` at your zone: the apex as a custom domain and `*.<domain>/*` as a zone route. Create the R2 bucket named in `r2_buckets`.

## DNS

The wildcard route needs proxied placeholder records so Cloudflare answers for every subdomain:

| Record | Name | Value | Proxy |
|---|---|---|---|
| `AAAA` | `*` | `100::` | on |
| `A` | `*` | `192.0.2.1` | on |

Universal SSL covers one level of wildcard, which is all the names use.

## Service key

Zaps are addressed to a nostr pubkey. Generate a keypair, put the pubkey in `SERVICE_PUBKEY` and keep the secret out of the repo. Import the secret into the wallet behind `LIGHTNING_ADDRESS` so the wallet signs receipts as that key. The wallet's LNURL document must report `allowsNostr: true` and a `nostrPubkey`.

## Deploy

```
npm install
npm run deploy
```

Nothing else is required: no origin, no certificates, no servers. An idle relay costs nothing; a busy one is billed per Cloudflare's Durable Object and R2 rates.

## Operate

- `wrangler tail` streams logs, including receipt validation.
- Deploys roll to objects within seconds. Live websockets survive when the object hibernates; a mid-flight negentropy sync does not.
- The `usage` table grows one row per relay per month. No cleanup is needed.
- To take a relay down as the operator, use the owner's typed-name `deleterelay` call or the console.

## Local development

```
npm run dev
```

`wrangler dev --env dev` serves `http://<name>.localhost:8787` as the relay named `<name>`, `http://<domain>.localhost:8787` as the apex and anything else as `DEV_RELAY`. The dev environment has no routes, so hostnames pass through.

To use the console without a browser extension, run `node scripts/dev-signer.mjs` and paste the snippet from that file into the devtools console before clicking sign in. `node scripts/seed.mjs <name>` publishes sample events.
