import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  patchLayout, LEVELS17, calibrationSequence, createAccumulator, fitLut,
  predictLow, predictHigh, observable, serialize, deserialize,
} from '../src/photometric.js';

const W = 480, H = 270;

// ---------------------------------------------------------------------------
// Deterministic helpers (no Math.random in tests either — failures must replay).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  // Box–Muller; the u1 guard keeps log() finite.
  const u1 = Math.max(rand(), 1e-12), u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const rms = (arr) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length);
function relRms(est, truth) {
  let se = 0, st = 0;
  for (let i = 0; i < truth.length; i++) { const d = est[i] - truth[i]; se += d * d; st += truth[i] * truth[i]; }
  return Math.sqrt(se / st);
}

// A synthetic camera: obs = g(t) * (D + (W − D) * f(render)) + N(0, σ), quantised.
// D and W carry radial vignetting so the per-cell maps are genuinely spatial,
// f is a 2.2 gamma, and g(t) is a slow ±30% auto-exposure drift across the run.
function makeSyntheticCamera({ w, h, layout, seed = 7, sigma = 2, drift = 0.3, length }) {
  const N = w * h;
  const D = new Float32Array(N * 3), Wm = new Float32Array(N * 3);
  const Dc = [18, 20, 24], Wc = [185, 180, 170];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1)) * 2 - 1, v = (y / (h - 1)) * 2 - 1;
      const r2 = (u * u + v * v) / 2;                  // 0 centre .. 1 corner
      const i = y * w + x;
      for (let ch = 0; ch < 3; ch++) {
        D[i * 3 + ch] = Dc[ch] * (1 - 0.3 * r2);
        Wm[i * 3 + ch] = Wc[ch] * (1 - 0.45 * r2);
      }
    }
  }
  const f = (code) => Math.pow(code / 255, 2.2);
  // Phase chosen so the first accumulated frame (index 1, index 0 is a settle
  // frame) sits at gain exactly 1: the accumulator anchors to its first frame.
  const gain = (i) => 1 + drift * Math.sin((2 * Math.PI * (i - 1)) / length);
  const rand = mulberry32(seed);
  const render = new Uint8Array(N * 3);
  function observeRender(R, g, out) {
    for (let i = 0; i < N * 3; i++) {
      const v = g * (D[i] + (Wm[i] - D[i]) * f(R[i])) + sigma * gaussian(rand);
      out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
    return out;
  }
  function observe(spec, i, out) {
    render.fill(0);
    for (const p of spec.lit) for (const c of layout.cells[p]) render[c * 3] = render[c * 3 + 1] = render[c * 3 + 2] = spec.level;
    return observeRender(render, gain(i), out);
  }
  return { D, W: Wm, f, gain, observe, observeRender, rand };
}

// ---------------------------------------------------------------------------
test('patchLayout covers every cell exactly once and patchOf agrees with cells', () => {
  const layout = patchLayout({ cols: 8, rows: 8, w: W, h: H });
  assert.equal(layout.count, 64);
  assert.equal(layout.cells.length, 64);
  assert.equal(layout.patchOf.length, W * H);
  const seen = new Uint8Array(W * H);
  for (let p = 0; p < layout.count; p++) {
    assert.ok(layout.cells[p] instanceof Int32Array);
    assert.ok(layout.cells[p].length > 0, `patch ${p} is empty`);
    for (const c of layout.cells[p]) {
      assert.equal(seen[c], 0, `cell ${c} appears twice`);
      seen[c] = 1;
      assert.equal(layout.patchOf[c], p);
    }
  }
  for (let i = 0; i < W * H; i++) assert.equal(seen[i], 1, `cell ${i} uncovered`);
});

test('patchLayout patches are rectangular blocks in an 8×8 grid', () => {
  const layout = patchLayout({ cols: 8, rows: 8, w: W, h: H });
  // Top-left patch is the top-left block; bottom-right patch the bottom-right block.
  assert.equal(layout.patchOf[0], 0);
  assert.equal(layout.patchOf[W * H - 1], 63);
  assert.equal(layout.patchOf[(W - 1)], 7);
  assert.equal(layout.patchOf[(H - 1) * W], 56);
});

