// A NIP-07 stand-in for browser testing without an extension: signs with a
// fixed key over HTTP. Start it, then in the page's devtools console run:
//
//   window.nostr = { getPublicKey: async () => (await (await fetch('http://127.0.0.1:9999/pk')).text()),
//                    signEvent: async (e) => (await fetch('http://127.0.0.1:9999/sign', { method: 'POST', body: JSON.stringify(e) })).json() };
//
// Never use this key for anything real.
import { createServer } from "node:http";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
const sk = new Uint8Array(32).fill(7);
createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.end();
  if (req.url === "/pk") return res.end(getPublicKey(sk));
  let body = "";
  for await (const c of req) body += c;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(finalizeEvent(JSON.parse(body), sk)));
}).listen(9999, () => console.log("signer on 9999"));
