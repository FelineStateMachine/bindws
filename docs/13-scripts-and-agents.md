---
title: Scripts and agents
audience: integrator
---

# Scripts and agents

A relay for a script, an agent or a service, from nothing to handover, without a browser. Everything the console does is a signed HTTP call, so a key is all a program needs.

## The path

1. **Lease a name.** `POST https://bind.ws/lease` answers with a memorable name, its websocket URL, its console URL and when it expires (14 days). Anyone can read and write to a lease. Sign the request with your key (NIP-98, below) and the lease is reserved: only that key can claim it.
2. **Claim it.** Send the `claim` method (NIP-86, below) to the relay's console URL. The relay converts in place: the events stay, your key is the owner. A lease starts with open writes and a 14-day keep-for rule; `resetrules` restores the defaults, or `applypreset` sets a bundle.
3. **Publish and query.** `POST /events` with an event, `POST /query` or `POST /count` with a list of filters, each signed with NIP-98. The signer has the same standing as an authenticated socket, so the owner's own reads pass any read rule.
4. **Bring history in.** `backfill` pulls your own events from the relays in your kind 10002 stored here, or from a list you give. `pullfrom` copies another relay. `listjobs` and `pullstatus` report on them.
5. **Read the summary.** `GET /card.json` is the machine-readable state of a name: owner, rules, fuel, member count when public and the group address. `GET /card.nostr` is the same, signed by the relay's key.
6. **Hand it over.** `transferowner` gives the relay to a member, so an agent can set a relay up and pass it to its human. The old owner stays on as a moderator.

The cheap way to learn a community is its views: `GET /view/profiles` is every member's name and picture in one signed record, `GET /view/relays` is where those members also publish, and `GET /view/zaps` says what the place values. Each is one request and no websocket; the relay's information document lists which views it keeps.

## Signing a request (NIP-98)

Every management call and every door that needs a key takes an `Authorization: Nostr <base64 event>` header. The event is:

| Field | Value |
|---|---|
| `kind` | 27235 |
| `created_at` | now; the relay allows 60 seconds either way |
| tag `u` | the full URL, host and path must match the request |
| tag `method` | the HTTP method |
| tag `payload` | the hex SHA-256 of the body, required whenever there is a body |

Encode the signed event as base64 JSON. The relay answers `401` with an `auth-required:` reason when any of that is off.

