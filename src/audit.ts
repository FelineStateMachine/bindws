// The moderation log: who did what, when, to whom. Every management method
// that changes something (the ones without `reads` in manage.ts) and every NIP-29 moderation event
// (groups.ts) leaves a row. The owner and moderators read it with listaudit
// and on the console's Moderation tab. Each row also goes out as a JSON
// line on the console, so an OTLP logs destination gets it as it happens
// (docs/11-hosting-bindws.md, Observe). Rows past the cap are dropped
// oldest first.

export const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
`;

export const AUDIT_KEEP = 5000;
const MAX_DETAIL = 500;
const PAGE = 100;

export type AuditRow = { seq: number; at: number; actor: string; action: string; target: string; detail: string };
type Row = Record<string, string | number>;

// detailOf compresses a method's parameters into the detail column: the
// first string parameter is the target, the rest is JSON, and bulky
// payloads are described rather than copied.
export function detailOf(method: string, params: unknown[]): { target: string; detail: string } {
  const target = typeof params[0] === "string" ? params[0].slice(0, 200) : "";
  let rest = typeof params[0] === "string" ? params.slice(1) : params;
  if (method === "importconfig") {
    const c = (params[0] ?? {}) as Record<string, unknown[]>;
    const n = (k: string) => (Array.isArray(c[k]) ? c[k].length : 0);
    return { target: "", detail: `members ${n("members")}, bans ${n("bans")}, banned events ${n("banned_events")}, addresses ${n("addresses")}` };
  }
  if (method === "setpolicy") rest = [Object.keys((params[0] ?? {}) as object)];
  let detail = "";
  try {
    detail = rest.length ? JSON.stringify(rest.length === 1 ? rest[0] : rest) : "";
  } catch {
    detail = "";
  }
  return { target, detail: detail.length > MAX_DETAIL ? detail.slice(0, MAX_DETAIL - 3) + "..." : detail };
}

export class Audit {
  constructor(private sql: SqlStorage, private relay: () => string) {
    sql.exec(AUDIT_SCHEMA);
  }

  record(at: number, actor: string, action: string, target = "", detail = "") {
    this.sql.exec(`INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)`, at, actor, action, target, detail);
    this.sql.exec(`DELETE FROM audit WHERE seq <= (SELECT max(seq) FROM audit) - ?`, AUDIT_KEEP);
    console.log(JSON.stringify({ msg: "audit", relay: this.relay(), at, actor, action, target, detail }));
  }

  // list pages backward: rows with seq below `before` (0 for the newest), newest first.
  list(before = 0, limit = PAGE): AuditRow[] {
    limit = Math.min(Math.max(limit, 1), PAGE);
    return before > 0
      ? (this.sql.exec<Row>(`SELECT * FROM audit WHERE seq < ? ORDER BY seq DESC LIMIT ?`, before, limit).toArray() as AuditRow[])
      : (this.sql.exec<Row>(`SELECT * FROM audit ORDER BY seq DESC LIMIT ?`, limit).toArray() as AuditRow[]);
  }
}
