---
title: Costs and margins
audience: developer
---

# Costs and margins

What a relay costs the host, what fuel charges for it, and how to keep the two apart as the bitcoin price moves. The numbers come from one script:

```
npm run margin                     # today's price
npm run margin -- --btc 60000      # a price you pick
npm run margin -- --relays 5000    # the deployment at that size
```

It prints markdown and exits with code 1 when any priced line is under the target margin. A GitHub Actions workflow runs it every Monday, puts the tables in the run summary and opens or refreshes one issue when a line is under target.

## The model

Fuel prices four resource lines: SQLite event storage, R2 media storage,
Durable Object duration and rows written. Each fuel price is a sats figure in
`wrangler.jsonc`. Each Cloudflare price is a dollar figure on their pricing
pages, copied into the script with the date it was checked. The bitcoin price
joins the two.

The four lines are the tenant-facing budget, not a complete provider invoice.
The relay records stored event bytes, stored media bytes, its awake-time
counter and rows written by its SQLite work. GRASP objects share the media
storage allowance with Blossom files and dumps; NIP-5A mirroring does the same.
Marmot events share event storage and ordinary row accounting. Site proxy and
Git request bytes are visible traffic with no fuel price, and tenant usage does
not gain a separate feature surcharge.

Some provider costs remain outside the four tenant-priced lines. R2 operations, KV reads and
writes, and platform requests can be billed by operation even when the relay
only exposes bytes. The row meter drains cursors recorded by `Store.x`; direct SQL bookkeeping
in GRASP, site queues and other modules bypasses it. The awake-time meter
uses entrypoint gaps capped at ten seconds, so a long Git or remote-fetch
operation is not measured as an exact request duration.
Those costs belong in the host's deployment review and margin target; they do
not silently change the four meters shown to a relay owner.

For a line with cost `c` dollars per unit and price `p` sats per unit at `B` dollars per bitcoin, revenue per unit is `p / 1e8 * B` and margin is `1 - c / revenue`. The script defaults to a 33% margin on revenue, which prices a line at about 1.493x cost. The floor is 20%. Under the target the weekly run flags it; under the floor, review pricing.

Because prices are in sats and costs in dollars, margins move with the exchange rate on their own. A rising bitcoin widens them. A falling one narrows them, and the script prints, for each line, the bitcoin price under which the target no longer holds and the price under which the floor breaks.

## The lines, checked Sept. 3, 2026

At $81,500 per bitcoin:

| Line | Cloudflare | Fuel | Margin | Target holds above |
|---|---|---|---|---|
| Events stored | $0.20 per GB-month | 400 sats | 39% | $74,600 |
| Files stored | $0.015 per GB-month | 30 sats | 39% | $74,600 |
| Time awake | $0.0058 per hour | 11 sats | 36% | $78,200 |
| Rows written | $1.00 per million | 2,000 sats | 39% | $74,600 |

Time awake is an hour of a Durable Object held in memory at 128 MB, which Cloudflare bills as 460.8 GB-seconds. Hibernating objects incur no duration charge, but retained storage and alarm work can still cost the host.

## The free tier

At the dated rates above, a relay that spends its whole allowance costs the host about $0.86 a month. Time awake is most of it. Storage is nearly free at these sizes. The rows allowance was a million until Sept. 2026, which made it $1.00 of a $1.61 tier; it came down to 250,000, about 15 times what a personal relay writes, because rows are the one line Cloudflare charges real money per unit.

| Allowance | Amount | Cost |
|---|---|---|
| Events stored | 100 MB | $0.02 |
| Files stored | 1 GB | $0.015 |
| Time awake | 100 hours | $0.58 |
| Rows written | 250,000 | $0.25 |

Few relays get near the allowance. At the dated rates above, a typical personal relay, 20 MB of events, 100 MB of files, eight hours awake and 100,000 rows a month, costs about 15 cents once the plan's included quotas are used up, and those quotas cover the first few dozen relays outright.

## The deployment

The script projects a fleet from two illustrative shapes, a typical relay and a heavy one that passes its allowances and pays fuel, at a chosen share of heavy relays. These are assumptions, not measured customer workloads or a validated provider bill. The fleet projection includes platform requests, rows read and R2 operations as host costs even though these have no separate tenant price. Worker CPU, logs, traces, Analytics Engine, site-index KV operations, custom-hostname fees, payment fees and support still need deployment measurements or separate budgets.