test('LEVELS17 is 0,16,…,240,255', () => {
  assert.equal(LEVELS17.length, 17);
  assert.equal(LEVELS17[0], 0);
  assert.equal(LEVELS17[1], 16);
  assert.equal(LEVELS17[15], 240);
  assert.equal(LEVELS17[16], 255);
  for (let i = 1; i < 17; i++) assert.ok(LEVELS17[i] > LEVELS17[i - 1]);
});

function countHolds(seq, layout) {
  // holds (settle frames) per patch at 255, and per patch per level in the stair phase
  const white = new Int32Array(layout.count);
  const perLevel = new Map();
  for (let i = 0; i < seq.length; i++) {
    const fr = seq.frame(i);
    if (!fr.settle) continue;
    for (const p of fr.lit) {
      if (fr.level === 255) white[p]++;
      if (fr.phase === 'stair') {
        if (!perLevel.has(fr.level)) perLevel.set(fr.level, new Int32Array(layout.count));
        perLevel.get(fr.level)[p]++;
      }
    }
  }
  return { white, perLevel };
}

test('calibrationSequence lights every patch at 255 ≥ whiteCycles times and at every level ≥ levelCycles times', () => {
  const layout = patchLayout({ w: W, h: H });
  const seq = calibrationSequence({ layout, litPerFrame: 4, holdFrames: 2, whiteCycles: 3, levelCycles: 1 });
  const { white, perLevel } = countHolds(seq, layout);
  for (let p = 0; p < layout.count; p++) assert.ok(white[p] >= 3, `patch ${p} white ${white[p]} < 3`);
  for (const lv of LEVELS17) {
    const c = perLevel.get(lv);
    assert.ok(c, `level ${lv} never shown`);
    for (let p = 0; p < layout.count; p++) assert.ok(c[p] >= 1, `patch ${p} at level ${lv}: ${c[p]}`);
  }
  // and with levelCycles 2 / whiteCycles 1
  const seq2 = calibrationSequence({ layout, litPerFrame: 8, holdFrames: 3, whiteCycles: 1, levelCycles: 2, levels: [0, 128, 255] });
  const r2 = countHolds(seq2, layout);
  for (let p = 0; p < layout.count; p++) assert.ok(r2.white[p] >= 1);
  for (const lv of [0, 128, 255]) for (let p = 0; p < layout.count; p++) assert.ok(r2.perLevel.get(lv)[p] >= 2);
});

test('calibrationSequence keeps APL ≤ litPerFrame/count and constant on every frame', () => {
  const layout = patchLayout({ w: W, h: H });
  for (const litPerFrame of [1, 2, 4, 8, 16]) {
    const seq = calibrationSequence({ layout, litPerFrame });
    const apl0 = seq.frame(0).lit.length / layout.count;
    for (let i = 0; i < seq.length; i++) {
      const fr = seq.frame(i);
      assert.ok(fr.lit.length <= litPerFrame, `frame ${i}: ${fr.lit.length} lit > ${litPerFrame}`);
      assert.ok(fr.lit.length / layout.count <= litPerFrame / layout.count + 1e-12);
      assert.equal(fr.lit.length / layout.count, apl0, `frame ${i}: APL changed`);
      assert.equal(new Set(fr.lit).size, fr.lit.length, 'duplicate patch in lit');
      assert.ok(fr.level >= 0 && fr.level <= 255);
      assert.ok(fr.phase === 'white' || fr.phase === 'stair');
    }
  }
});

