import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Two projects: pure functions on node, and the Durable Object tests inside
// workerd with isolated storage per test. The black-box conformance suite
// has its own config, since it needs a running relay.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/*.test.ts"], environment: "node" } },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // A fake lightning provider for the fuel tests (see test/object/fuel.test.ts).
            miniflare: { bindings: { LIGHTNING_ADDRESS: "fuel@ln.test", SERVICE_PUBKEY: "ab".repeat(32) } },
          }),
        ],
        test: { name: "object", include: ["test/object/*.test.ts"], testTimeout: 30_000 },
      },
    ],
  },
});
