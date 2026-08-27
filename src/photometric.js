// Photometric calibration: a per-cell model of what the camera reads for what we
// render, obs = D + (W − D) · lut[render]. Safari exposes no exposure lock, so the
// calibration is a constant-APL patch sequence: the same number of patches is lit
// on every frame and the accumulator normalises each frame by the exposure it can
// see in that frame's *unlit* cells. D, W, σ_D and the response LUT therefore all
// come out in one shared exposure reference (that of the first accumulated frame).
// Pure module: no DOM, no Date.now, no Math.random.

import { boxBlur } from './field.js';

export const LEVELS17 = Object.freeze([0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255]);

const SERIAL_VERSION = 1;
const DEFAULT_MIN_RANGE = 12;

// ---------------------------------------------------------------------------
// Layout

export function patchLayout({ cols = 8, rows = 8, w = 480, h = 270 } = {}) {
  const N = w * h;
  const count = cols * rows;
  const patchOf = new Int16Array(N);
  const sizes = new Int32Array(count);
  for (let y = 0; y < h; y++) {
    const r = Math.floor((y * rows) / h);
    for (let x = 0; x < w; x++) {
      const p = r * cols + Math.floor((x * cols) / w);
      patchOf[y * w + x] = p;
      sizes[p]++;
    }
  }
  const cells = new Array(count);
  const fill = new Int32Array(count);
  for (let p = 0; p < count; p++) cells[p] = new Int32Array(sizes[p]);
  for (let i = 0; i < N; i++) {
    const p = patchOf[i];
    cells[p][fill[p]++] = i;
  }
  return { count, cells, patchOf, cols, rows, w, h };
}

// ---------------------------------------------------------------------------
// Sequence

// Partition the patch grid into groups of `k` patches that are as far apart as
// possible. When the group count factors into (a | rows) × (b | cols) the groups
// are residue classes (r mod a, c mod b): members are a rows / b columns apart,
// so never 8-adjacent whenever a, b ≥ 2. Otherwise a greedy max–min dispersion
// fill is used, which keeps patches apart "when possible".
function spreadGroups(rows, cols, k) {
  const count = rows * cols;
  k = Math.max(1, Math.min(k | 0, count));
  if (count % k === 0) {
    const G = count / k;
    let best = null;
    for (let a = 1; a <= rows; a++) {
      if (rows % a !== 0 || G % a !== 0) continue;
      const b = G / a;
      if (cols % b !== 0) continue;
      const score = Math.min(a, b) * 1000 - Math.abs(a - b);
      if (!best || score > best.score) best = { a, b, score };
    }
    if (best) {
      const { a, b } = best;
      const groups = Array.from({ length: G }, () => []);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) groups[(r % a) * b + (c % b)].push(r * cols + c);
      return groups;
    }
  }
  const free = new Uint8Array(count).fill(1);
  const groups = [];
  let remaining = count;
  while (remaining > 0) {
    const g = [];
    let seed = 0;
    while (!free[seed]) seed++;
    g.push(seed); free[seed] = 0; remaining--;
    while (g.length < k && remaining > 0) {
      let bestP = -1, bestD = -1;
      for (let p = 0; p < count; p++) {
        if (!free[p]) continue;
        const pr = Math.floor(p / cols), pc = p % cols;
        let dmin = Infinity;
        for (const q of g) {
          const d = Math.max(Math.abs(pr - Math.floor(q / cols)), Math.abs(pc - (q % cols)));
          if (d < dmin) dmin = d;
        }
        if (dmin > bestD) { bestD = dmin; bestP = p; }
      }
      g.push(bestP); free[bestP] = 0; remaining--;
    }
    groups.push(g);
  }
  return groups;
}

