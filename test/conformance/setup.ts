// Global setup: when CLAIM=1, claim the relay under test through the NIP-86
// management API so that writes are accepted (bind.ws relays start unclaimed).
import { getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "../../src/negentropy.ts";

export default async function setup() {
  if (process.env.CLAIM !== "1") return;
  const url = (process.env.RELAY_URL ?? "ws://127.0.0.1:8787").replace(/^ws/, "http") + "/";
  // A fixed key by default, so repeated runs against a persistent dev relay
  // keep claiming as the same owner; CLAIM_SK (hex) overrides it.
  const sk = process.env.CLAIM_SK ? hexToBytes(process.env.CLAIM_SK) : sha256(new TextEncoder().encode("bind.ws conformance owner"));
  const payload = { method: "claim", params: [] };
  const body = JSON.stringify(payload);
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body });
  const json: any = await resp.json();
  if (!json.result?.claimed) throw new Error(`claim failed: ${resp.status} ${JSON.stringify(json)}`);
  console.log(`claimed ${url} as ${getPublicKey(sk)}`);
}
