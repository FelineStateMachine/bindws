// The QR encoder behind the relay card. A symbol is read back: format
// bits, unmasked data, de-interleaved blocks, Reed-Solomon syndromes, and
// the bytes themselves; then jsQR, which shares nothing with the encoder.
import { describe, it, expect } from "vitest";
import { EC_M, MASKS, dataCodewords, dataOrder, encode, formatBits, gfMul, gfPow, layout, capacity } from "../../src/qr.ts";
import { scan } from "../helpers/qr.ts";

// readBack decodes a symbol without any error correction: it must be exact.
function readBack(sym: ReturnType<typeof encode>): { mask: number; level: number; bytes: Uint8Array } {
  const { size, modules, version } = sym;
  const at = (x: number, y: number) => modules[y * size + x];
  // Format bits around the top-left finder, and the second copy split
  // between the other two; both must agree.
  const fbits: number[] = [];
  for (let i = 0; i < 6; i++) fbits.push(at(8, i));
  fbits.push(at(8, 7), at(8, 8), at(7, 8));
  for (let i = 9; i < 15; i++) fbits.push(at(14 - i, 8));
  const second: number[] = [];
  for (let i = 0; i < 8; i++) second.push(at(size - 1 - i, 8));
  for (let i = 8; i < 15; i++) second.push(at(8, size - 15 + i));
  expect(second).toEqual(fbits);
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

  it("scans with an independent decoder, which the read-back above cannot prove", () => {
    // The read-back shares the encoder's assumptions: transposed format bits
    // passed it for months while no phone could scan the result, and a
    // misplaced alignment pattern in version 10 hid behind error correction
    // at short lengths. jsQR is a different code base; every version at
    // full capacity goes through it.
    const uri = "nostrconnect://" + "ab".repeat(32) + "?relay=wss%3A%2F%2Fdami.bind.ws&secret=0123456789abcdef&perms=sign_event%3A27235%2Csign_event%3A9734&name=dami.bind.ws&url=https%3A%2F%2Fdami.bind.ws";
    const full = Array.from({ length: 20 }, (_, i) => Array.from({ length: capacity(i + 1) }, (_, j) => String.fromCharCode(48 + ((j * 7 + i) % 74))).join(""));
    for (const text of ["nostr:npub1abc", uri, ...full]) {
      const sym = encode(text);
      expect(scan(sym.size, (x, y) => sym.modules[y * sym.size + x] === 1), `version ${sym.version}`).toBe(text);
    }
  });
});
