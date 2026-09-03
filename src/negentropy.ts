// NIP-77 Negentropy v1: range-based set reconciliation. A port of the Go
// implementation in the root package; both sides hold a sorted (timestamp,
// id) list and exchange ranges carrying fingerprints or id lists until the
// initiator knows exactly which ids each side is missing.

export interface SyncItem {
  timestamp: number; // unix seconds
  id: Uint8Array; // 32 bytes
}

const VERSION = 0x61;
const MODE_SKIP = 0n;
const MODE_FP = 1n;
const MODE_IDLIST = 2n;
const INFINITY = (1n << 64n) - 1n;
const BUCKETS = 16;
export const FRAME_SIZE = 60_000;

interface Bound {
  ts: bigint;
  id: Uint8Array; // 32 bytes, zero padded
  len: number; // significant prefix bytes
}

const ZERO32 = new Uint8Array(32);

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function itemLess(a: SyncItem, b: SyncItem): boolean {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp;
  return cmpBytes(a.id, b.id) < 0;
}

export function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

class Writer {
  parts: number[] = [];
  varint(v: bigint) {
    const digits: number[] = [];
    do {
      digits.unshift(Number(v & 0x7fn));
      v >>= 7n;
    } while (v > 0n);
    for (let i = 0; i < digits.length - 1; i++) digits[i] |= 0x80;
    this.parts.push(...digits);
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  get length() {
    return this.parts.length;
  }
  toBytes() {
    return new Uint8Array(this.parts);
  }
}

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  get remaining() {
    return this.buf.length - this.pos;
  }
  varint(): bigint {
    let v = 0n;
    for (let i = 0; ; i++) {
      if (this.pos >= this.buf.length || i === 10) throw new Error("bad varint");
      const b = this.buf[this.pos++];
      v = (v << 7n) | BigInt(b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
  }
  bytes(n: number): Uint8Array {
    if (this.remaining < n) throw new Error("truncated message");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export class Negentropy {
  items: SyncItem[];
  initiator = false;
  frame = FRAME_SIZE;
  private lastIn = 0n;
  private lastOut = 0n;

  constructor(items: SyncItem[], private sha256: (b: Uint8Array) => Uint8Array) {
    this.items = [...items].sort((a, b) => (itemLess(a, b) ? -1 : itemLess(b, a) ? 1 : 0));
  }

  initiate(): Uint8Array {
    this.initiator = true;
    this.lastOut = 0n;
    const w = new Writer();
    w.parts.push(VERSION);
    this.splitRange(0, this.items.length, { ts: INFINITY, id: ZERO32, len: 0 }, w);
    return w.toBytes();
  }

  // Returns the reply (null when an initiator is done) and, for the
  // initiator, the ids only we have and the ids only the peer has.
  reconcile(msg: Uint8Array): { reply: Uint8Array | null; have: string[]; need: string[] } {
    const have: string[] = [];
    const need: string[] = [];
    if (msg.length === 0) throw new Error("empty message");
    if (msg[0] !== VERSION) {
      if (this.initiator) throw new Error("peer does not support protocol v1");
      return { reply: new Uint8Array([VERSION]), have, need };
    }
    const r = new Reader(msg.subarray(1));
    this.lastIn = 0n;
    this.lastOut = 0n;
    const out = new Writer();
    out.parts.push(VERSION);
    let prevBound: Bound = { ts: 0n, id: ZERO32, len: 0 };
    let prevIndex = 0;
    let pendingSkip = false;
    const flushSkip = () => {
      if (pendingSkip) {
        pendingSkip = false;
        this.writeBound(out, prevBound);
        out.varint(MODE_SKIP);
      }
    };

    while (r.remaining > 0) {
      let bound = this.readBound(r);
      const mode = r.varint();
      const lower = prevIndex;
      let upper = this.findUpper(lower, bound);

      if (mode === MODE_SKIP) {
        pendingSkip = true;
      } else if (mode === MODE_FP) {
        const theirs = r.bytes(16);
        const ours = this.fingerprint(lower, upper);
        let same = true;
        for (let i = 0; i < 16; i++) if (theirs[i] !== ours[i]) same = false;
        if (same) pendingSkip = true;
        else {
          flushSkip();
          this.splitRange(lower, upper, bound, out);
        }
      } else if (mode === MODE_IDLIST) {
        const count = Number(r.varint());
        const theirs = new Map<string, true>();
        for (let i = 0; i < count; i++) theirs.set(bytesToHex(r.bytes(32)), true);
        if (this.initiator) {
          pendingSkip = true;
          for (let i = lower; i < upper; i++) {
            const h = bytesToHex(this.items[i].id);
            if (theirs.has(h)) theirs.delete(h);
            else have.push(h);
          }
          for (const h of theirs.keys()) need.push(h);
        } else {
          flushSkip();
          let end = bound;
          const ids: number[] = [];
          let cnt = 0;
          for (let i = lower; i < upper; i++) {
            if (out.length + ids.length > this.frame) {
              end = { ts: BigInt(this.items[i].timestamp), id: this.items[i].id, len: 32 };
              upper = i;
              break;
            }
            ids.push(...this.items[i].id);
            cnt++;
          }
          this.writeBound(out, end);
          out.varint(MODE_IDLIST);
          out.varint(BigInt(cnt));
          out.parts.push(...ids);
          bound = end;
        }
      } else {
        throw new Error("unknown range mode");
      }
      prevIndex = upper;
      prevBound = bound;

      if (out.length > this.frame) {
        flushSkip();
        this.writeBound(out, { ts: INFINITY, id: ZERO32, len: 0 });
        out.varint(MODE_FP);
        out.bytes(this.fingerprint(upper, this.items.length));
        break;
      }
    }
    if (this.initiator && out.length === 1) return { reply: null, have, need };
    return { reply: out.toBytes(), have, need };
  }

  private splitRange(lower: number, upper: number, bound: Bound, out: Writer) {
    const count = upper - lower;
    if (count < BUCKETS * 2) {
      this.writeBound(out, bound);
      out.varint(MODE_IDLIST);
      out.varint(BigInt(count));
      for (let i = lower; i < upper; i++) out.bytes(this.items[i].id);
      return;
    }
    const per = Math.floor(count / BUCKETS);
    const extra = count % BUCKETS;
    let cur = lower;
    for (let i = 0; i < BUCKETS; i++) {
      const size = per + (i < extra ? 1 : 0);
      const fp = this.fingerprint(cur, cur + size);
      cur += size;
      const next = cur < upper ? minimalBound(this.items[cur - 1], this.items[cur]) : bound;
      this.writeBound(out, next);
      out.varint(MODE_FP);
      out.bytes(fp);
    }
  }

  fingerprint(lower: number, upper: number): Uint8Array {
    const sum = new Uint8Array(32);
    for (let i = lower; i < upper; i++) {
      let carry = 0;
      const id = this.items[i].id;
      for (let j = 0; j < 32; j++) {
        const v = sum[j] + id[j] + carry;
        sum[j] = v & 0xff;
        carry = v >> 8;
      }
    }
    const w = new Writer();
    w.bytes(sum);
    w.varint(BigInt(upper - lower));
    return this.sha256(w.toBytes()).subarray(0, 16);
  }

  private findUpper(lower: number, b: Bound): number {
    let lo = lower;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const it = this.items[mid];
      const ts = BigInt(it.timestamp);
      const below = ts !== b.ts ? ts < b.ts : cmpBytes(it.id, b.id) < 0;
      if (below) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private writeBound(w: Writer, b: Bound) {
    if (b.ts === INFINITY) {
      this.lastOut = INFINITY;
      w.varint(0n);
    } else {
      w.varint(b.ts - this.lastOut + 1n);
      this.lastOut = b.ts;
    }
    w.varint(BigInt(b.len));
    w.bytes(b.id.subarray(0, b.len));
  }

  private readBound(r: Reader): Bound {
    const v = r.varint();
    let ts: bigint;
    if (v === 0n) ts = INFINITY;
    else {
      ts = this.lastIn + v - 1n;
      if (ts < this.lastIn || ts > INFINITY) ts = INFINITY;
    }
    this.lastIn = ts;
    const len = Number(r.varint());
    if (len > 32) throw new Error("bound id prefix too long");
    const id = new Uint8Array(32);
    id.set(r.bytes(len));
    return { ts, id, len };
  }
}

export function minimalBound(prev: SyncItem, cur: SyncItem): Bound {
  if (cur.timestamp !== prev.timestamp) return { ts: BigInt(cur.timestamp), id: ZERO32, len: 0 };
  let shared = 0;
  while (shared < 32 && prev.id[shared] === cur.id[shared]) shared++;
  const id = new Uint8Array(32);
  id.set(cur.id.subarray(0, shared + 1));
  return { ts: BigInt(cur.timestamp), id, len: shared + 1 };
}

export function encodeVarint(v: bigint): Uint8Array {
  const w = new Writer();
  w.varint(v);
  return w.toBytes();
}