The free tier is a cost the paid relays and the host share. Unpriced operations consume part of the margin on paid usage. A target on four priced lines alone does not establish a fleet margin after free users and shared costs.

The bounded GRASP implementation adds a relay-wide ceiling of 320 MiB for
retained Git objects, with 4 MiB packs, 16 MiB packed history and bounded
transaction, ref and object counts. This is a safety limit and shares the
existing media allowance; it is not a new free tier. Retained bytes can remain
billable after expired metadata is hidden when immutable Git history or a
cleanup transaction still keeps them.

The current [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)
distinguish storage, execution and operation charges. The historical fleet
shapes below the script's pricing tables are not measured site or Git workloads.
Use deployment telemetry before treating their projected margin as coverage
for these features.

## Weekly

The workflow is `.github/workflows/margin.yml`. Read the summary. When a line is flagged:

1. Run the script locally to see the suggested prices for the target at today's rate.
2. Change the `SATS_PER_*` values in `wrangler.jsonc`. The comment above them records the rate they were set at; update it.
3. Deploy. Fuel meters are unchanged; only the price of what is over the allowance moves, from the next charge.

Prices go up when bitcoin falls. When it rises, do nothing until a line has sat above twice the target for a month, then bring it down. Relay owners see prices on the front page and on their Fuel section, so every change is visible the moment it deploys. The table above was checked on Sept. 3, 2026; rerun `npm run margin` and verify current provider pricing before using it for a new forecast.

## Accounting coverage, checked Sept. 4, 2026

The following inventory describes the host with the current repository
inventory contract and the owner-only inventory admission path. The pinned ntig 0.3.0
package supports both formats; installing it does not migrate roots.
Observing an expense does not authorize a new customer charge. `/fuel` and the
Health tab expose aggregate tenant meters, not every operation the host pays
for.

| Dimension | Existing source and persistence | Coverage limit |
|---|---|---|
| Usage and credits | [Fuel](../src/fuel.ts), monthly SQLite usage and unique receipt IDs | Counters become durable only after a flush; receipts prevent duplicate credit |
| SQLite storage | `Relay.eventBytes`, the database's allocated size | Includes tables beyond events; daily charging uses the current size, not a continuous storage integral |
| R2 storage | `Relay.mediaBytes`, blobs + dumps + imports + `grasp_objects` | Shared allowance; retained history and conservative reservations can outlive visible refs |
| Awake time | `Relay.touch`, in-memory ten-second entrypoint gaps | No handler completion timing; long async work, idle gaps and restart estimates differ from provider duration |
| SQL rows | [Store](../src/store.ts), cursors from `Store.x`, then `Relay.tally` | Direct SQL in settings, GRASP, sites, media and other modules bypasses the meter; DO key-value and alarm work is not covered |
| Traffic | `Relay.meterBytes` and socket counters, then monthly usage | No fuel price; socket string lengths and attempted/produced HTTP bytes are not exact delivered wire bytes |
| Requests | [Worker routing](../src/index.ts), HTTP, RPC, sockets and alarms | No durable per-tenant request ledger; application REQ counters are not platform request counts |
| R2 operations | [Git object wrapper](../src/grasp.ts), [Blossom](../src/blossom.ts), [site mirrors](../src/site-mirror.ts) and dumps | No durable per-tenant Class A/B ledger; observer callbacks are best-effort evidence |
| Jobs and alarms | [Jobs](../src/jobs.ts) and `Relay.alarm` | Required cleanup, mirrors and retries consume host work; no optional maintenance budget exists |
| KV and external services | [Host routing](../src/edge.ts), [site index](../src/sites.ts), notifications and provider fetches | No tenant operation meter for reads, writes, misses, retries or external fees |
| Observability | `Relay.flushUsage`, console deltas and optional Analytics Engine | Logs, traces and analytics are expense and diagnosis sources, not the durable fuel ledger |

[Relay](../src/relay.ts) batches usage in memory. A restart can lose an
unflushed batch. `flushUsage` resets counters before `Fuel.record`; a failed
record can therefore lose that batch too. Its final `Store.drain` discards
pending cursors, so a direct flush without `tally` can omit rows. Usage is
assigned to the month of the flush rather than split across the work's month
boundary. These are accounting gaps, not grounds for reconstructing charges
against old tenant balances.

