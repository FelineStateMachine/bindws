// NIP-01 filters: parsing, in-memory matching for live subscriptions, and
// NIP-50 search term handling. Mirrors filter.go.
import { isPrivate, type Event } from "./event.ts";

export interface Filter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  tags: Record<string, string[]>; // "#e" -> tags.e
  since?: number;
  until?: number;
  limit?: number;
  search?: string;
}

// parse validates a raw filter object. Returns an error string or the Filter.
export function parseFilter(raw: unknown): Filter | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "filter must be an object";
  const f: Filter = { tags: {} };
  const strList = (v: unknown, k: string): string[] | string =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : `${k} must be a list of strings`;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "ids" || k === "authors") {
      const r = strList(v, k);
      if (typeof r === "string") return r;
      f[k] = r;
    } else if (k === "kinds") {
      if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) return "kinds must be a list of integers";
      f.kinds = v as number[];
    } else if (k === "since" || k === "until" || k === "limit") {
      if (!Number.isInteger(v)) return `${k} must be an integer`;
      f[k] = v as number;
    } else if (k === "search") {
      if (typeof v !== "string") return "search must be a string";
      f.search = v;
    } else if (k.length === 2 && k[0] === "#") {
      const r = strList(v, k);
      if (typeof r === "string") return r;
      f.tags[k[1]] = r;
    }
  }
  return f;
}

export function match(f: Filter, e: Event): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [name, vals] of Object.entries(f.tags)) {
    if (!e.tags.some((t) => t[0] === name && t.length > 1 && vals.includes(t[1]))) return false;
  }
  const terms = searchTerms(f.search);
  if (terms.length > 0) {
    if (isPrivate(e.kind)) return false;
    const content = e.content.toLowerCase();
    for (const term of terms) if (!content.includes(term.toLowerCase())) return false;
  }
  return true;
}

// searchTerms drops key:value extensions this relay does not implement.
export function searchTerms(q: string | undefined): string[] {
  if (!q) return [];
  return q.split(/\s+/).filter((w) => w && !w.includes(":"));
}

// ftsQuery quotes every term so user input cannot inject FTS5 syntax.
export function ftsQuery(terms: string[]): string {
  return terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(" ");
}
