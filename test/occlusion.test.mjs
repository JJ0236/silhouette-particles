import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOcclusion, estimateGains, evidence, smoothness, OCCLUSION_DEFAULTS } from '../src/occlusion.js';
import { OCCLUSION_DEFAULTS as RAW_DEFAULTS } from '../src/occlusion-defaults.js';
import { createRing } from '../src/frames.js';
import { linearise } from '../src/morph.js';

const W = 480, H = 270, N = W * H;

// Deterministic PRNG so property tests are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Internals

test('OCCLUSION_DEFAULTS is re-exported from occlusion-defaults.js', () => {
  assert.equal(OCCLUSION_DEFAULTS, RAW_DEFAULTS);
  assert.equal(OCCLUSION_DEFAULTS.openR, 0);
  assert.equal(OCCLUSION_DEFAULTS.closeR, 1);
});

test('estimateGains recovers a known per-band gain with 30% outlier cells', () => {
  const w = 96, h = 60, n = w * h, bands = 6;
  const rand = rng(7);
  const obs = new Float32Array(3 * n), pred = new Float32Array(3 * n);
  const eligible = new Uint8Array(n).fill(1);
  const truth = new Float32Array(bands * 3);
  for (let k = 0; k < bands * 3; k++) truth[k] = 0.7 + 0.07 * k;   // 0.7 .. 1.89
  for (let y = 0; y < h; y++) {
    const b = Math.floor((y * bands) / h);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const outlier = rand() < 0.3;
      const f = outlier ? (rand() < 0.5 ? 0.1 + 0.4 * rand() : 1.5 + rand()) : 1;
      for (let ch = 0; ch < 3; ch++) {
        const p = 0.05 + 0.95 * rand();
        pred[ch * n + i] = p;
        obs[ch * n + i] = p * truth[b * 3 + ch] * f;
      }
    }
  }
  const out = new Float32Array(bands * 3);
  const prev = new Float32Array(bands * 3).fill(1);
  // bandSpread Infinity: this exercises the estimator's raw per-band recovery,
  // with truth spanning 0.7..1.89. Production clamps bands to within a few
  // percent of each other, because a spread that large is an occluder skewing a
  // band rather than real sensor banding — see the clamp test below.
  const refFrac = estimateGains(obs, pred, eligible, w, h, bands, prev, 0.15, 0.3, out, Infinity);
  assert.equal(refFrac, 1);
  for (let k = 0; k < bands * 3; k++) {
    assert.ok(Math.abs(out[k] / truth[k] - 1) < 0.01, `band gain ${k}: ${out[k]} vs ${truth[k]}`);
  }
});

test('estimateGains holds prior (within slew) when refFrac < refMinFrac', () => {
  const w = 96, h = 60, n = w * h, bands = 6;
  const rand = rng(11);
  const obs = new Float32Array(3 * n), pred = new Float32Array(3 * n);
  const eligible = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    eligible[i] = rand() < 0.1 ? 1 : 0;
    for (let ch = 0; ch < 3; ch++) { pred[ch * n + i] = 0.5; obs[ch * n + i] = 0.75; }   // true gain 1.5
  }
  const prev = new Float32Array(bands * 3).fill(1);
  const out = new Float32Array(bands * 3);
  // bandSpread Infinity: this exercises the estimator's raw per-band recovery,
  // with truth spanning 0.7..1.89. Production clamps bands to within a few
  // percent of each other, because a spread that large is an occluder skewing a
  // band rather than real sensor banding — see the clamp test below.
  const refFrac = estimateGains(obs, pred, eligible, w, h, bands, prev, 0.15, 0.3, out, Infinity);
  assert.ok(refFrac < 0.3 && refFrac > 0.05, `refFrac ${refFrac}`);
  for (let k = 0; k < bands * 3; k++) {
    assert.ok(out[k] >= 1 && out[k] <= 1.15 + 1e-6, `slewed gain ${k}: ${out[k]}`);
  }
  // Zero slew is a hard hold; out may alias prev.
  const held = prev.slice();
  estimateGains(obs, pred, eligible, w, h, bands, held, 0, 0.3, held);
  for (let k = 0; k < bands * 3; k++) assert.equal(held[k], 1);
  // And with a large enough reference set the estimate is adopted directly.
  eligible.fill(1);
  estimateGains(obs, pred, eligible, w, h, bands, prev, 0.15, 0.3, out);
  for (let k = 0; k < bands * 3; k++) assert.ok(Math.abs(out[k] - 1.5) < 0.01, `adopted ${out[k]}`);
});

