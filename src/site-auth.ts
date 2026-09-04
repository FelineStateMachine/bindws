// Browser sign-in for hosted sites.  The site origin is deliberately kept
// separate from the relay HTTP doors: this module only identifies a visitor
// and never fetches or publishes site data.
import { sha256 } from "@noble/hashes/sha2.js";
import { validate, tagValues, type Event } from "./event.ts";
import { now } from "./event.ts";
import { page, FONTS } from "./ui.ts";
import type { Relay } from "./relay.ts";

export const SITE_AUTH_PATH = "/.well-known/nsite/auth";
const CHALLENGE_TTL = 5 * 60;
const COOKIE_TTL = 7 * 24 * 60 * 60;
const MAX_BODY = 32 * 1024;
const COOKIE = "__Host-nsite";

type AuthRelay = Pick<Relay, "identity" | "settings" | "sql">;

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
const text = (req: Request, status: number, message: string) => new Response(req.method === "HEAD" ? null : message, {
  status, headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8" },
});
const reject = (req: Request, message = "Authentication required", status = 401) => text(req, status, message);

function exactNIP98(header: string, url: string, method: string, body: string): Event | string {
  const m = /^Nostr\s+(\S+)$/i.exec(header.trim());
  if (!m) return "auth-required: missing NIP-98 Authorization header";
  let e: Event;
  try { e = JSON.parse(unb64(m[1])); } catch { return "auth-required: malformed NIP-98 token"; }
  const bad = validate(e);
  if (bad) return "auth-required: " + bad;
  if (e.kind !== 27235) return "auth-required: token must be kind 27235";
  const t = now();
  if (Math.abs(t - e.created_at) > 60) return "auth-required: token expired";
  if (tagValues(e, "u").length !== 1 || tagValues(e, "u")[0] !== url) return "auth-required: token was signed for another URL";
  if (tagValues(e, "method").length !== 1 || (tagValues(e, "method")[0] ?? "").toUpperCase() !== method.toUpperCase()) return "auth-required: token was signed for another method";
  const payload = tagValues(e, "payload");
  if (body !== "" && (payload.length !== 1 || payload[0] !== hex(sha256(new TextEncoder().encode(body))))) return "auth-required: token payload hash does not match the body";
  if (body === "" && (payload.length > 1 || (payload.length === 1 && payload[0] !== hex(sha256(new Uint8Array()))))) return "auth-required: token payload hash does not match the body";
  return e;
}

