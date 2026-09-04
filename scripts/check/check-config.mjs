// Checks relay configuration files, part of npm run typecheck for every
// template in relay-templates/. For one file of your own: npm run relay check <file>.
import { checkConfig, describe, readConfig } from "./config.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: check-config.mjs <file.jsonc>...; for one file, npm run relay check <file>");
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
