// SQL Git namespaces retain their signed repository identity for quotas and
// portable backups. Their hash is independent of the relay's hostname.
import type { Relay } from "./relay.ts";

export const GIT_CATALOG_SCHEMA = `CREATE TABLE IF NOT EXISTS git_sqlite_catalog (
  repository TEXT PRIMARY KEY, owner TEXT NOT NULL, identifier TEXT NOT NULL, alternative INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS git_sqlite_catalog_owner ON git_sqlite_catalog(owner);`;

// sqliteGitBytes is a logical payload breakdown, already included in the
// database's physical SQLite meter. It is never added to the R2 media meter.
export function sqliteGitBytes(relay: Relay, owner?: string, namespace = ""): number {
  const row = owner === undefined
    ? gitSql<{ bytes: number }>(relay, "SELECT coalesce(sum(compressed_bytes + metadata_bytes),0) AS bytes FROM git_sqlite_meta").one()
    : gitSql<{ bytes: number }>(relay, "SELECT coalesce(sum(m.compressed_bytes + m.metadata_bytes),0) AS bytes FROM git_sqlite_meta m LEFT JOIN git_sqlite_catalog c ON c.repository=m.repository WHERE c.owner=? OR m.repository=?", owner, namespace).one();
  return row.bytes;
}

// gitSql accounts for SQL work outside the object store, including failed writes.
export function gitSql<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(relay: Relay, query: string, ...bindings: SqlStorageValue[]) {
  const cursor = relay.sql.exec<T>(query, ...bindings);
  let rows: T[];
  try { rows = cursor.toArray(); }
  finally { relay.meterPush(cursor.rowsRead, cursor.rowsWritten); }
  return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error("Expected one Git SQL row"); return rows[0]; } };
}
