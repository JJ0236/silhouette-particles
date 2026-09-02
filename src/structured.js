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

// The block of the axis a decode that dropped `floor` low bits can narrow the
// position to: [start, end), clamped to the axis.
export function blockOf(centre, floor, limit) {
  const block = 1 << floor;
  const start = Math.floor(centre / block) * block;
  return [Math.min(start, limit), Math.min(start + block, limit)];
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

  // A camera pixel that had to drop `floor` low bits has not located a cell:
  // it has located a BLOCK of cells, and it is somewhere in there. The
  // inversion has to honour that. Scattering every such pixel onto the block's
  // centre cell — the previous behaviour — left every other cell in the block
  // untouched, so "coverage" counted one cell in sixty-four on a rig where the
  // camera could plainly see the whole screen, and the wizard's acceptance
  // gate then reported "no patterns decoded" for a decode that was correct to a
  // pixel. On the real wall this sat right on the gate and flipped with focus
  // and noise. Coverage now means what it says: the fraction of the screen
  // some camera pixel was seen to fall within.
  //
  // Positions come from the block CENTROIDS (mean camera position of the
  // pixels in a block), interpolated with a tent kernel one block wide. On a
  // regular lattice of blocks that is exactly bilinear interpolation between
  // centres; where fine and coarse pixels mix, the normalisation makes it a
  // sensible weighted blend rather than a choice.
  function finish({ minContrast = 0.04, fillIters = w + h } = {}) {
    flushHold();   // the last invert hold has no following spec to trigger it

    const N = w * h;
    let rejContrast = 0, rejBlockX = 0, rejBlockY = 0, rejRange = 0, used = 0;
    const maxBlockX = Math.max(2, w * MAX_BLOCK_FRAC);
    const maxBlockY = Math.max(2, h * MAX_BLOCK_FRAC);

    // Bits whose pair never completed are unknown for every pixel, so no floor
    // may sit below them.
    let missX = 0, missY = 0;
    for (let b = 0; b < seq.bitsX; b++) if (!doneX[b]) missX = b + 1;
    for (let b = 0; b < seq.bitsY; b++) if (!doneY[b]) missY = b + 1;

    // Per-pixel decode, kept so the scatter can be decided once every pixel is
    // known. Centre cell, or -1 when the pixel was rejected.
    const pdx = new Int32Array(n).fill(-1), pdy = new Int32Array(n).fill(-1);
    const pfx = new Uint8Array(n), pfy = new Uint8Array(n);
    const histX = new Uint32Array(seq.bitsX + 1), histY = new Uint32Array(seq.bitsY + 1);

    for (let i = 0; i < n; i++) {
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
      pdx[i] = dx; pdy[i] = dy; pfx[i] = fx; pfy[i] = fy;
    }

    // A pixel has to agree with its neighbours. In a dim room the sensor's
    // own noise clears the contrast floor on plenty of pixels that never saw
    // the screen at all, and each of those decodes to a RANDOM cell — one
    // stray pixel lands a block of the map hundreds of pixels away. The
    // screen's pixels, by contrast, decode within a block or so of the pixels
    // beside them, because the surface is continuous. So: reject a pixel
    // whose position is far from the median of its decoded 3x3 neighbours, or
    // that has too few decoded neighbours to judge.
    let rejStray = 0;
    const keep = new Uint8Array(n);
    const nx = [], ny = [];
    for (let i = 0; i < n; i++) {
      if (pdx[i] < 0) continue;
      const cx = i % camW, cy = (i / camW) | 0;
      nx.length = 0; ny.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy; if (yy < 0 || yy >= camH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx; if ((!dx && !dy) || xx < 0 || xx >= camW) continue;
          const j = yy * camW + xx;
          if (pdx[j] >= 0) { nx.push(pdx[j]); ny.push(pdy[j]); }
        }
      }
      if (nx.length < 3) { rejStray++; continue; }
      nx.sort((a, b) => a - b); ny.sort((a, b) => a - b);
      const mx = nx[nx.length >> 1], my = ny[ny.length >> 1];
      // Neighbouring camera pixels are a few cells apart on the screen, plus
      // whatever the block quantisation adds on either side.
      const tolX = 2 * Math.max(4, 1 << pfx[i]) + 4, tolY = 2 * Math.max(4, 1 << pfy[i]) + 4;
      if (Math.abs(pdx[i] - mx) > tolX || Math.abs(pdy[i] - my) > tolY) { rejStray++; continue; }
      keep[i] = 1;
      histX[pfx[i]]++; histY[pfy[i]]++;
      used++;
    }
    for (let i = 0; i < n; i++) if (!keep[i]) pdx[i] = -1;

    // Knots: one per (centre cell, floor pair). Two pixels with different
    // floors can share a centre cell while meaning blocks of different sizes,
    // so the floors are part of the key.
    const knots = new Map();
    for (let i = 0; i < n; i++) {
      if (pdx[i] < 0) continue;
      const key = ((pdy[i] * w + pdx[i]) * 16 + pfx[i]) * 16 + pfy[i];
      let k = knots.get(key);
      if (!k) { k = { x: pdx[i], y: pdy[i], fx: pfx[i], fy: pfy[i], su: 0, sv: 0, c: 0 }; knots.set(key, k); }
      k.su += (i % camW) / (camW - 1);
      k.sv += ((i / camW) | 0) / (camH - 1);
      k.c += 1;
    }

    const wU = new Float32Array(N), wV = new Float32Array(N), wS = new Float32Array(N);
    const valid = new Uint8Array(N);
    for (const k of knots.values()) {
      const [bx0, bx1] = blockOf(k.x, k.fx, w), [by0, by1] = blockOf(k.y, k.fy, h);
      const bw = bx1 - bx0, bh = by1 - by0;
      // The block itself was SEEN.
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) valid[y * w + x] = 1;
      // Tent one block wide about the centroid, weighted by pixels per cell so
      // a coarse knot spread over many cells does not drown a fine one.
      const u = k.su / k.c, v = k.sv / k.c, wt = k.c / (bw * bh);
      const cx = bx0 + (bw - 1) / 2, cy = by0 + (bh - 1) / 2;
      const x0 = Math.max(0, Math.ceil(cx - bw)), x1 = Math.min(w - 1, Math.floor(cx + bw));
      const y0 = Math.max(0, Math.ceil(cy - bh)), y1 = Math.min(h - 1, Math.floor(cy + bh));
      for (let y = y0; y <= y1; y++) {
        const ty = 1 - Math.abs(y - cy) / bh;
        if (ty <= 0) continue;
        for (let x = x0; x <= x1; x++) {
          const tx = 1 - Math.abs(x - cx) / bw;
          if (tx <= 0) continue;
          const d = y * w + x, g = wt * tx * ty;
          wU[d] += u * g; wV[d] += v * g; wS[d] += g;
        }
      }
    }

    const mapU = new Float32Array(N), mapV = new Float32Array(N);
    const filled = new Uint8Array(N);
    let seen = 0;
    for (let d = 0; d < N; d++) {
      if (wS[d] > 0) { mapU[d] = wU[d] / wS[d]; mapV[d] = wV[d] / wS[d]; filled[d] = 1; }
      if (valid[d]) seen++;
    }
    const decoded = used;

    // Typical location block: the floor most pixels settled at, not the worst.
    const medianFloor = (hist, total) => {
      let acc = 0;
      for (let f = 0; f < hist.length; f++) { acc += hist[f]; if (acc * 2 >= total) return f; }
      return 0;
    };
    const deepestX = used ? medianFloor(histX, used) : 0;
    const deepestY = used ? medianFloor(histY, used) : 0;

    // Cells no block reached — off the frame's edge, behind a speaker — take
    // the nearest measured values, iterated until nothing is left. A fixed
    // iteration cap used to leave the far cells at (0,0), the sensor's corner,
    // and the warp then read the wrong part of the room for them.
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
      rejects: { contrast: rejContrast, blockX: rejBlockX, blockY: rejBlockY, range: rejRange, stray: rejStray, used },
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

// Cells the camera never directly saw must not be believed by the detector.
//
// The hole fill gives an unseen cell — behind a speaker, above the frame — the
// camera position of its nearest SEEN neighbour, so the warp has somewhere to
// look. That is right for the warp and wrong for detection: the pixel it looks
// at shows the neighbour's content, the prediction is this cell's content, the
// two disagree whenever the wall is not flat grey, and the disagreement reads
// as a body standing there. On the real wall that drew permanent outlines
// along the top band where the speakers hang. Unseen cells, plus a margin for
// the coarse blocks at their edge, are struck from `observable`.
export function gateUnseen(observable, valid, w, h, margin = 2) {
  let struck = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!observable[i]) continue;
      let unseen = false;
      for (let dy = -margin; dy <= margin && !unseen; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -margin; dx <= margin; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          if (!valid[yy * w + xx]) { unseen = true; break; }
        }
      }
      if (unseen) { observable[i] = 0; struck++; }
    }
  }
  return struck;
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
