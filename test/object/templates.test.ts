// Every template in relay-templates/ boots a relay that says what the
// template declares: the features in the policy, the numbers in NIP-11,
// the doors that answer, and a dry run of the template afterwards that
// changes nothing. The schema the files reference is served at the apex.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { PRESETS } from "../../src/presets.ts";
import { FEATURE_NIPS } from "../../src/nip11.ts";
import { DEFAULT_FEATURES, FEATURE_NAMES, featureOn } from "../../src/settings.ts";
import { rpc, info, get } from "../helpers/relay.ts";

describe("templates", () => {
  it("each boots a relay that matches its document, and a dry run of it afterwards changes nothing", async () => {
    for (const p of PRESETS) {
      const host = `tpl-${p.name}.bind.ws`;
      const owner = generateSecretKey();
      await rpc(host, owner, "claim");
      const r = await rpc(host, owner, "applypreset", p.name, p.source ? { source: "wss://source.example" } : undefined);
      expect(r.status, p.name + " " + JSON.stringify(r)).toBe(200);
      const policy = (await rpc(host, owner, "getpolicy")).result;
      const features = { ...DEFAULT_FEATURES, ...(p.config.policy.features ?? {}) };
      expect(policy.features, p.name).toEqual(features);
      expect(policy.writes).toBe(p.writes);
      const doc = await info(host);
      for (const f of FEATURE_NAMES) for (const n of FEATURE_NIPS[f]) expect(doc.supported_nips.includes(n), `${p.name}: NIP-${n}`).toBe(featureOn(policy, f));
      expect((await get(host, "/.well-known/nostr/nip96.json")).status).toBe(features.files ? 200 : 404);
      expect((await get(host, "/feed.xml")).status).toBe(features.pages && p.reads === "open" ? 200 : 404);
      const dry = (await rpc(host, owner, "importconfig", p.config === undefined ? {} : { format: "bind.ws/relay-config/2", policy: p.config.policy, kinds: p.config.kinds, retention: p.config.retention, ...(p.config.sections.includes("connections") ? { connections: p.config.connections } : {}) }, { dryRun: true })).result;
      expect(dry.changes.summary, p.name).toEqual([]);
      expect(dry.warnings, p.name).toEqual([]);
    }
  });

  it("serves the configuration schema at the apex", async () => {
    const resp = await SELF.fetch("http://bind.ws/relay-config.schema.json");
    expect(resp.status).toBe(200);
    const schema: any = await resp.json();
    expect(schema.title).toBe("bind.ws relay configuration");
    expect(schema.properties.policy.properties.features.properties.search.enum).toEqual(["full", "prose", "off"]);
  });
});
