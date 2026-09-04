// NIP-11 extras: the policy links and lists the owner can set, the terms of
// service page, and what gets into the information document.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey } from "nostr-tools/pure";
import { rpc, info } from "./helpers/relay.ts";

describe("NIP-11 extras", () => {
  it("publishes the policy links and lists once set, validated", async () => {
    const host = "eleven.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    let doc = await info(host);
    for (const k of ["banner", "terms_of_service", "posting_policy", "privacy_policy", "tags", "language_tags", "relay_countries"]) expect(doc[k], k).toBeUndefined();

    const r = await rpc(host, owner, "setpolicy", {
      banner: "https://img.example/banner.png",
      postingPolicy: "https://example.com/posting",
      privacyPolicy: "http://example.com/privacy", // not https: dropped
      tags: ["Bitcoin", "cats", "cats", "Not Valid!", "x".repeat(40)],
      languageTags: ["en", "pt-BR", "english", "zh-Hant-TW"],
      relayCountries: ["us", "DE", "USA", "fr"],
    });
    expect(r.status).toBe(200);
    expect(r.result.privacyPolicy).toBe("");
    doc = await info(host);
    expect(doc.banner).toBe("https://img.example/banner.png");
    expect(doc.posting_policy).toBe("https://example.com/posting");
    expect(doc.privacy_policy).toBeUndefined();
    expect(doc.tags).toEqual(["bitcoin", "cats"]);
    expect(doc.language_tags).toEqual(["en", "pt-BR", "zh-Hant-TW"]);
    expect(doc.relay_countries).toEqual(["US", "DE", "FR"]);

    // Clearing a link removes it; a list capped at twenty.
    await rpc(host, owner, "setpolicy", { postingPolicy: "", tags: Array.from({ length: 30 }, (_, i) => "t" + i) });
    doc = await info(host);
    expect(doc.posting_policy).toBeUndefined();
    expect(doc.tags.length).toBe(20);
  });

  it("serves the join terms as the terms of service page", async () => {
    const host = "terms.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    expect((await SELF.fetch(`http://${host}/terms`)).status).toBe(404);
    expect((await info(host)).terms_of_service).toBeUndefined();
    await rpc(host, owner, "setpolicy", { joinTerms: "Be kind.\nNo spam <ever>." });
    expect((await info(host)).terms_of_service).toBe(`https://${host}/terms`);
    const page = await SELF.fetch(`http://${host}/terms`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Be kind.");
    expect(html).toContain("No spam &lt;ever&gt;.");
  });

  it("carries the extras through export and import", async () => {
    const host = "carry.bind.ws";
    const owner = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setpolicy", { privacyPolicy: "https://example.com/privacy", tags: ["art"], languageTags: ["fr"], relayCountries: ["FR"] });
    const cfg = (await rpc(host, owner, "exportconfig")).result;
    expect(cfg.policy.tags).toEqual(["art"]);
    const other = "carried.bind.ws";
    await rpc(other, owner, "claim");
    expect((await rpc(other, owner, "importconfig", cfg)).status).toBe(200);
    const doc = await info(other);
    expect(doc.privacy_policy).toBe("https://example.com/privacy");
    expect(doc.tags).toEqual(["art"]);
    expect(doc.language_tags).toEqual(["fr"]);
    expect(doc.relay_countries).toEqual(["FR"]);
  });
});