export function calibrationSequence({ layout, litPerFrame = 4, holdFrames = 2,
                                      whiteCycles = 3, levels = LEVELS17, levelCycles = 1 } = {}) {
  const rows = layout.rows ?? 8;
  const cols = layout.cols ?? Math.round(layout.count / rows);
  const groups = spreadGroups(rows, cols, litPerFrame);
  const G = groups.length;
  holdFrames = Math.max(1, holdFrames | 0);
  whiteCycles = Math.max(0, whiteCycles | 0);
  levelCycles = Math.max(0, levelCycles | 0);
  const lv = Array.from(levels, (v) => Math.max(0, Math.min(255, Math.round(v))));
  // Steps: white phase first so every cell has a W estimate before any stair
  // frame is accumulated; then level-major stair phase.
  const whiteSteps = whiteCycles * G;
  const stairSteps = lv.length * levelCycles * G;
  const length = (whiteSteps + stairSteps) * holdFrames;

  function frame(i) {
    if (i < 0 || i >= length) throw new RangeError(`frame ${i} outside sequence of ${length}`);
    const step = Math.floor(i / holdFrames);
    const settle = i % holdFrames === 0;
    if (step < whiteSteps) {
      return { lit: groups[step % G].slice(), level: 255, phase: 'white', settle };
    }
    const s = step - whiteSteps;
    const levelIdx = Math.floor(s / (levelCycles * G));
    return { lit: groups[s % G].slice(), level: lv[levelIdx], phase: 'stair', settle };
  }

  return { length, frame, groups, holdFrames };
}

// ---------------------------------------------------------------------------
// Accumulator

