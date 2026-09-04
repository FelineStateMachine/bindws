import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/ops/margin.mjs", import.meta.url).href);
const forecast = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("margin", () => {
  it("uses gross margin for target prices and keeps the default target unchanged", () => {
    const result = forecast("--btc", "80000", "--target", "0.4");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("price is cost / 0.60; 67% markup on cost");
    expect(result.stdout).toContain("$83,333 | 417 sats");
    expect(result.stdout).toContain("$83,333 | 32 sats");
    expect(result.stdout).toContain("$87,273 | 13 sats");
    expect(result.stdout).toContain("$83,333 | 2,084 sats");
    const normal = forecast("--btc", "80000");
    expect(normal.status).toBe(0);
    expect(normal.stdout).toContain("Target gross margin 33%");
  });

  it("discounts incoming socket messages once and pools the account request allowance once", () => {
    const result = forecast("--btc", "100000", "--relays", "1000");
    expect(result.status).toBe(0);
    // 950 * (10k + 290k/20) + 50 * (200k + 4.8M/20) = 45.275M.
    // Less one pooled 1M allowance, at $0.15/M, gives $6.64125.
    expect(result.stdout).toContain("DO requests $6.64");
    // 950 * 10k + 50 * 200k = 19.5M Worker requests; frames stay in the DO.
    expect(result.stdout).toContain("Worker requests $2.85");
    expect(result.stdout).toContain("not an invoice");
  });
});