test('evidence is one-sided: obs >= pred everywhere never yields a seed or candidate (100 seeds)', () => {
  const w = 64, h = 36, n = w * h, bands = 6;
  const obs = new Float32Array(3 * n), pred = new Float32Array(3 * n), sigma = new Float32Array(n);
  const gains = new Float32Array(bands * 3).fill(1);
  const strength = new Float32Array(n), seed = new Uint8Array(n), cand = new Uint8Array(n);
  const thr = { tauLow: 0.35, tauHigh: 0.6, noiseK: 3 };
  for (let s = 1; s <= 100; s++) {
    const rand = rng(s);
    for (let i = 0; i < n; i++) {
      sigma[i] = rand() < 0.5 ? 0 : 0.01 * rand();
      for (let ch = 0; ch < 3; ch++) {
        const p = rand() < 0.1 ? 0 : rand();
        pred[ch * n + i] = p;
        const noise = (rand() - 0.5) * 2 * rand();
        obs[ch * n + i] = p * (1 + Math.abs(noise));
      }
    }
    evidence(obs, pred, sigma, gains, w, h, bands, thr, strength, seed, cand);
    for (let i = 0; i < n; i++) {
      if (seed[i] || cand[i] || strength[i] !== 0) assert.fail(`seed ${s} cell ${i} flagged with obs >= pred`);
    }
  }
});

test('evidence fires for a 0.3-ratio blob and not for a 0.8-ratio blob at tauHigh 0.6', () => {
  const w = 64, h = 36, n = w * h, bands = 6;
  const obs = new Float32Array(3 * n), pred = new Float32Array(3 * n).fill(0.5);
  const sigma = new Float32Array(n).fill(0.001);
  const gains = new Float32Array(bands * 3).fill(1);
  const strength = new Float32Array(n), seed = new Uint8Array(n), cand = new Uint8Array(n);
  const ratio = new Float32Array(n);
  const inA = (x, y) => x >= 5 && x < 20 && y >= 5 && y < 25;
  const inB = (x, y) => x >= 40 && x < 55 && y >= 5 && y < 25;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const f = inA(x, y) ? 0.3 : inB(x, y) ? 0.8 : 1;
    for (let ch = 0; ch < 3; ch++) obs[ch * n + y * w + x] = 0.5 * f;
  }
  evidence(obs, pred, sigma, gains, w, h, bands, { tauLow: 0.35, tauHigh: 0.6, noiseK: 3 }, strength, seed, cand, ratio);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (inA(x, y)) { assert.equal(seed[i], 1); assert.equal(cand[i], 1); assert.equal(strength[i], 1); assert.ok(Math.abs(ratio[i] - 0.3) < 1e-5); }
    else { assert.equal(seed[i], 0); assert.equal(cand[i], 0); assert.equal(strength[i], 0); }
  }
});

