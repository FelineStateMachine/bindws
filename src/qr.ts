// A QR code encoder: byte mode, error correction level M, versions 1 to 20
// (up to 666 bytes), no dependencies. Used for the group naddr on the relay
// card and for the remote signer link. Written from the ISO 18004 tables;
// the helpers are exported so the test can read a symbol back and check the
// Reed-Solomon syndromes rather than trust a picture.

// Error correction blocks for level M: [ec codewords per block, group 1
// block count, group 1 data codewords, group 2 block count, group 2 data
// codewords], indexed by version. Version 0 is a placeholder.
export const EC_M: [number, number, number, number, number][] = [
  [0, 0, 0, 0, 0],
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
];
const ALIGN: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 52],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];
export const MAX_VERSION = 20;

export function dataCodewords(version: number): number {
  const [, g1, d1, g2, d2] = EC_M[version];
  return g1 * d1 + g2 * d2;
}
// capacity is how many bytes a version holds in byte mode at level M.
export function capacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);
}

// ---- GF(256) and Reed-Solomon ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
export function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}
export function gfPow(base: number, e: number): number {
  return EXP[(LOG[base] * e) % 255];
}
function generator(ec: number): number[] {
  let g = [1];
  for (let i = 0; i < ec; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}
export function rsEncode(data: number[], ec: number): number[] {
  const g = generator(ec);
  const rem = new Array<number>(ec).fill(0);
  for (const d of data) {
    const f = d ^ rem[0];
    rem.shift();
    rem.push(0);
    if (f === 0) continue;
    for (let j = 0; j < ec; j++) rem[j] ^= gfMul(g[j + 1], f);
  }
  return rem;
}

// ---- layout ----

export interface Layout {
  size: number;
  isFunction: Uint8Array; // 1 where a module is fixed or reserved
}

export function layout(version: number): Layout {
  const size = version * 4 + 17;
  const f = new Uint8Array(size * size);
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) f[y * size + x] = 1;
  };
  // Finders with separators, and the format areas next to them.
  for (const [cx, cy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y < 8; y++) for (let x = -1; x < 8; x++) mark(cx + x, cy + y);
  }
  for (let i = 0; i < 9; i++) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  // Timing.
  for (let i = 8; i < size - 8; i++) {
    mark(i, 6);
    mark(6, i);
  }
  // Alignment.
  const a = ALIGN[version];
  for (const cy of a) {
    for (const cx of a) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) mark(cx + x, cy + y);
    }
  }
  // Version information.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      mark(Math.floor(i / 3), size - 11 + (i % 3));
      mark(size - 11 + (i % 3), Math.floor(i / 3));
    }
  }
  return { size, isFunction: f };
}

// dataOrder lists the non-function modules in the zigzag order data bits are placed.
export function dataOrder(l: Layout): [number, number][] {
  const out: [number, number][] = [];
  const { size, isFunction } = l;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const y = up ? size - 1 - i : i;
      for (const dx of [0, 1]) {
        const x = col - dx;
        if (!isFunction[y * size + x]) out.push([x, y]);
      }
    }
    up = !up;
  }
  return out;
}

export const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// formatBits is the 15-bit BCH-coded format information for level M and a mask.
export function formatBits(mask: number): number {
  const data = (0 << 3) | mask; // level M is 00
  let bch = data << 10;
  for (let i = 14; i >= 10; i--) if (bch & (1 << i)) bch ^= 0x537 << (i - 10);
  return ((data << 10) | bch) ^ 0x5412;
}
export function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if (rem & (1 << i)) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

// ---- encoding ----

export interface Symbol {
  version: number;
  size: number;
  mask: number;
  modules: Uint8Array; // 1 is dark
}

// codewords builds the interleaved data and error correction stream.
export function codewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const total = dataCodewords(version) * 8;
  push(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < dataCodewords(version); pad ^= 0xec ^ 0x11) data.push(pad);
  // Split into blocks, compute EC, interleave.
  const [ec, g1, d1, g2, d2] = EC_M[version];
  const blocks: number[][] = [];
  let off = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g1 ? d1 : d2;
    blocks.push(data.slice(off, off + len));
    off += len;
  }
  const ecs = blocks.map((b) => rsEncode(b, ec));
  const out: number[] = [];
  const longest = Math.max(d1, d2);
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

