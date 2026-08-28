// Structured-light geometry: measure the display→camera mapping instead of
// assuming it.
//
// The four-corner homography is exact for a flat wall and wrong for anything
// else, because a projective transform maps planes to planes. On a 120° curved
// screen the error peaks in the middle — dead centre, where people stand — at
// roughly 9 cells on a 416-wide grid, against a detector that tolerates one or
// two. It also cannot represent lens distortion on any surface, flat included.
//
// Gray code sidesteps the whole problem by measuring. Each display cell is
// given a binary address, one bit at a time, and the camera reads that address
// off the surface directly. Whatever the surface does to the light — curve it,
// blend two projectors across it, distort it through a wide lens — is already
// baked into what comes back.
//
// Gray code specifically, rather than plain binary: consecutive values differ
// in exactly one bit, so a camera pixel straddling a stripe boundary misreads
// at most one bit and lands on a neighbouring cell, instead of a plain-binary
// carry flipping every bit at once and landing somewhere arbitrary.

// A bit must swing at least this much absolutely, and at least this fraction of
// what the pixel has shown it can swing, before it is believed.
const MIN_BIT_SWING = 0.012, BIT_FRACTION = 0.25;
// How coarse a position may be and still be worth keeping, as a fraction of the
// axis. Expressed relative to the screen rather than as a bit count, because a
// fixed count means something completely different on a 96-cell grid than on a
// 416-cell one — an absolute rule rejected almost every pixel on small grids and
// left 0.3% coverage.
const MAX_BLOCK_FRAC = 1 / 6;

export const bitsFor = (n) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
export const grayEncode = (x) => x ^ (x >> 1);

// Decode using only bits at or above `floor`, then centre the result in the
// block the discarded bits would have chosen. Sound because gray decoding runs
// top-down: each bit of the position depends only on bits at or above it.
export function grayDecodeFrom(g, bits, floor, limit) {
  let x = 0;
  for (let b = bits - 1; b >= floor; b--) {
    const gb = (g >> b) & 1;
    const above = (x >> (b + 1)) & 1;
    x |= (gb ^ above) << b;
  }
  if (floor <= 0) return x;
  // Centre within the block's intersection with the axis. The last block on an
  // axis whose length is not a multiple of the block size is truncated, so an
  // unclamped centre lands past the end and the pixel is discarded — losing
  // precisely the right and bottom edges, the ones the operator is being told
  // to aim at.
  const block = 1 << floor;
  const end = limit === undefined ? x + block : Math.min(x + block, limit);
  const mid = x + ((end - x) >> 1);
  return mid < x ? x : mid;
}

export function grayDecode(g, bits) {
  let x = g;
  for (let s = 1; s < bits; s <<= 1) x ^= x >> s;
  return x;
}

// Each bit is shown twice, normal and inverted. Thresholding a pixel against
// its own inverse is immune to how brightly that part of the surface happens to
// be lit — which matters on a curved screen, where the edges are far dimmer
// than the centre, and across a blend seam where two projectors overlap.
export function patternSequence({ w, h, holdFrames = 2 }) {
  const bx = bitsFor(w), by = bitsFor(h);
  const specs = [{ kind: 'white' }, { kind: 'black' }];
  for (let b = 0; b < bx; b++) { specs.push({ kind: 'x', bit: b, invert: false }); specs.push({ kind: 'x', bit: b, invert: true }); }
  for (let b = 0; b < by; b++) { specs.push({ kind: 'y', bit: b, invert: false }); specs.push({ kind: 'y', bit: b, invert: true }); }
  return {
    bitsX: bx, bitsY: by, steps: specs.length,
    length: specs.length * holdFrames,
    frame(i) {
      const step = Math.floor(i / holdFrames);
      const spec = specs[Math.min(step, specs.length - 1)];
      return { ...spec, step, settle: i % holdFrames === 0 };
    },
  };
}

// Paint one pattern into a display-space greyscale buffer.
export function patternFor(spec, w, h, out) {
  if (spec.kind === 'white') { out.fill(255); return out; }
  if (spec.kind === 'black') { out.fill(0); return out; }
  const along = spec.kind === 'x';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = grayEncode(along ? x : y);
      let on = (v >> spec.bit) & 1;
      if (spec.invert) on ^= 1;
      out[y * w + x] = on ? 255 : 0;
    }
  }
  return out;
}