test('deficit gate blocks a shallow ratio dip when sigma is large', () => {
  const w = 32, h = 18, n = w * h, bands = 6;
  const obs = new Float32Array(3 * n).fill(0.05), pred = new Float32Array(3 * n).fill(0.1);   // ratio 0.5
  const gains = new Float32Array(bands * 3).fill(1);
  const strength = new Float32Array(n), seed = new Uint8Array(n), cand = new Uint8Array(n);
  const thr = { tauLow: 0.35, tauHigh: 0.6, noiseK: 3 };
  const big = new Float32Array(n).fill(0.1);      // 3σ = 0.3 > deficit 0.05
  evidence(obs, pred, big, gains, w, h, bands, thr, strength, seed, cand);
  assert.equal(cand.reduce((a, b) => a + b, 0), 0);
  const small = new Float32Array(n).fill(0.001);
  evidence(obs, pred, small, gains, w, h, bands, thr, strength, seed, cand);
  assert.equal(cand.reduce((a, b) => a + b, 0), n);
  assert.equal(seed.reduce((a, b) => a + b, 0), 0);   // 0.5 is above tauLow
});

test('smoothness ~1 for a uniform ratio field and low for a shaped occluder', () => {
  const n = 5000;
  const rand = rng(3);
  const uniform = new Float32Array(n);
  for (let i = 0; i < n; i++) uniform[i] = 0.5 * (1 + (rand() - 0.5) * 0.1);
  assert.ok(smoothness(uniform, null) > 0.95);
  const eligible = new Uint8Array(n).fill(1);
  assert.ok(smoothness(uniform, eligible) > 0.95);
  const shaped = new Float32Array(n);
  for (let i = 0; i < n; i++) shaped[i] = (i % 2 === 0 ? 0.3 : 1.0) * (1 + (rand() - 0.5) * 0.1);
  assert.ok(smoothness(shaped, eligible) < 0.6);
  // Near-black fields (lights off) still read as smooth rather than blowing up on log(0).
  assert.ok(smoothness(new Float32Array(n), eligible) > 0.99);
  assert.equal(smoothness(uniform, new Uint8Array(n)), 0);
});

// ---------------------------------------------------------------------------
// Full update()

const D_CODE = 20, W_CODE = 200, PEDESTAL = 8, GAMMA = 2.2;

function makePhoto() {
  const D = new Float32Array(N * 3).fill(D_CODE);
  const Wm = new Float32Array(N * 3).fill(W_CODE);
  const sigmaD = new Float32Array(N).fill(2);
  const lut = new Float32Array(3 * 256);
  for (let ch = 0; ch < 3; ch++) for (let c = 0; c < 256; c++) lut[ch * 256 + c] = c / 255;
  return { w: W, h: H, D, W: Wm, sigmaD, lut, observable: new Uint8Array(N).fill(1), meta: {} };
}

// Camera code whose linear light is `ratio` times that of the dark level.
function codeForRatio(ratio) {
  const lin = new Float32Array(256);
  linearise(PEDESTAL, GAMMA, lin);
  const target = lin[D_CODE] * ratio;
  for (let c = 0; c < 256; c++) if (lin[c] >= target) return c;
  return 255;
}

function makeRig(extra = {}) {
  const settings = { ...OCCLUSION_DEFAULTS, lagMs: 0, ...extra };
  const occ = createOcclusion({ w: W, h: H, workW: 160, workH: 90, settings });
  const ring = createRing({ entries: 8, size: N * 3 });
  const photo = makePhoto();
  const obs = new Uint8Array(N * 3).fill(D_CODE);   // wall at black render reads exactly D
  const black = new Uint8Array(N * 3);
  let t = 1000;
  function step(frames = 1) {
    for (let k = 0; k < frames; k++) {
      t += 33;
      ring.push(black, t);
      occ.update({ obs, tCam: t, ring, photo, lagMs: 0 });
    }
    return t;
  }
  const paint = (pred, code) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pred(x, y)) {
      const i3 = (y * W + x) * 3; obs[i3] = code; obs[i3 + 1] = code; obs[i3 + 2] = code;
    }
  };
  return { occ, ring, photo, obs, settings, step, paint, get t() { return t; } };
}

const sum = (a) => a.reduce((acc, v) => acc + v, 0);

