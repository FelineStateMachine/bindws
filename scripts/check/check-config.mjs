// Checks relay configuration files: node scripts/check/check-config.mjs <file.jsonc>...
// Part of npm run typecheck for every template in relay-templates/.
import { checkConfig, describe, readConfig } from "./config.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/check/check-config.mjs <file.jsonc>...");
  process.exit(2);
}
let failed = false;
for (const f of files) {
  try {
    const cfg = await checkConfig(readConfig(f), f);
    console.log(`${f}: ok\n  ${describe(cfg).join("\n  ")}`);
  } catch (e) {
    failed = true;
    console.error(e.message);
  }
}
process.exit(failed ? 1 : 0);