const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export function createAccumulator(layout, N) {
  const { count, cells, w, h } = layout;
  if (N == null) N = layout.patchOf.length;
  // Dark statistics per cell: RGB sums for D, luma sum/sumsq for σ_D.
  const dSum = new Float64Array(N * 3);
  const dCnt = new Uint32Array(N);
  const ySum = new Float64Array(N);
  const ySq = new Float64Array(N);
  // White statistics per cell.
  const wSum = new Float64Array(N * 3);
  const wCnt = new Uint32Array(N);
  // Per-level, per-channel response sums (global).
  const levelIdx = new Map();
  const rSum = [];   // [levelIndex] → Float64Array(3)
  const rCnt = [];
  const litFlag = new Uint8Array(count);
  let frames = 0, skipped = 0;

  // Exposure of this frame relative to the accumulated dark reference: the
  // unlit cells were rendered black on every frame, so the only reason their
  // reading differs from the running D is the camera's auto-exposure (and AWB,
  // which is why the gain is per channel). Only cells that already hold dark
  // samples take part so the two sums cover the same pixels.
  function frameGain(obs, g) {
    const so = [0, 0, 0], sd = [0, 0, 0];
    for (let p = 0; p < count; p++) {
      if (litFlag[p]) continue;
      const cs = cells[p];
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k];
        const n = dCnt[c];
        if (n === 0) continue;
        const i3 = c * 3;
        so[0] += obs[i3]; so[1] += obs[i3 + 1]; so[2] += obs[i3 + 2];
        sd[0] += dSum[i3] / n; sd[1] += dSum[i3 + 1] / n; sd[2] += dSum[i3 + 2] / n;
      }
    }
    for (let ch = 0; ch < 3; ch++) {
      // A projector black of well under a code per cell gives no leverage on
      // the exposure; fall back to unity rather than divide by noise.
      g[ch] = sd[ch] > 0.5 && so[ch] > 0 ? so[ch] / sd[ch] : 1;
    }
    return g;
  }

  const g = [1, 1, 1];

  function add(spec, obs) {
    if (!spec || spec.settle) { skipped++; return; }
    litFlag.fill(0);
    for (const p of spec.lit) if (p >= 0 && p < count) litFlag[p] = 1;
    frameGain(obs, g);
    const level = spec.level;
    frames++;

    // Unlit cells → dark samples in the reference exposure.
    for (let p = 0; p < count; p++) {
      if (litFlag[p]) continue;
      const cs = cells[p];
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k], i3 = c * 3;
        const r = obs[i3] / g[0], gg = obs[i3 + 1] / g[1], b = obs[i3 + 2] / g[2];
        dSum[i3] += r; dSum[i3 + 1] += gg; dSum[i3 + 2] += b;
        dCnt[c]++;
        const y = lumaOf(r, gg, b);
        ySum[c] += y; ySq[c] += y * y;
      }
    }

    // Lit cells → white samples and/or response samples. The response uses the
    // running D and W of the same cell, which the white phase has already
    // populated by the time the stair phase begins.
    const isStair = spec.phase === 'stair';
    let li = -1, rs = null, rc = null;
    if (isStair) {
      li = levelIdx.get(level);
      if (li === undefined) {
        li = rSum.length;
        levelIdx.set(level, li);
        rSum.push(new Float64Array(3));
        rCnt.push(new Float64Array(3));
      }
      rs = rSum[li]; rc = rCnt[li];
    }
    for (let p = 0; p < count; p++) {
      if (!litFlag[p]) continue;
      const cs = cells[p];
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k], i3 = c * 3;
        const nd = dCnt[c], nw = wCnt[c];
        if (isStair && nd > 0 && nw > 0) {
          for (let ch = 0; ch < 3; ch++) {
            const d = dSum[i3 + ch] / nd, wv = wSum[i3 + ch] / nw;
            const range = wv - d;
            if (range <= 1e-3) continue;
            rs[ch] += (obs[i3 + ch] / g[ch] - d) / range;
            rc[ch] += 1;
          }
        }
        if (level === 255) {
          wSum[i3] += obs[i3] / g[0]; wSum[i3 + 1] += obs[i3 + 1] / g[1]; wSum[i3 + 2] += obs[i3 + 2] / g[2];
          wCnt[c]++;
        }
      }
    }
  }

  // Low-pass the flat-field maps to erase the patch grid.
  //
  // A projector's black level and white level across a wall are SMOOTH fields —
  // lamp falloff, lens vignetting, viewing angle. Nothing physical varies at the
  // size of a calibration patch. But each patch is measured at a different
  // moment under a different auto-exposure state, so residual per-patch scale
  // error survives the per-frame normalisation and lands in D and W as a visible
  // 8x8 grid. That grid then appears in every prediction, and therefore in every
  // ratio, as cross-hatched blocks.
  //
  // Smoothing at roughly the patch pitch removes exactly that frequency and
  // keeps the genuine falloff, which is far lower frequency. Radius 0 disables
  // it for tests that need the raw measurement.
  function smoothField(field, planes, radius) {
    if (radius <= 0) return field;
    const src = new Float32Array(N), dst = new Float32Array(N), tmp = new Float32Array(N);
    for (let ch = 0; ch < planes; ch++) {
      for (let c = 0; c < N; c++) src[c] = field[c * planes + ch];
      boxBlur(src, dst, w, h, radius, tmp);
      for (let c = 0; c < N; c++) field[c * planes + ch] = dst[c];
    }
    return field;
  }

  function finish({ minRange = DEFAULT_MIN_RANGE, smoothRadius } = {}) {
    const D = new Float32Array(N * 3);
    const Wm = new Float32Array(N * 3);
    const sigmaD = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      const i3 = c * 3, nd = dCnt[c], nw = wCnt[c];
      if (nd > 0) {
        D[i3] = dSum[i3] / nd; D[i3 + 1] = dSum[i3 + 1] / nd; D[i3 + 2] = dSum[i3 + 2] / nd;
        if (nd > 1) {
          const m = ySum[c] / nd;
          const v = (ySq[c] / nd - m * m) * (nd / (nd - 1));
          sigmaD[c] = v > 0 ? Math.sqrt(v) : 0;
        }
      }
      if (nw > 0) {
        Wm[i3] = wSum[i3] / nw; Wm[i3 + 1] = wSum[i3 + 1] / nw; Wm[i3 + 2] = wSum[i3 + 2] / nw;
      } else {
        // No white sample: no range, cell becomes unobservable.
        Wm[i3] = D[i3]; Wm[i3 + 1] = D[i3 + 1]; Wm[i3 + 2] = D[i3 + 2];
      }
    }
    const lut = new Float32Array(3 * 256);
    const levels = [...levelIdx.keys()];
    for (let ch = 0; ch < 3; ch++) {
      const ls = [], rs = [];
      for (const lv of levels) {
        const li = levelIdx.get(lv);
        if (rCnt[li][ch] > 0) { ls.push(lv); rs.push(rSum[li][ch] / rCnt[li][ch]); }
      }
      lut.set(fitLut(ls, rs), ch * 256);
    }
    // Default to roughly half a patch pitch: wide enough to average a patch
    // boundary away, narrow enough to keep real falloff.
    const rad = smoothRadius === undefined
      ? Math.max(2, Math.round(Math.min(w / layout.cols, h / layout.rows) * 0.5))
      : smoothRadius;
    smoothField(D, 3, rad);
    smoothField(Wm, 3, rad);
    smoothField(sigmaD, 1, rad);

    const photo = { w, h, D, W: Wm, sigmaD, lut, observable: new Uint8Array(N),
                    meta: { frames, skipped, smoothRadius: rad,
                            levels: levels.slice().sort((a, b) => a - b) } };
    observable(photo, minRange);
    return photo;
  }

  return { add, finish };
}

