// png-squeeze-01: lossless PNG re-encoder.
//
// Method (from a plain description of the approach):
//   For each screenshot, try every exact way of writing it and keep the
//   smallest, weighed by a real deflate of the filtered bytes:
//   - Colour forms: a palette (at most 256 colours) ordered by count or by
//     luminance, transparent entries first; grey / grey+alpha when every
//     pixel is grey; RGB / RGBA otherwise; and when the image has exactly
//     one fully-transparent value and every other pixel opaque, RGB or grey
//     with a tRNS key instead of an alpha channel.
//   - Filter choices per form: every row unfiltered, every row one fixed
//     filter, or each row its own by one of three heuristics (minimum
//     signed sum, fewest distinct neighbouring byte pairs, lowest row
//     entropy), or brute force: each row's five filters weighed by a real
//     deflate of the row against the 32 KiB of filtered bytes before it.
//   - The winner's filtered bytes are deflated (zlib level 9) and written
//     as a minimal PNG: IHDR / PLTE / tRNS / IDAT / IEND only.
// Deterministic: no clock, no randomness, no environment input.
import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateOptimal } from './deflate.mjs';
import { pathToFileURL } from 'node:url';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC-32 (PNG) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

// ---------- PNG decode ----------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) {
    throw new Error('not a PNG');
  }
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error('unexpected input format');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    const row = px.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : px.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= 4 ? prev[x - 4] : 0;
      let v = raw[p++];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) v = (v + paeth(a, b, c)) & 0xff;
      row[x] = v;
    }
  }
  return { width, height, px };
}

// ---------- Image analysis ----------
function analyse(px) {
  const n = px.length >>> 2;
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (px[d + 3] !== 255) opaque = false;
    if (px[d] !== px[d + 1] || px[d] !== px[d + 2]) grey = false;
    if (!many) {
      const key = ((px[d] << 24) | (px[d + 1] << 16) | (px[d + 2] << 8) | px[d + 3]) >>> 0;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else counts.set(key, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      word,
      rgba: [(word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff],
      count,
    }));
  }
  return { opaque, grey, colours };
}

// The one fully-transparent value the image may key by tRNS: every
// non-opaque pixel is alpha 0 of that exact value, and no opaque pixel
// holds the same value. Null when there is none.
function transparentKey(px, grey) {
  let key = -1;
  for (let d = 0; d < px.length; d += 4) {
    const a = px[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? px[d] : (px[d] << 16) | (px[d + 1] << 8) | px[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < px.length; d += 4) {
    if (px[d + 3] !== 255) continue;
    const v = grey ? px[d] : (px[d] << 16) | (px[d + 1] << 8) | px[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(px, ct) {
  const n = px.length >>> 2;
  if (ct === 6) return Buffer.from(px);
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = Buffer.alloc(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = px[d];
    else if (ct === 4) { out[s] = px[d]; out[s + 1] = px[d + 3]; }
    else { out[s] = px[d]; out[s + 1] = px[d + 1]; out[s + 2] = px[d + 2]; }
  }
  return out;
}

// Palette entries: transparent ones first (by alpha), then by order:
// 'count' (most frequent first) or 'luminance' (darkest first).
function paletteForm(px, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = Buffer.alloc(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0
    ? null
    : Buffer.from(entries.slice(0, transparent).map((c) => c.rgba[3]));
  const n = px.length >>> 2;
  const indices = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    const key = ((px[d] << 24) | (px[d + 1] << 16) | (px[d + 2] << 8) | px[d + 3]) >>> 0;
    indices[i] = index.get(key);
  }
  return { plte, trns, indices };
}

// ---------- Filters ----------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    let v = cur[i];
    if (type === 1) v = (v - a) & 0xff;
    else if (type === 2) v = (v - b) & 0xff;
    else if (type === 3) v = (v - ((a + b) >> 1)) & 0xff;
    else v = (v - paeth(a, b, c)) & 0xff;
    out[i] = v;
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const LOG2 = new Float64Array(8192);
for (let k = 1; k < LOG2.length; k++) LOG2[k] = k * Math.log2(k);
function rowEntropy(row) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < row.length; i++) hist[row[i]]++;
  let cost = row.length * Math.log2(row.length);
  for (let k = 0; k < 256; k++) if (hist[k]) cost -= LOG2[hist[k]];
  return cost;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// Filter the samples by `choice`: a fixed filter 0-4, or a per-row choice
// ('minsum', 'pairs', 'entropy', 'brute'). Returns the filtered stream:
// one filter byte + row bytes per row.
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  const trial = [0, 1, 2, 3, 4].map((t) => {
    const row = Buffer.alloc(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else if (choice === 'entropy') cost = rowEntropy(trial[t].subarray(1));
      else {
        cost = deflateSync(trial[t], before.length === 0
          ? { level: BRUTE_LEVEL, memLevel: 9 }
          : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------- Forms ----------
function formsOf(px) {
  const { opaque, grey, colours } = analyse(px);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
    ]) {
      const p = paletteForm(px, colours, order);
      forms.push({
        colourType: 3, bpp: 1, samples: p.indices,
        plte: p.plte, trns: p.trns, filters,
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(px, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Buffer.from([0, key]);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) {
      trns = Buffer.from([0, (key >>> 16) & 0xff, 0, (key >>> 8) & 0xff, 0, key & 0xff]);
    }
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    colourType: ct, bpp, samples: samplesOf(px, ct),
    plte: null, trns,
    filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute', 'entropy'],
  });
  return forms;
}

const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) +
  (form.trns === null ? 0 : 12 + form.trns.length);

// Screen every form and filter choice; weigh each by a real deflate (the
// smaller of zlib level 6 and level 9: higher levels are not monotonic)
// plus its PLTE/tRNS chunk overhead. Keep the smallest.
function screen(px, width, height) {
  let best = null;
  for (const form of formsOf(px)) {
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z6 = deflateSync(data, { level: 6, memLevel: 8 });
      const z9 = deflateSync(data, { level: 9, memLevel: 9 });
      const zlib = z9.length < z6.length ? z9 : z6;
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        best = { form, choice, data, zlib, bytes };
      }
    }
  }
  // Re-deflate the winner with the optimal-parsing encoder and keep the
  // smaller stream (it never writes more than the zlib stream).
  const mine = deflateOptimal(best.data);
  if (mine.length < best.zlib.length) {
    best = { ...best, zlib: mine, bytes: mine.length + chunkBytes(best.form) };
  }
  return best;
}

// ---------- PNG encode ----------
function encodePng(width, height, form, zlib) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = form.colourType;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (form.plte !== null) parts.push(chunk('PLTE', form.plte));
  if (form.trns !== null) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', zlib));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------- Main ----------
function run() {
  for (const id of readdirSync(INPUT).sort()) {
    let raw;
    try {
      raw = readFileSync(join(INPUT, id, 'image.png'));
    } catch {
      continue;
    }
    const { width, height, px } = decodePng(raw);
    const best = screen(px, width, height);
    const png = encodePng(width, height, best.form, best.zlib);
    const outDir = join(OUTPUT, id);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'image.png'), png);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) run();
export { decodePng, screen, formsOf, filtered, encodePng, paeth };
