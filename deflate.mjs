// A DEFLATE encoder in the manner of zopfli, written from a plain
// description of the method: lazy hash-chain LZ77 matching, two cost
// passes (fixed-Huffman costs, then dynamic-Huffman costs), per-block
// dynamic Huffman codes with length-limited (package-merge) lengths, and
// fixed-Huffman / stored fallbacks per block, keeping the smallest.
// Emits a zlib stream (header + adler). Deterministic: every limit is
// fixed work, never the clock.
import { inflateSync } from 'node:zlib';

// ---- DEFLATE tables (the format's own) ----
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenSymbol(len) {
  // Largest base <= len (258 maps to symbol 285).
  let lo = 0, hi = LEN_BASE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1;
  }
  return 257 + lo;
}
function distSymbol(dist) {
  let lo = 0, hi = DIST_BASE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---- Bit writer (LSB-first) ----
class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  grow() {
    const next = new Uint8Array(this.buf.length * 2);
    next.set(this.buf);
    this.buf = next;
  }
  put(bits, len) {
    if (len === 0) return;
    this.bitBuf = (this.bitBuf | (bits << this.bitCnt)) >>> 0;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  align() {
    if (this.bitCnt > 0) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

// Canonical Huffman codes from code lengths. Returns { codes, lengths }.
function canonicalCodes(lengths) {
  const maxLen = Math.max(...lengths);
  const blCount = new Int32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Int32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) codes[s] = nextCode[l]++;
  }
  return { codes, lengths };
}

// Length-limited Huffman lengths by package-merge (Larmore-Hirschberg,
// Turpin-Moffat form): repeat maxLen-1 times — package the sorted list
// into neighbouring pairs (discarding the costliest item when odd),
// merge the packages with the single symbols, sort by cost — then take
// the lowest-cost 2n-2 items; a symbol's length is how many taken items
// contain it. Returns Int32Array of lengths, or null when invalid
// (caller falls back to fixed codes).
function huffmanLengths(freqs, maxLen) {
  const n = freqs.length;
  const syms = [];
  for (let s = 0; s < n; s++) if (freqs[s] > 0) syms.push(s);
  const count = syms.length;
  if (count === 0) return null;
  if (count === 1) return null; // single symbol: no valid code here; caller falls back
  if (count === 2) {
    const L = new Int32Array(n);
    L[syms[0]] = 1;
    L[syms[1]] = 1;
    return L;
  }
  const singletons = () => syms.map((s) => ({ w: freqs[s], syms: [s] }));
  let list = singletons();
  const cmp = (a, b) => a.w - b.w || a.syms[0] - b.syms[0] || a.syms.length - b.syms.length;
  for (let iter = 1; iter <= maxLen - 1; iter++) {
    const packaged = [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      packaged.push({ w: list[i].w + list[i + 1].w, syms: list[i].syms.concat(list[i + 1].syms) });
    }
    list = packaged.concat(singletons());
    list.sort(cmp);
  }
  const taken = list.slice(0, 2 * count - 2);
  const lengths = new Int32Array(n);
  for (const it of taken) for (const s of it.syms) lengths[s]++;
  let kraft = 0;
  for (const s of syms) {
    if (lengths[s] === 0 || lengths[s] > maxLen) return null;
    kraft += 2 ** -lengths[s];
  }
  if (Math.abs(kraft - 1) > 1e-9) return null;
  return lengths;
}

// ---- LZ77 matcher ----
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const WSIZE = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;

class Matcher {
  constructor(data, chainLimit, goodLen) {
    this.d = data;
    this.n = data.length;
    this.chainLimit = chainLimit;
    this.goodLen = goodLen;
    this.head = new Int32Array(HASH_SIZE).fill(-1);
    this.prev = new Int32Array(this.n).fill(-1);
  }
  hashAt(i) {
    const d = this.d;
    return (((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK) >>> 0;
  }
  insert(i) {
    if (i + 2 >= this.n) return;
    const h = this.hashAt(i);
    this.prev[i] = this.head[h];
    this.head[h] = i;
  }
  // Longest match at position i; returns [len, dist] (len 0 when none).
  find(i) {
    const d = this.d, n = this.n;
    if (i + MIN_MATCH > n) return [0, 0];
    const maxLen = Math.min(MAX_MATCH, n - i);
    const h = this.hashAt(i);
    let cur = this.head[h];
    const limit = Math.max(0, i - WSIZE);
    let bestLen = 2, bestDist = 0, steps = 0;
    while (cur >= limit && steps < this.chainLimit) {
      steps++;
      if (d[cur] === d[i] && d[cur + bestLen] === d[i + bestLen]) {
        let len = 0;
        while (len < maxLen && d[cur + len] === d[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = i - cur;
          if (len >= this.goodLen) break;
          if (len >= maxLen) break;
        }
      }
      cur = this.prev[cur];
    }
    return bestLen >= MIN_MATCH ? [bestLen, bestDist] : [0, 0];
  }
}

// Token arrays: sym (literal byte or length symbol 257-285), lenEx, dist,
// distEx, endPos (filtered offset after the token).
class Tokens {
  constructor(cap) {
    this.sym = new Uint16Array(cap);
    this.lenEx = new Uint16Array(cap);
    this.dist = new Uint16Array(cap);
    this.distEx = new Uint16Array(cap);
    this.endPos = new Uint32Array(cap);
    this.count = 0;
  }
  grow() {
    const nc = this.sym.length * 2;
    const ns = new Uint16Array(nc), nl = new Uint16Array(nc),
      nd = new Uint16Array(nc), ne = new Uint16Array(nc), np = new Uint32Array(nc);
    ns.set(this.sym); nl.set(this.lenEx); nd.set(this.dist); ne.set(this.distEx); np.set(this.endPos);
    this.sym = ns; this.lenEx = nl; this.dist = nd; this.distEx = ne; this.endPos = np;
  }
  push(sym, lenEx, dist, distEx, endPos) {
    if (this.count >= this.sym.length) this.grow();
    const c = this.count++;
    this.sym[c] = sym; this.lenEx[c] = lenEx; this.dist[c] = dist; this.distEx[c] = distEx; this.endPos[c] = endPos;
  }
}

// Lazy tokenization. costModel is null for length-based decisions, or
// { litCost, lenCost, distCost } (Float64 arrays of bit costs) for
// cost-aware deferral.
function tokenize(data, chainLimit, goodLen, costModel) {
  const n = data.length;
  const m = new Matcher(data, chainLimit, goodLen);
  const toks = new Tokens(Math.max(1024, n >> 2));
  let i = 0;
  while (i < n) {
    if (i + MIN_MATCH > n) {
      while (i < n) { toks.push(data[i], 0, 0, 0, i + 1); i++; }
      break;
    }
    const [len1, dist1] = m.find(i);
    if (len1 < MIN_MATCH) {
      toks.push(data[i], 0, 0, 0, i + 1);
      m.insert(i);
      i++;
      continue;
    }
    m.insert(i);
    const [len2, dist2] = m.find(i + 1);
    let defer = false;
    if (len2 > len1) defer = true;
    else if (costModel && len2 === len1 && len2 >= MIN_MATCH) {
      const c1 = costModel.lenCost[lenSymbol(len1)] + LEN_EXTRA[lenSymbol(len1) - 257]
        + costModel.distCost[distSymbol(dist1)] + DIST_EXTRA[distSymbol(dist1)];
      const c2 = costModel.litCost[data[i]] + costModel.lenCost[lenSymbol(len2)] + LEN_EXTRA[lenSymbol(len2) - 257]
        + costModel.distCost[distSymbol(dist2)] + DIST_EXTRA[distSymbol(dist2)];
      if (c2 < c1) defer = true;
    }
    if (defer) {
      toks.push(data[i], 0, 0, 0, i + 1);
      i++;
      continue;
    }
    const ls = lenSymbol(len1);
    const ds = distSymbol(dist1);
    toks.push(ls, len1 - LEN_BASE[ls - 257], ds, dist1 - DIST_BASE[ds], i + len1);
    for (let j = i + 1; j < i + len1; j++) m.insert(j);
    i += len1;
  }
  return toks;
}

// Frequencies of a token range, plus a cost model from them.
function frequencies(toks, from, to) {
  const litFreq = new Int32Array(286);
  const distFreq = new Int32Array(30);
  for (let t = from; t < to; t++) {
    const s = toks.sym[t];
    litFreq[s]++;
    if (s >= 257) distFreq[toks.dist[t]]++;
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

function costModelFromFreq(litFreq, distFreq) {
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);
  if (!litLen || !distLen) return null;
  const litCost = new Float64Array(286);
  const lenCost = new Float64Array(286);
  for (let s = 0; s < 286; s++) { litCost[s] = litLen[s]; lenCost[s] = litLen[s]; }
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s];
  return { litCost, lenCost, distCost, litLen, distLen };
}

const FIXED_LIT_LEN = (() => {
  const L = new Int32Array(288);
  for (let s = 0; s < 144; s++) L[s] = 8;
  for (let s = 144; s < 256; s++) L[s] = 9;
  for (let s = 256; s < 280; s++) L[s] = 7;
  for (let s = 280; s < 288; s++) L[s] = 8;
  return L;
})();
const FIXED_DIST_LEN = new Int32Array(30).fill(5);

// Run-length encode the lit+dist code lengths for a dynamic block.
// Returns the CL symbol sequence (with extras packed as [sym, extra, extraBits]).
function rleLengths(lengths) {
  const out = [];
  let i = 0;
  const n = lengths.length;
  while (i < n) {
    const v = lengths[i];
    let run = 1;
    while (i + run < n && lengths[i + run] === v) run++;
    if (v === 0) {
      let z = run;
      while (z >= 11) {
        const c = Math.min(z, 138);
        out.push([18, c - 11, 7]);
        z -= c;
      }
      if (z >= 3) { out.push([17, z - 3, 3]); z = 0; }
      while (z > 0) { out.push([0, 0, 0]); z--; }
    } else {
      out.push([v, 0, 0]);
      let z = run - 1;
      while (z >= 3) {
        const c = Math.min(z, 6);
        out.push([16, c - 3, 2]);
        z -= c;
      }
      while (z > 0) { out.push([v, 0, 0]); z--; }
    }
    i += run;
  }
  return out;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Emit one block of tokens [from, to). Returns the bit count used.
// w: BitWriter, final: whether this is the last block.
function emitBlock(w, toks, from, to, data, blockStart, blockEnd, final) {
  const { litFreq, distFreq } = frequencies(toks, from, to);
  const dyn = costModelFromFreq(litFreq, distFreq);
  // Bit cost with fixed codes.
  let fixedBits = 3;
  for (let s = 0; s < 286; s++) if (litFreq[s]) fixedBits += litFreq[s] * FIXED_LIT_LEN[s];
  for (let s = 0; s < 30; s++) if (distFreq[s]) fixedBits += distFreq[s] * 5;
  // Bit cost with dynamic codes (if available).
  let dynBits = Infinity, dynPlan = null;
  if (dyn) {
    const lengths = new Int32Array(286 + 30);
    lengths.set(dyn.litLen.subarray(0, 286), 0);
    lengths.set(dyn.distLen.subarray(0, 30), 286);
    // Trim trailing zero lengths: HLIT = last nonzero lit index + 1 (>=257),
    // HDIST = last nonzero dist index + 1 (>=1).
    let hlit = 286, hdist = 30;
    while (hlit > 257 && lengths[hlit - 1] === 0) hlit--;
    while (hdist > 1 && lengths[285 + hdist] === 0) hdist--;
    const seq = lengths.subarray(0, hlit + hdist);
    const rle = rleLengths(seq);
    const clFreq = new Int32Array(19);
    for (const [s] of rle) clFreq[s]++;
    const clLen = huffmanLengths(clFreq, 7);
    if (clLen) {
      let hclen = 19;
      while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
      let bits = 3 + 5 + 5 + 4 + hclen * 3;
      for (const [s, ex, eb] of rle) bits += clLen[s] + eb;
      for (let s = 0; s < 286; s++) if (litFreq[s]) bits += litFreq[s] * dyn.litLen[s];
      for (let s = 0; s < 30; s++) if (distFreq[s]) bits += distFreq[s] * dyn.distLen[s];
      dynBits = bits;
      dynPlan = { hlit, hdist, hclen, rle, clLen, litLen: dyn.litLen, distLen: dyn.distLen };
    }
  }
  // Stored cost (raw bytes of this block's filtered range); only when the
  // range fits one stored chunk (<= 65535 bytes).
  const nBytes = blockEnd - blockStart;
  const storedBits = nBytes <= 65535 ? 3 + 8 * (5 + nBytes + 1) : Infinity;
  if (storedBits <= fixedBits && storedBits <= dynBits) {
    w.put(final ? 1 : 0, 1);
    w.put(0, 2);
    w.align();
    w.put(nBytes & 0xffff, 16);
    w.put((~nBytes) & 0xffff, 16);
    for (let k = 0; k < nBytes; k++) w.put(data[blockStart + k], 8);
    return storedBits;
  }
  if (dynPlan && dynBits <= fixedBits) {
    const { hlit, hdist, hclen, rle, clLen, litLen, distLen } = dynPlan;
    const clCodes = canonicalCodes(clLen);
    const litCodes = canonicalCodes(litLen);
    const distCodes = canonicalCodes(distLen);
    w.put(final ? 1 : 0, 1);
    w.put(2, 2);
    w.put(hlit - 257, 5);
    w.put(hdist - 1, 5);
    w.put(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) w.put(clLen[CL_ORDER[k]], 3);
    for (const [s, ex, eb] of rle) {
      w.put(reverseBits(clCodes.codes[s], clLen[s]), clLen[s]);
      if (eb) w.put(ex, eb);
    }
    emitTokens(w, toks, from, to, litCodes, distCodes);
    return dynBits;
  }
  const litCodes = canonicalCodes(FIXED_LIT_LEN);
  const distCodes = canonicalCodes(FIXED_DIST_LEN);
  w.put(final ? 1 : 0, 1);
  w.put(1, 2);
  emitTokens(w, toks, from, to, litCodes, distCodes);
  return fixedBits;
}

function emitTokens(w, toks, from, to, litCodes, distCodes) {
  for (let t = from; t < to; t++) {
    const s = toks.sym[t];
    if (s < 256) {
      w.put(reverseBits(litCodes.codes[s], litCodes.lengths[s]), litCodes.lengths[s]);
    } else {
      const li = s - 257;
      w.put(reverseBits(litCodes.codes[s], litCodes.lengths[s]), litCodes.lengths[s]);
      if (LEN_EXTRA[li]) w.put(toks.lenEx[t], LEN_EXTRA[li]);
      const ds = toks.dist[t];
      w.put(reverseBits(distCodes.codes[ds], distCodes.lengths[ds]), distCodes.lengths[ds]);
      if (DIST_EXTRA[ds]) w.put(toks.distEx[t], DIST_EXTRA[ds]);
    }
  }
  w.put(reverseBits(litCodes.codes[256], litCodes.lengths[256]), litCodes.lengths[256]);
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const BLOCK_BYTES = 262144;
const CHAIN_LIMIT = 4096;
const GOOD_LEN = 258;

// Deflate `data` (Uint8Array) into a zlib stream. Two tokenization
// passes: length-based lazy matching, then cost-aware lazy matching with
// the dynamic Huffman costs of the first pass.
export function deflateOptimal(data) {
  const n = data.length;
  if (n === 0) {
    const w = new BitWriter(16);
    w.put(1, 1); w.put(1, 2);
    w.put(reverseBits(canonicalCodes(FIXED_LIT_LEN).codes[256], 7), 7);
    w.align();
    const out = Buffer.alloc(2 + w.pos + 4);
    out[0] = 0x78; out[1] = 0xda;
    out.set(w.bytes(), 2);
    out.writeUInt32BE(1, 2 + w.pos);
    return out;
  }
  let toks = tokenize(data, CHAIN_LIMIT, GOOD_LEN, null);
  const { litFreq, distFreq } = frequencies(toks, 0, toks.count);
  const model = costModelFromFreq(litFreq, distFreq);
  if (model) {
    const toks2 = tokenize(data, CHAIN_LIMIT, GOOD_LEN, model);
    // Keep the pass whose token stream is cheaper under the final model.
    const bitsOf = (tk) => {
      let b = 0;
      for (let t = 0; t < tk.count; t++) {
        const s = tk.sym[t];
        if (s < 256) b += model.litCost[s];
        else {
          const li = s - 257;
          b += model.lenCost[s] + LEN_EXTRA[li] + model.distCost[tk.dist[t]] + DIST_EXTRA[tk.dist[t]];
        }
      }
      return b;
    };
    if (bitsOf(toks2) < bitsOf(toks)) toks = toks2;
  }
  // Split tokens into blocks at BLOCK_BYTES boundaries of filtered data.
  const cuts = [];
  let nextCut = BLOCK_BYTES;
  for (let t = 0; t < toks.count; t++) {
    if (toks.endPos[t] >= nextCut && t < toks.count - 1) {
      cuts.push(t + 1);
      nextCut += BLOCK_BYTES;
    }
  }
  cuts.push(toks.count);
  const w = new BitWriter(n + 65536);
  let from = 0, blockStart = 0;
  for (let bi = 0; bi < cuts.length; bi++) {
    const to = cuts[bi];
    const blockEnd = to === toks.count ? n : toks.endPos[to - 1];
    emitBlock(w, toks, from, to, data, blockStart, blockEnd, bi === cuts.length - 1);
    from = to;
    blockStart = blockEnd;
  }
  w.align();
  const body = w.bytes();
  const out = Buffer.alloc(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0xda;
  out.set(body, 2);
  out.writeUInt32BE(adler32(data), 2 + body.length);
  return out;
}

// Self-test helper: round-trip through the system inflater.
export function roundTripOk(data, stream) {
  try {
    const back = inflateSync(stream);
    return back.length === data.length && Buffer.compare(Buffer.from(back), Buffer.from(data)) === 0;
  } catch {
    return false;
  }
}