// ---------------------------------------------------------------------------
// LUT fit: isotonic regression (pool-adjacent-violators) over (level, response),
// linear interpolation to 256 codes, normalised so lut[0] = 0 and lut[255] = 1.

export function fitLut(levels, responses) {
  const out = new Float32Array(256);
  // Merge duplicate levels by averaging, then sort by level.
  const byLevel = new Map();
  const n = Math.min(levels?.length ?? 0, responses?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const x = Math.round(levels[i]), y = responses[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const e = byLevel.get(x);
    if (e) { e.s += y; e.c++; } else byLevel.set(x, { s: y, c: 1 });
  }
  const xs = [...byLevel.keys()].sort((a, b) => a - b);
  if (xs.length < 2) {
    for (let i = 0; i < 256; i++) out[i] = i / 255;
    return out;
  }
  // PAVA with block weights = number of merged samples.
  const bx = [], by = [], bw = [], bn = [];   // start x, mean y, weight, block size in points
  const px = xs, py = xs.map((x) => byLevel.get(x).s / byLevel.get(x).c), pw = xs.map((x) => byLevel.get(x).c);
  for (let i = 0; i < px.length; i++) {
    bx.push(i); by.push(py[i]); bw.push(pw[i]); bn.push(1);
    while (bx.length > 1 && by[bx.length - 2] > by[bx.length - 1]) {
      const j = bx.length - 1;
      const wsum = bw[j - 1] + bw[j];
      by[j - 1] = (by[j - 1] * bw[j - 1] + by[j] * bw[j]) / wsum;
      bw[j - 1] = wsum; bn[j - 1] += bn[j];
      bx.pop(); by.pop(); bw.pop(); bn.pop();
    }
  }
  const fit = new Float64Array(px.length);
  for (let b = 0, k = 0; b < bx.length; b++) for (let m = 0; m < bn[b]; m++) fit[k++] = by[b];
  // Interpolate to 256 codes, flat beyond the sampled range.
  const raw = new Float64Array(256);
  let j = 0;
  for (let c = 0; c < 256; c++) {
    if (c <= px[0]) { raw[c] = fit[0]; continue; }
    if (c >= px[px.length - 1]) { raw[c] = fit[px.length - 1]; continue; }
    while (px[j + 1] < c) j++;
    const t = (c - px[j]) / (px[j + 1] - px[j]);
    raw[c] = fit[j] + (fit[j + 1] - fit[j]) * t;
  }
  const lo = raw[0], span = raw[255] - raw[0];
  if (!(span > 1e-9)) {
    for (let i = 0; i < 256; i++) out[i] = i / 255;
    return out;
  }
  for (let c = 0; c < 256; c++) {
    const v = (raw[c] - lo) / span;
    out[c] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  out[0] = 0; out[255] = 1;
  return out;
}

// ---------------------------------------------------------------------------
// Prediction

export function predictLow(photo, Rlow, beta, out) {
  const { D, W: Wm, lut } = photo;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const ch = i % 3;
    out[i] = D[i] + beta * (Wm[i] - D[i]) * lut[ch * 256 + Rlow[i]];
  }
  return out;
}

export function predictHigh(photo, Rhigh, beta, out) {
  const { D, W: Wm, lut } = photo;
  const inv = beta > 0 ? 1 / beta : 1;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const ch = i % 3;
    const v = D[i] + inv * (Wm[i] - D[i]) * lut[ch * 256 + Rhigh[i]];
    out[i] = v > 255 ? 255 : v;
  }
  return out;
}

