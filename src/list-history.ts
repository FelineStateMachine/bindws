import { expiration, type Event } from "./event.ts";

export type UnsignedEvent = { kind: number; created_at: number; tags: string[][]; content: string };
type HistorySQL = <T extends Record<string, SqlStorageValue>>(q: string, ...args: unknown[]) => SqlStorageCursor<T>;

// List history keeps a small private undo trail for the replaceable lists that
// are difficult to recreate. It is keyed by the signing pubkey, never indexed
// as events, and only the same signer can ask for a version back.
export const LIST_KINDS = [3, 10002, 10003, 30003] as const;
export const LIST_HISTORY_LIMIT = 12;
export const LIST_HISTORY_OWNER_LIMIT = 96;
export const LIST_HISTORY_GLOBAL_LIMIT = 4096;
export const LIST_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS list_history (
  owner      TEXT NOT NULL,
  kind       INTEGER NOT NULL,
  d          TEXT NOT NULL DEFAULT '',
  event_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  saved_at   INTEGER NOT NULL,
  expires    INTEGER NOT NULL DEFAULT 0,
  raw        TEXT NOT NULL,
  PRIMARY KEY (owner, kind, d, event_id)
);
CREATE INDEX IF NOT EXISTS list_history_owner ON list_history(owner, saved_at DESC);
CREATE INDEX IF NOT EXISTS list_history_list ON list_history(owner, kind, d, created_at DESC);
`;

const listKind = (kind: number) => (LIST_KINDS as readonly number[]).includes(kind);
export const isListKind = listKind;
const listD = (e: Pick<Event, "kind" | "tags">) => e.kind >= 30000 ? e.tags.find((t: Event["tags"][number]) => t[0] === "d")?.[1] ?? "" : "";

// archiveCurrent records the version about to be replaced, then trims the
// owner's trail. The current event remains available through ordinary NIP-01
// queries; history is an internal recovery aid.
export const archiveCurrent = (x: HistorySQL, e: Event, savedAt: number) => {
  if (!listKind(e.kind)) return;
  const d = listD(e);
  x(`INSERT OR IGNORE INTO list_history(owner,kind,d,event_id,created_at,saved_at,expires,raw) VALUES(?,?,?,?,?,?,?,?)`, e.pubkey, e.kind, d, e.id, e.created_at, savedAt, expiration(e), JSON.stringify(e));
  x(`DELETE FROM list_history WHERE owner=? AND kind=? AND d=? AND event_id NOT IN (SELECT event_id FROM list_history WHERE owner=? AND kind=? AND d=? ORDER BY created_at DESC, event_id ASC LIMIT ?)`, e.pubkey, e.kind, d, e.pubkey, e.kind, d, LIST_HISTORY_LIMIT);
  x(`DELETE FROM list_history WHERE owner=? AND event_id NOT IN (SELECT event_id FROM list_history WHERE owner=? ORDER BY saved_at DESC, event_id ASC LIMIT ?)`, e.pubkey, e.pubkey, LIST_HISTORY_OWNER_LIMIT);
  x(`DELETE FROM list_history WHERE event_id NOT IN (SELECT event_id FROM list_history ORDER BY saved_at DESC, event_id ASC LIMIT ?)`, LIST_HISTORY_GLOBAL_LIMIT);
};

// clearForDelete removes versions an author's NIP-09 deletion names. A list
// deletion must not leave private old tags recoverable through this feature.
export const clearForDelete = (x: HistorySQL, author: string, eventID: string) => {
  x(`DELETE FROM list_history WHERE owner=? AND event_id=?`, author, eventID);
};

export const clearList = (x: HistorySQL, owner: string, kind: number, d: string, before?: number) => {
  if (before === undefined) x(`DELETE FROM list_history WHERE owner=? AND kind=? AND d=?`, owner, kind, d);
  else x(`DELETE FROM list_history WHERE owner=? AND kind=? AND d=? AND created_at<=?`, owner, kind, d, before);
};

export interface ListHistoryRow { owner: string; kind: number; d: string; event_id: string; created_at: number; saved_at: number; raw: string; }

export const listHistory = (x: HistorySQL, owner: string, now: number): Omit<ListHistoryRow, "owner" | "raw">[] => {
  x(`DELETE FROM list_history WHERE owner=? AND expires>0 AND expires<=?`, owner, now);
  return x<Omit<ListHistoryRow, "owner" | "raw">>(`SELECT kind,d,event_id,created_at,saved_at FROM list_history WHERE owner=? AND (expires=0 OR expires>?) ORDER BY saved_at DESC LIMIT ?`, owner, now, LIST_HISTORY_OWNER_LIMIT).toArray();
};

export const restoreHistory = (x: HistorySQL, owner: string, eventID: string, now: number): { draft: UnsignedEvent; diff: { addedTags: string[][]; removedTags: string[][]; contentChanged: boolean } } | string => {
  x(`DELETE FROM list_history WHERE owner=? AND expires>0 AND expires<=?`, owner, now);
  const row = x<{ raw: string }>(`SELECT raw FROM list_history WHERE owner=? AND event_id=? AND (expires=0 OR expires>?)`, owner, eventID, now).toArray()[0];
  if (!row) return "not found";
  try {
    const event = JSON.parse(row.raw) as Event;
    const current = x<{ created_at: number; raw: string }>(`SELECT created_at,raw FROM events WHERE pubkey=? AND kind=? AND d=?`, owner, event.kind, listD(event)).toArray()[0];
    let currentEvent: Event | undefined;
    try { currentEvent = current ? JSON.parse(current.raw) as Event : undefined; } catch { /* saved current rows are validated events */ }
    const key = (t: string[]) => JSON.stringify(t);
    const currentTags = new Set((currentEvent?.tags ?? []).map(key));
    const oldTags = new Set(event.tags.map(key));
    return {
      draft: { kind: event.kind, created_at: Math.max(Math.floor(Date.now() / 1000), (current?.created_at ?? 0) + 1), tags: event.tags, content: event.content },
      diff: { addedTags: event.tags.filter((t) => !currentTags.has(key(t))), removedTags: (currentEvent?.tags ?? []).filter((t) => !oldTags.has(key(t))), contentChanged: (currentEvent?.content ?? "") !== event.content },
    };
  } catch {
    return "error: saved list is unreadable";
  }
};