// Accumulates the captured patterns and inverts the correspondence.
//
// Decoding reads camera pixel -> display cell, but the warp needs the opposite:
// for a display cell, where in the camera to look. So decoded camera pixels are
// scattered into the display cells they landed on and averaged, which also
// suppresses noise wherever several camera pixels see one cell.
export function createDecoder({ w, h, camW, camH, holdFrames = 2 }) {
  const seq = patternSequence({ w, h, holdFrames });
  const n = camW * camH;
  const white = new Float32Array(n), black = new Float32Array(n);
  const codeX = new Int32Array(n), codeY = new Int32Array(n);
  const swing = new Float32Array(n);

  // Per-bit evidence, kept so floors can be decided AFTER the final swing is
  // known. Judging a bit against a running maximum it has just set makes the
  // relative test unfireable for whichever bit happens to be largest so far —
  // in practice bit 0, the finest and least trustworthy stripe of all.
  const magX = new Uint8Array(n * seq.bitsX), magY = new Uint8Array(n * seq.bitsY);
  // Which bits actually had BOTH halves of their pair captured. A bit whose
  // pair never completed used to stay silently zero for every pixel, and
  // forcing a gray bit to zero folds the decoded position into half the axis —
  // a confident, badly wrong map that nothing in the diagnostics could see.
  const doneX = new Uint8Array(seq.bitsX), doneY = new Uint8Array(seq.bitsY);

  // One hold's frames are averaged rather than one frame being taken. Every bit
  // of the map is a single difference of two captures, on a signal this module
  // treats as marginal by design; averaging what the hold actually gave us is
  // free and strictly better.
  const accSum = new Float32Array(n);
  let accKey = null, accSpec = null, accN = 0;
  const normBuf = new Float32Array(n);
  let normSpec = null, haveNorm = false;

  const keyOf = (s) => `${s.kind}:${s.bit ?? -1}:${s.invert ? 1 : 0}:${s.step ?? -1}`;

  function differencePair(spec, a, b) {
    const code = spec.kind === 'x' ? codeX : codeY;
    const mag = spec.kind === 'x' ? magX : magY;
    const base = spec.bit * n;
    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i], ad = d < 0 ? -d : d;
      if (ad > swing[i]) swing[i] = ad;
      mag[base + i] = ad >= 1 ? 255 : (ad * 255) | 0;
      if (d > 0) code[i] |= 1 << spec.bit;
    }
    (spec.kind === 'x' ? doneX : doneY)[spec.bit] = 1;
  }

  function flushHold() {
    if (!accN || !accSpec) { accKey = null; accSpec = null; accN = 0; return; }
    const inv = 1 / accN;
    for (let i = 0; i < n; i++) accSum[i] *= inv;
    const s = accSpec;
    if (s.kind === 'white') white.set(accSum);
    else if (s.kind === 'black') black.set(accSum);
    else if (!s.invert) { normBuf.set(accSum); normSpec = s; haveNorm = true; }
    else if (haveNorm && normSpec.kind === s.kind && normSpec.bit === s.bit
             && s.step === normSpec.step + 1) {
      // Only pair with the IMMEDIATELY preceding hold. Without that test a
      // single misattributed frame at a boundary still cross-pairs two
      // different bits, which reads as noise for every pixel at once.
      differencePair(s, normBuf, accSum);
      haveNorm = false;
    }
    accSum.fill(0); accN = 0; accKey = null; accSpec = null;
  }

  function add(spec, camLuma) {
    const k = keyOf(spec);
    if (k !== accKey) { flushHold(); accKey = k; accSpec = spec; }
    for (let i = 0; i < n; i++) accSum[i] += camLuma[i];
    accN++;
  }

  function finish({ minContrast = 0.04, fillIters = 24 } = {}) {
    flushHold();   // the last invert hold has no following spec to trigger it

    const N = w * h;
    const sumU = new Float32Array(N), sumV = new Float32Array(N), cnt = new Float32Array(N);
    let decoded = 0, deepestX = 0, deepestY = 0;
    let rejContrast = 0, rejBlockX = 0, rejBlockY = 0, rejRange = 0, used = 0;
    const maxBlockX = Math.max(2, w * MAX_BLOCK_FRAC);
    const maxBlockY = Math.max(2, h * MAX_BLOCK_FRAC);

    // Bits whose pair never completed are unknown for every pixel, so no floor
    // may sit below them.
    let missX = 0, missY = 0;
    for (let b = 0; b < seq.bitsX; b++) if (!doneX[b]) missX = b + 1;
    for (let b = 0; b < seq.bitsY; b++) if (!doneY[b]) missY = b + 1;

    for (let cy = 0; cy < camH; cy++) {
      for (let cx = 0; cx < camW; cx++) {
        const i = cy * camW + cx;
        if (swing[i] < minContrast) { rejContrast++; continue; }
        const thr = Math.max(MIN_BIT_SWING, swing[i] * BIT_FRACTION);
        let fx = missX, fy = missY;
        for (let b = 0; b < seq.bitsX; b++) if (magX[b * n + i] / 255 < thr) fx = Math.max(fx, b + 1);
        for (let b = 0; b < seq.bitsY; b++) if (magY[b * n + i] / 255 < thr) fy = Math.max(fy, b + 1);
        if ((1 << fx) > maxBlockX) { rejBlockX++; continue; }
        if ((1 << fy) > maxBlockY) { rejBlockY++; continue; }
        const dx = grayDecodeFrom(codeX[i], seq.bitsX, fx, w);
        const dy = grayDecodeFrom(codeY[i], seq.bitsY, fy, h);
        if (dx < 0 || dx >= w || dy < 0 || dy >= h) { rejRange++; continue; }
        used++;
        if (fx > deepestX) deepestX = fx;
        if (fy > deepestY) deepestY = fy;
        const d = dy * w + dx;
        sumU[d] += cx / (camW - 1);
        sumV[d] += cy / (camH - 1);
        cnt[d] += 1;
        decoded++;
      }
    }

    const mapU = new Float32Array(N), mapV = new Float32Array(N);
    const valid = new Uint8Array(N);
    let seen = 0;
    for (let d = 0; d < N; d++) {
      if (cnt[d] > 0) { mapU[d] = sumU[d] / cnt[d]; mapV[d] = sumV[d] / cnt[d]; valid[d] = 1; seen++; }
    }

    const filled = Uint8Array.from(valid);
    for (let it = 0; it < fillIters; it++) {
      let added = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = y * w + x;
          if (filled[d]) continue;
          let su = 0, sv = 0, c = 0;
          for (let k = 0; k < 4; k++) {
            const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
            const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nd = ny * w + nx;
            if (!filled[nd]) continue;
            su += mapU[nd]; sv += mapV[nd]; c++;
          }
          if (c > 0) { mapU[d] = su / c; mapV[d] = sv / c; added++; }
        }
      }
      if (!added) break;
      for (let d = 0; d < N; d++) if (!filled[d] && (mapU[d] || mapV[d])) filled[d] = 1;
    }

    const sorted = Float32Array.from(swing).sort();
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
    const missingBits = [];
    for (let b = 0; b < seq.bitsX; b++) if (!doneX[b]) missingBits.push(`x${b}`);
    for (let b = 0; b < seq.bitsY; b++) if (!doneY[b]) missingBits.push(`y${b}`);
    return {
      w, h, mapU, mapV, valid, filled, coverage: seen / N, decoded,
      contrast: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: sorted[sorted.length - 1], threshold: minContrast },
      resolution: { xCells: 1 << deepestX, yCells: 1 << deepestY, bitsX: seq.bitsX, bitsY: seq.bitsY },
      reach: reachOf(valid, w, h),
      rejects: { contrast: rejContrast, blockX: rejBlockX, blockY: rejBlockY, range: rejRange, used },
      blocks: { maxX: maxBlockX, maxY: maxBlockY },
      // Bits whose pair never completed. A non-empty list means frames were
      // dropped or misattributed, and says exactly which — far more actionable
      // than a flat zero.
      missingBits,
    };
  }

  return { sequence: seq, add, finish };
}

