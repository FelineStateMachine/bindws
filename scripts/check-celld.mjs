// Keeps wrangler.celld.jsonc, the config for hosting without Cloudflare
// (docs/16-hosting-without-cloudflare.md), in step with wrangler.jsonc: the
// same code, bindings, migrations and prices, and only the keys celld
// accepts. Runs as part of `npm run typecheck`, so a change to one file that
// forgets the other fails the build instead of quietly dropping the host.
import { readFileSync } from "node:fs";

// stripComments removes // and /* */ comments outside strings.
function stripComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return out;
}
const load = (path) => JSON.parse(stripComments(readFileSync(new URL("../" + path, import.meta.url), "utf8")));

const cf = load("wrangler.jsonc");
const celld = load("wrangler.celld.jsonc");
const problems = [];
const same = (what, a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what} differs: wrangler.jsonc has ${JSON.stringify(a)}, wrangler.celld.jsonc has ${JSON.stringify(b)}`);
};

// The keys celld deploy accepts (https://celld.dev/docs/cloudflare-compat);
// any other top-level key stops its deployment.
const ACCEPTED = new Set(["$schema", "name", "main", "no_bundle", "compatibility_date", "compatibility_flags", "durable_objects", "migrations", "assets", "services", "triggers", "vars", "d1_databases", "kv_namespaces", "queues", "workflows", "r2_buckets"]);
for (const k of Object.keys(celld)) if (!ACCEPTED.has(k)) problems.push(`wrangler.celld.jsonc has "${k}", which celld deploy refuses`);

same("name", cf.name, celld.name);
same("main", cf.main, celld.main);
same("compatibility_date", cf.compatibility_date, celld.compatibility_date);
same("compatibility_flags", cf.compatibility_flags, celld.compatibility_flags);
same("durable_objects", cf.durable_objects, celld.durable_objects);
same("migrations", cf.migrations, celld.migrations);
same("r2_buckets bindings", cf.r2_buckets.map((b) => b.binding), celld.r2_buckets.map((b) => b.binding));
same("kv_namespaces bindings", cf.kv_namespaces.map((b) => b.binding), celld.kv_namespaces.map((b) => b.binding));

// Vars: the prices and allowances match; the site-specific ones may differ;
// the Cloudflare-only ones are empty on celld; celld has the proxy header.
const SITE = new Set(["DOMAIN", "DEV_RELAY", "LIGHTNING_ADDRESS", "SERVICE_PUBKEY", "LEASE_DAYS"]);
const CLOUDFLARE_ONLY = new Set(["ZONE_ID", "CNAME_TARGET"]);
const CELLD_ONLY = new Set(["CLIENT_IP_HEADER"]);
for (const k of Object.keys(cf.vars)) {
  if (!(k in celld.vars)) problems.push(`vars.${k} is missing from wrangler.celld.jsonc`);
  else if (CLOUDFLARE_ONLY.has(k)) {
    if (celld.vars[k] !== "") problems.push(`vars.${k} is Cloudflare-only and must be empty in wrangler.celld.jsonc`);
  } else if (!SITE.has(k)) same(`vars.${k}`, cf.vars[k], celld.vars[k]);
}
for (const k of Object.keys(celld.vars)) if (!(k in cf.vars) && !CELLD_ONLY.has(k)) problems.push(`vars.${k} is in wrangler.celld.jsonc but not in wrangler.jsonc`);
for (const k of CELLD_ONLY) if (!(k in celld.vars)) problems.push(`vars.${k} is missing from wrangler.celld.jsonc`);

if (problems.length) {
  console.error("wrangler.celld.jsonc is out of step with wrangler.jsonc:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("wrangler.celld.jsonc matches wrangler.jsonc");
