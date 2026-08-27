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

export const bitsFor = (n) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
export const grayEncode = (x) => x ^ (x >> 1);

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
  const okX = new Uint8Array(n).fill(1), okY = new Uint8Array(n).fill(1);
  // Contrast measured from the pattern PAIRS, not from white/black.
  //
  // A full-white frame and a full-black frame are exactly the two the camera's
  // auto-exposure fights hardest: it stops down on one and opens up on the
  // other, so both come back at similar brightness and their difference — the
  // thing being used to decide whether a pixel can see the screen at all —
  // collapses. Measured on a real rig it left about 1% of the screen usable.
  //
  // A pattern and its inverse have identical average brightness, so AE cannot
  // tell them apart and cannot flatten the difference between them. The largest
  // swing a pixel shows across all such pairs is therefore an AE-proof measure
  // of how well that pixel sees the display.
  const swing = new Float32Array(n);
  const pending = new Float32Array(n);
  let havePending = false, pendingSpec = null;

  function add(spec, camLuma) {
    if (spec.kind === 'white') { white.set(camLuma); return; }
    if (spec.kind === 'black') { black.set(camLuma); return; }
    if (!spec.invert) { pending.set(camLuma); pendingSpec = spec; havePending = true; return; }
    if (!havePending || pendingSpec.kind !== spec.kind || pendingSpec.bit !== spec.bit) return;
    havePending = false;
    const code = spec.kind === 'x' ? codeX : codeY;
    const ok = spec.kind === 'x' ? okX : okY;
    for (let i = 0; i < n; i++) {
      const a = pending[i], b = camLuma[i];
      const d = a - b, ad = d < 0 ? -d : d;
      if (ad > swing[i]) swing[i] = ad;
      // A bit too close to call is marked unusable rather than guessed — one
      // wrong bit is one wrong address. The threshold is relative to what this
      // pixel has already shown it can swing, so a dim corner of a curved
      // screen is judged by its own standard rather than the bright centre's.
      if (ad < Math.max(MIN_BIT_SWING, swing[i] * BIT_FRACTION)) { ok[i] = 0; continue; }
      if (d > 0) code[i] |= 1 << spec.bit;
    }
  }

  function finish({ minContrast = 0.04, fillIters = 24 } = {}) {
    const N = w * h;
    const sumU = new Float32Array(N), sumV = new Float32Array(N), cnt = new Float32Array(N);
    let decoded = 0;
    for (let cy = 0; cy < camH; cy++) {
      for (let cx = 0; cx < camW; cx++) {
        const i = cy * camW + cx;
        // Below this the pixel never responded to the patterns: off the screen,
        // deep in shadow, or an edge so oblique the camera gets nothing. Judged
        // on the pattern pairs, which auto-exposure cannot flatten.
        if (swing[i] < minContrast) continue;
        if (!okX[i] || !okY[i]) continue;
        const dx = grayDecode(codeX[i], seq.bitsX);
        const dy = grayDecode(codeY[i], seq.bitsY);
        if (dx < 0 || dx >= w || dy < 0 || dy >= h) continue;
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

    // Cells no camera pixel happened to land on are filled from their
    // neighbours. The mapping is smooth by construction — it is a physical
    // surface — so averaging known neighbours is the honest reconstruction, and
    // it converges outward from the measured region.
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

    // Report the contrast distribution: if coverage is poor this says whether
    // the camera saw nothing at all, or saw plenty and failed to decode it.
    const sorted = Float32Array.from(swing).sort();
    const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
    return {
      w, h, mapU, mapV, valid, filled, coverage: seen / N, decoded,
      contrast: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: sorted[sorted.length - 1], threshold: minContrast },
    };
  }

  return { sequence: seq, add, finish };
}

// Smooth the measured map. Decoding is quantised to whole display cells, so the
// raw correspondence is stair-stepped; the real surface is not.
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
