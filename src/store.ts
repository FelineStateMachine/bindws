// Persistence on Durable Object SQLite. Every method is
// synchronous, so each call is one atomic write batch on the DO.
import { canonical, expiration, isAddressable, isEphemeral, isPrivate, isReplaceable, tag, tagValues, type Event } from "./event.ts";
import { ftsQuery, searchTerms, type Filter } from "./filter.ts";
import { SITE_SCHEMA, SITE_KINDS } from "./sites.ts";
import { HLL } from "./hll.ts";
import { hexToBytes, type SyncItem } from "./negentropy.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  pubkey     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind       INTEGER NOT NULL,
  d          TEXT NOT NULL DEFAULT '',
  expires    INTEGER NOT NULL DEFAULT 0,
  raw        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ev_time    ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS ev_pk_kind ON events(pubkey, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS ev_kind    ON events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS ev_expires ON events(expires) WHERE expires > 0;
CREATE TABLE IF NOT EXISTS tags (
  event_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  value    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tag_lookup ON tags(name, value, event_id);
CREATE INDEX IF NOT EXISTS tag_event  ON tags(event_id);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(content);
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  DELETE FROM tags WHERE event_id = old.id;
  DELETE FROM search WHERE rowid = old.seq;
END;
CREATE TABLE IF NOT EXISTS vanished (
  pubkey TEXT PRIMARY KEY,
  until  INTEGER NOT NULL
);
`;

export const ERR_DUPLICATE = "duplicate: already have this event";
export const ERR_REPLACED = "duplicate: a newer version exists";
export const ERR_DELETED = "blocked: event was previously deleted by its author";
export const ERR_VANISHED = "blocked: this pubkey asked for its events to be deleted";
export const ERR_TOO_BIG = "blocked: this query is too big, narrow the filter";

// Access says who is asking. Private kinds only go to their parties unless all.
export interface Access {
  pubkeys: string[];
  all?: boolean;
}

// Lists are bound as one JSON parameter: DO SQLite allows 100 bindings per statement.
const inList = (col: string) => `${col} IN (SELECT value FROM json_each(?))`;

// searchable says which kinds go into the full-text index: the ones whose
// content is prose. Reactions, JSON blobs and private kinds are skipped; it
// keeps the index small and every event a few rows cheaper to write.
export const SEARCH_KINDS = new Set([0, 1, 11, 1111, 9802, 30023, 30024, 30818]);
export function searchable(kind: number): boolean {
  return SEARCH_KINDS.has(kind) && !isPrivate(kind);
}

export class Store {
  private pending: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  // Event ids under a report hold: left out of every read. Settings owns the
  // Set; the relay hands the same instance here.
  hidden: Set<string> = new Set();
  // What the full-text index takes (settings.ts, features.search): every
  // public kind with content, the prose kinds, or nothing. Changing it
  // affects events from then on; the index is not rebuilt.
  searchMode: () => "full" | "prose" | "off" = () => "prose";

  onSitesChanged: () => void = () => {};

  constructor(private sql: SqlStorage) {}

  init() {
    this.sql.exec(SCHEMA);
    this.sql.exec(SITE_SCHEMA);
  }

  // x runs a statement and remembers its cursor so drain() can report rows
  // read and written (the DO's billing units) once the cursor is consumed.
  private x<T extends Record<string, SqlStorageValue>>(q: string, ...args: unknown[]): SqlStorageCursor<T> {
    const c = this.sql.exec<T>(q, ...args);
    this.pending.push(c as SqlStorageCursor<Record<string, SqlStorageValue>>);
    if (q.startsWith("DELETE FROM events") && c.rowsWritten) this.onSitesChanged();
    return c;
  }

  drain(): { rowsRead: number; rowsWritten: number } {
    let rowsRead = 0;
    let rowsWritten = 0;
    for (const c of this.pending) {
      rowsRead += c.rowsRead;
      rowsWritten += c.rowsWritten;
    }
    this.pending = [];
    return { rowsRead, rowsWritten };
  }

  get databaseSize() {
    return this.sql.databaseSize;
  }

  // save applies the NIP-01/09/40/62 storage rules. It returns "" on success,
  // or the OK reason for a benign rejection. Ephemeral events store nothing.
  save(e: Event, now: number): string {
    if (isEphemeral(e.kind)) return "";
    const has = (q: string, ...args: unknown[]) => this.x(q, ...args).toArray().length > 0;
    if (has(`SELECT 1 FROM events WHERE id=?`, e.id)) return ERR_DUPLICATE;
    if (has(`SELECT 1 FROM vanished WHERE pubkey=? AND until>=?`, e.pubkey, e.created_at)) return ERR_VANISHED;
    // NIP-09 tombstones: the author's own deletions, or a recipient's for gift wraps.
    const deleters = [e.pubkey, ...(e.kind === 1059 ? tagValues(e, "p") : [])];
    if (
      has(
        `SELECT 1 FROM tags t JOIN events d ON d.id=t.event_id WHERE d.kind=5 AND t.name='e' AND t.value=? AND ${inList("d.pubkey")} LIMIT 1`,
        e.id,
        JSON.stringify(deleters),
      )
    )
      return ERR_DELETED;

    let d = "";
    if (isReplaceable(e.kind)) {
      if (has(`SELECT 1 FROM events WHERE pubkey=? AND kind=? AND (created_at>? OR (created_at=? AND id<?)) LIMIT 1`, e.pubkey, e.kind, e.created_at, e.created_at, e.id))
        return ERR_REPLACED;
      this.x(`DELETE FROM events WHERE pubkey=? AND kind=?`, e.pubkey, e.kind);
    } else if (isAddressable(e.kind)) {
      d = tag(e, "d");
      if (has(`SELECT 1 FROM events WHERE pubkey=? AND kind=? AND d=? AND (created_at>? OR (created_at=? AND id<?)) LIMIT 1`, e.pubkey, e.kind, d, e.created_at, e.created_at, e.id))
        return ERR_REPLACED;
      this.x(`DELETE FROM events WHERE pubkey=? AND kind=? AND d=?`, e.pubkey, e.kind, d);
    } else if (e.kind === 5) {
      for (const t of e.tags) {
        if (t.length < 2) continue;
        if (t[0] === "e") {
          this.x(
            `DELETE FROM events WHERE id=? AND (pubkey=? OR (kind=1059 AND EXISTS (SELECT 1 FROM tags WHERE tags.event_id=events.id AND name='p' AND value=?)))`,
            t[1], e.pubkey, e.pubkey,
          );
        } else if (t[0] === "a") {
          const parts = t[1].split(":");
          if (parts.length === 3 && parts[1] === e.pubkey) {
            this.x(`DELETE FROM events WHERE kind=? AND pubkey=? AND d=? AND created_at<=?`, parseInt(parts[0], 10) || 0, e.pubkey, parts[2], e.created_at);
          }
        }
      }
    }

    const { seq } = this.sql
      .exec<{ seq: number }>(`INSERT INTO events(id,pubkey,created_at,kind,d,expires,raw) VALUES(?,?,?,?,?,?,?) RETURNING seq`, e.id, e.pubkey, e.created_at, e.kind, d, expiration(e), canonical(e))
      .one();
    for (const t of e.tags) {
      if (t.length >= 2 && t[0].length === 1) this.x(`INSERT INTO tags(event_id,name,value) VALUES(?,?,?)`, e.id, t[0], t[1]);
    }
    if (SITE_KINDS.includes(e.kind)) this.onSitesChanged();
    const mode = this.searchMode();
    const indexed = mode === "full" ? !isPrivate(e.kind) : mode === "prose" && searchable(e.kind);
    if (e.content !== "" && indexed) this.x(`INSERT INTO search(rowid,content) VALUES(?,?)`, seq, e.content);
    return "";
  }

  // vanish implements NIP-62.
  vanish(pubkey: string, until: number) {
    this.bytesByAuthor.clear();
    this.x(`INSERT INTO vanished(pubkey,until) VALUES(?,?) ON CONFLICT(pubkey) DO UPDATE SET until=max(until,excluded.until)`, pubkey, until);
    this.x(`DELETE FROM events WHERE pubkey=? AND created_at<=?`, pubkey, until);
    this.x(`DELETE FROM events WHERE kind=1059 AND id IN (SELECT event_id FROM tags WHERE name='p' AND value=?)`, pubkey);
  }

  // sweepExpired deletes NIP-40 expired rows and returns the next expiry, or 0.
  sweepExpired(now: number): number {
    this.bytesByAuthor.clear();
    this.x(`DELETE FROM events WHERE expires > 0 AND expires <= ?`, now);
    const row = this.x<{ next: number | null }>(`SELECT MIN(expires) AS next FROM events WHERE expires > 0`).one();
    return row.next ?? 0;
  }

  private where(f: Filter, who: Access, now: number): { conds: string[]; args: unknown[] } {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (f.ids) {
      conds.push(inList("id"));
      args.push(JSON.stringify(f.ids));
    }
    if (f.authors) {
      conds.push(inList("pubkey"));
      args.push(JSON.stringify(f.authors));
    }
    if (f.kinds) {
      conds.push(inList("kind"));
      args.push(JSON.stringify(f.kinds));
    }
    if (f.since !== undefined) {
      conds.push("created_at >= ?");
      args.push(f.since);
    }
    if (f.until !== undefined) {
      conds.push("created_at <= ?");
      args.push(f.until);
    }
    for (const [name, vals] of Object.entries(f.tags)) {
      if (vals.length === 0) return { conds: ["0"], args: [] };
      conds.push(`EXISTS (SELECT 1 FROM tags WHERE tags.event_id=events.id AND name=? AND ${inList("value")})`);
      args.push(name, JSON.stringify(vals));
    }
    const terms = searchTerms(f.search);
    if (terms.length > 0) {
      conds.push("seq IN (SELECT rowid FROM search WHERE search MATCH ?)");
      args.push(ftsQuery(terms));
    }
    conds.push("(expires = 0 OR expires > ?)");
    args.push(now);
    if (this.hidden.size > 0) {
      conds.push(`id NOT IN (SELECT value FROM json_each(?))`);
      args.push(JSON.stringify([...this.hidden]));
    }
    if (!who.all) {
      if (who.pubkeys.length === 0) conds.push("kind NOT IN (4,1059)");
      else {
        conds.push(`(kind NOT IN (4,1059) OR ${inList("pubkey")} OR EXISTS (SELECT 1 FROM tags WHERE tags.event_id=events.id AND name='p' AND ${inList("value")}))`);
        const list = JSON.stringify(who.pubkeys);
        args.push(list, list);
      }
    }
    return { conds, args };
  }

  // query returns raw event JSON newest first, and whether more exist beyond the limit.
  query(f: Filter, who: Access, maxLimit: number, now: number): { rows: string[]; more: boolean } {
    const { conds, args } = this.where(f, who, now);
    let limit = maxLimit;
    if (f.limit !== undefined && f.limit < limit) limit = f.limit;
    if (limit < 0) limit = 0;
    const cur = this.x<{ raw: string }>(`SELECT raw FROM events WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id ASC LIMIT ?`, ...args, limit + 1);
    const rows: string[] = [];
    for (const r of cur) {
      if (rows.length === limit) return { rows, more: true };
      rows.push(r.raw);
    }
    return { rows, more: false };
  }

  count(filters: Filter[], who: Access, now: number): number {
    const ors: string[] = [];
    const args: unknown[] = [];
    for (const f of filters) {
      const w = this.where(f, who, now);
      ors.push("(" + w.conds.join(" AND ") + ")");
      args.push(...w.args);
    }
    return this.x<{ n: number }>(`SELECT count(*) AS n FROM events WHERE ${ors.join(" OR ")}`, ...args).one().n;
  }

  countHLL(f: Filter, who: Access, offset: number, now: number): { count: number; hll: string } {
    const { conds, args } = this.where(f, who, now);
    const h = new HLL(offset);
    let count = 0;
    for (const r of this.x<{ pubkey: string }>(`SELECT pubkey FROM events WHERE ${conds.join(" AND ")}`, ...args)) {
      h.add(r.pubkey);
      count++;
    }
    return { count, hll: h.hex() };
  }

  // syncItems lists (created_at, id) for NIP-77; the filter's limit is ignored.
  syncItems(f: Filter, who: Access, max: number, now: number): SyncItem[] | "too big" {
    const { conds, args } = this.where(f, who, now);
    const items: SyncItem[] = [];
    for (const r of this.x<{ created_at: number; id: string }>(`SELECT created_at, id FROM events WHERE ${conds.join(" AND ")} ORDER BY created_at, id LIMIT ?`, ...args, max + 1)) {
      if (items.length === max) return "too big";
      items.push({ timestamp: r.created_at, id: hexToBytes(r.id) });
    }
    return items;
  }

  stats(): { events: number; bytes: number; oldest: number; newest: number } {
    const row = this.x<{ n: number; oldest: number | null; newest: number | null }>(`SELECT count(*) AS n, min(created_at) AS oldest, max(created_at) AS newest FROM events`).one();
    return { events: row.n, bytes: this.sql.databaseSize, oldest: row.oldest ?? 0, newest: row.newest ?? 0 };
  }

  // kinds counts events per kind since a timestamp, busiest first, for the dashboard.
  kinds(since: number): { kind: number; n: number }[] {
    return this.x<{ kind: number; n: number }>(`SELECT kind, count(*) AS n FROM events WHERE created_at >= ? GROUP BY kind ORDER BY n DESC LIMIT 50`, since).toArray();
  }

  // kindCounts groups events since a timestamp by kind, for the dashboard.
  kindCounts(since: number): { kind: number; n: number }[] {
    return this.x<{ kind: number; n: number }>(`SELECT kind, count(*) AS n FROM events WHERE created_at >= ? GROUP BY kind ORDER BY n DESC LIMIT 50`, since).toArray();
  }

  // recent returns the newest events for the dashboard, regardless of visibility.
  // after returns up to `limit` rows with a sequence number past `seq`, in
  // insertion order, for jobs that walk the store with a cursor.
  after(seq: number, f: Filter, limit: number, now: number): { seq: number; raw: string }[] {
    const { conds, args } = this.where(f, { pubkeys: [], all: true }, now);
    return this.x<{ seq: number; raw: string }>(`SELECT seq, raw FROM events WHERE seq>? AND ${conds.join(" AND ")} ORDER BY seq LIMIT ?`, seq, ...args, limit).toArray();
  }

  recent(limit: number, now: number): string[] {
    return this.x<{ raw: string }>(`SELECT raw FROM events WHERE (expires = 0 OR expires > ?) ORDER BY created_at DESC, id ASC LIMIT ?`, now, limit).toArray().map((r) => r.raw);
  }

  deleteEvent(id: string): boolean {
    this.bytesByAuthor.clear();
    return this.x(`DELETE FROM events WHERE id=?`, id).rowsWritten > 0;
  }

  // authorBytes is how much raw event text one pubkey has stored, for the
  // per-member cap. Cached per author; save adds to it, and anything that
  // deletes clears the cache rather than guessing.
  private bytesByAuthor = new Map<string, number>();
  authorBytes(pubkey: string): number {
    const cached = this.bytesByAuthor.get(pubkey);
    if (cached !== undefined) return cached;
    const n = this.x<{ n: number | null }>(`SELECT sum(length(raw)) AS n FROM events WHERE pubkey=?`, pubkey).one().n ?? 0;
    this.bytesByAuthor.set(pubkey, n);
    return n;
  }
  // noteSaved keeps the cache right after a save. A replaceable kind may
  // have displaced an older row, so its author is simply recounted next time.
  noteSaved(pubkey: string, bytes: number, replaceable: boolean) {
    if (replaceable) {
      this.bytesByAuthor.delete(pubkey);
      return;
    }
    const cached = this.bytesByAuthor.get(pubkey);
    if (cached !== undefined) this.bytesByAuthor.set(pubkey, cached + bytes);
  }

  // eraseAuthor deletes everything one pubkey wrote, profile included.
  eraseAuthor(pubkey: string): number {
    const n = this.x<{ n: number }>(`SELECT count(*) AS n FROM events WHERE pubkey=?`, pubkey).one().n;
    if (n > 0) {
      this.x(`DELETE FROM events WHERE pubkey=?`, pubkey);
      this.bytesByAuthor.delete(pubkey);
    }
    return n;
  }

  // purgeAuthor deletes one pubkey's events created before `before`, except
  // the listed kinds. Returns how many went.
  purgeAuthor(pubkey: string, before: number, except: number[]): number {
    const list = JSON.stringify(except);
    const n = this.x<{ n: number }>(`SELECT count(*) AS n FROM events WHERE pubkey=? AND created_at<? AND kind NOT IN (SELECT value FROM json_each(?))`, pubkey, before, list).one().n;
    if (n > 0) {
      this.x(`DELETE FROM events WHERE pubkey=? AND created_at<? AND kind NOT IN (SELECT value FROM json_each(?))`, pubkey, before, list);
      this.bytesByAuthor.delete(pubkey);
    }
    return n;
  }

  // dumpPage reads a page of raw events by sequence for the JSONL dump.
  dumpPage(afterSeq: number, limit: number): { seq: number; raw: string }[] {
    return this.x<{ seq: number; raw: string }>(`SELECT seq, raw FROM events WHERE seq>? ORDER BY seq LIMIT ?`, afterSeq, limit).toArray();
  }

  // kindStats sizes each kind present: how many, how many bytes of raw event,
  // and the span of timestamps. Heaviest first.
  kindStats(): { kind: number; n: number; bytes: number; oldest: number; newest: number }[] {
    return this.x<{ kind: number; n: number; bytes: number; oldest: number; newest: number }>(
      `SELECT kind, count(*) AS n, sum(length(raw)) AS bytes, min(created_at) AS oldest, max(created_at) AS newest FROM events GROUP BY kind ORDER BY bytes DESC`,
    ).toArray();
  }

  // purge deletes events of one kind, or of every kind not in `except` when
  // kind is null, created before `before`. Returns how many went.
  // exceptPubkey is the relay's own key: what it signed is never swept.
  purge(kind: number | null, before: number, except: number[] = [], exceptPubkey = ""): number {
    this.bytesByAuthor.clear();
    if (kind !== null) {
      const n = this.x<{ n: number }>(`SELECT count(*) AS n FROM events WHERE kind=? AND created_at<? AND pubkey<>?`, kind, before, exceptPubkey).one().n;
      if (n > 0) this.x(`DELETE FROM events WHERE kind=? AND created_at<? AND pubkey<>?`, kind, before, exceptPubkey);
      return n;
    }
    const list = JSON.stringify(except);
    const n = this.x<{ n: number }>(`SELECT count(*) AS n FROM events WHERE created_at<? AND pubkey<>? AND kind NOT IN (SELECT value FROM json_each(?))`, before, exceptPubkey, list).one().n;
    if (n > 0) this.x(`DELETE FROM events WHERE created_at<? AND pubkey<>? AND kind NOT IN (SELECT value FROM json_each(?))`, before, exceptPubkey, list);
    return n;
  }
}