test('update() with photo=null does nothing and does not throw', () => {
  const rig = makeRig();
  rig.paint(() => true, PEDESTAL);   // everything black: would be a huge occluder if calibrated
  rig.ring.push(new Uint8Array(N * 3), 1033);
  rig.occ.update({ obs: rig.obs, tCam: 1033, ring: rig.ring, photo: null, lagMs: 0 });
  assert.equal(sum(rig.occ.bin), 0);
  assert.equal(rig.occ.coverage, 0);
  assert.equal(rig.occ.diag.veto, false);
  assert.equal(sum(rig.occ.mask), 0);
});

test('an unlit wall (obs == D at black render) yields an empty mask and unity gains', () => {
  const rig = makeRig();
  rig.step(4);
  assert.equal(sum(rig.occ.bin), 0);
  assert.equal(sum(rig.occ.diag.seed), 0);
  assert.equal(rig.occ.diag.lagStarved, false);
  for (const g of rig.occ.diag.gains) assert.ok(Math.abs(g - 1) < 0.01, `gain ${g}`);
  assert.equal(rig.occ.diag.observableFrac, 1);
  // refFrac is the fraction of cells carrying enough light to say anything
  // about exposure gain, and on a black frame that is correctly ZERO: a cell
  // receiving no light cannot measure gain. Letting near-black cells vote is
  // what previously let one-sided noise inflate the gain to 1.46 and
  // manufacture occluders out of the cells nearest prediction. With no
  // reference the gain holds at unity, which is the assertion above.
  assert.equal(rig.occ.diag.refFrac, 0, 'a dark frame cannot measure gain');
});

test('lag starvation falls back to the latest frame and flags diag.lagStarved', () => {
  const rig = makeRig();
  rig.ring.push(new Uint8Array(N * 3), 100);   // far outside any window around t=1033+
  rig.occ.update({ obs: rig.obs, tCam: 5000, ring: rig.ring, photo: rig.photo, lagMs: 0 });
  assert.equal(rig.occ.diag.lagStarved, true);
  assert.equal(sum(rig.occ.bin), 0);
});

test('suppress() freezes bin until the deadline passes', () => {
  const rig = makeRig();
  const blob = (x, y) => x >= 100 && x < 160 && y >= 100 && y < 160;
  rig.paint(blob, codeForRatio(0.1));
  rig.step(3);
  const before = sum(rig.occ.bin);
  assert.ok(before > 3000, `blob detected: ${before}`);
  rig.occ.suppress(500);
  rig.paint(() => true, D_CODE);   // blob gone
  rig.step(1);
  assert.equal(rig.occ.diag.suppressed, true);
  assert.equal(sum(rig.occ.bin), before);
  rig.step(3);   // 4 × 33 ms < 500 ms: still suppressed
  assert.equal(rig.occ.diag.suppressed, true);
  assert.equal(sum(rig.occ.bin), before);
  rig.step(16);  // past the deadline, and enough frames for the temporal median to flush
  assert.equal(rig.occ.diag.suppressed, false);
  assert.equal(sum(rig.occ.bin), 0);
});

test('reset() clears state', () => {
  const rig = makeRig();
  rig.paint((x, y) => x >= 100 && x < 160 && y >= 100 && y < 160, codeForRatio(0.1));
  rig.step(3);
  assert.ok(sum(rig.occ.bin) > 0);
  rig.occ.reset();
  assert.equal(sum(rig.occ.bin), 0);
  assert.equal(sum(rig.occ.mask), 0);
  assert.equal(rig.occ.coverage, 0);
  for (const g of rig.occ.diag.gains) assert.equal(g, 1);
});

