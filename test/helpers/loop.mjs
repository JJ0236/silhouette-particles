// The closed loop in Node: detector → renderer → simulated camera → detector.
// Nothing here knows how the detector works; it only wires the contract
// surfaces together and records what a viewer would see.
//
// Frame order: render R_i from the detector's state after frame i−1, push it
// to the ring at t = i·dt, show it to the camera, run the detector on what the
// camera saw. The sim delays by latencyFrames of ITS call index, so the lag the
// detector should assume is exactly latencyFrames × dt.

import { renderFrame, renderPatches } from '../../src/renderG.js';

const OCC_PATH = process.env.OCCLUSION_MODULE ?? '../../src/occlusion.js';

async function tryImport(spec) {
  try { return await import(spec); } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw e;
  }
}

export const occlusion = await tryImport(OCC_PATH);
export const photometric = await tryImport('../../src/photometric.js');
export const frames = await tryImport('../../src/frames.js');
export const morph = await tryImport('../../src/morph.js');
export const available = !!(occlusion && photometric && frames && morph);
export const missing = [['occlusion', occlusion], ['photometric', photometric], ['frames', frames], ['morph', morph]]
  .filter(([, m]) => !m).map(([n]) => n);

// Least-squares slope of a series against its index: the sign says whether
// coverage is creeping up over a soak.
export function trendSlope(arr, from = 0) {
  const n = arr.length - from;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let k = 0; k < n; k++) { const x = k, y = arr[from + k]; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

export function iouOf(bin, truth, thresh = 0.5) {
  let inter = 0, uni = 0;
  for (let i = 0; i < bin.length; i++) {
    const a = bin[i] > 0, b = truth ? truth[i] >= thresh : false;
    if (a && b) inter++;
    if (a || b) uni++;
  }
  return uni === 0 ? 1 : inter / uni;
}

// occluder ∪ its cast shadow: what the camera can actually see of a person.
export function shadowUnion(occ, w, h, [sx, sy], out) {
  sx = Math.round(sx); sy = Math.round(sy);
  if (!out) out = new Float32Array(occ.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let v = occ[i];
    const xs = x - sx, ys = y - sy;
    if (xs >= 0 && xs < w && ys >= 0 && ys < h) v = Math.max(v, occ[ys * w + xs]);
    out[i] = v;
  }
  return out;
}

export function dilateBin(src, w, h, r) {
  const dst = new Uint8Array(src.length), tmp = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = -r; k <= r; k++) { const xx = Math.min(w - 1, Math.max(0, x + k)); if (src[y * w + xx]) { m = 1; break; } }
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = -r; k <= r; k++) { const yy = Math.min(h - 1, Math.max(0, y + k)); if (tmp[yy * w + x]) { m = 1; break; } }
    dst[y * w + x] = m;
  }
  return dst;
}

export function erodeBin(src, w, h, r) {
  const inv = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) inv[i] = src[i] ? 0 : 1;
  const d = dilateBin(inv, w, h, r);
  for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

export const toBin = (f, thresh = 0.5) => { const b = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) b[i] = f[i] >= thresh ? 1 : 0; return b; };

export async function runLoop({
  occlusion: occ, sim, photo, ring, occluderFn = null, frames: count = 300, settings, particles = null,
  lagMs, dtMs = 33.3, onFrame = null, rimFn = null, presence = 1, keepBins = false, prefill = 8,
}) {
  const { w, h } = sim.params;
  const N = w * h;
  lagMs = lagMs ?? sim.params.latencyFrames * dtMs;
  const R = new Uint8Array(N * 3);
  const obs = new Uint8Array(N * 3);
  const coverage = new Float32Array(count);
  const iou = new Float32Array(count);
  const iouUnion = new Float32Array(count);
  const falseCov = new Float32Array(count);
  const bins = keepBins ? [] : null;
  const shadow = sim.params.shadowShift;
  const hasShadow = Math.round(shadow[0]) !== 0 || Math.round(shadow[1]) !== 0;
  const union = new Float32Array(N);

  const partsAt = (i) => (typeof particles === 'function' ? particles(i) : particles);
  const rimAt = (i) => (rimFn ? rimFn(i, occ) : occ.rim);

  // Before frame 0 the wall was already showing frame 0's content.
  renderFrame({ rim: rimAt(0), particles: partsAt(0), presence, settings, w, h }, R);
  for (let k = prefill; k >= 1; k--) ring.push(R, -k * dtMs);

  for (let i = 0; i < count; i++) {
    const t = i * dtMs;
    const occluder = occluderFn ? occluderFn(i) : null;
    renderFrame({ rim: rimAt(i), particles: partsAt(i), presence, settings, w, h }, R);
    ring.push(R, t);
    sim.observe(R, occluder, i, obs);
    occ.update({ obs, tCam: t, ring, photo, lagMs });
    coverage[i] = occ.coverage;
    iou[i] = iouOf(occ.bin, occluder);
    let truth = occluder;
    if (occluder && hasShadow) truth = shadowUnion(occluder, w, h, shadow, union);
    iouUnion[i] = iouOf(occ.bin, truth);
    // Fraction of the frame flagged where nothing (body or shadow) is.
    let fp = 0;
    for (let c = 0; c < N; c++) if (occ.bin[c] && !(truth && truth[c] >= 0.5)) fp++;
    falseCov[i] = fp / N;
    if (bins) bins.push(new Uint8Array(occ.bin));
    if (onFrame) await onFrame({ i, t, occluder, truth, obs, R, occlusion: occ });
  }
  return { coverage, iou, iouUnion, falseCov, bins, lastBin: new Uint8Array(occ.bin) };
}

