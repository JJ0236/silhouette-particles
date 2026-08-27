// An independent physical model of projector + wall + viewer + camera.
//
// This exists so the closed-loop tests are not a tautology. The detector in
// occlusion.js predicts the camera from a photometric fit; this module never
// sees that fit. It works in linear light from first principles — projector
// gamma, black level, latency as a blend of two past frames, a body that is
// closer to the projector than the wall, a cast shadow that lands elsewhere,
// lens glare, sensor bands, then a camera curve with pedestal, white balance,
// gain, noise and quantisation. If the detector is right for the wrong
// reasons, the ADVERSARIAL preset is meant to find out.
//
// Pure: no DOM, no Date.now, no Math.random. Noise is a PRNG re-seeded from
// (seed, frame index) so observe(i) is a function of its inputs alone.

import { boxBlur } from './field.js';

const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const UNITY = Object.freeze([1, 1, 1]);
const one = () => 1;
const unity = () => UNITY;
const zero = () => 0;

export const IDEAL = Object.freeze({
  w: 480, h: 270,
  wallAlbedo: 0.8,
  dark: [0.003, 0.003, 0.003],
  white: [1, 1, 1],
  gammaProj: 2.2, gammaCam: 2.2, pedestal: 0, gain: 1,
  latencyFrames: 3, latencyJitter: 0,
  gainFn: one, awbFn: unity, ambientFn: zero,
  noiseSigma: 0, seed: 1,
  bodyAlbedo: 0.3, bodyK: 2,
  shadowShift: [0, 0], contentShift: [0, 0], misreg: [0, 0],
  blurRadius: 0,
  irisFn: one,
  bandsFn: one,
  glare: { radius: 0, gain: 0 },
});

// Everything the rig could plausibly get wrong, at once. AWB drifts ±10% in
// opposite directions on R and B over ~230 frames; the bands flicker ±8% on
// rows 60–90 like a rolling-shutter beat against a DLP colour wheel.
export const ADVERSARIAL = Object.freeze({
  ...IDEAL,
  gammaProj: 2.4, gammaCam: 1.8, pedestal: 12,
  latencyFrames: 3.4, latencyJitter: 0.5,
  misreg: [0.7, 0.9], contentShift: [4, 2], shadowShift: [6, 3],
  awbFn: (i) => { const d = 0.1 * Math.sin(i / 37); return [1 + d, 1, 1 - d]; },
  noiseSigma: 3, seed: 7,
  irisFn: (apl) => (apl < 0.05 ? 0.6 : 1),
  bandsFn: (i, row) => (row >= 60 && row <= 90 ? 1 + 0.08 * Math.sin(i * 0.9) : 1),
  glare: { radius: 4, gain: 0.05 },
});

// Average picture level of a rendered frame, 0..1 in code units. Projectors
// with a dynamic iris key their dimming off this, so irisFn receives it.
export function apl(R) {
  let s = 0;
  for (let i = 0; i < R.length; i++) s += R[i];
  return s / (R.length * 255);
}

// --- deterministic noise -----------------------------------------------------

