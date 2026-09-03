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
| `LEASE_DAYS` | how long a temporary relay from `POST /lease` lives; 14 if unset |
| `ratelimits` | how many leases a minute, per address and overall; the defaults are 5 and 60 |

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

## Custom domains

Owners can put a relay under a hostname they control, such as `relay.example.com`, through [Cloudflare for SaaS custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/). The feature is off until the one-time setup below is done; the console says so until then.

How it works, from the [docs](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/): the customer's hostname CNAMEs to a name in your zone, so their traffic enters your zone, and a Worker route that matches any host sends it to the Worker. The Worker sees the customer's hostname in `Host`, looks it up in the `HOSTS` KV namespace to find the relay name, and forwards to that object exactly as it does for `<name>.<domain>`. Inside the object nothing changes; the URLs it prints already follow the request host. Certificates use [HTTP validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/http/), which Cloudflare completes on its own once the CNAME resolves to you, so the owner has one DNS record to create. [Hostname validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/) happens the same way; the optional TXT record the console also shows lets an owner activate the hostname before switching DNS.

One-time setup, in this order:

1. **Enable Cloudflare for SaaS** on the zone: dashboard, your zone, SSL/TLS, Custom Hostnames, Enable. Non-enterprise zones enter payment details; the first 100 hostnames are free ([enable](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/enable/), [plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)).
2. **Create the fallback origin record**, originless and proxied, in the zone's DNS ([worker as origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)):

   | Record | Name | Value | Proxy |
   |---|---|---|---|
   | `AAAA` | `fallback` | `100::` | on |

   Then on the Custom Hostnames page set **Fallback Origin** to `fallback.<domain>` and wait for it to read Active. The wildcard placeholder records from the DNS section above are not enough here: the fallback origin must be a record of its own.
3. **Create the CNAME target** owners will point at, proxied ([getting started, step 2](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/#2-optional-create-cname-target)):

   | Record | Name | Value | Proxy |
   |---|---|---|---|
   | `CNAME` | `customers` | `fallback.<domain>` | on |

   `CNAME_TARGET` in `wrangler.jsonc` must match: `customers.<domain>`.
4. **Routes.** Only now can the zone take a catch-all route, which is what makes custom hostname traffic reach the Worker; before Cloudflare for SaaS is enabled the API refuses it with code 10022. Uncomment the `*/*` route in `wrangler.jsonc` and deploy, then confirm in Workers Routes that the zone lists `*/*` for `bindws-relay`. If wrangler still refuses the pattern, add it by hand on that page.
5. **KV namespace.** `npx wrangler kv namespace create HOSTS` and put the id in both `kv_namespaces` entries of `wrangler.jsonc` (the repo carries the bind.ws one).
6. **API token.** My Profile, API Tokens, Create Token, Custom token: permission **Zone, SSL and Certificates, Edit**, zone resources limited to your zone. Store it as a secret: `npx wrangler secret put CF_API_TOKEN`. `ZONE_ID` in `wrangler.jsonc` is the zone the hostnames are created in (the same id the routes use). Without the secret the console reports custom domains as not enabled and the methods answer `unsupported:`.

The Worker calls three endpoints with that token: [create](https://developers.cloudflare.com/api/resources/custom_hostnames/methods/create/), [get](https://developers.cloudflare.com/api/resources/custom_hostnames/methods/get/) and [delete](https://developers.cloudflare.com/api/resources/custom_hostnames/methods/delete/) under `/zones/<zone>/custom_hostnames`. A hostname is ready when the API reports `status: active` and `ssl.status: active` ([check when ready](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/#check-when-a-custom-hostname-is-ready)). Deleting a relay removes its hostnames from Cloudflare and KV; transferring keeps them. Do not let an owner add the zone's own apex as a custom hostname; the relay refuses anything under `<domain>`.

Locally, `wrangler dev` has no custom hostname traffic; the KV binding exists so tests can seed a mapping.

## Local development

```
npm run dev
```

`wrangler dev --env dev` serves `http://<name>.localhost:8787` as the relay named `<name>`, `http://<domain>.localhost:8787` as the apex and anything else as `DEV_RELAY`. The dev environment has no routes, so hostnames pass through.

To use the console without a browser extension, run `node scripts/dev-signer.mjs` and paste the snippet from that file into the devtools console before clicking sign in. `node scripts/seed.mjs <name>` publishes sample events.
