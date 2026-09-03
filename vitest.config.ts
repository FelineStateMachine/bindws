import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Durable Object tests run inside workerd with isolated storage per test.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A fake lightning provider for the fuel tests (see test/fuel.test.ts).
      miniflare: { bindings: { LIGHTNING_ADDRESS: "fuel@ln.test", SERVICE_PUBKEY: "ab".repeat(32) } },
    }),
  ],
  test: { include: ["test/*.test.ts"], testTimeout: 30_000 },
});
