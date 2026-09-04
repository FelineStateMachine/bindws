import { describe, it, expect } from "vitest";
import { HTTP_URL } from "./helpers.ts";

describe("NIP-11", () => {
  it("serves the information document with limitations", async () => {
    const resp = await fetch(HTTP_URL, { headers: { Accept: "application/nostr+json" } });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/nostr+json");
    const doc: any = await resp.json();
    expect(typeof doc.name).toBe("string");
    for (const n of [1, 9, 11, 40, 42, 45, 50, 62, 67, 70, 77]) expect(doc.supported_nips).toContain(n);
    expect(doc.limitation.max_subid_length).toBeGreaterThanOrEqual(64);
    expect(typeof doc.limitation.max_limit).toBe("number");
  });
});