Git reserves the larger retained object size in SQLite before PUT. Success
reconciles the size; a definite CAS loss uses HEAD to reconcile it. An
exception leaves the reservation because the write may have succeeded. No
automatic reconciliation queue or orphan collector exists. Counting PUT
bytes again as stored bytes would double-charge existing media accounting.
Future temporary packs also need reservations while both copies exist.

For an explicitly migrated format-2 repository, ref advertisements read two
R2 objects, the root and manifest. This saves legacy history and pack reads
on that path; full loads and Git transfers still read all stored packs.
Each new commit also retains a manifest and receipt-index path nodes beside
its record and optional pack. Ref-only workloads can pass 128 transactions,
but their metadata and reservation rows continue to grow. All of these keys
use the same pre-PUT storage reservation. CAS-loser objects remain accounted
for, and an ambiguous PUT can leave a reservation larger than physical
storage. Neither receipt lookup nor checkpointing reclaims old bytes.
Operation counts are host costs, not a new tenant charge; lower read costs
alone do not establish a margin after metadata writes and retained storage.

Git HTTP requests reuse bounded immutable payload in a session that ends with
the request. Repeated validation and promotion can reuse those bytes, while
mutable roots and all writes still reach R2 and its accounting adapter. New
requests start fresh, oversized objects bypass the cache, and Git validation
still runs. Lower R2 read counts do not imply lower CPU cost or a complete
request-memory bound. Inventory uses its own 16 MiB total-read, 4 MiB object,
10,000-key, 100-page, 10,000-node and 10,000-receipt budgets,
with a 1,024-byte key and 8,192-byte cursor limit; it returns no partial report
when a budget or root-stability check fails.

The isolated checkpoint fixture separates physical storage from the objects
referenced by the current format. Both workloads use one 214-byte Git pack,
260 transactions and an explicit checkpoint after transaction 128. One keeps
updating the same ref to the same commit; the other retains 259 new tags.
These local fixtures were first measured with ntig 0.2.1. The ntig 0.3.0
runtime inventory reproduces their physical, current-format and reservation
totals exactly. They are not production usage or a per-repository minimum.

| Retained Git payload | One fixed ref | Growing tags |
|---|---:|---:|
| Pack | 214 bytes | 214 bytes |
| Current root and manifest | 430 bytes | 16,888 bytes |
| All 260 retry records and current receipt index | 136,165 bytes | 126,982 bytes |
| Current-format total | 136,809 bytes | 144,084 bytes |
| Superseded manifests | 42,900 bytes | 1,671,120 bytes |
| Superseded receipt-index nodes | 332,722 bytes | 332,722 bytes |
| Physical objects and reserved bytes | 512,431 bytes | 2,147,926 bytes |

Each runtime scan uses 349 R2 GETs and one LIST. It reads 137,239 bytes for
fixed refs and 160,972 bytes for growing tags. At the R2 unit rates below,
those requests represent about $0.00013 per scan before pooled allowances
and billing-unit rounding, excluding execution and SQL costs. The scan does
not reclaim bytes or add a tenant fuel rate; its operation counts are
diagnostics rather than a billing ledger.

The ledger equals the paginated R2 inventory for every key and size in these
quiet fixtures: there is no reservation slack. Each untouched fixture
has no Git R2 keys; its first commit uses 631 bytes in three keys. SQLite
allocation, provider operations and execution are separate quantities.
The larger growing-tag total comes mainly from retained copies of earlier
ref maps. Its current manifest is only 16,783 bytes. Fixed-ref transaction
records are larger because their updates include an old object ID.

All historical retry records remain required by the current retention
contract. Current-format membership includes every pack in the manifest;
it does not establish that every object inside those packs is reachable
from today's refs. Superseded metadata is outside the latest root's
dependency set, but older readers and in-flight publishers can still need
it. This inventory supplies no online deletion authority. No collector or
storage saving is deployed, and these bytes still count toward tenant file
usage. Coordinated metadata collection is the larger target in this fixture;
changing receipt retention would change retry semantics.

`npm test -- test/object/grasp-checkpoint.test.ts --reporter=verbose --disableConsoleIntercept`
reproduces the inventory, current-format traversal, all historical receipt
lookups and unchanged root checks. The measurements apply to healthy,
quiescent fixtures; ambiguous writes can still leave reservation slack.

