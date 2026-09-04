// Owner-requested Git storage inventory. Repository identity selects the R2
// namespace; server limits bound work and the report never permits deletion.
import { boundedInventory, R2InventoryListing, R2ObjectStore, LimitError, type InventoryLimits } from "ntig";
import { repository } from "./grasp-state.ts";
import { gitStoragePrefix } from "./grasp.ts";
import { featureOn } from "./settings.ts";
import { now } from "./event.ts";
import type { Relay } from "./relay.ts";

export const GIT_INVENTORY_LIMITS: Readonly<InventoryLimits> = Object.freeze({
  maxGets: 10_000, maxReadBytes: 16 * 1024 * 1024, maxObjectBytes: 4 * 1024 * 1024,
  maxListedKeys: 10_000, maxPages: 100, maxIndexNodes: 10_000, maxReceipts: 10_000,
  maxKeyBytes: 1024, maxCursorBytes: 8192,
});
const nextInventory = new WeakMap<Relay, number>();
const failure = (error: string, status: number) => ({ body: { error }, status });

// gitStorage compares one complete physical inventory with quota reservations.
// The cooldown limits repeated manual scans in this instance, including failures.
export async function gitStorage(relay: Relay, owner: string, identifier: string) {
  return relay.repositoryAccess.run("control", async () => {
    if (!featureOn(relay.settings.policy, "grasp")) return failure("not found", 404);
    if (relay.settings.isUnclaimed() || relay.settings.leaseExpired(now())) return failure("restricted: relay is not active", 403);
    const repo = repository(relay, owner, identifier);
    if (!repo) return failure("not found", 404);
    if (relay.fuelStatus().outOfFuel) return failure("restricted: relay storage or fuel limit reached", 403);
    const retryAfter = (nextInventory.get(relay) ?? 0) - now();
    if (retryAfter > 0) return { body: { error: "restricted: Git inventory cooldown; retry", retryAfter }, status: 429 };
    nextInventory.set(relay, now() + 60);
    const operations = { gets: 0, lists: 0 };
    let completed = false;
    try {
      const prefix = await gitStoragePrefix(relay, repo);
      const r2 = new R2ObjectStore(relay.media, { prefix, maxObjectBytes: GIT_INVENTORY_LIMITS.maxObjectBytes });
      const listing = new R2InventoryListing({ list: (options) => { operations.lists++; return relay.media.list(options); } }, { prefix, pageSize: 1000 });
      const inventory = await boundedInventory({ get: (key) => { operations.gets++; return r2.get(key); } }, listing, { prefix: "data/", limits: GIT_INVENTORY_LIMITS });
      const reservations = relay.sql.exec<{ keys: number; bytes: number }>(`SELECT count(*) AS keys, coalesce(sum(size),0) AS bytes FROM grasp_objects WHERE substr(key,1,?)=?`, prefix.length, prefix).one();
      completed = true;
      return { body: { result: { repository: { owner, identifier, announcement: repo.id }, inventory, reservations,
        reservationMinusListedBytes: reservations.bytes - inventory.listed.bytes, operations, limits: GIT_INVENTORY_LIMITS,
        cooldownSeconds: 60, capturedAt: now() } }, status: 200 };
    } catch (error) {
      return error instanceof LimitError ? failure("restricted: Git inventory limit reached; no complete report", 413)
        : failure("error: Git inventory unavailable; no complete report", 503);
    } finally {
      console.log(JSON.stringify({ msg: "git-inventory", relay: relay.slug, ...operations, completed }));
    }
  }, () => failure("restricted: relay operation in progress; retry", 429));
}