const hex = (bytes: Uint8Array) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
function authPage(origin: string, action: string, returnUrl: string, nonce: string, expires: number): Response {
  const scriptNonce = b64url(crypto.randomUUID());
  const jsq = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
  const js = `const challenge=${jsq(nonce)}, action=${jsq(action)}, returnUrl=${jsq(returnUrl)};
async function sign(){
 if(!window.nostr){document.querySelector('#msg').textContent='Install a NIP-07 signer first';return}
 const e=await window.nostr.signEvent({kind:22242,created_at:Math.floor(Date.now()/1000),tags:[['relay',${jsq(origin)}],['challenge',challenge]],content:'bind.ws site sign-in'});
 const body=JSON.stringify({event:e}); const p=await window.nostr.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',action],['method','POST'],['payload',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)).then(x=>[...new Uint8Array(x)].map(x=>x.toString(16).padStart(2,'0')).join(''))]],content:''});
 const r=await fetch(action,{method:'POST',headers:{'content-type':'application/json','authorization':'Nostr '+btoa(JSON.stringify(p))},body}); if(r.ok) location.assign(returnUrl); else document.querySelector('#msg').textContent=await r.text(); }
document.querySelector('button').onclick=()=>sign().catch(e=>document.querySelector('#msg').textContent=String(e));`;
  // The shared shell supplies the layout; system fonts keep the sign-in
  // page independent of external hosts under its narrow content policy.
  const html = page("Sign in", `<main><h1>Sign in</h1><p class="note" id="msg">Your Nostr signer opens this site under the relay's read rule.</p><button class="btn pri">Sign in</button></main><script nonce="${scriptNonce}">${js}</script>`).replace(FONTS, "");
  return new Response(html, { status: 401, headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'`, "x-content-type-options": "nosniff", "x-nsite-challenge-expires": String(expires) } });
}

function cookieEvent(relay: AuthRelay, label: string, origin: string, pubkey: string, expires: number): Event {
  return relay.identity.sign(22242, [["site", label], ["origin", origin], ["pubkey", pubkey], ["expiration", String(expires)], ["purpose", "nsite-cookie"]], "bind.ws site cookie");
}

async function challengePage(relay: AuthRelay, req: Request, label: string): Promise<Response> {
  const u = new URL(req.url);
  const origin = u.origin;
  relay.sql.exec(`CREATE TABLE IF NOT EXISTS nsite_auth_challenges (nonce TEXT PRIMARY KEY, label TEXT NOT NULL, origin TEXT NOT NULL, return_url TEXT NOT NULL, expires INTEGER NOT NULL)`);
  const t = now();
  relay.sql.exec(`DELETE FROM nsite_auth_challenges WHERE expires<=?`, t);
  const outstanding = relay.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM nsite_auth_challenges WHERE label=? AND origin=?`, label, origin).one().n;
  const total = relay.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM nsite_auth_challenges`).one().n;
  if (outstanding >= 32 || total >= 512) return text(req, 429, "Too many sign-in attempts");
  const nonce = b64url(crypto.randomUUID() + crypto.randomUUID());
  const expires = t + CHALLENGE_TTL;
  const returnUrl = req.method === "GET" && u.pathname === SITE_AUTH_PATH
    ? (() => { const raw = u.searchParams.get("return"); if (!raw) return origin + "/"; try { const x = new URL(raw, origin); return x.origin === origin ? x.href : origin + "/"; } catch { return origin + "/"; } })()
    : u.href;
  relay.sql.exec(`INSERT INTO nsite_auth_challenges(nonce,label,origin,return_url,expires) VALUES(?,?,?,?,?)`, nonce, label, origin, returnUrl, expires);
  const action = origin + SITE_AUTH_PATH;
  return authPage(origin, action, returnUrl, nonce, expires);
}

function readCookie(relay: AuthRelay, value: string, label: string, origin: string): { pubkey: string; expires: number } | null {
  try {
    const e = JSON.parse(unb64(value)) as Event;
    if (validate(e) || e.kind !== 22242 || e.pubkey !== relay.identity.pubkey) return null;
    if (tagValues(e, "purpose").length !== 1 || tagValues(e, "purpose")[0] !== "nsite-cookie") return null;
    if (tagValues(e, "site")[0] !== label || tagValues(e, "origin")[0] !== origin) return null;
    const pubkey = tagValues(e, "pubkey")[0] ?? "";
    const expires = Number(tagValues(e, "expiration")[0]);
    return /^[0-9a-f]{64}$/.test(pubkey) && Number.isSafeInteger(expires) && expires > now() ? { pubkey, expires } : null;
  } catch { return null; }
}

// siteIdentity returns the visitor's proved pubkeys, or the sign-in response.
export async function siteIdentity(relay: AuthRelay, req: Request, label: string): Promise<{ pubkeys: string[] } | Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const authPath = url.pathname === SITE_AUTH_PATH;
  const cookie = req.headers.get("cookie")?.split(";").map((x) => x.trim()).find((x) => x.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (cookie) {
    const c = readCookie(relay, cookie, label, origin);
    if (c) {
      const gate = relay.settings.mayRead([c.pubkey]);
      if (!gate && !authPath) return { pubkeys: [c.pubkey] };
      if (!authPath) return reject(req, gate, 403);
    }
  }
  if (!authPath) {
    const supplied = req.headers.get("authorization");
    if (supplied) {
      const proof = exactNIP98(supplied, req.url, req.method, "");
      if (typeof proof === "string") return reject(req, proof);
      const gate = relay.settings.mayRead([proof.pubkey]);
      return gate ? reject(req, gate, 403) : { pubkeys: [proof.pubkey] };
    }
    const gate = relay.settings.mayRead([]);
    if (!gate) return { pubkeys: [] };
    if (req.method === "GET" && /\btext\/html\b/i.test(req.headers.get("accept") ?? "")) return challengePage(relay, req, label);
    return reject(req, gate);
  }
  if (req.method === "GET") {
    const supplied = req.headers.get("authorization");
    if (supplied) {
      const proof = exactNIP98(supplied, req.url, req.method, "");
      if (typeof proof === "string") return reject(req, proof);
      const gate = relay.settings.mayRead([proof.pubkey]);
      if (gate) return reject(req, gate, 403);
    }
    if (!/\btext\/html\b/i.test(req.headers.get("accept") ?? "")) return reject(req);
    if (req.headers.get("origin") && req.headers.get("origin") !== origin) return reject(req);
    return challengePage(relay, req, label);
  }
  if (req.method !== "POST" || req.headers.get("origin") !== origin) return reject(req);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return text(req, 413, "Request body too large");
  if (!req.body) return reject(req, "Malformed sign-in request");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); return text(req, 413, "Request body too large"); }
    chunks.push(part.value);
  }
  // Assemble after the bounded read; this avoids Request.text() accepting an
  // unbounded upload while retaining the exact bytes used by NIP-98.
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  const rawBody = new TextDecoder().decode(bytes);
  if (rawBody.length > MAX_BODY) return text(req, 413, "Request body too large");
  let input: { event?: Event };
  try { input = JSON.parse(rawBody); } catch { return reject(req, "Malformed sign-in request"); }
  const proof = exactNIP98(req.headers.get("authorization") ?? "", req.url, req.method, rawBody);
  if (typeof proof === "string" || !input || !input.event) return reject(req, "Invalid sign-in proof");
  const e = input.event; const bad = validate(e); const t = now();
  if (bad || e.kind !== 22242 || Math.abs(t - e.created_at) > 120 || e.pubkey !== proof.pubkey || tagValues(e, "challenge").length !== 1 || tagValues(e, "relay").length !== 1) return reject(req, "Invalid sign-in proof");
  const nonce = tagValues(e, "challenge")[0] ?? "";
  relay.sql.exec(`CREATE TABLE IF NOT EXISTS nsite_auth_challenges (nonce TEXT PRIMARY KEY, label TEXT NOT NULL, origin TEXT NOT NULL, return_url TEXT NOT NULL, expires INTEGER NOT NULL)`);
  const stored = relay.sql.exec<{ label: string; origin: string; return_url: string; expires: number }>(`DELETE FROM nsite_auth_challenges WHERE nonce=? AND expires>? RETURNING label,origin,return_url,expires`, nonce, t).toArray()[0];
  if (!stored || stored.label !== label || stored.origin !== origin || tagValues(e, "relay")[0] !== origin) return reject(req, "Invalid or expired challenge");
  if (relay.settings.mayRead([e.pubkey])) return reject(req, "You are not allowed to read this site", 403);
  await relay.identity.ensure();
  const expires = t + COOKIE_TTL;
  const signed = cookieEvent(relay, label, origin, e.pubkey, expires);
  return new Response(null, { status: 204, headers: { "set-cookie": `${COOKIE}=${b64url(JSON.stringify(signed))}; Path=/; Max-Age=${COOKIE_TTL}; HttpOnly; Secure; SameSite=Lax`, "cache-control": "no-store" } });
}
