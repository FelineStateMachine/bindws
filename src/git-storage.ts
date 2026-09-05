// Owner-requested Git inventory reads bounded SQLite metadata. The database's
// physical byte meter already includes these objects, refs and retry receipts.
import { repository } from "./grasp-state.ts";
import { gitStoragePrefix } from "./grasp.ts";
import { DEFAULT_GIT_SQLITE_LIMITS } from "./git-sqlite.ts";
import { featureOn } from "./settings.ts";
import { now } from "./event.ts";
import type { Relay } from "./relay.ts";

const nextInventory = new WeakMap<Relay, number>();
const failure = (error: string, status: number) => ({ body: { error }, status });

// gitStorage reports one repository's retained payload and the shared database.
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
    const namespace = (await gitStoragePrefix(relay, repo)).split("/").filter(Boolean).at(-1)!;
    const cursor = relay.sql.exec<{ count: number; rawBytes: number; compressedBytes: number; metadataBytes: number }>("SELECT object_count AS count, raw_bytes AS rawBytes, compressed_bytes AS compressedBytes, metadata_bytes AS metadataBytes FROM git_sqlite_meta WHERE repository=?", namespace);
    const objects = cursor.toArray()[0] ?? { count: 0, rawBytes: 0, compressedBytes: 0, metadataBytes: 0 };
    const counts = relay.sql.exec<{ refs: number; receipts: number }>("SELECT (SELECT count(*) FROM git_sqlite_refs WHERE repository=?) AS refs, (SELECT count(*) FROM git_sqlite_receipts WHERE repository=?) AS receipts", namespace, namespace);
    const { refs, receipts } = counts.one();
    relay.meterPush(cursor.rowsRead + counts.rowsRead, cursor.rowsWritten + counts.rowsWritten);
    return { body: { result: { repository: { owner, identifier, announcement: repo.id }, backend: "sqlite", objects, refs, receipts, physicalDatabaseBytes: relay.eventBytes(), operations: { gets: 0, lists: 0 }, limits: DEFAULT_GIT_SQLITE_LIMITS, cooldownSeconds: 60, capturedAt: now() } }, status: 200 };
  }, () => failure("restricted: relay operation in progress; retry", 429));
}
