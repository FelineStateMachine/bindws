import type { Event } from "./event.ts";

// List history keeps a small private undo trail for the replaceable lists that
// are difficult to recreate. It is keyed by the signing pubkey, never indexed
// as events, and only the same signer can ask for a version back.
export const LIST_KINDS = [3, 10002, 10003, 30003] as const;
export const LIST_HISTORY_LIMIT = 12;
export const LIST_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS list_history (
  owner      TEXT NOT NULL,
  kind       INTEGER NOT NULL,
  d          TEXT NOT NULL DEFAULT '',
  event_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  saved_at   INTEGER NOT NULL,
  raw        TEXT NOT NULL,
  PRIMARY KEY (owner, kind, d, event_id)
);
CREATE INDEX IF NOT EXISTS list_history_owner ON list_history(owner, saved_at DESC);
CREATE INDEX IF NOT EXISTS list_history_list ON list_history(owner, kind, d, created_at DESC);
`;

const listKind = (kind: number) => (LIST_KINDS as readonly number[]).includes(kind);
const listD = (e: Pick<Event, "kind" | "tags">) => e.kind >= 30000 ? e.tags.find((t: Event["tags"][number]) => t[0] === "d")?.[1] ?? "" : "";

// archiveCurrent records the version about to be replaced, then trims the
// owner's trail. The current event remains available through ordinary NIP-01
// queries; history is an internal recovery aid.
export const archiveCurrent = (sql: SqlStorage, e: Event, savedAt: number) => {
  if (!listKind(e.kind)) return;
  sql.exec(`INSERT OR IGNORE INTO list_history(owner,kind,d,event_id,created_at,saved_at,raw) VALUES(?,?,?,?,?,?,?)`, e.pubkey, e.kind, listD(e), e.id, e.created_at, savedAt, JSON.stringify(e));
  sql.exec(`DELETE FROM list_history WHERE owner=? AND kind=? AND d=? AND event_id NOT IN (SELECT event_id FROM list_history WHERE owner=? AND kind=? AND d=? ORDER BY created_at DESC, event_id ASC LIMIT ?)`, e.pubkey, e.kind, listD(e), e.pubkey, e.kind, listD(e), LIST_HISTORY_LIMIT);
};

// clearForDelete removes versions an author's NIP-09 deletion names. A list
// deletion must not leave private old tags recoverable through this feature.
export const clearForDelete = (sql: SqlStorage, author: string, eventID: string) => {
  sql.exec(`DELETE FROM list_history WHERE owner=? AND event_id=?`, author, eventID);
};

export const clearList = (sql: SqlStorage, owner: string, kind: number, d: string, before?: number) => {
  if (before === undefined) sql.exec(`DELETE FROM list_history WHERE owner=? AND kind=? AND d=?`, owner, kind, d);
  else sql.exec(`DELETE FROM list_history WHERE owner=? AND kind=? AND d=? AND created_at<=?`, owner, kind, d, before);
};

export interface ListHistoryRow { owner: string; kind: number; d: string; event_id: string; created_at: number; saved_at: number; raw: string; }

export const listHistory = (sql: SqlStorage, owner: string): Omit<ListHistoryRow, "owner" | "raw">[] =>
  sql.exec<Omit<ListHistoryRow, "owner" | "raw">>(`SELECT kind,d,event_id,created_at,saved_at FROM list_history WHERE owner=? ORDER BY saved_at DESC LIMIT 100`, owner).toArray();

export const restoreHistory = (sql: SqlStorage, owner: string, eventID: string): (Event & { sig: string }) | string => {
  const row = sql.exec<{ raw: string }>(`SELECT raw FROM list_history WHERE owner=? AND event_id=?`, owner, eventID).toArray()[0];
  if (!row) return "not found";
  try {
    const event = JSON.parse(row.raw) as Event;
    return { kind: event.kind, created_at: Math.floor(Date.now() / 1000), tags: event.tags, content: event.content } as Event & { sig: string };
  } catch {
    return "error: saved list is unreadable";
  }
};
