import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimCamera, IDEAL, ADVERSARIAL, apl } from '../src/simcam.js';

const W = 480, H = 270, N = W * H;

const flat = (code) => new Uint8Array(N * 3).fill(code);
const rectFrame = (x0, y0, x1, y1, code, base = 0) => {
  const R = flat(base);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * W + x) * 3; R[o] = R[o + 1] = R[o + 2] = code; }
  return R;
};
const rectOcc = (x0, y0, x1, y1) => {
  const o = new Float32Array(N);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) o[y * W + x] = 1;
  return o;
};
const at = (obs, x, y) => obs[(y * W + x) * 3 + 1];   // green channel
const meanRegion = (obs, x0, y0, x1, y1, ch = 1) => {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += obs[(y * W + x) * 3 + ch]; n++; }
  return s / n;
};
const stdRegion = (obs, x0, y0, x1, y1, ch = 1) => {
  const m = meanRegion(obs, x0, y0, x1, y1, ch);
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const d = obs[(y * W + x) * 3 + ch] - m; s += d * d; n++; }
  return Math.sqrt(s / n);
};

test('latency: content appears exactly latencyFrames after it is submitted', () => {
  const sim = createSimCamera({ ...IDEAL, latencyFrames: 3 });
  const dark = flat(0), bright = rectFrame(100, 100, 200, 160, 220);
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const obs = sim.observe(i < 3 ? dark : bright, null, i);
    seen.push(at(obs, 150, 130));
  }
  for (let i = 0; i < 6; i++) assert.ok(seen[i] < 40, `frame ${i} should still show the dark frame, got ${seen[i]}`);
  for (let i = 6; i < 10; i++) assert.ok(seen[i] > 150, `frame ${i} should show the bright frame, got ${seen[i]}`);
});

test('fractional latency blends the two neighbouring frames', () => {
  const sim = createSimCamera({ ...IDEAL, latencyFrames: 3.5 });
  const dark = flat(0), bright = rectFrame(100, 100, 200, 160, 220);
  const seen = [];
  for (let i = 0; i < 10; i++) seen.push(at(sim.observe(i < 3 ? dark : bright, null, i), 150, 130));
  assert.ok(seen[5] < 40, 'before');
  assert.ok(seen[6] > 60 && seen[6] < seen[7] - 20, `half-way frame should be intermediate, got ${seen[6]} vs ${seen[7]}`);
  assert.ok(seen[7] > 150, 'after');
});

test('body reads darker than the wall, the cast shadow darker still and displaced', () => {
  const sim = createSimCamera({ ...IDEAL, shadowShift: [12, 0] });
  const R = flat(200);
  const occ = rectOcc(100, 80, 140, 200);
  let obs;
  for (let i = 0; i < 6; i++) obs = sim.observe(R, occ, i);
  const wall = meanRegion(obs, 300, 100, 340, 180);
  const body = meanRegion(obs, 105, 100, 135, 180);
  const shadow = meanRegion(obs, 142, 100, 150, 180);   // occluder shifted right by 12, past the body
  assert.ok(body < wall, `body ${body} should be darker than wall ${wall}`);
  // bodyAlbedo 0.3 × bodyK 2 / wallAlbedo 0.8 = 0.75 linear → 0.75^(1/2.2) ≈ 0.88 in code.
  assert.ok(Math.abs(body / wall - 0.877) < 0.03, `body/wall in code should be ≈0.88, got ${body / wall}`);
  assert.ok(shadow < 5, `shadow should be near black, got ${shadow}`);
  assert.ok(shadow < body, 'shadow darker than body');
  const beside = meanRegion(obs, 152, 100, 170, 180);
  assert.ok(Math.abs(beside - wall) < 2, 'wall beyond the shadow untouched');
});

test('iris dims the projected content at low APL only', () => {
  const dim = createSimCamera({ ...IDEAL, irisFn: (a) => (a < 0.05 ? 0.6 : 1) });
  const open = createSimCamera(IDEAL);
  const low = rectFrame(180, 90, 220, 120, 255);   // a lone bright patch: APL ≈ 0.009
  const high = flat(200);
  let a, b;
  for (let i = 0; i < 6; i++) { a = dim.observe(low, null, i); b = open.observe(low, null, i); }
  assert.ok(at(a, 200, 100) < at(b, 200, 100) * 0.9, `iris should dim: ${at(a, 200, 100)} vs ${at(b, 200, 100)}`);
  for (let i = 6; i < 12; i++) { a = dim.observe(high, null, i); b = open.observe(high, null, i); }
  assert.equal(at(a, 200, 100), at(b, 200, 100), 'bright frames are not dimmed');
});

test('bands multiply the affected rows', () => {
  const sim = createSimCamera({ ...IDEAL, bandsFn: (i, row) => (row >= 60 && row <= 90 ? 1.2 : 1) });
  let obs;
  for (let i = 0; i < 6; i++) obs = sim.observe(flat(120), null, i);
  const inBand = meanRegion(obs, 0, 62, W, 88), outBand = meanRegion(obs, 0, 120, W, 200);
  assert.ok(inBand > outBand * 1.05, `band rows should be brighter: ${inBand} vs ${outBand}`);
});

