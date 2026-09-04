// Shared by the Durable Object tests: keys and events, the NIP-86 management
// call, the information document, the HTTP bridge, and the alarm.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import type { Relay } from "../../src/relay.ts";
import type { Job } from "../../src/jobs.ts";

export const now = () => Math.floor(Date.now() / 1000);
export const ev = (sk: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()): Event => finalizeEvent({ kind, content, tags, created_at }, sk);
export const pk = (sk: Uint8Array) => getPublicKey(sk);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const tagsOf = (e: Event, name: string) => e.tags.filter((t) => t[0] === name);

// nip98 signs a request for the exact URL, with the body when there is one.
export const nip98 = (sk: Uint8Array, url: string, method = "GET", body?: unknown) => getToken(url, method, (e) => finalizeEvent(e, sk), true, body as object | undefined);

// rpc calls the NIP-86 management API as the given key, or unsigned.
export async function rpc(host: string, sk: Uint8Array | null, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const headers: Record<string, string> = { "content-type": "application/nostr+json+rpc" };
  if (sk) headers.authorization = await nip98(sk, url, "POST", payload);
  // Background alarms may own admission between management calls. Retry only
  // this transient refusal; quota, rate and inventory cooldown errors surface.
  for (let attempt = 0; ; attempt++) {
    const resp = await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const result = { status: resp.status, ...(await resp.json<any>()) };
    if (result.status !== 429 || result.error !== "restricted: relay operation in progress; retry" || attempt >= 20) return result;
    await sleep(50);
  }
}

// info reads the NIP-11 document.
export const info = async (host: string) => (await SELF.fetch(`http://${host}/`, { headers: { accept: "application/nostr+json" } })).json<any>();

// get fetches a path, signed when a key is given.
export async function get(host: string, path: string, sk: Uint8Array | null = null) {
  const url = `http://${host}${path}`;
  const headers: Record<string, string> = {};
  if (sk) headers.authorization = await nip98(sk, url);
  return SELF.fetch(url, { headers });
}

// post sends a JSON body to a bridge path, signed when a key is given. The
// answer is parsed when there is one.
export async function post(host: string, sk: Uint8Array | null, path: string, body: unknown, headers: Record<string, string> = {}) {
  const url = `http://${host}${path}`;
  headers = { "content-type": "application/json", ...headers };
  if (sk) headers.authorization = await nip98(sk, url, "POST", body);
  const resp = await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, body: text ? JSON.parse(text) : null };
}

// alarm fires the relay's alarm by hand.
export const alarm = (name: string) => runInDurableObject(env.RELAY.getByName(name), async (r: Relay) => r.alarm());

// drive fires the alarm until no job is running or due, and returns the list.
export async function drive(host: string, owner: Uint8Array): Promise<Job[]> {
  const name = host.split(".")[0];
  for (let i = 0; i < 80; i++) {
    await alarm(name);
    const jobs = (await rpc(host, owner, "listjobs")).result as Job[];
    if (!jobs.some((j) => j.running || (j.nextRun > 0 && j.nextRun <= now()))) return jobs;
    await sleep(25);
  }
  throw new Error("jobs did not settle");
}