test('calibrationSequence sets settle on the first frame of each hold and holds are stable', () => {
  const layout = patchLayout({ w: W, h: H });
  for (const holdFrames of [1, 2, 3]) {
    const seq = calibrationSequence({ layout, holdFrames, whiteCycles: 1, levels: [64, 255] });
    assert.equal(seq.length % holdFrames, 0);
    for (let i = 0; i < seq.length; i++) {
      const fr = seq.frame(i);
      assert.equal(fr.settle, i % holdFrames === 0, `frame ${i} settle`);
      if (i % holdFrames !== 0) {
        const prev = seq.frame(i - 1);
        assert.deepEqual(fr.lit, prev.lit);
        assert.equal(fr.level, prev.level);
        assert.equal(fr.phase, prev.phase);
      }
    }
  }
  // length = (whiteCycles + levels·levelCycles) · groups · holdFrames
  const seq = calibrationSequence({ layout, litPerFrame: 4, holdFrames: 2, whiteCycles: 3, levelCycles: 1 });
  assert.equal(seq.length, (3 + 17) * 16 * 2);
  // white phase comes first so W is known before any stair frame is accumulated
  assert.equal(seq.frame(0).phase, 'white');
  assert.equal(seq.frame(seq.length - 1).phase, 'stair');
});

