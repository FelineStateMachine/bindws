// The HTTP bridge: the same three verbs as the websocket, for scripts,
// serverless functions and agents that don't want a long-lived socket.
//
//   POST /events  body: one signed event        -> {event_id, accepted, message}
//   POST /query   body: [filter, ...]           -> [event, ...]
//   POST /count   body: [filter, ...]           -> {count, hll?}
//
// All three take NIP-98 (Authorization: Nostr <base64 event>); the signer is
// treated exactly like a NIP-42-authenticated websocket client.
import { validate, type Event } from "./event.ts";
import { parseFilter, type Filter } from "./filter.ts";
import { hllOffset } from "./hll.ts";
import { verifyNIP98 } from "./auth.ts";
import { readGate } from "./gates.ts";
import type { Relay } from "./relay.ts";

export async function bridge(relay: Relay, req: Request): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  const url = new URL(req.url);
  const body = await req.text();
  const auth = verifyNIP98(req.headers.get("authorization") ?? "", req.url, req.method, body);
  if (typeof auth === "string") return json({ error: auth }, 401);
  const conn = relay.virtualConn(url.host, auth.pubkey, req.headers.get("x-relay-ip") || "unknown");
  const t = Math.floor(Date.now() / 1000);
  // The bridge has no socket to meter, so the address bucket is its rate limit.
  const limited = relay.ipLimit(conn.ip, url.pathname === "/events" ? "events" : "reqs");
  if (limited) return json({ error: limited }, 429);

  if (url.pathname === "/events") {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return json({ error: "invalid: body is not JSON" }, 400);
    }
    const bad = validate(raw);
    if (bad) return json({ error: bad }, 400);
    const e = raw as Event;
    const r = await relay.acceptAny(e, conn);
    if (r.stored) relay.broadcast(e);
    return json({ event_id: e.id, accepted: r.ok, message: r.msg }, r.ok ? 200 : 400);
  }

  let rawFilters: unknown;
  try {
    rawFilters = JSON.parse(body);
  } catch {
    return json({ error: "invalid: body is not JSON" }, 400);
  }
  if (!Array.isArray(rawFilters) || rawFilters.length === 0) return json({ error: "invalid: body must be a non-empty array of filters" }, 400);
  const filters: Filter[] = [];
  for (const rf of rawFilters) {
    const f = parseFilter(rf);
    if (typeof f === "string") return json({ error: "invalid: bad filter: " + f }, 400);
    filters.push(f);
  }
  const gate = readGate(relay, conn, filters);
  if (gate.reason) return json({ error: gate.reason }, gate.reason.startsWith("auth-required") || gate.reason.startsWith("restricted") ? 403 : 400);
  const who = { pubkeys: conn.authed };
  const p = relay.settings.policy;

  if (url.pathname === "/count") {
    const result: Record<string, unknown> = {};
    if (filters.length === 1 && hllOffset(filters[0]) >= 0) {
      const r = relay.store.countHLL(filters[0], who, hllOffset(filters[0]), t);
      result.count = r.count;
      result.hll = r.hll;
    } else result.count = relay.store.count(filters, who, t);
    relay.tally();
    return json(result);
  }

  // /query: OR of filters, deduplicated, newest first per filter order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of filters) {
    for (const raw of relay.store.query(f, who, p.maxLimit, t).rows) {
      const id = (JSON.parse(raw) as { id: string }).id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(raw);
    }
  }
  relay.tally();
  return new Response("[" + out.join(",") + "]", { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