// Per-column and per-row fraction of cells the camera actually resolved.
// A speaker in front of the screen shows up as a column of zeros; an edge out
// of frame shows up as zeros at one end.
function reachOf(valid, w, h) {
  const cols = new Float32Array(w), rows = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (valid[y * w + x]) { cols[x] += 1; rows[y] += 1; }
    }
  }
  for (let x = 0; x < w; x++) cols[x] /= h;
  for (let y = 0; y < h; y++) rows[y] /= w;
  let blind = 0, firstSeen = -1, lastSeen = -1;
  for (let x = 0; x < w; x++) {
    if (cols[x] > 0.02) { if (firstSeen < 0) firstSeen = x; lastSeen = x; }
  }
  for (let x = firstSeen; x >= 0 && x <= lastSeen; x++) if (cols[x] <= 0.02) blind++;
  return {
    cols, rows,
    // Fraction of the screen's width that lies inside what the camera can see
    // at all — the rest is off-frame.
    spanFrac: firstSeen < 0 ? 0 : (lastSeen - firstSeen + 1) / w,
    leftEdge: firstSeen < 0 ? 0 : firstSeen / w,
    rightEdge: lastSeen < 0 ? 0 : (lastSeen + 1) / w,
    // Columns inside that span the camera still could not read: something is
    // standing in front of them.
    blockedFrac: firstSeen < 0 ? 0 : blind / Math.max(1, lastSeen - firstSeen + 1),
  };
}

export function smoothMap(map, radius = 2) {
  const { w, h, mapU, mapV } = map;
  for (const field of [mapU, mapV]) {
    const tmp = Float32Array.from(field);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            s += tmp[yy * w + xx]; c++;
          }
        }
        field[y * w + x] = s / c;
      }
    }
  }
  return map;
}
