// The relay card: the JSON, the nostr event, the SVG with a QR the phone
// can read, and the caching. The encoder itself is test/unit/qr.test.ts.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";
import { encode } from "../../src/qr.ts";
import { scan } from "../helpers/qr.ts";
import { rpc, get } from "../helpers/relay.ts";

describe("relay card", () => {
  it("describes a claimed relay, hides the member count when the directory is private, and signs", async () => {
    const host = "cardy.bind.ws";
    const owner = generateSecretKey();
    const member = generateSecretKey();
    await rpc(host, owner, "claim");
    await rpc(host, owner, "setmember", getPublicKey(member), { name: "bob" });
    await rpc(host, owner, "setpolicy", { description: "A relay for people who like cards.", writes: "allowlist" });

    let r = await get(host, "/card.json");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("max-age=300");
    let c: any = await r.json();
    expect(c.state).toBe("claimed");
    expect(c.name).toBe("cardy");
    expect(c.url).toBe("wss://cardy.bind.ws");
    expect(c.console).toBe("https://cardy.bind.ws/");
    expect(c.owner).toBe(getPublicKey(owner));
    expect(c.members).toBe(2);
    expect(c.writes).toBe("allowlist");
    expect(c.reads).toBe("open");
    expect(c.fuel).toBe("allowance");
    expect(c.self).toMatch(/^[0-9a-f]{64}$/);
    expect(c.signed_url).toBe("https://cardy.bind.ws/card.nostr");
    const prof = decode(c.nprofile);
    expect(prof.type).toBe("nprofile");
    expect((prof.data as any).pubkey).toBe(c.owner);
    expect((prof.data as any).relays).toEqual(["wss://cardy.bind.ws"]);
    const addr = decode(c.naddr);
    expect(addr.type).toBe("naddr");
    expect((addr.data as any).kind).toBe(39000);
    expect((addr.data as any).pubkey).toBe(c.self);
    expect((addr.data as any).identifier).toBe("cardy");
    expect((addr.data as any).relays).toEqual(["wss://cardy.bind.ws"]);

    await rpc(host, owner, "setpolicy", { directoryPublic: false });
    c = await (await get(host, "/card.json")).json();
    expect(c.members).toBeUndefined();

    const signed: any = await (await get(host, "/card.nostr")).json();
    expect(signed.kind).toBe(30078);
    expect(signed.pubkey).toBe(c.self);
    expect(signed.tags).toEqual([["d", "bind.ws/card"]]);
    expect(verifyEvent(signed)).toBe(true);
    expect(JSON.parse(signed.content).naddr).toBe(c.naddr);

    r = await get(host, "/card.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await r.text();
    expect(svg).toContain("cardy");
    expect(svg).toContain("people who like cards");
    expect(svg).toContain("members write");
    expect(svg).toContain("group naddr");
    expect(svg).toContain('<path d="M');
    // The QR on the card scans to the naddr: the card scales the modules
    // into a 150 unit box, so read the cells back from the path.
    const path = svg.match(/<g transform="translate\(418 58\)">.*?<path d="([^"]+)"/)![1];
    const cells = [...path.matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2], cell: +m[3] }));
    const size = encode(c.naddr).size;
    expect(cells.length).toBeGreaterThan(100);
    const dark = new Set(cells.map((k) => Math.round(k.x / k.cell) + "," + Math.round(k.y / k.cell)));
    expect(scan(size, (x, y) => dark.has(x + "," + y))).toBe(c.naddr);
  });

  it("says so on unclaimed and leased relays, and does not sign for them", async () => {
    const host = "nobody.bind.ws";
    const c: any = await (await get(host, "/card.json")).json();
    expect(c.state).toBe("unclaimed");
    expect(c.owner).toBeUndefined();
    expect(c.naddr).toBeUndefined();
    expect((await get(host, "/card.nostr")).status).toBe(404);
    const svg = await (await get(host, "/card.svg")).text();
    expect(svg).toContain("Nobody owns this relay yet");
    const l: any = await (await SELF.fetch("http://bind.ws/lease", { method: "POST", headers: { "cf-connecting-ip": "10.9.9.9" } })).json();
    const lc: any = await (await get(`${l.name}.bind.ws`, "/card.json")).json();
    expect(lc.state).toBe("leased");
    expect(lc.expires_at).toBe(l.expires_at);
  });

  it("serves any short text as a QR and caps it", async () => {
    const host = "nobody.bind.ws";
    let r = await get(host, "/qr.svg?text=" + encodeURIComponent("nostr:npub1abc"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(await r.text()).toContain("<path");
    expect((await get(host, "/qr.svg")).status).toBe(400);
    r = await get(host, "/qr.svg?text=" + "a".repeat(513));
    expect(r.status).toBe(413);
  });
});