test('veto zeroes the mask on a global darkening (lights off)', () => {
  const rig = makeRig();
  rig.step(2);
  // Whole frame drops to near the pedestal: darker than any exposure gain can
  // absorb, and featureless.
  rig.paint(() => true, PEDESTAL + 2);
  rig.step(1);   // temporal median needs two agreeing frames before the bin fills
  rig.step(1);
  assert.equal(rig.occ.diag.veto, true);
  assert.equal(rig.occ.diag.vetoReason, 'global');
  assert.equal(sum(rig.occ.bin), 0);
  assert.equal(rig.occ.coverage, 0);
  assert.ok(rig.occ.diag.smoothness > OCCLUSION_DEFAULTS.vetoSmooth);
  // The same darkening confined to a shape is NOT vetoed.
  const rig2 = makeRig();
  rig2.step(2);
  rig2.paint((x, y) => x >= 40 && x < 300 && y >= 30 && y < 240, PEDESTAL + 2);
  rig2.step(2);
  assert.equal(rig2.occ.diag.veto, false);
  assert.ok(rig2.occ.coverage > 0.3);
});

test('hole fill: an enclosed bright hole is filled, a border-touching one is not', () => {
  const rig = makeRig();
  const dark = codeForRatio(0.05);
  const bright = 60;   // obs well above pred: projector content on the viewer's back
  // Enclosed: 40x40 blob with a 6x6 bright hole in the middle.
  const blobA = (x, y) => x >= 200 && x < 240 && y >= 100 && y < 140;
  const holeA = (x, y) => x >= 217 && x < 223 && y >= 117 && y < 123;
  // Border-touching: blob on the left edge with a bright bay open to the border.
  const blobB = (x, y) => x >= 0 && x < 40 && y >= 200 && y < 240;
  const holeB = (x, y) => x >= 0 && x < 6 && y >= 217 && y < 223;
  rig.paint((x, y) => (blobA(x, y) && !holeA(x, y)) || (blobB(x, y) && !holeB(x, y)), dark);
  rig.paint((x, y) => holeA(x, y) || holeB(x, y), bright);
  rig.step(3);
  const { bin } = rig.occ;
  for (let y = 117; y < 123; y++) for (let x = 217; x < 223; x++) assert.equal(bin[y * W + x], 1, `enclosed hole cell ${x},${y}`);
  // The bay's centre cells cannot be reached by any closing and must remain open.
  for (let y = 218; y < 222; y++) for (let x = 0; x < 3; x++) assert.equal(bin[y * W + x], 0, `border bay cell ${x},${y}`);
  // Blob bodies are detected.
  assert.equal(bin[110 * W + 205], 1);
  assert.equal(bin[210 * W + 20], 1);

  const off = makeRig({ fillHoles: false });
  off.paint((x, y) => blobA(x, y) && !holeA(x, y), dark);
  off.paint(holeA, bright);
  off.step(3);
  for (let y = 118; y < 122; y++) for (let x = 218; x < 222; x++) assert.equal(off.occ.bin[y * W + x], 0, `unfilled hole cell ${x},${y}`);
});

// A hand: a palm block with five fingers, each 3 cells wide, separated by
// 2-cell gaps, pointing up (free tips).
function makeHand({ x0 = 200, palmY0 = 150, palmH = 30, fingerLen = 14 } = {}) {
  const fingerCells = [], gapCells = [];
  const palmW = 5 * 3 + 4 * 2;
  const palm = (x, y) => x >= x0 && x < x0 + palmW && y >= palmY0 && y < palmY0 + palmH;
  const finger = (x, y) => {
    if (y < palmY0 - fingerLen || y >= palmY0) return false;
    const dx = x - x0;
    if (dx < 0 || dx >= palmW) return false;
    return dx % 5 < 3;
  };
  const gap = (x, y) => {
    if (y < palmY0 - fingerLen || y >= palmY0) return false;
    const dx = x - x0;
    if (dx < 0 || dx >= palmW) return false;
    return dx % 5 >= 3;
  };
  // The gap row touching the palm (the "crotch") is excluded from gapCells:
  // radius-1 pooling averages it with the palm row and a finger column (5 of
  // 9 cells dark), which is a concave-corner cost of one cell, not a weld.
  for (let y = palmY0 - fingerLen; y < palmY0; y++) for (let x = x0; x < x0 + palmW; x++) {
    if (finger(x, y)) fingerCells.push(y * W + x);
    else if (gap(x, y) && y < palmY0 - 1) gapCells.push(y * W + x);
  }
  return { hand: (x, y) => palm(x, y) || finger(x, y), fingerCells, gapCells };
}

