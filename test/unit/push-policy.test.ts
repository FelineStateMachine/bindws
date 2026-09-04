import { describe, it, expect } from "vitest";
import { callbackOrigin, callbackOrigins } from "../../src/push-policy.ts";

describe("callback origins", () => {
  it("accepts HTTPS public DNS origins and never broadens a path into a policy origin", () => {
    expect(callbackOrigin("https://push.example.com/token?q=secret")).toBe("https://push.example.com");
    expect(callbackOrigins(["https://push.example.com/", "https://push.example.com"])).toEqual(["https://push.example.com"]);
    expect(callbackOrigins(["https://push.example.com/token"])).toBeNull();
    expect(callbackOrigins([])).toEqual([]);
    expect(callbackOrigins(Array(17).fill("https://push.example.com"))).toBeNull();
  });

  it("rejects local targets, credentials, redirects disguised as origins and other protocols", () => {
    for (const url of ["http://push.example.com", "https://127.0.0.1", "https://2130706433", "https://0x7f000001", "https://[::1]", "https://localhost", "https://service.local", "https://service.internal", "https://host.test", "https://user:secret@push.example.com", "https://push.example.com:8443", "https://push.example.com/#secret", "file:///etc/passwd", "https://push.example.com.", "https://*.example.com"]) expect(callbackOrigin(url), url).toBe("");
  });
});
