// NIP-45 HyperLogLog sketch of the pubkeys behind a count.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./negentropy.ts";
import type { Filter } from "./filter.ts";

// hllOffset derives the register offset from a filter, or -1 if ineligible
// (exactly one tag attribute with at least one value).
export function hllOffset(f: Filter): number {
  const names = Object.keys(f.tags);
  if (names.length !== 1) return -1;
  let v = f.tags[names[0]][0];
  if (v === undefined) return -1;
  const parts = v.split(":");
  if (parts.length === 3 && parts[1].length === 64) v = parts[1];
  if (!/^[0-9a-f]{64}$/.test(v)) v = bytesToHex(sha256(new TextEncoder().encode(v)));
  return parseInt(v[32], 16) + 8;
}

export class HLL {
  regs = new Uint8Array(256);
  constructor(private offset: number) {}

  add(pubkeyHex: string) {
    if (pubkeyHex.length !== 64) return;
    const pk = hexToBytes(pubkeyHex);
    const ri = pk[this.offset];
    let zeros = 0;
    for (let i = this.offset + 1; i < 32; i++) {
      const b = pk[i];
      if (b === 0) {
        zeros += 8;
        continue;
      }
      zeros += Math.clz32(b) - 24;
      break;
    }
    const v = zeros + 1;
    if (v > this.regs[ri]) this.regs[ri] = v;
  }

  hex() {
    return bytesToHex(this.regs);
  }
}
