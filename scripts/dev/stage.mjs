// Stages a local relay for screenshots: claims it with the dev signer's key,
// gives it a name and a description, and adds a few members. Run the dev
// server first. Usage: npm run dev:stage <name>
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";

const name = process.argv[2] || "kitchen";
const url = `http://${name}.localhost:8787/`;
const sk = new Uint8Array(32).fill(7); // the dev signer's key; never real
const ws = (n) => `ws://${n}.localhost:8787`;

async function rpc(method, ...params) {
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + j.error);
  return j.result;
}

await rpc("claim");
await rpc("setpolicy", { name: "Kitchen", description: "Where the cooks talk. Members post, anyone reads.", writes: "allowlist", contact: "mailto:chef@kitchen.example", icon: "https://bind.ws/favicon.svg", banner: "https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=1600&q=70", tags: ["cooking", "recipes", "sunday"], languageTags: ["en", "fr"], relayCountries: ["FR"], postingPolicy: "https://kitchen.example/posting", privacyPolicy: "https://kitchen.example/privacy", joinTerms: "Be kind. Share the recipe." });
const people = [
  ["alice", "brings the bread"],
  ["bo", "runs the pass"],
  ["cy", "sunday roasts"],
];
for (const [n, note] of people) {
  const key = new Uint8Array(32).fill(n.charCodeAt(0));
  await rpc("setmember", getPublicKey(key), { name: n, note });
}
const e = finalizeEvent({ kind: 1, content: "Soup's on. First batch of the season.", tags: [], created_at: Math.floor(Date.now() / 1000) - 600 }, sk);
const evUrl = url + "events";
const t = await getToken(evUrl, "POST", (x) => finalizeEvent(x, sk), true, e);
await fetch(evUrl, { method: "POST", headers: { "content-type": "application/json", authorization: t }, body: JSON.stringify(e) });
console.log(`staged ${ws(name)} owner ${getPublicKey(sk).slice(0, 8)}`);
