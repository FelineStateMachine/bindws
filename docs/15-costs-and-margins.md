---
title: Costs and margins
audience: developer
---

# Costs and margins

How applications budget a tenant's relay usage, interpret fuel meters and
control storage growth. Fuel prices the relay's measured resources; hosting
expenses determine the service's margins. The two serve different purposes.
[Understanding fuel](02-understanding-fuel.md) covers allowances and top-ups
for relay owners.

## Budget from the relay's meters

`GET /fuel` returns current usage, allowances, rates and balance without
authentication. The Health tab shows the same information. Applications read
these values from the relay instead of hard-coding the public service's
prices, since another deployment can set different rates and allowances.

| Fuel line | Usage and allowance fields | What the meter includes |
|---|---|---|
| Events stored | `eventBytes`, `freeEventBytes` | Allocated SQLite storage, including relay metadata, events and SQLite-backed Git repositories |
| Files stored | `mediaBytes`, `freeMediaBytes` | Uploaded files, dumps, imports and mirrored site files |
| Time awake | `activeMs`, `freeActiveMs` | An estimate from relay entrypoints, including client requests, jobs and alarms |
| Rows written | `rowsWritten`, `freeRowsWritten` | SQLite rows written by event storage and the Git object backend |

`rates` gives storage prices in sats per GB-month, awake time in sats per
hour and writes in sats per million rows. Balance and credited or charged
amounts use millisatoshis: `balanceMsats / 1000` is the balance in sats.
Storage above its allowance is charged daily, pro rata. Awake time and rows
use the usage accumulated in `month` against their monthly allowances.

`bytesIn`, `bytesOut` and `rowsRead` are diagnostics with no fuel price.
A request can still increase awake time or stored data even when its traffic
is unpriced. Sites, Marmot and Git share the existing allowances; enabling a
feature creates neither a separate allowance nor a request surcharge. Git
repositories use the relay's SQLite allowance. The configured
public rates remain separate: SQLite events are 400 sats per GB-month and R2
files are 30 sats per GB-month. The storage path alone does not establish
which option costs less for a repository.

The meters describe application accounting, not a complete provider bill.
Awake time is estimated from entrypoint gaps capped at ten seconds, rather
than timing each job to completion. Git object reads and writes report their
SQLite row work to the same meter. Usage is flushed in batches, so it is not a
durable record of every request. Applications use the reported balance
and `outOfFuel` for admission status rather than reconstructing charges from
traffic, event counts or wall-clock timings.

## How features consume the budget

| Workload | Resource use | Application choice |
|---|---|---|
| Events and Marmot messages | Event storage and database writes; encrypted envelopes still occupy space | Restrict admitted writers and set retention for kinds that do not need permanent history |
| Blossom files, dumps and imports | File storage alongside database metadata | Bound uploads and remove stored copies that are no longer needed |
| Sites | Manifests occupy event storage; mirrored files occupy file storage; remote fetches and mirrors wake the relay | Reuse unchanged files and choose whether the relay mirrors remote content |
| Git | Repositories occupy SQLite storage as compressed chunks, refs, receipts and indexes; clone, fetch and push wake the relay | Budget for repository history and ref updates, not just the checked-out files |
| Pulls, backfills and scheduled dumps | Jobs wake the relay and can add events, rows and files without a connected client | Use once-only jobs for one-time transfers and remove recurring jobs that no longer serve the application |

[Relay templates](../relay-templates/README.md) provide starting policies.
[Data and names](04-data-and-names.md) describes retention, dumps and jobs.
Feature limits still apply below the fuel allowance: a positive balance does
not increase a maximum upload size or repository cap.
The limits and admission rules are in
[GRASP-01 Git hosting](22-grasp-01-git-hosting.md) and
[HTTP reference](14-http-reference.md).

## Account for retained Git storage

Git storage has no fixed allocation per repository. It grows with compressed
objects, chunks, refs, transaction receipts and metadata, including ref-only
updates. Removing a branch, hiding an announcement or expiring a PR does not
remove its immutable history. Repositories retain these bytes in SQLite
and they count toward `eventBytes`. There is no automatic Git garbage
collector.