// Run the photometric calibration THROUGH the simulated camera, the way the
// wizard would on the rig, honouring the sim's latency: an observation is
// accumulated against the spec that was on the wall when it was exposed, and
// only when the whole exposure (fractional latency, jitter and all) lay inside
// one hold of the sequence. The photo is therefore consistent with the sim but
// measured, not copied — the closed loop is not testing the sim against itself.
export async function calibrateThroughSim(sim, w, h, {
  cols = 8, rows = 8, litPerFrame = 4, whiteCycles = 2, levels, levelCycles = 1, holdFrames, minRange,
} = {}) {
  if (!photometric) throw new Error('photometric.js is not available');
  const { patchLayout, calibrationSequence, createAccumulator, LEVELS17 } = photometric;
  const { latencyFrames: L, latencyJitter: J } = sim.params;
  const lo = Math.floor(-(L + J)), hi = Math.ceil(-(L - J));     // displayed index offsets
  const hold = holdFrames ?? Math.max(2, hi - lo + 2);
  const layout = patchLayout({ cols, rows, w, h });
  const seq = calibrationSequence({ layout, litPerFrame, holdFrames: hold, whiteCycles, levels: levels ?? LEVELS17, levelCycles });
  const acc = createAccumulator(layout, w * h);
  const R = new Uint8Array(w * h * 3), obs = new Uint8Array(w * h * 3);
  const black = { lit: [], level: 0, phase: 'white', settle: false };
  const tail = Math.ceil(L + J) + 2;
  sim.reset?.();
  for (let i = 0; i < seq.length + tail; i++) {
    renderPatches(layout, i < seq.length ? seq.frame(i) : black, R);
    sim.observe(R, null, i, obs);
    const jHi = i + hi, jLo = i + lo;
    if (jHi < 0 || jHi >= seq.length || jLo < 0) continue;
    if (Math.floor(jLo / hold) !== Math.floor(jHi / hold)) continue;
    if (jHi % hold !== hold - 1) continue;
    acc.add(seq.frame(jHi), obs);
  }
  const photo = acc.finish(minRange != null ? { minRange } : undefined);
  photo.meta = { ...(photo.meta ?? {}), source: 'simcam', latencyFrames: L, holdFrames: hold };
  return photo;
}

// A synthetic, perfectly known photo for property tests that must not depend
// on a calibration run: D, W flat, response a 2.2 gamma.
export function makePhoto(w, h, { D = 20, Wc = 200, sigma = 1, gamma = 2.2 } = {}) {
  const N = w * h;
  const photo = {
    w, h,
    D: new Float32Array(N * 3).fill(D), W: new Float32Array(N * 3).fill(Wc),
    sigmaD: new Float32Array(N).fill(sigma), lut: new Float32Array(3 * 256),
    observable: new Uint8Array(N).fill(1), meta: { source: 'synthetic' },
  };
  for (let ch = 0; ch < 3; ch++) for (let c = 0; c < 256; c++) photo.lut[ch * 256 + c] = Math.pow(c / 255, gamma);
  return photo;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(rand) {
  const u1 = Math.max(rand(), 1e-12), u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
