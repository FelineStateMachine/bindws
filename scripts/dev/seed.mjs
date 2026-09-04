// Seeds a dev relay with a few events: node scripts/seed.mjs [name]
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
const name = process.argv[2] ?? "dev";
const ws = new WebSocket("ws://127.0.0.1:8787/", { headers: { host: `${name}.localhost:8787` } });
const texts = ["Reading list for October: The Left Hand of Darkness, Piranesi, and Kindred.", "Meeting moved to Thursday 7pm, same place.", "Anyone have a spare copy of Piranesi?", "gm ☕", "Finished chapter 12. No spoilers but wow."];
ws.on("open", () => {
  for (const [i, t] of texts.entries()) {
    const sk = generateSecretKey();
    const e = finalizeEvent({ kind: i === 3 ? 7 : 1, content: t, tags: [["t", "bookclub"]], created_at: Math.floor(Date.now() / 1000) - i * 3600 }, sk);
    ws.send(JSON.stringify(["EVENT", e]));
  }
});
let n = 0;
ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m[0] === "OK") { console.log(m[2], m[3]); if (++n === texts.length) ws.close(); } });