function penalty(m: Uint8Array, size: number): number {
  let score = 0;
  const at = (x: number, y: number) => m[y * size + x];
  // Runs of five or more in a row or column.
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (at(x, y) === at(x - 1, y)) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (at(x, y) === at(x, y - 1)) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }
  // Two by two blocks.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }
  // Finder-like patterns with four light modules on a side.
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const check = (get: (i: number) => number, len: number) => {
    for (let i = 0; i + 11 <= len; i++) {
      let fwd = true;
      let back = true;
      for (let j = 0; j < 11; j++) {
        const v = get(i + j);
        if (v !== pat[j]) fwd = false;
        if (v !== pat[10 - j]) back = false;
      }
      if (fwd || back) score += 40;
    }
  };
  for (let y = 0; y < size; y++) check((i) => at(i, y), size);
  for (let x = 0; x < size; x++) check((i) => at(x, i), size);
  // Dark proportion.
  let dark = 0;
  for (const v of m) dark += v;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// encode picks the smallest version that fits, tries every mask and keeps
// the one with the lowest penalty.
export function encode(text: string | Uint8Array): Symbol {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let version = 1;
  while (version <= MAX_VERSION && capacity(version) < bytes.length) version++;
  if (version > MAX_VERSION) throw new Error(`too long for a QR code: ${bytes.length} bytes, at most ${capacity(MAX_VERSION)}`);
  const l = layout(version);
  const { size } = l;
  const cw = codewords(bytes, version);
  const order = dataOrder(l);
  const base = new Uint8Array(size * size);
  const set = (x: number, y: number, v: number) => {
    base[y * size + x] = v;
  };
  // Finders.
  for (const [cx, cy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        set(cx + x, cy + y, edge || core ? 1 : 0);
      }
    }
  }
  // Timing.
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0 ? 1 : 0);
    set(6, i, i % 2 === 0 ? 1 : 0);
  }
  // Alignment.
  const a = ALIGN[version];
  for (const cy of a) {
    for (const cx of a) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) set(cx + x, cy + y, Math.max(Math.abs(x), Math.abs(y)) !== 1 ? 1 : 0);
    }
  }
  // Dark module.
  set(8, size - 8, 1);
  // Version information.
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >> i) & 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }
  // Data bits, zeros where the stream runs out (the remainder bits).
  const bitAt = (i: number) => (i < cw.length * 8 ? (cw[i >> 3] >> (7 - (i & 7))) & 1 : 0);
  order.forEach(([x, y], i) => set(x, y, bitAt(i)));

  let best: Uint8Array | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.slice();
    for (const [x, y] of order) if (MASKS[mask](x, y)) m[y * size + x] ^= 1;
    const fb = formatBits(mask);
    const bit = (i: number) => (fb >> i) & 1;
    // Around the top-left finder.
    for (let i = 0; i < 6; i++) m[8 * size + i] = bit(i);
    m[8 * size + 7] = bit(6);
    m[8 * size + 8] = bit(7);
    m[7 * size + 8] = bit(8);
    for (let i = 9; i < 15; i++) m[(14 - i) * size + 8] = bit(i);
    // Split between the other two finders.
    for (let i = 0; i < 8; i++) m[(size - 1 - i) * size + 8] = bit(i);
    for (let i = 8; i < 15; i++) m[8 * size + (size - 15 + i)] = bit(i);
    const s = penalty(m, size);
    if (s < bestScore) {
      bestScore = s;
      best = m;
      bestMask = mask;
    }
  }
  return { version, size, mask: bestMask, modules: best as Uint8Array };
}

// svg renders a symbol with a quiet zone, dark on transparent so it sits on
// any background; pass a fill and a background to change that.
export function svg(text: string | Uint8Array, opts: { margin?: number; fill?: string; background?: string; title?: string } = {}): string {
  const q = encode(text);
  const margin = opts.margin ?? 2;
  const n = q.size + margin * 2;
  let d = "";
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (q.modules[y * q.size + x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  const bg = opts.background ? `<rect width="${n}" height="${n}" fill="${opts.background}"/>` : "";
  const title = opts.title ? `<title>${opts.title.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c] as string)}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">${title}${bg}<path d="${d}" fill="${opts.fill ?? "#1c1b18"}"/></svg>`;
}
