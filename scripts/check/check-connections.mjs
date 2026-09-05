// Checks every connection template in connection-templates/ two ways: against
// the schema, for the editor's sake, and with the relay's own parser
// (src/connections.ts), which is the last word on placeholders. A template
// whose link names a placeholder the relay cannot fill, or an input it does
// not declare, would show a visitor a broken link, so it fails here instead.
import { readdirSync, readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import Ajv from "ajv";
import { stripComments } from "./jsonc.mjs";

const ROOT = new URL("../../", import.meta.url);
const DIR = new URL("connection-templates/", ROOT);
const schema = JSON.parse(readFileSync(new URL("connection-template.schema.json", ROOT), "utf8"));
const validate = new Ajv({ allErrors: true }).compile(schema);
const js = buildSync({ entryPoints: [new URL("src/connections.ts", ROOT).pathname], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent", external: ["cloudflare:*"] }).outputFiles[0].text;
const { parseConnectionTemplate } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonc")).sort();
let failed = false;
for (const f of files) {
  const label = `connection-templates/${f}`;
  const problems = [];
  let doc;
  try {
    doc = JSON.parse(stripComments(readFileSync(new URL(f, DIR), "utf8")));
  } catch (e) {
    problems.push(`${label}: ${e.message}`);
  }
  if (doc) {
    if (!validate(doc)) for (const e of validate.errors) problems.push(`${label}: ${e.instancePath || "/"} ${e.message}`);
    const parsed = parseConnectionTemplate(f.replace(/^\d+-/, "").replace(/\.jsonc$/, ""), doc);
    if (typeof parsed === "string") problems.push(`${label}: ${parsed}`);
  }
  if (problems.length) {
    failed = true;
    console.error(problems.join("\n"));
  } else console.log(`${label}: ok`);
}
process.exit(failed ? 1 : 0);