With curl and [nak](https://github.com/fiatjaf/nak):

```
BODY='{"method":"claim","params":[]}'
TOKEN=$(nak event -k 27235 -t u=https://brave-otter.bind.ws/ -t method=POST \
  -t payload=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1) --sec "$NSEC" | base64)
curl -X POST https://brave-otter.bind.ws/ \
  -H "Authorization: Nostr $TOKEN" -H "content-type: application/nostr+json+rpc" -d "$BODY"
```

With node and nostr-tools:

```js
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";

const sk = generateSecretKey();
const sign = (e) => finalizeEvent(e, sk);

// A reserved lease: the signature names the key that may claim it.
const leaseURL = "https://bind.ws/lease";
const lease = await (await fetch(leaseURL, { method: "POST", headers: { authorization: await getToken(leaseURL, "POST", sign, true) } })).json();

// Management calls go to the relay's root as JSON-RPC.
async function rpc(method, ...params) {
  const body = { method, params };
  const token = await getToken(lease.console, "POST", sign, true, body);
  const r = await fetch(lease.console, { method: "POST", headers: { authorization: token, "content-type": "application/nostr+json+rpc" }, body: JSON.stringify(body) });
  return r.json();
}

await rpc("claim");                       // { result: { owner, claimed: true, converted: true } }
await rpc("applypreset", "outbox");       // one call sets writes, reads, kinds and keep-for
await rpc("backfill", ["wss://relay.damus.io", "wss://nos.lol"]);
console.log(await rpc("listjobs"));
```

The bridge takes the same header. `POST /events` answers `{ event_id, accepted, message }`; `POST /query` answers a list of events; `POST /count` answers `{ count }`. The bridge is rate limited per address at four times the per-connection allowance and answers `429` past it.

## Management calls (NIP-86)

`POST /` with `content-type: application/nostr+json+rpc` and a body of `{ "method": "...", "params": [...] }`. Answers are `{ result }` or `{ error }` with a reason that starts with `invalid:`, `restricted:`, `unsupported:` or `error:`. Each method needs an action; the owner has every action and a moderator has read, members, ban, delete events, invites and reports. `supportedmethods` lists the names.

**Open to anyone**

- `claim`: take an unclaimed relay, or convert a lease you hold. Answers the owner and `converted: true` when it was a lease.

**Read**

- `stats`: counts, connections, name, owner and fuel.
- `getpolicy`: the whole policy.
- `listpresets`: preset names, descriptions and whether one needs a source.
- `listmembers`, `listpeople`, `listallowedpubkeys`: the member list in three shapes.
- `listbannedpubkeys`, `listbannedevents`, `listblockedips`: the bans.
- `listinvites`: live invites; a member under the invite rule sees only their own.
- `listrecentevents [limit]`: the newest events.
- `listallowedkinds`, `listblockedkinds`, `listretention`: the kind and keep-for rules.
- `listblobs`, `listreports`: files and the reports queue.
- `successionstatus`: last seen, days silent, warning state and the handover log; the heir may read it too.

**Members**

- `setmember pubkey {name?, note?, role?, keepDays?, maxBytes?}`: add or edit. Only the owner sets roles and limits.
- `allowpubkey pubkey reason`: the NIP-86 spelling of add.
- `removemember pubkey`, `unrulepubkey pubkey`: remove a member or lift a ban.
- `removesubtree pubkey`: remove a member and everyone they invited, stopping at moderators.

**Ban**

- `banpubkey pubkey reason`, `banevent id reason`, `allowevent id`.
- `blockip address reason`, `unblockip address`.
- `setblockedwords [words]`: the list, plain words or `/patterns/`; a pattern that does not compile fails the call with `invalid:`. `setpolicy {blockedWordsInTags: true}` searches tag values too.

**Delete events**

- `deleteevent id`: remove one event.

**Invites**

- `createinvite ttlSeconds maxUses note`: mint a code. A member under the invite rule may mint within their quota.
- `revokeinvite code`.

**Reports**

- `resolvereport id action`: dismiss, delete or ban.
- `listeventsneedingmoderation`: one entry per open reported thing, event id or blob hash.

**Rules**

- `setpolicy {…}`: any policy fields; the relay drops values it does not accept.
- `allowkind k`, `disallowkind k`, `unrulekind k`.
- `setretention kind|null days`, `purgekind kind|null days`.
- `resetrules`: the defaults, kind rules and keep-for cleared.
- `applypreset name {source?}`: a bundle; `search` needs a source, `articles` takes one.

**Identity**

- `changerelayname`, `changerelaydescription`, `changerelayicon`: one string each.
- `adddomain host`, `checkdomain host`, `removedomain host`, `listdomains`: custom hostnames, when the host has them on.
- `notifytest`: a test message to the owner.

**Storage**

- `storagestats`: bytes by kind, files, retention.
- `deleteblob sha256`.
- `listdumps`, `dumpnow`, `deletedump name`.

**Config**

- `exportconfig`, `importconfig document`: rules, identity, members, bans, address blocks, kind rules and retention as one document.

**Jobs**

- `pullfrom url`, `pullstatus`: copy one relay and follow it.
- `addjob {kind, relays, filter?, every?, label?}`: a `pull` or `push`, once or every 1, 6 or 24 hours. Up to 10 relays; filters take up to 50 authors and 50 kinds and a `since`.
- `removejob id`, `runjob id`, `listjobs`.
- `backfill [relays?]`: your own events from your kind 10002 here, or from the list.

**Transfer**

- `transferowner pubkey`: to a member; you stay as a moderator.
- `setsuccession {heir, afterDays}` with 90, 180 or 365, `clearsuccession`.

**Fork**

- `forkrelay {name?, holder?, filter?, people?}`: a new leased name filled from this relay, reserved for the holder. One an hour.

**Delete**

- `deleterelay name`: the relay's own name, typed, is the confirmation.

## Limits worth knowing

- Leases: five a minute per address and 60 a minute overall at the apex.
- Bridge and sockets: the relay's events and queries per minute, per connection, and four times that per address.
- Fuel: a lease cannot be zapped and runs on the free allowance only. A claimed relay past an allowance with no balance goes read-only until zapped; `GET /fuel` reports the meters.
- A relay only pulls from sources that let anyone read, and only pushes to targets that accept its key's writes.
