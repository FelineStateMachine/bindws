// Screenshot a page with phone emulation over CDP. Usage: npm run dev:shot <url> <out.png> [width] [height]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";
const [url, out, w = "390", h = "1600"] = process.argv.slice(2);
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
await call("Page.navigate", { url });
await sleep(3500);
const { result } = await call("Runtime.evaluate", { expression: "JSON.stringify({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, sh:document.documentElement.scrollHeight})" });
console.log("layout", result.result.value);
const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close(); br.kill();