test('calibrationSequence never lights adjacent patches in the same frame', () => {
  const layout = patchLayout({ w: W, h: H });
  for (const litPerFrame of [2, 4, 8, 16]) {
    const seq = calibrationSequence({ layout, litPerFrame, whiteCycles: 1, levels: [255] });
    for (let i = 0; i < seq.length; i++) {
      const lit = seq.frame(i).lit;
      for (let a = 0; a < lit.length; a++) {
        for (let b = a + 1; b < lit.length; b++) {
          const ra = Math.floor(lit[a] / 8), ca = lit[a] % 8, rb = Math.floor(lit[b] / 8), cb = lit[b] % 8;
          const cheb = Math.max(Math.abs(ra - rb), Math.abs(ca - cb));
          assert.ok(cheb >= 2, `frame ${i}: patches ${lit[a]} and ${lit[b]} adjacent`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The synthetic-camera run is shared by several tests (it is the expensive bit).
function runCalibration({ w = 160, h = 90, drift = 0.3, sigma = 2, seed = 7 } = {}) {
  const N = w * h;
  const layout = patchLayout({ w, h });
  const seq = calibrationSequence({ layout, litPerFrame: 4, holdFrames: 2, whiteCycles: 3, levelCycles: 1 });
  const cam = makeSyntheticCamera({ w, h, layout, seed, sigma, drift, length: seq.length });
  const acc = createAccumulator(layout, N);
  const obs = new Uint8Array(N * 3);
  for (let i = 0; i < seq.length; i++) {
    const spec = seq.frame(i);
    cam.observe(spec, i, obs);
    acc.add(spec, obs);
  }
  const photo = acc.finish();
  return { w, h, N, layout, seq, cam, photo };
}
let shared = null;
const getRun = () => (shared ??= runCalibration());

test('accumulator recovers D, W, σ_D and the response within 2% RMS under ±30% AE drift', () => {
  const { w, h, N, cam, photo } = getRun();
  assert.equal(photo.w, w);
  assert.equal(photo.h, h);
  assert.equal(photo.D.length, N * 3);
  assert.equal(photo.W.length, N * 3);
  assert.equal(photo.sigmaD.length, N);
  assert.equal(photo.lut.length, 768);
  assert.equal(photo.observable.length, N);

  const eD = relRms(photo.D, cam.D);
  const eW = relRms(photo.W, cam.W);
  assert.ok(eD < 0.02, `D relative RMS ${eD.toFixed(4)}`);
  assert.ok(eW < 0.02, `W relative RMS ${eW.toFixed(4)}`);

  // σ_D is a luma σ: three independent σ=2 channels combine through the Y weights
  // to 2·√(.299²+.587²+.114²) ≈ 1.34 codes; quantisation and the 1/g normalisation
  // on low-gain frames push the measured value slightly above that.
  let s = 0; for (let i = 0; i < N; i++) s += photo.sigmaD[i];
  const meanSigma = s / N;
  const sigmaY = 2 * Math.sqrt(0.299 ** 2 + 0.587 ** 2 + 0.114 ** 2);
  assert.ok(meanSigma > sigmaY - 0.1 && meanSigma < sigmaY + 0.3, `σ_D mean ${meanSigma.toFixed(3)} vs ${sigmaY.toFixed(3)}`);

  // Response: lut sampled at the levels vs the true 2.2 gamma, per channel.
  for (let ch = 0; ch < 3; ch++) {
    const err = LEVELS17.map((lv) => photo.lut[ch * 256 + lv] - cam.f(lv));
    const e = rms(err);
    assert.ok(e < 0.02, `channel ${ch} response RMS ${e.toFixed(4)}`);
  }
  assert.equal(photo.lut[0], 0);
  assert.equal(photo.lut[255], 1);
  // everything is observable in this camera
  let obsCount = 0; for (let i = 0; i < N; i++) obsCount += photo.observable[i];
  assert.equal(obsCount, N);
});

test('accumulator skips settle frames', () => {
  const w = 32, h = 16, N = w * h;
  const layout = patchLayout({ w, h });
  const acc = createAccumulator(layout, N);
  const garbage = new Uint8Array(N * 3).fill(255);
  // settle frames carrying garbage must leave no trace
  acc.add({ lit: [0], level: 255, phase: 'white', settle: true }, garbage);
  acc.add({ lit: [1], level: 128, phase: 'stair', settle: true }, garbage);
  const photo = acc.finish();
  for (let i = 0; i < N * 3; i++) { assert.equal(photo.D[i], 0); }
  let anyObs = 0; for (let i = 0; i < N; i++) anyObs += photo.observable[i];
  assert.equal(anyObs, 0);
});

test('accumulator without drift matches the drifted run (normalisation is not harmful)', () => {
  const a = getRun();
  const b = runCalibration({ drift: 0, seed: 11 });
  assert.ok(relRms(b.photo.D, b.cam.D) < 0.02);
  assert.ok(relRms(b.photo.W, b.cam.W) < 0.02);
  for (let lv of LEVELS17) {
    assert.ok(Math.abs(a.photo.lut[lv] - b.photo.lut[lv]) < 0.03, `lut differs at ${lv}`);
  }
});

// ---------------------------------------------------------------------------
test('fitLut reproduces a gamma curve, is monotone, and is normalised', () => {
  const levels = [...LEVELS17];
  const resp = levels.map((l) => Math.pow(l / 255, 2.2));
  const lut = fitLut(levels, resp);
  assert.equal(lut.length, 256);
  assert.equal(lut[0], 0);
  assert.equal(lut[255], 1);
  for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1], `non-monotone at ${i}`);
  // Linear interpolation between 16-code knots of a gamma curve is within ~0.5%.
  for (let c = 0; c < 256; c++) assert.ok(Math.abs(lut[c] - Math.pow(c / 255, 2.2)) < 0.01, `code ${c}`);
});

test('fitLut handles non-monotone noisy input via pool-adjacent-violators', () => {
  const levels = [...LEVELS17];
  const rand = mulberry32(3);
  const resp = levels.map((l) => Math.pow(l / 255, 2.2) + 0.05 * (rand() - 0.5));
  resp[5] = resp[6] + 0.1;    // an explicit violator
  resp[0] = 0.02;            // dark end above zero
  resp[16] = 0.95;           // white end below one
  const lut = fitLut(levels, resp);
  assert.equal(lut[0], 0);
  assert.equal(lut[255], 1);
  for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1], `non-monotone at ${i}`);
  for (let i = 0; i < 256; i++) assert.ok(lut[i] >= 0 && lut[i] <= 1);
  // Still tracks the underlying curve loosely.
  const err = levels.map((l) => lut[l] - Math.pow(l / 255, 2.2));
  assert.ok(rms(err) < 0.06, `rms ${rms(err)}`);
  // Unsorted / duplicate levels are tolerated.
  const lut2 = fitLut([255, 0, 128, 128], [1, 0, 0.3, 0.2]);
  assert.equal(lut2[0], 0);
  assert.equal(lut2[255], 1);
  assert.ok(Math.abs(lut2[128] - 0.25) < 1e-6);
  // Degenerate input falls back to a monotone ramp rather than NaN.
  const lut3 = fitLut([], []);
  assert.equal(lut3[0], 0);
  assert.equal(lut3[255], 1);
  for (let i = 0; i < 256; i++) assert.ok(Number.isFinite(lut3[i]));
  const lut4 = fitLut([0, 255], [0.5, 0.5]);
  assert.equal(lut4[0], 0);
  assert.equal(lut4[255], 1);
});

// ---------------------------------------------------------------------------
test('predictLow at beta 1 reproduces the synthetic camera within noise', () => {
  const { N, cam, photo } = getRun();
  const R = new Uint8Array(N * 3);
  const rand = mulberry32(99);
  for (let i = 0; i < N * 3; i++) R[i] = Math.floor(rand() * 256);
  const obs = new Uint8Array(N * 3);
  cam.observeRender(R, 1, obs);          // no drift: gain 1 is the accumulator's reference
  const pred = new Float32Array(N * 3);
  assert.equal(predictLow(photo, R, 1, pred), pred);
  const err = new Float64Array(N * 3);
  for (let i = 0; i < N * 3; i++) err[i] = pred[i] - obs[i];
  const e = rms(err);
  // σ=2 noise plus ~0.3 quantisation; anything above 3 codes means a model error.
  assert.ok(e < 3, `prediction RMS error ${e.toFixed(3)} codes`);
  let bias = 0; for (let i = 0; i < N * 3; i++) bias += err[i]; bias /= N * 3;
  assert.ok(Math.abs(bias) < 0.5, `bias ${bias.toFixed(3)}`);
});

test('predictHigh ≥ predictLow for beta < 1, both equal at beta 1, high clamped ≤ 255', () => {
  const { N, photo } = getRun();
  const R = new Uint8Array(N * 3);
  const rand = mulberry32(5);
  for (let i = 0; i < N * 3; i++) R[i] = Math.floor(rand() * 256);
  const lo = new Float32Array(N * 3), hi = new Float32Array(N * 3);
  predictLow(photo, R, 0.7, lo);
  assert.equal(predictHigh(photo, R, 0.7, hi), hi);
  for (let i = 0; i < N * 3; i++) {
    assert.ok(hi[i] >= lo[i] - 1e-4, `cell ${i}: high ${hi[i]} < low ${lo[i]}`);
    assert.ok(hi[i] <= 255);
  }
  predictLow(photo, R, 1, lo);
  predictHigh(photo, R, 1, hi);
  for (let i = 0; i < N * 3; i++) assert.ok(Math.abs(hi[i] - Math.min(255, lo[i])) < 1e-4);
  // the formula, spot-checked
  const i = 1234, ch = i % 3;
  const expect = photo.D[i] + 0.7 * (photo.W[i] - photo.D[i]) * photo.lut[ch * 256 + R[i]];
  predictLow(photo, R, 0.7, lo);
  assert.ok(Math.abs(lo[i] - expect) < 1e-3);
});

test('observable is false where W−D is small', () => {
  const w = 16, h = 4, N = w * h;
  const D = new Float32Array(N * 3).fill(10), Wm = new Float32Array(N * 3).fill(200);
  // cells 0..7: no range at all; 8..15: 11 codes of Y range (just under default 12); 16: exactly 12
  for (let i = 0; i < 8; i++) for (let ch = 0; ch < 3; ch++) Wm[i * 3 + ch] = 10;
  for (let i = 8; i < 16; i++) for (let ch = 0; ch < 3; ch++) Wm[i * 3 + ch] = 21;
  for (let ch = 0; ch < 3; ch++) Wm[16 * 3 + ch] = 22;
  const photo = { w, h, D, W: Wm, sigmaD: new Float32Array(N), lut: new Float32Array(768), observable: new Uint8Array(N), meta: {} };
  const out = observable(photo);
  assert.equal(out, photo.observable);
  for (let i = 0; i < 16; i++) assert.equal(out[i], 0, `cell ${i}`);
  for (let i = 16; i < N; i++) assert.equal(out[i], 1, `cell ${i}`);
  // custom threshold
  observable(photo, 30);
  assert.equal(photo.observable[16], 0);
  assert.equal(photo.observable[20], 1);
  // and the accumulator applies it: a camera cell with W == D ends up unobservable
  const { photo: real } = getRun();
  const clone = { ...real, D: real.D.slice(), W: real.W.slice(), observable: real.observable.slice() };
  clone.W[0] = clone.D[0]; clone.W[1] = clone.D[1]; clone.W[2] = clone.D[2];
  observable(clone);
  assert.equal(clone.observable[0], 0);
  assert.equal(clone.observable[1], 1);
});

// ---------------------------------------------------------------------------
const META = { quadHash: 'abc123', deviceId: 'cam-1', mirror: true };

test('serialize / deserialize round-trips within rounding', () => {
  const { photo, w, h, N } = getRun();
  const json = serialize(photo, META);
  assert.equal(typeof json, 'string');
  const back = deserialize(json, { ...META, w, h });
  assert.ok(back, 'deserialize returned null');
  assert.equal(back.w, w);
  assert.equal(back.h, h);
  assert.ok(back.D instanceof Float32Array && back.D.length === N * 3);
  assert.ok(back.W instanceof Float32Array && back.W.length === N * 3);
  assert.ok(back.sigmaD instanceof Float32Array && back.sigmaD.length === N);
  assert.ok(back.lut instanceof Float32Array && back.lut.length === 768);
  assert.ok(back.observable instanceof Uint8Array && back.observable.length === N);
  for (let i = 0; i < N * 3; i++) {
    assert.ok(Math.abs(back.D[i] - photo.D[i]) < 0.01);
    assert.ok(Math.abs(back.W[i] - photo.W[i]) < 0.01);
  }
  for (let i = 0; i < N; i++) {
    assert.ok(Math.abs(back.sigmaD[i] - photo.sigmaD[i]) < 0.01);
    assert.equal(back.observable[i], photo.observable[i]);
  }
  for (let i = 0; i < 768; i++) assert.ok(Math.abs(back.lut[i] - photo.lut[i]) < 1e-3);
  assert.equal(back.lut[0], 0);
  assert.equal(back.lut[255], 1);
  assert.equal(back.meta.quadHash, 'abc123');
  assert.equal(back.meta.deviceId, 'cam-1');
  assert.equal(back.meta.mirror, true);
  assert.equal(back.meta.w, w);
  assert.equal(back.meta.h, h);
  // meta on the photo is also accepted when serialize is called without a second arg
  const json2 = serialize({ ...photo, meta: META });
  assert.ok(deserialize(json2, { ...META, w, h }));
});

test('deserialize returns null on each meta mismatch and on bad shapes', () => {
  const { photo, w, h } = getRun();
  const json = serialize(photo, META);
  const good = { ...META, w, h };
  assert.ok(deserialize(json, good));
  assert.equal(deserialize(json, { ...good, quadHash: 'zzz' }), null, 'quadHash');
  assert.equal(deserialize(json, { ...good, deviceId: 'cam-2' }), null, 'deviceId');
  assert.equal(deserialize(json, { ...good, w: w + 1 }), null, 'w');
  assert.equal(deserialize(json, { ...good, h: h - 1 }), null, 'h');
  assert.equal(deserialize(json, { ...good, mirror: false }), null, 'mirror');
  // version mismatch
  const obj = JSON.parse(json);
  assert.equal(deserialize(JSON.stringify({ ...obj, version: obj.version + 1 }), good), null, 'version');
  // bad array lengths
  assert.equal(deserialize(JSON.stringify({ ...obj, D: obj.D.slice(1) }), good), null, 'D length');
  assert.equal(deserialize(JSON.stringify({ ...obj, W: obj.W.slice(0, 10) }), good), null, 'W length');
  assert.equal(deserialize(JSON.stringify({ ...obj, sigmaD: [] }), good), null, 'sigmaD length');
  assert.equal(deserialize(JSON.stringify({ ...obj, lut: obj.lut.slice(0, 767) }), good), null, 'lut length');
  assert.equal(deserialize(JSON.stringify({ ...obj, observable: obj.observable.concat([1]) }), good), null, 'observable length');
  assert.equal(deserialize(JSON.stringify({ ...obj, D: 'nope' }), good), null, 'D type');
  // garbage input
  assert.equal(deserialize('not json', good), null);
  assert.equal(deserialize('null', good), null);
  assert.equal(deserialize('[]', good), null);
  assert.equal(deserialize(JSON.stringify({ version: obj.version }), good), null);
});
