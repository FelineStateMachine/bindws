// Asks a relay for a fuel invoice from a signed zap request, to check the
// lightning provider end to end. Usage: node scripts/dev/zaptest.mjs [wss://relay] [direct]
// With `direct`, the provider's LNURL callback is called straight, skipping the relay.
import { finalizeEvent } from "nostr-tools/pure";
const sk = new Uint8Array(32).fill(7);
const relay = process.argv[2] || "wss://demo.bind.ws";
const zr = finalizeEvent({ kind: 9734, created_at: Math.floor(Date.now()/1000), content: "fuel test",
  tags: [["p","6b559c0816c3b9ec03c2f0cedb8a56efe83746f8c56e543e36e1973c04ef0384"],["amount","21000"],["relays",relay]] }, sk);
if (process.argv[3] === "direct") {
  const u = new URL("https://getalby.com/lnurlp/bindws/callback");
  u.searchParams.set("amount","21000"); u.searchParams.set("nostr", JSON.stringify(zr));
  const r = await fetch(u); console.log(r.status, (await r.text()).slice(0,300));
} else {
  const r = await fetch(relay.replace("wss://","https://") + "/fuel/invoice", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ zapRequest: zr }) });
  console.log(r.status, (await r.text()).slice(0,300));
}
