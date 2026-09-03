// Runs the console script's synchronous start against a stub document, so a
// handler wired above the helper it calls, or any other error before the
// first await, fails typecheck instead of a live page. Syntax alone is not
// enough: `node --check` passed the day the page came up empty.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
const js = JSON.parse(src.match(/^const JS = (".*");$/m)[1]);

// Every element lookup answers with an object that accepts any property and
// any method call, so the script gets through its wiring.
const element = () => new Proxy(function () {}, {
  get: (_, k) => (k === Symbol.toPrimitive ? () => "" : k === "classList" ? { toggle() {}, add() {}, remove() {}, contains: () => false } : k === "style" ? { setProperty() {} } : element()),
  set: () => true,
  apply: () => element(),
});
const doc = element();
const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
define("document", doc);
define("window", globalThis);
define("location", { host: "check.localhost", hostname: "check.localhost", origin: "http://check.localhost", protocol: "http:", hash: "", pathname: "/", search: "" });
define("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
define("history", { replaceState() {} });
define("navigator", { clipboard: { writeText: async () => {} } });
define("confirm", () => false);
define("prompt", () => null);
define("alert", () => {});
// fetch never answers, so the boot stops at its first await and only the synchronous start is judged.
define("fetch", () => new Promise(() => {}));
define("WebSocket", class { close() {} send() {} });
define("SIGNER_URL", "/signer.js");
define("addEventListener", () => {});

let failed = null;
process.on("unhandledRejection", (e) => { failed = e; });
try {
  new Function(js)();
  // The script is an async IIFE; its synchronous part runs before this resolves.
  await new Promise((r) => setTimeout(r, 50));
} catch (e) {
  failed = e;
}
if (failed) {
  console.error("console script fails before it boots:", failed);
  process.exit(1);
}
console.log("console script starts");
