// Checks a relay configuration file (JSONC) two ways: against the schema,
// for the editor's sake, and with the relay's own parser (src/config.ts),
// which is the last word. Both must pass and the parser must drop nothing,
// since an entry a relay would quietly leave out is a mistake in a file
// under source control. Returns the parsed configuration or throws with
// every problem found.
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import Ajv from "ajv";
import { stripComments } from "./jsonc.mjs";

const ROOT = new URL("../../", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("relay-config.schema.json", ROOT), "utf8"));
const validate = new Ajv({ allErrors: true }).compile(schema);

let parser = null;
async function parseConfig() {
  if (parser) return parser;
  const js = buildSync({ entryPoints: [new URL("src/config.ts", ROOT).pathname], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent", external: ["cloudflare:*"] }).outputFiles[0].text;
  parser = (await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"))).parseConfig;
  return parser;
}

export function readConfig(path) {
  return JSON.parse(stripComments(readFileSync(path, "utf8")));
}

export async function checkConfig(doc, label = "configuration") {
  const problems = [];
  if (!validate(doc)) for (const e of validate.errors) problems.push(`${label}: ${e.instancePath || "/"} ${e.message}`);
  const parsed = (await parseConfig())(doc);
  if (typeof parsed === "string") problems.push(`${label}: ${parsed}`);
  else for (const w of parsed.warnings) problems.push(`${label}: ${w}`);
  if (problems.length) throw new Error(problems.join("\n"));
  return parsed;
}

// describe says what a parsed configuration declares, one line per section.
export function describe(cfg) {
  const lines = [];
  if (cfg.template) lines.push(`template: ${cfg.template.title}`);
  if (cfg.sections.includes("policy")) lines.push(`policy: ${Object.keys(cfg.policy).length} settings (${Object.keys(cfg.policy).join(", ")})`);
  if (cfg.sections.includes("members")) lines.push(`members: ${cfg.members.length}`);
  if (cfg.sections.includes("bans")) lines.push(`bans: ${cfg.bans.length}`);
  if (cfg.sections.includes("addresses")) lines.push(`addresses: ${cfg.addresses.length}`);
  if (cfg.sections.includes("banned_events")) lines.push(`banned events: ${cfg.banned_events.length}`);
  if (cfg.sections.includes("kinds")) lines.push(`kinds: allow ${cfg.kinds.allow.length ? cfg.kinds.allow.join(", ") : "every kind"}; block ${cfg.kinds.block.join(", ") || "none"}`);
  if (cfg.sections.includes("retention")) lines.push(`retention: ${cfg.retention.map((r) => `${r.kind === null ? "everything" : "kind " + r.kind} ${r.days} days`).join(", ") || "none"}`);
  if (cfg.sections.includes("connections")) lines.push(`connections: ${cfg.connections.map((c) => c.template + (c.visibility === "public" ? "" : " (" + c.visibility + ")")).join(", ") || "none"}`);
  return lines;
}