function hashSeed(seed, i) {
  let h = (seed | 0) ^ Math.imul(i | 0, 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(a) {
  a >>>= 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianSource(rand) {
  let spare = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    const u1 = Math.max(rand(), 1e-12), u2 = rand();
    const m = Math.sqrt(-2 * Math.log(u1));
    spare = m * Math.sin(2 * Math.PI * u2);
    return m * Math.cos(2 * Math.PI * u2);
  };
}

// --- the camera --------------------------------------------------------------

export function createSimCamera(params = {}) {
  const p = { ...IDEAL, ...params };
  p.glare = { ...IDEAL.glare, ...(params.glare ?? {}) };
  const { w, h } = p;
  const N = w * h, N3 = N * 3;
  const glareRadius = Math.max(0, Math.round(p.glare.radius));
  const glareGain = p.glare.gain;

  // Projector transfer: code → linear light per channel, black level separate.
  const lutP = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let ch = 0; ch < 3; ch++) {
    for (let c = 0; c < 256; c++) lutP[ch][c] = p.white[ch] * Math.pow(c / 255, p.gammaProj);
  }

  // The projector's frame queue. Slot = index mod E; `minIdx..maxIdx` are the
  // indices still held. Enough entries for the longest latency plus one frame
  // of blend partner, with slack.
  const E = Math.max(4, Math.ceil(p.latencyFrames + p.latencyJitter) + 3);
  const bufs = new Array(E);
  const aplOf = new Float64Array(E);
  for (let s = 0; s < E; s++) bufs[s] = new Uint8Array(N3);
  let minIdx = 0, maxIdx = -1, primed = false;
  const slot = (j) => ((j % E) + E) % E;

  function store(R, i) {
    if (!primed) {
      // Before the first frame the projector was already showing "this" —
      // the harness starts from a settled state, not a black flash.
      for (let k = 0; k < E; k++) { const s = slot(i - k); bufs[s].set(R); aplOf[s] = apl(R); }
      minIdx = i - E + 1; maxIdx = i; primed = true;
      return;
    }
    // A skipped index means the projector kept showing the previous frame.
    for (let j = maxIdx + 1; j < i; j++) {
      const prev = bufs[slot(j - 1)]; const s = slot(j);
      bufs[s].set(prev); aplOf[s] = aplOf[slot(j - 1)];
    }
    const s = slot(i);
    bufs[s].set(R); aplOf[s] = apl(R);
    maxIdx = Math.max(maxIdx, i);
    minIdx = Math.max(minIdx, maxIdx - E + 1);
  }
  const frameAt = (j) => bufs[slot(j < minIdx ? minIdx : j > maxIdx ? maxIdx : j)];
  const aplAt = (j) => aplOf[slot(j < minIdx ? minIdx : j > maxIdx ? maxIdx : j)];

  const proj = new Float32Array(N3);
  const proj2 = new Float32Array(N3);
  const lin = new Float32Array(N3);
  const planeA = new Float32Array(N), planeB = new Float32Array(N), planeT = new Float32Array(N);
  const halo = new Float32Array(N);

  const [mx, my] = p.misreg;
  const hasMisreg = mx !== 0 || my !== 0;
  const [sx, sy] = p.shadowShift.map(Math.round);
  const hasShadow = sx !== 0 || sy !== 0;
  const [cx, cy] = p.contentShift.map(Math.round);
  const hasContentShift = cx !== 0 || cy !== 0;
  const invGam = 1 / p.gammaCam;
  const span = 255 - p.pedestal;

  function projectorOutput(i, dst) {
    // Fractional latency: the camera's exposure straddles two projector
    // frames, so it integrates a blend of them — in linear light, not code.
    const L = Math.max(0, p.latencyFrames + p.latencyJitter * Math.sin(i * 0.7));
    const jf = i - L, j0 = Math.floor(jf), f = jf - j0;
    const A = frameAt(j0), B = f > 1e-6 ? frameAt(j0 + 1) : A;
    const iris = p.irisFn((1 - f) * aplAt(j0) + f * aplAt(j0 + 1));
    const fa = (1 - f) * iris, fb = f * iris;
    const l0 = lutP[0], l1 = lutP[1], l2 = lutP[2];
    for (let k = 0; k < N3; k += 3) {
      dst[k]     = fa * l0[A[k]]     + fb * l0[B[k]];
      dst[k + 1] = fa * l1[A[k + 1]] + fb * l1[B[k + 1]];
      dst[k + 2] = fa * l2[A[k + 2]] + fb * l2[B[k + 2]];
    }
    return dst;
  }

  // The homography's residual: the projector raster lands a fraction of a
  // cell away from where the calibration believes. Constant shift → constant
  // bilinear weights; only edge clamping varies.
  function misregister(src, dst) {
    const fx = -mx, fy = -my;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    for (let y = 0; y < h; y++) {
      let y0 = y + iy, y1 = y0 + 1;
      y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
      y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
      for (let x = 0; x < w; x++) {
        let x0 = x + ix, x1 = x0 + 1;
        x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
        x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
        const a = (y0 * w + x0) * 3, b = (y0 * w + x1) * 3, c = (y1 * w + x0) * 3, d = (y1 * w + x1) * 3;
        const o = (y * w + x) * 3;
        dst[o]     = w00 * src[a]     + w10 * src[b]     + w01 * src[c]     + w11 * src[d];
        dst[o + 1] = w00 * src[a + 1] + w10 * src[b + 1] + w01 * src[c + 1] + w11 * src[d + 1];
        dst[o + 2] = w00 * src[a + 2] + w10 * src[b + 2] + w01 * src[c + 2] + w11 * src[d + 2];
      }
    }
    return dst;
  }

  function blurPlanar(buf, r) {
    for (let ch = 0; ch < 3; ch++) {
      for (let c = 0; c < N; c++) planeA[c] = buf[c * 3 + ch];
      boxBlur(planeA, planeB, w, h, r, planeT);
      for (let c = 0; c < N; c++) buf[c * 3 + ch] = planeB[c];
    }
  }

  function observe(R, occluder, i, out) {
    if (!out) out = new Uint8Array(N3);
    store(R, i);
    let P = projectorOutput(i, proj);
    if (hasMisreg) { misregister(P, proj2); P = proj2; }

    // Lens glare: a wide, faint halo of the bright content over everything,
    // including the body and the shadow. Grey, because glare is.
    const hasGlare = glareGain > 0 && glareRadius > 0;
    if (hasGlare) {
      for (let c = 0, k = 0; c < N; c++, k += 3) planeA[c] = lumaOf(P[k], P[k + 1], P[k + 2]);
      boxBlur(planeA, halo, w, h, glareRadius, planeT);
    }

    const amb = p.ambientFn(i);
    const wa = p.wallAlbedo, ba = p.bodyAlbedo, bk = p.bodyK;
    const d0 = p.dark[0], d1 = p.dark[1], d2 = p.dark[2];
    const shadowV = wa * amb;   // a shadowed wall cell sees only the room
    for (let y = 0; y < h; y++) {
      const band = p.bandsFn(i, y);
      for (let x = 0; x < w; x++) {
        const c = y * w + x, k = c * 3;
        const occ = occluder ? clamp01(occluder[c]) : 0;
        let sh = 0;
        if (occluder && hasShadow) {
          const xs = x - sx, ys = y - sy;
          if (xs >= 0 && xs < w && ys >= 0 && ys < h) sh = clamp01(occluder[ys * w + xs]);
        }
        // Content on the body is what the projector throws at the body's
        // depth — parallax-shifted from where the same content lands on the
        // wall — and the body is nearer the lens, so it collects bodyK× more.
        let pb0 = P[k], pb1 = P[k + 1], pb2 = P[k + 2];
        if (occ > 0 && hasContentShift) {
          const xs = x - cx, ys = y - cy;
          if (xs >= 0 && xs < w && ys >= 0 && ys < h) {
            const kk = (ys * w + xs) * 3; pb0 = P[kk]; pb1 = P[kk + 1]; pb2 = P[kk + 2];
          } else { pb0 = pb1 = pb2 = 0; }
        }
        const wall0 = wa * (amb + d0 + P[k]), wall1 = wa * (amb + d1 + P[k + 1]), wall2 = wa * (amb + d2 + P[k + 2]);
        const body0 = ba * (amb + bk * (d0 + pb0)), body1 = ba * (amb + bk * (d1 + pb1)), body2 = ba * (amb + bk * (d2 + pb2));
        const g = hasGlare ? halo[c] * glareGain : 0;
        const uw = 1 - occ, us = 1 - sh;
        lin[k]     = (occ * body0 + uw * (sh * shadowV + us * wall0) + g) * band;
        lin[k + 1] = (occ * body1 + uw * (sh * shadowV + us * wall1) + g) * band;
        lin[k + 2] = (occ * body2 + uw * (sh * shadowV + us * wall2) + g) * band;
      }
    }
    if (p.blurRadius > 0) blurPlanar(lin, p.blurRadius);

    // Camera: opto-electronic curve with a pedestal, then white balance and
    // gain on the codes (contract order), noise, clamp, quantise.
    const gTot = p.gain * p.gainFn(i);
    const awb = p.awbFn(i);
    const g0 = awb[0] * gTot, g1 = awb[1] * gTot, g2 = awb[2] * gTot;
    const sigma = p.noiseSigma;
    const gauss = sigma > 0 ? gaussianSource(mulberry32(hashSeed(p.seed, i))) : null;
    const ped = p.pedestal;
    for (let k = 0; k < N3; k += 3) {
      let v0 = lin[k], v1 = lin[k + 1], v2 = lin[k + 2];
      if (v0 < 0) v0 = 0; if (v1 < 0) v1 = 0; if (v2 < 0) v2 = 0;
      let c0 = (ped + span * Math.pow(v0, invGam)) * g0;
      let c1 = (ped + span * Math.pow(v1, invGam)) * g1;
      let c2 = (ped + span * Math.pow(v2, invGam)) * g2;
      if (gauss) { c0 += sigma * gauss(); c1 += sigma * gauss(); c2 += sigma * gauss(); }
      out[k]     = c0 <= 0 ? 0 : c0 >= 255 ? 255 : Math.round(c0);
      out[k + 1] = c1 <= 0 ? 0 : c1 >= 255 ? 255 : Math.round(c1);
      out[k + 2] = c2 <= 0 ? 0 : c2 >= 255 ? 255 : Math.round(c2);
    }
    return out;
  }

  function reset() { primed = false; minIdx = 0; maxIdx = -1; }

  return { observe, reset, params: p };
}