test('projector and camera gammas: monotone, and a higher projector gamma reads darker at mid grey', () => {
  const sim = createSimCamera(IDEAL);
  const codes = [0, 16, 48, 96, 128, 176, 224, 255];
  const out = [];
  let i = 0;
  for (const c of codes) {
    let obs;
    for (let k = 0; k < 5; k++) obs = sim.observe(flat(c), null, i++);
    out.push(at(obs, 200, 100));
  }
  for (let k = 1; k < out.length; k++) assert.ok(out[k] > out[k - 1], `monotone at ${codes[k]}: ${out}`);
  const steep = createSimCamera({ ...IDEAL, gammaProj: 2.4 });
  let a, b;
  for (let k = 0; k < 5; k++) { a = steep.observe(flat(128), null, k); b = sim.observe(flat(128), null, i + k); }
  assert.ok(at(a, 200, 100) < at(b, 200, 100), 'gamma 2.4 darker than 2.2 at code 128');
});

test('noise is deterministic per seed and has the requested amplitude', () => {
  const R = flat(150);
  const a = createSimCamera({ ...ADVERSARIAL, seed: 3 });
  const b = createSimCamera({ ...ADVERSARIAL, seed: 3 });
  const c = createSimCamera({ ...ADVERSARIAL, seed: 4 });
  let oa, ob, oc;
  for (let i = 0; i < 6; i++) { oa = sim2(a, R, i); ob = sim2(b, R, i); oc = sim2(c, R, i); }
  assert.deepEqual(oa, ob, 'same seed → identical bytes');
  assert.notDeepEqual(oa, oc, 'different seed → different noise');
  const sd = stdRegion(oa, 100, 120, 300, 200);
  assert.ok(sd > 2 && sd < 4.5, `σ≈3 expected, got ${sd}`);
  function sim2(s, r, i) { return new Uint8Array(s.observe(r, null, i)); }
});

test('sub-cell misregistration smears an edge by the shift', () => {
  const sim = createSimCamera({ ...IDEAL, misreg: [0.5, 0] });
  const R = rectFrame(0, 0, 200, H, 200);   // bright for x < 200
  let obs;
  for (let i = 0; i < 6; i++) obs = sim.observe(R, null, i);
  const inside = at(obs, 150, 100), edge = at(obs, 200, 100), outside = at(obs, 210, 100);
  assert.ok(edge > outside + 20 && edge < inside - 20, `edge cell should be intermediate: ${outside} < ${edge} < ${inside}`);
});

test('glare puts a faint halo just outside bright content', () => {
  const sim = createSimCamera({ ...IDEAL, glare: { radius: 4, gain: 0.05 } });
  const R = rectFrame(100, 100, 200, 160, 255);
  let obs;
  for (let i = 0; i < 6; i++) obs = sim.observe(R, null, i);
  assert.ok(at(obs, 202, 130) > at(obs, 300, 130), 'cell 2 outside the rectangle is brighter than far away');
});

test('camera gain, awb and pedestal act on the codes', () => {
  const R = flat(100);
  const base = createSimCamera(IDEAL);
  const gained = createSimCamera({ ...IDEAL, gainFn: () => 1.3 });
  const warm = createSimCamera({ ...IDEAL, awbFn: () => [1.2, 1, 0.8] });
  const ped = createSimCamera({ ...IDEAL, pedestal: 12 });
  let ob, og, ow, op;
  for (let i = 0; i < 6; i++) { ob = base.observe(R, null, i); og = gained.observe(R, null, i); ow = warm.observe(R, null, i); op = ped.observe(R, null, i); }
  const o = (200 * W + 200) * 3;
  assert.ok(Math.abs(og[o + 1] / ob[o + 1] - 1.3) < 0.03, 'gain 1.3');
  assert.ok(ow[o] > ow[o + 1] && ow[o + 1] > ow[o + 2], 'awb tilts R up and B down');
  const black = createSimCamera({ ...IDEAL, pedestal: 12, dark: [0, 0, 0] });
  let oz; for (let i = 0; i < 6; i++) oz = black.observe(flat(0), null, i);
  assert.equal(oz[o], 12, 'pedestal is the code for zero light');
  assert.ok(op[o] > ob[o], 'pedestal lifts every code');
});

test('apl is the mean code as a fraction', () => {
  assert.equal(apl(flat(0)), 0);
  assert.equal(apl(flat(255)), 1);
  assert.ok(Math.abs(apl(flat(51)) - 0.2) < 1e-6);
});

test('presets carry the contract values', () => {
  assert.equal(IDEAL.latencyFrames, 3);
  assert.equal(IDEAL.noiseSigma, 0);
  assert.deepEqual(IDEAL.dark, [0.003, 0.003, 0.003]);
  assert.equal(ADVERSARIAL.gammaProj, 2.4);
  assert.equal(ADVERSARIAL.gammaCam, 1.8);
  assert.equal(ADVERSARIAL.pedestal, 12);
  assert.equal(ADVERSARIAL.latencyFrames, 3.4);
  assert.equal(ADVERSARIAL.latencyJitter, 0.5);
  assert.deepEqual(ADVERSARIAL.misreg, [0.7, 0.9]);
  assert.deepEqual(ADVERSARIAL.contentShift, [4, 2]);
  assert.deepEqual(ADVERSARIAL.shadowShift, [6, 3]);
  assert.equal(ADVERSARIAL.noiseSigma, 3);
  assert.equal(ADVERSARIAL.irisFn(0.02), 0.6);
  assert.equal(ADVERSARIAL.irisFn(0.2), 1);
  assert.deepEqual(ADVERSARIAL.glare, { radius: 4, gain: 0.05 });
  const a = ADVERSARIAL.awbFn(58)[0];
  assert.ok(Math.abs(a - 1) <= 0.1 && Math.abs(a - 1) > 0.05, 'awb drifts within ±10%');
  assert.ok(Math.abs(ADVERSARIAL.bandsFn(2, 70) - 1) <= 0.08 && ADVERSARIAL.bandsFn(2, 10) === 1, 'bands ±8% on rows 60–90');
});