// Marks cells whose white-minus-dark luma range is large enough to carry
// occlusion evidence; writes into photo.observable (or `out`) and returns it.
export function observable(photo, minRange = DEFAULT_MIN_RANGE, out = photo.observable) {
  const { D, W: Wm } = photo;
  const N = out.length;
  for (let c = 0; c < N; c++) {
    const i3 = c * 3;
    const dy = lumaOf(Wm[i3] - D[i3], Wm[i3 + 1] - D[i3 + 1], Wm[i3 + 2] - D[i3 + 2]);
    out[c] = dy >= minRange ? 1 : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence. Float arrays go out as plain arrays rounded to a fixed number of
// decimals (2 for code-unit maps, 5 for the LUT); the meta block carries the
// identity the calibration is only valid for.

function roundArray(arr, decimals) {
  const k = 10 ** decimals;
  const a = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) a[i] = Math.round(arr[i] * k) / k;
  return a;
}

export function serialize(photo, meta = {}) {
  const m = { ...(photo.meta ?? {}), ...meta, w: photo.w, h: photo.h };
  return JSON.stringify({
    version: SERIAL_VERSION,
    w: photo.w, h: photo.h,
    meta: m,
    D: roundArray(photo.D, 2),
    W: roundArray(photo.W, 2),
    sigmaD: roundArray(photo.sigmaD, 2),
    lut: roundArray(photo.lut, 5),
    observable: Array.from(photo.observable),
  });
}

export function deserialize(json, expectMeta = {}) {
  let obj;
  try { obj = JSON.parse(json); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.version !== SERIAL_VERSION) return null;
  const meta = obj.meta;
  if (!meta || typeof meta !== 'object') return null;
  const w = obj.w | 0, h = obj.h | 0;
  if (!(w > 0 && h > 0) || meta.w !== w || meta.h !== h) return null;
  // Every key the caller states an expectation for (quadHash, deviceId, w, h,
  // mirror, …) must match exactly; a calibration is only valid for the camera,
  // quad and orientation it was measured on.
  for (const k of Object.keys(expectMeta)) if (meta[k] !== expectMeta[k]) return null;
  const N = w * h;
  const arr = (v, len) => (Array.isArray(v) && v.length === len && v.every(Number.isFinite) ? v : null);
  const D = arr(obj.D, N * 3), Wm = arr(obj.W, N * 3), sigmaD = arr(obj.sigmaD, N),
        lut = arr(obj.lut, 768), obs = arr(obj.observable, N);
  if (!D || !Wm || !sigmaD || !lut || !obs) return null;
  const photo = {
    w, h,
    D: Float32Array.from(D), W: Float32Array.from(Wm), sigmaD: Float32Array.from(sigmaD),
    lut: Float32Array.from(lut), observable: Uint8Array.from(obs, (v) => (v ? 1 : 0)),
    meta: { ...meta },
  };
  for (let ch = 0; ch < 3; ch++) { photo.lut[ch * 256] = 0; photo.lut[ch * 256 + 255] = 1; }
  return photo;
}
