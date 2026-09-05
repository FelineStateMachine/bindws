// Presets: the templates in relay-templates/, one click each. A template is
// a relay configuration with the rules sections only (policy, kinds and
// retention, and the Connect fold's shortcuts when it names them), so
// applying one sets writes, reads, the directory, the features, the kind
// rules, the keep-for rules and the app shortcuts together and leaves
// limits, identity, people and bans alone. Haven's four relays are the
// first four: names are cheap here, so one name per role is the way to get
// the same split.
import { TEMPLATES } from "./gen/templates.ts";
import { applyConfig, parseConfig, type Config } from "./config.ts";
import type { Connection, Policy, Settings } from "./settings.ts";

export interface Preset {
  name: string;
  title: string;
  about: string;
  writes: Policy["writes"];
  reads: Policy["reads"];
  directoryPublic: boolean;
  allow: number[];
  block: number[];
  retention: { kind: number | null; days: number }[];
  // The Connect fold's shortcuts the template sets, when it has a
  // connections section; left out, the shortcuts stay as they are.
  connections?: Connection[];
  // A replica keeps itself in step with a source relay through a standing
  // pull of its kinds. "required" presets refuse to apply without one.
  source?: "required" | "optional";
  every?: number; // hours between pulls
  config: Config;
}

export const PRESETS: Preset[] = TEMPLATES.map(({ name, document }) => {
  const config = parseConfig(document);
  if (typeof config === "string" || !config.template) throw new Error(`template ${name}: ${typeof config === "string" ? config : "no template block"}`);
  const p = config.policy;
  return { name, title: config.template.title, about: config.template.about, source: config.template.source, every: config.template.every, writes: p.writes ?? "open", reads: p.reads ?? "open", directoryPublic: p.directoryPublic ?? true, allow: config.kinds.allow, block: config.kinds.block, retention: config.retention, ...(config.sections.includes("connections") ? { connections: config.connections } : {}), config };
});

export function findPreset(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}

// applyPreset applies the template's sections: the policy fields it names,
// the kind rules and the keep-for rules. Returns "" or a reason.
export function applyPreset(s: Settings, name: string, now: number): string {
  const p = findPreset(name);
  if (!p) return "invalid: no preset named " + name;
  applyConfig(s, p.config, now);
  return "";
}
