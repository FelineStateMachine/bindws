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
  get: (t, k) => (k === Symbol.toPrimitive ? () => "" : k === "classList" ? { toggle() {}, add() {}, remove() {}, contains: () => false } : k === "style" ? { setProperty() {} } : element()),
  set: () => true,
  apply: () => element(),
});
const doc = element();
const g = globalThis;
g.document = doc;
g.window = g;
g.location = { host: "check.localhost", hostname: "check.localhost", origin: "http://check.localhost", protocol: "http:", hash: "", pathname: "/", search: "" };
g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
g.history = { replaceState() {} };
g.navigator = { clipboard: { writeText: async () => {} } };
g.confirm = () => false;
g.prompt = () => null;
g.alert = () => {};
g.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "" });
g.WebSocket = class { close() {} send() {} };
g.SIGNER_URL = "/signer.js";
g.addEventListener = () => {};

let failed = null;
process.on("unhandledRejection", (e) => { failed = e; });
try {
  new Function(js)();
  // The script is an async IIFE; its synchronous part runs before this resolves.
  await new Promise((r) => setTimeout(r, 50));
} catch (e) {
  failed = e;
}
if (failed && !/fetch|json|network/i.test(String(failed))) {
  console.error("console script fails before it boots:", failed);
  process.exit(1);
}
console.log("console script starts");