`repository-access.ts` carries one live owner token across awaits. Git,
non-GET controls, alarms, event ingestion and direct lease, adoption and
teardown paths use the same admission seam, and nested work owned by that
token proceeds. Async handlers can still interleave across independent
instances or R2 clients. The token is admission control, not persisted crash
recovery or authority to delete data. Repository CAS and persisted authority
remain necessary.

The coordination tests pause actual Git HTTP and alarm requests at an R2
root read. Competing Git requests return 429 without reading R2. The active
`repositoryAccess` token admits nested work owned by that operation and
refuses unrelated controls, event writes and alarms until it releases. This
is live-instance admission evidence, not proof of crash recovery or exclusive
maintenance across clients. Both successful and failed R2 reads release the
token. Consuming the completed HTTP response performs no more R2 reads in this
fixture.

| Entry point | Existing coordination | Limit before collection |
|---|---|---|
| Git advertisement, fetch and push | `repositoryAccess` owns the live token across the Git operation | Live-instance admission only; no persisted reader lease |
| Accepted state and promotion | Run inside the Git token or the alarm token; promotion rechecks candidates after reads | An immutable read session caches bytes but acquires no cross-instance lock |
| Non-GET HTTP management | The control token refuses an active Git operation | Nested work owned by the active token proceeds |
| Signed events, imports and pulls | The event token refuses an unrelated Git or control operation | Independent instances can still interleave |
| Alarm, PR expiry and pending promotion | The alarm defers and reschedules when another token is active, otherwise it owns the alarm token | Alarm work is not crash recovery |
| Whole-relay deletion | Management or lease-expiry alarm enters the teardown token | Teardown deletes the whole slug prefix; it is not a metadata collector |
| Direct repository helper calls | Production callers enter through the repository access seam | Helpers do not become durable locks or deletion authority |

The current HTTP handler constructs its response bytes before the read
session closes. A future streaming path would need to preserve coordination
until its last storage read. The owner token does not coordinate an
independent R2 client, another object ID sharing a prefix, or recovery after
the owning instance is replaced. CAS protects root publication, but does not
prevent deletion of an object that a reader or unpublished writer still
needs. Removing a repository announcement also leaves its WAL and quota
rows behind; visibility is not a storage-liveness test. The repository helper
itself has no host admission; production callers enter through
`repositoryAccess`.

The owner-only `gitstorage` management method makes this distinction visible
without turning it into a cleanup operation. It walks one repository under
bounded budgets and reports physical, live, unreferenced and unknown objects
by class, SQL reservations and the reservation-to-listed-byte difference. A
complete report is required, and a changed root, budget exhaustion or backend
failure returns no partial result. The 60-second per-instance cooldown limits
repeated scans. Unreferenced bytes remain tenant storage until a future,
separately authorized collection protocol exists.

Before metadata collection, a complete inventory needs explicit object,
byte and operation budgets and must refuse an incomplete mark. The host
also needs a proven ownership and recovery protocol covering active
readers, unpublished writes, administrative deletion and maintenance.
Budget exhaustion, missing or corrupt dependencies and changed roots must
prevent a deletion decision. Stable before/after roots alone are insufficient:
a reader may hold an older root, or a publisher may have uploaded objects
without publishing its new root yet. This remains a collection blocker; the
tests exercise the runtime admission seam but introduce no collector.

`npm test -- test/object/grasp-coordination.test.ts` reproduces the paused
HTTP/alarm checks. The checkpoint inventory above remains an isolated,
quiescent fixture rather than an online maintenance API.

Provider request accounting separates HTTP/RPC/alarm invocations from
incoming WebSocket messages, which have a 20:1 billing ratio. Socket frames
do not become Worker requests. DO duration counts overlapping work once per
object; idle objects eligible for hibernation have no duration charge.
DO key-value operations and alarm writes also consume SQLite rows. Included
allocations and billing-unit rounding apply at account level.
See [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

R2 Standard includes pooled storage and operation allowances. Beyond them,
storage is $0.015/GB-month, Class A operations $4.50/million and Class B
$0.36/million, with billing-unit rounding. Free egress does not remove those
operation costs. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) and
[Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)
cover other host expenses. These sources were checked on Sept. 4, 2026.

## A 40% margin scenario

This is a planning target; the deployed rates, allowances and weekly default
remain unchanged. A 40% gross margin means `price = cost / 0.60`, or about
1.667x cost. Multiplying cost by 1.40 produces only a 28.57% margin.

