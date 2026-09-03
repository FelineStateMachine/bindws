import { defineConfig } from "vitest/config";

// Black-box conformance suite: talks to whatever relay RELAY_URL names.
export default defineConfig({
  test: {
    include: ["test/conformance/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    globalSetup: ["test/conformance/setup.ts"],
  },
});
