// Blossom from the outside: the kind 24242 token and an upload.
import { SELF } from "cloudflare:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "../../src/negentropy.ts";
import { ev, now } from "./relay.ts";

// blossomToken mints a kind 24242 token for an action, naming a hash when given.
export const blossomToken = (sk: Uint8Array, action: string, sha?: string) =>
  "Nostr " + btoa(JSON.stringify(ev(sk, 24242, action, [["t", action], ...(sha ? [["x", sha]] : []), ["expiration", String(now() + 300)]])));

// upload puts a text file and returns its hash with the descriptor, when there is one.
export async function upload(host: string, sk: Uint8Array, text: string) {
  const body = new TextEncoder().encode(text);
  const sha = bytesToHex(sha256(body));
  const resp = await SELF.fetch(`http://${host}/upload`, { method: "PUT", headers: { authorization: blossomToken(sk, "upload", sha), "content-type": "text/plain" }, body });
  const raw = await resp.text();
  let answer: any = null;
  try {
    answer = raw ? JSON.parse(raw) : null;
  } catch {
    answer = raw; // a door that is not there answers with text
  }
  return { status: resp.status, sha, body: answer };
}