```
npm run margin -- --btc 60000 --target 0.40
npm run margin -- --btc 80000 --target 0.40
npm run margin -- --btc 100000 --target 0.40
```

These are Sept. 4 planning scenarios, not bitcoin spot quotes. At the
current sats rates, before free users and other expenses:

| BTC scenario | Events, files and rows margin | Awake margin |
|---|---|---|
| $60,000 | 16.67% | 12.73% |
| $80,000 | 37.50% | 34.55% |
| $100,000 | 50.00% | 47.64% |

The 40% threshold is about $83,333/BTC for events, files and rows, and
$87,273/BTC for awake time at $0.00576 per provider hour. The script already
uses gross margin; its existing 33% default was never a 40% markup formula.

For a whole deployment, the planning condition is
`revenue >= (provider bill + shared operating costs + subsidy) / 0.60`.
The subsidy is only free-user cost not already included in the provider bill;
counting it twice overstates expense. Provider allocations are pooled once,
including other services on the account, rather than granted anew per relay.

An illustrative personal relay consumes about $0.152 of the four resource
lines at marginal list rates: 20 MB events, 100 MB files, eight provider hours
and 100,000 written rows. A relay consuming all current allowances reaches
about $0.861 before other costs and account rounding. Actual duration and row
usage must come from provider evidence because the tenant meters are partial.

Storage-light workloads can still be expensive. One million Class A and ten
million Class B operations beyond the pooled allocation cost $8.10 even if
they repeatedly access only a few kilobytes. Across 100 such relays that is
$810 before duration, requests or rows; storage revenue alone cannot cover it.
A fleet forecast therefore needs active tenant share, utilization, operation
mix, cache misses, retries and concentration in its busiest tenants, alongside
FX and payment-fee sensitivity. The script's two shapes do not establish this
distribution.

## What can be bundled

These are proposed operating boundaries, not new allowances or charges.

| Work | Proposed treatment |
|---|---|
| Bounded metadata and health reads during ordinary use | Bundled with request and abuse caps; no separate tiny surcharge |
| Service-caused retries and ambiguous-write reconciliation | Host operating budget; record attempts and expense without charging a second logical operation |
| Existing retained data | Existing storage meter, including reserved and temporary bytes; no second Git storage charge |
| Free tenants | Explicit monthly fleet subsidy budget with utilization and heavy-tail review |
| High-volume scans, repeated cold clones and uncached site fetches | Bounded work and request quotas; operation-heavy use cannot be treated as unlimited because bytes are unpriced |
| Optional optimization | Tenant-visible budget and deferral; extra wake-ups require opt-in |

## Proposed maintenance contract

The current ntig 0.3.0 package has no resumable optimization runner. No
maintenance job, budget setting, wake schedule, format migration or garbage
collection is enabled by this contract. Existing ref cleanup, retention and
alarms keep their current roles. An eventual integration has these boundaries:

| Stage | Host and backend contract |
|---|---|
| Eligibility | Cheap stored statistics identify pack/read amplification, reclaimable bytes or a limit approaching; no daily full scan or unconditional repack |
| Admission | Optional work starts only while the tenant is already active by default; foreground requests take priority before each bounded step |
| Reservation | A durable job ID and UTC budget month reserve bounded work, operation counts and temporary retained bytes before execution |
| Execution | A resumable cursor, bounded I/O and a cooperative deadline limit each step; a timer alone cannot preempt arbitrary work safely |
| Completion | Persist outcome and actual expense once per step; stable attempt IDs separate retries from completed logical work |
| Recovery | A crash or ambiguous write keeps its reservation until reconciliation; CAS and persisted authority protect state across restarts |
| Scheduling | Extra wakes require opt-in, a monthly budget and an allowed window; later window, manual run and pause are separate choices |
| Exhaustion | Optional work defers; a write that cannot safely fit a hard limit fails clearly without discarding protected data |
| Retention | Optimization never authorizes deleting retained history; reachability, readers and retention rules need a separate proof |

Host expense accounting stays separate from tenant charge calculation. A
future duration observer measures the union of registered work intervals,
including long steps, without claiming it is the provider's entire active
lifetime. Its validation covers overlap, mid-step flush, month boundaries,
crash before and after persistence, retries, reservation exhaustion and
foreground arrival. The host contract also needs tests for ambiguous PUT,
temporary copies, authority changes and paused scheduling before it runs
against customer data.
