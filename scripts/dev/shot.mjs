// Screenshot a page with phone emulation over CDP.
//
//   npm run dev:shot <url> <out.png> [width] [height] [--nostr] [--eval <js>]
//
// --nostr signs in as the dev signer's key (scripts/dev/dev-signer.mjs must be
// running), so the owner's console is in the picture; --eval runs a snippet
// after the page has loaded, such as opening a fold or a tab, before the shot.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const [, v] = args.splice(i, name === "--nostr" ? 1 : 2); return v ?? true; };
const nostr = flag("--nostr");
const evalJS = flag("--eval");
const [url, out, w = "390", h = "1600"] = args;
// The dev signer's key, never real: new Uint8Array(32).fill(7).
const DEV_PUBKEY = "989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f";
const NOSTR = `localStorage.setItem("me", "${DEV_PUBKEY}"); window.nostr = { getPublicKey: async () => (await (await fetch("http://127.0.0.1:9999/pk")).text()), signEvent: async (e) => (await fetch("http://127.0.0.1:9999/sign", { method: "POST", body: JSON.stringify(e) })).json() };`;
const bin = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const port = 9333;
const br = spawn(bin, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/brave-cdp", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));
let id = 0; const pending = new Map();
ws.on("message", (m) => { const j = JSON.parse(m); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } });
const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await call("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 2, mobile: true });
await call("Page.enable");
if (nostr) await call("Page.addScriptToEvaluateOnNewDocument", { source: NOSTR });
await call("Page.navigate", { url });
await sleep(3500);
if (evalJS) { await call("Runtime.evaluate", { expression: evalJS, awaitPromise: true }); await sleep(1500); }
const { result } = await call("Runtime.evaluate", { expression: "JSON.stringify({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, sh:document.documentElement.scrollHeight})" });
console.log("layout", result.result.value);
const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close(); br.kill();