Git publication stores compressed object chunks, refs and retry receipts in
SQLite. Native SQL transactions publish them atomically, so a retry receipt
and its ref changes commit with the accepted objects. The physical database
meter includes indexes and metadata as well as compressed chunks. A logical
Git byte total is diagnostic and is not added to the fuel meter a second time.

The relay owner can inspect one hosted repository with the `gitstorage`
management method. It takes the repository owner's hex public key and the
repository identifier. The repository owner can differ from the relay owner.
The report identifies the backend and gives compressed payload bytes, raw
object bytes and metadata bytes for a SQLite repository. Those diagnostics
explain the SQLite total; they are not additional fuel lines.
[Scripts and agents](13-scripts-and-agents.md) describes signing the call;
[HTTP reference](14-http-reference.md) defines its responses.

| Report field | Interpretation |
|---|---|
| `backend` | `sqlite`, the repository's object and ref backend |
| `objects` | `count`, `rawBytes`, `compressedBytes` and `metadataBytes` for retained objects |
| `refs` | Number of stored refs |
| `receipts` | Number of retained retry receipts |
| `physicalDatabaseBytes` | The relay's complete SQLite size, including Git, events, indexes and metadata |

The object byte fields explain the repository's logical and compressed
payloads. `physicalDatabaseBytes` is shared by all relay data and is the value
used by `eventBytes`; it must not be added to `objects.compressedBytes`. The
report changes no stored objects, refs, receipts or fuel rates.

Inventory is a manual diagnostic, not a health poll. It reads bounded SQLite
metadata and holds the relay's admission owner while it runs, so competing Git
requests and mutations receive a retry response. The 60-second cooldown limits
repeated scans in a live instance and resets when that instance restarts. It is
not a recommended polling interval.

`operations` reports zero R2 gets and lists for the SQLite backend. The SQL
metadata queries still contribute rows to the ordinary SQLite row meter. The
diagnostic fields are not a second storage charge or a separate inventory fee.

## Handle limits without multiplying work

A client checks the response reason before retrying. A transient admission
refusal can clear; a storage or repository limit requires a change in the
workload or available budget.

| Condition | Client behavior |
|---|---|
| `outOfFuel` | Show the relay's allowance and balance; stop repeated writes until the budget permits them |
| Busy relay or rate limit (`429`) | Honor `Retry-After` or the response's `retryAfter` when supplied, and back off |
| Upload or repository limit | Keep the rejected operation visible to the user; a top-up does not raise a hard limit |
| Incomplete inventory | Keep the last complete report labelled with its capture time; an error does not mean zero usage or free storage |

Fuel exhaustion does not delete data. Ordinary reads remain available under
the read policy, but Git requests and remote site fetches also require fuel.
Already stored site files remain readable under their access rules. Client
interfaces distinguish these cases instead of treating every refusal as a
network error.

## Margins for deployments

For developers hosting the service, `npm run margin` compares configured fuel
rates with provider costs. It reads `wrangler.jsonc`, uses the provider rates
recorded in the script and either fetches a bitcoin price or accepts an
explicit scenario:

```
npm run margin
npm run margin -- --btc 60000
npm run margin -- --btc 60000 --target 0.40 --relays 5000
```

The explicit bitcoin prices are scenario inputs, not quotes. For cost `c`
dollars per unit, price `p` sats per unit and bitcoin price `B` dollars,
revenue is `p * B / 100000000` and gross margin is `1 - c / revenue`.
A target margin `m` requires `price = cost / (1 - m)` in the same currency.
The script defaults to a 33% target and a 20% floor. It exits with code 1 when
a priced line falls below target; the weekly workflow records the result and
opens or refreshes an issue.

Per-line margins do not establish a deployment margin. Provider allowances
are shared across the account, while tenants receive the relay allowances.
Free usage, R2 operations, platform requests, CPU, KV, observability and payment
costs also consume the service's revenue. A small stored dataset can generate
many reads or writes. The script's fleet shapes are illustrative assumptions;
actual workload mix and provider usage determine whether revenue covers the
deployment.

Provider prices and included allocations are documented under
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) and
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).
[Hosting bind.ws](11-hosting-bindws.md) describes deployment configuration.
Running the margin script changes no tenant rates; a rate change requires a
configuration change and deployment, and appears in the relay's `/fuel`
response.