test('finger preservation: a shadow-dark hand keeps every finger cell and every gap cell', () => {
  const rig = makeRig();
  const { hand, fingerCells, gapCells } = makeHand();
  rig.paint(hand, codeForRatio(0.05));
  rig.step(3);
  const { bin } = rig.occ;
  let missing = 0;
  for (const c of fingerCells) if (!bin[c]) missing++;
  assert.equal(missing, 0, `${missing} of ${fingerCells.length} finger cells lost`);
  for (const c of gapCells) assert.equal(bin[c], 0, `gap cell ${c % W},${(c / W) | 0} welded`);
  assert.ok(rig.occ.coverage > 0);
});

test('finger preservation: a 0.3-ratio hand keeps gaps open and fingers intact except pooled tip corners', () => {
  const rig = makeRig();
  const { hand, fingerCells, gapCells } = makeHand();
  rig.paint(hand, codeForRatio(0.3));
  rig.step(3);
  const { bin } = rig.occ;
  for (const c of gapCells) assert.equal(bin[c], 0, `gap cell ${c % W},${(c / W) | 0} welded`);
  let kept = 0;
  for (const c of fingerCells) kept += bin[c];
  // Radius-1 pooling mixes a free fingertip's two corner cells with 5 wall
  // cells, which lifts them above tauHigh at this contrast; nothing else may go.
  assert.ok(kept >= fingerCells.length - 2 * 5, `${fingerCells.length - kept} finger cells lost`);
  // Every finger row still has its full width somewhere below the tip.
  const { x0 = 200, palmY0 = 150 } = {};
  for (let y = palmY0 - 12; y < palmY0; y++) for (let f = 0; f < 5; f++) for (let k = 0; k < 3; k++) {
    assert.equal(bin[y * W + x0 + f * 5 + k], 1, `finger ${f} row ${y} col ${k}`);
  }
});

test('temporalMedian: a single-frame flicker does not enter the mask', () => {
  const rig = makeRig();
  rig.step(2);
  rig.paint((x, y) => x >= 100 && x < 160 && y >= 100 && y < 160, codeForRatio(0.1));
  rig.step(1);
  assert.equal(sum(rig.occ.bin), 0);   // one frame of evidence is not a decision yet
  rig.paint(() => true, D_CODE);
  rig.step(3);
  assert.equal(sum(rig.occ.bin), 0);
});

test('a band skewed by an occluder is pulled back to the frame consensus', () => {
  // The bars-through-a-person artefact: bands holding a body drift away from
  // their neighbours, so those bands stop seeing the body while the ones beside
  // them keep seeing it, and the person comes out in horizontal strips.
  const w = 96, h = 60, n = w * h, bands = 6;
  const obs = new Float32Array(3 * n), pred = new Float32Array(3 * n);
  const eligible = new Uint8Array(n).fill(1);
  const skewed = 2;                                  // one band holds a "person"
  for (let y = 0; y < h; y++) {
    const b = Math.floor((y * bands) / h);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      for (let ch = 0; ch < 3; ch++) {
        pred[ch * n + i] = 0.5;
        obs[ch * n + i] = 0.5 * (b === skewed ? 0.55 : 1.0);
      }
    }
  }
  const out = new Float32Array(bands * 3);
  const prev = new Float32Array(bands * 3).fill(1);
  estimateGains(obs, pred, eligible, w, h, bands, prev, 0.15, 0.3, out);
  for (let ch = 0; ch < 3; ch++) {
    const skew = out[skewed * 3 + ch], other = out[0 * 3 + ch];
    assert.ok(Math.abs(skew / other - 1) < 0.2,
      `band ${skewed} drifted to ${skew.toFixed(3)} vs ${other.toFixed(3)} — bars`);
  }
});
