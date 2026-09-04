// The amount in a bolt11 invoice, from its human-readable part.
import { describe, it, expect } from "vitest";
import { bolt11Msats } from "../../src/fuel.ts";

describe("bolt11 amounts", () => {
  it("reads the human-readable amount", () => {
    expect(bolt11Msats("lnbc10n1abc")).toBe(1000);
    expect(bolt11Msats("lnbc10u1abc")).toBe(1_000_000);
    expect(bolt11Msats("lnbc2500u1abc")).toBe(250_000_000);
    expect(bolt11Msats("lnbc1m1abc")).toBe(100_000_000);
    expect(bolt11Msats("lnbc1abc")).toBe(0);
    expect(bolt11Msats("lnbc20p1abc")).toBe(2);
    expect(bolt11Msats("lnbc25p1abc")).toBe(0); // sub-msat precision is invalid
    expect(bolt11Msats("lntb500n1abc")).toBe(50_000);
    expect(bolt11Msats("nonsense")).toBe(0);
  });
});
