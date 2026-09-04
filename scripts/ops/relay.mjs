// A relay's configuration as a file in your repository: check it, see what
// applying it would change, apply it, or pull the relay's current one.
//
//   node scripts/ops/relay.mjs check <file.jsonc>
//   node scripts/ops/relay.mjs plan  <file.jsonc> <wss://name.bind.ws>
//   node scripts/ops/relay.mjs push  <file.jsonc> <wss://name.bind.ws>
//   node scripts/ops/relay.mjs pull  <wss://name.bind.ws> [file.json]
//
// plan, push and pull sign as the owner: RELAY_SK holds the secret key, hex
// or nsec. check needs no relay. plan is importconfig with dryRun, so it
// touches nothing; push prints the same plan and then applies it. The
// schema the file may reference is at https://bind.ws/relay-config.schema.json.
import { writeFileSync } from "node:fs";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { getToken } from "nostr-tools/nip98";
import { decode } from "nostr-tools/nip19";
import { checkConfig, describe, readConfig } from "../check/config.mjs";

const [cmd, a, b] = process.argv.slice(2);
const usage = () => {
  console.error("usage: relay.mjs check <file> | plan <file> <url> | push <file> <url> | pull <url> [file]");
  process.exit(2);
};

function key() {
  const raw = process.env.RELAY_SK ?? "";
  if (/^[0-9a-f]{64}$/i.test(raw)) return Uint8Array.from(Buffer.from(raw, "hex"));
  if (raw.startsWith("nsec")) return decode(raw).data;
  console.error("RELAY_SK must be the owner's secret key, hex or nsec");
  process.exit(2);
}

const httpURL = (url) => new URL(url.replace(/^ws(s?):\/\//, "http$1://")).origin + "/";

async function rpc(url, sk, method, ...params) {
  const payload = { method, params };
  const body = JSON.stringify(payload);
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body });
  const json = await resp.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

function printPlan(plan) {
  const { changes, warnings } = plan;
  console.log(changes.summary.length ? changes.summary.map((l) => "  " + l).join("\n") : "  nothing would change");
  if (warnings.length) console.log("not taken:\n" + warnings.map((w) => "  " + w).join("\n"));
}

if (cmd === "check" && a) {
  const cfg = await checkConfig(readConfig(a), a);
  console.log(`${a}: ok\n  ${describe(cfg).join("\n  ")}`);
} else if ((cmd === "plan" || cmd === "push") && a && b) {
  const doc = readConfig(a);
  await checkConfig(doc, a);
  const url = httpURL(b);
  const sk = key();
  console.log(`${cmd === "plan" ? "would apply" : "applying"} ${a} to ${url} as ${getPublicKey(sk).slice(0, 8)}:`);
  const plan = await rpc(url, sk, "importconfig", doc, { dryRun: true });
  printPlan(plan);
  if (cmd === "push") {
    if (plan.changes.summary.length === 0) console.log("nothing to apply");
    else {
      await rpc(url, sk, "importconfig", doc);
      console.log("applied");
    }
  }
} else if (cmd === "pull" && a) {
  const url = httpURL(a);
  const sk = key();
  const cfg = await rpc(url, sk, "exportconfig");
  delete cfg.exported_at; // the file is what the relay says, not when
  const text = JSON.stringify({ $schema: "https://bind.ws/relay-config.schema.json", ...cfg }, null, 2) + "\n";
  if (b) {
    writeFileSync(b, text);
    console.log(`${b}: ${cfg.name} pulled from ${url}`);
  } else process.stdout.write(text);
} else usage();
