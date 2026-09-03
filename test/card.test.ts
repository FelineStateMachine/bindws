// The relay card and the QR encoder behind it. The QR test reads a symbol
// back: format bits, unmasked data, de-interleaved blocks, Reed-Solomon
// syndromes, and the bytes themselves.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";
import { getToken } from "nostr-tools/nip98";
import { EC_M, MASKS, dataCodewords, dataOrder, encode, formatBits, gfMul, gfPow, layout, capacity } from "../src/qr.ts";

async function rpc(host: string, sk: Uint8Array, method: string, ...params: unknown[]) {
  const url = `http://${host}/`;
  const payload = { method, params };
  const token = await getToken(url, "POST", (e) => finalizeEvent(e, sk), true, payload);
  const resp = await SELF.fetch(url, { method: "POST", headers: { "content-type": "application/nostr+json+rpc", authorization: token }, body: JSON.stringify(payload) });
  return { status: resp.status, ...(await resp.json<any>()) };
}
const get = (host: string, path: string) => SELF.fetch(`http://${host}${path}`);

// readBack decodes a symbol without any error correction: it must be exact.
function readBack(sym: ReturnType<typeof encode>): { mask: number; level: number; bytes: Uint8Array } {
  const { size, modules, version } = sym;
  const at = (x: number, y: number) => modules[y * size + x];
  // Format bits around the top-left finder.
  const fbits: number[] = [];
  for (let i = 0; i < 6; i++) fbits.push(at(i, 8));
  fbits.push(at(7, 8), at(8, 8), at(8, 7));
  for (let i = 9; i < 15; i++) fbits.push(at(8, 14 - i));
  let f = 0;
  fbits.forEach((b, i) => (f |= b << i));
  const mask = (f ^ 0x5412) >> 10 & 7;
  const level = (f ^ 0x5412) >> 13 & 3;
  expect(f).toBe(formatBits(mask));
  // Data modules in placement order, unmasked.
  const l = layout(version);
  const order = dataOrder(l);
  const bits = order.map(([x, y]) => at(x, y) ^ (MASKS[mask](x, y) ? 1 : 0));
  const [ec, g1, d1, g2, d2] = EC_M[version];
  const nblocks = g1 + g2;
  const total = dataCodewords(version) + ec * nblocks;
  const cw: number[] = [];
  for (let i = 0; i < total; i++) cw.push(parseInt(bits.slice(i * 8, i * 8 + 8).join(""), 2));
  // De-interleave.
  const lens = [...Array(g1).fill(d1), ...Array(g2).fill(d2)] as number[];
  const data: number[][] = lens.map(() => []);
  const ecs: number[][] = lens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) for (let b = 0; b < nblocks; b++) if (i < lens[b]) data[b].push(cw[k++]);
  for (let i = 0; i < ec; i++) for (let b = 0; b < nblocks; b++) ecs[b].push(cw[k++]);
  expect(k).toBe(total);
  // Syndromes: the codeword polynomial vanishes at alpha^0 .. alpha^(ec-1).
  for (let b = 0; b < nblocks; b++) {
    const poly = [...data[b], ...ecs[b]];
    for (let i = 0; i < ec; i++) {
      let v = 0;
      const a = gfPow(2, i);
      for (const c of poly) v = gfMul(v, a) ^ c;
      expect(v, `block ${b} syndrome ${i}`).toBe(0);
    }
  }
  // Byte mode header and payload.
  const dbits: number[] = [];
  for (const block of data) for (const c of block) for (let i = 7; i >= 0; i--) dbits.push((c >> i) & 1);
  const mode = parseInt(dbits.slice(0, 4).join(""), 2);
  expect(mode).toBe(4);
  const cl = version < 10 ? 8 : 16;
  const len = parseInt(dbits.slice(4, 4 + cl).join(""), 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(dbits.slice(4 + cl + i * 8, 4 + cl + i * 8 + 8).join(""), 2);
  return { mask, level, bytes };
}

describe("qr encoder", () => {
  it("round-trips through every version class with valid format bits and zero syndromes", () => {
    const cases = [5, 14, 40, 100, 130, 213, 260, 400, 500, 666].map((n) => "x".repeat(n).replace(/x/g, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))));
    cases.push("HELLO WORLD", "nostrconnect://" + "ab".repeat(32) + "?relay=wss%3A%2F%2Fearly-trout.bind.ws&secret=deadbeef&perms=sign_event%3A27235");
    const seen = new Set<number>();
    for (const text of cases) {
      const sym = encode(text);
      seen.add(sym.version);
      expect(sym.size).toBe(sym.version * 4 + 17);
      // Finder patterns are dark at their corners and cores.
      for (const [cx, cy] of [[0, 0], [sym.size - 7, 0], [0, sym.size - 7]]) {
        expect(sym.modules[cy * sym.size + cx]).toBe(1);
        expect(sym.modules[(cy + 3) * sym.size + cx + 3]).toBe(1);
        expect(sym.modules[(cy + 1) * sym.size + cx + 1]).toBe(0);
      }
      const back = readBack(sym);
      expect(back.level).toBe(0); // M
      expect(back.mask).toBe(sym.mask);
      expect(new TextDecoder().decode(back.bytes)).toBe(text);
    }
    expect(seen.size).toBeGreaterThan(6);
    expect(capacity(1)).toBe(14);
    expect(capacity(10)).toBe(213);
    expect(capacity(20)).toBe(666);
    expect(() => encode("y".repeat(667))).toThrow(/too long/);
  });
});

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
