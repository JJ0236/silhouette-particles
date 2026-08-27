import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxBlur, dilate, contourBand, sample } from '../src/field.js';
import { createFlow } from '../src/flow.js';
import { createParticles } from '../src/particles.js';
import { WORK_W, WORK_H, MASK_W, MASK_H, settings } from '../src/config.js';

const grid = (w, h, fn) => {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y);
  return a;
};

test('boxBlur preserves a uniform field', () => {
  const w = 32, h = 16;
  const src = grid(w, h, () => 0.7);
  const dst = new Float32Array(w * h), tmp = new Float32Array(w * h);
  boxBlur(src, dst, w, h, 3, tmp);
  for (const v of dst) assert.ok(Math.abs(v - 0.7) < 1e-5, `expected 0.7, got ${v}`);
});

test('boxBlur spreads an impulse and conserves rough mass', () => {
  const w = 41, h = 41;
  const src = new Float32Array(w * h);
  src[20 * w + 20] = 1;
  const dst = new Float32Array(w * h), tmp = new Float32Array(w * h);
  boxBlur(src, dst, w, h, 2, tmp);
  assert.ok(dst[20 * w + 20] < 1, 'peak should fall');
  assert.ok(dst[20 * w + 21] > 0, 'neighbour should gain');
  const sum = dst.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.05, `mass drifted: ${sum}`);
});

test('dilate grows a solid block by the radius', () => {
  const w = 21, h = 21;
  const src = grid(w, h, (x, y) => (x >= 8 && x <= 12 && y >= 8 && y <= 12 ? 1 : 0));
  const dst = new Float32Array(w * h), tmp = new Float32Array(w * h);
  dilate(src, dst, w, h, 2, tmp);
  assert.equal(dst[10 * w + 10], 1, 'interior stays lit');
  assert.equal(dst[10 * w + 14], 1, 'grows by the radius');
  assert.equal(dst[10 * w + 15], 0, 'but no further');
});

// The contour is what "make it thinner" actually depends on. The old
// erosion-difference could not draw a line narrower than one grid cell, which
// on a 4K display is ~12px — this replaces it with a distance to the isoline.
function ramp(w, h, mid, slope) {
  return grid(w, h, (x) => Math.min(1, Math.max(0, 0.5 + (x - mid) * slope)));
}

test('the contour lands on the 0.5 isoline', () => {
  const w = 31, h = 5;
  const mask = ramp(w, h, 15, 0.25);
  const dst = new Float32Array(w * h);
  contourBand(mask, dst, w, h, 0.7, 1);
  const row = 2 * w;
  assert.ok(dst[row + 15] > 0.9, `should peak on the isoline, got ${dst[row + 15]}`);
  assert.ok(dst[row + 20] === 0, 'and be dark well away from it');
});

test('contour width is continuous, including below one cell', () => {
  const w = 31, h = 5;
  const mask = ramp(w, h, 15, 0.25);
  const lit = (width) => {
    const dst = new Float32Array(w * h);
    contourBand(mask, dst, w, h, width, 1);
    let n = 0;
    for (let x = 0; x < w; x++) if (dst[2 * w + x] > 0) n++;
    return n;
  };
  const thin = lit(0.5), thick = lit(3);
  assert.ok(thin < thick, `wider setting must light more cells: ${thin} vs ${thick}`);
  assert.equal(thin, 1, 'a sub-cell width must resolve to a single-cell line');
});

test('the contour is dark where the mask is flat', () => {
  const w = 16, h = 16;
  const solid = grid(w, h, () => 1);
  const dst = new Float32Array(w * h);
  contourBand(solid, dst, w, h, 1, 1);
  assert.ok(dst.every(v => v === 0), 'a filled region has no contour');

  const empty = new Float32Array(w * h);
  contourBand(empty, dst, w, h, 1, 1);
  assert.ok(dst.every(v => v === 0), 'and neither does an empty one');
});

test('sample interpolates between cells', () => {
  const w = 2, h = 2;
  const f = Float32Array.from([0, 1, 0, 1]);   // ramps left→right
  assert.ok(Math.abs(sample(f, w, h, 0, 0) - 0) < 1e-6);
  assert.ok(Math.abs(sample(f, w, h, 1, 0) - 1) < 1e-6);
  assert.ok(Math.abs(sample(f, w, h, 0.5, 0) - 0.5) < 1e-6);
});

// The one that matters: does a body moving RIGHT produce flow pointing RIGHT?
function flowForShift(dx, dy) {
  const flow = createFlow();
  const period = 20;
  for (let step = 0; step < 40; step++) {
    const ox = dx * step, oy = dy * step;
    const luma = grid(WORK_W, WORK_H, (x, y) =>
      0.5 + 0.35 * Math.sin(2 * Math.PI * (x - ox) / period)
          + 0.35 * Math.sin(2 * Math.PI * (y - oy) / period));
    flow.update(luma, null);
  }
  const i = (WORK_H >> 1) * WORK_W + (WORK_W >> 1);
  return { vx: flow.vx[i], vy: flow.vy[i] };
}

test('flow points the way the pattern moved', () => {
  const right = flowForShift(2, 0);
  assert.ok(right.vx > 0, `rightward motion should give vx>0, got ${right.vx}`);
  assert.ok(Math.abs(right.vy) < Math.abs(right.vx) * 0.5, 'should not leak into vy');

  const left = flowForShift(-2, 0);
  assert.ok(left.vx < 0, `leftward motion should give vx<0, got ${left.vx}`);

  const down = flowForShift(0, 2);
  assert.ok(down.vy > 0, `downward motion should give vy>0, got ${down.vy}`);
});

test('flow magnitude tracks the real displacement', () => {
  const slow = flowForShift(1, 0), fast = flowForShift(3, 0);
  assert.ok(fast.vx > slow.vx, `faster motion should push harder: ${fast.vx} vs ${slow.vx}`);
  // Normalised units: 2 cells/frame on a 160-wide grid ≈ 0.0125 screen widths,
  // scaled by the motion gain.
  const mid = flowForShift(2, 0);
  const expected = settings.flowGain * 2 / WORK_W;
  // Relative bound: the estimator reads ~half the true shift on this pattern, and the
  // old absolute 0.010 was the same 67% slack at flowGain 1.2 — it just didn't scale.
  assert.ok(Math.abs(mid.vx - expected) < expected * 0.67, `expected ~${expected}, got ${mid.vx}`);
});

test('a rightward flow inside the halo actually throws particles right', () => {
  const p = createParticles(300);
  const flow = { vx: new Float32Array(WORK_W * WORK_H).fill(0.01), vy: new Float32Array(WORK_W * WORK_H) };
  const seg = {
    influence: new Float32Array(MASK_W * MASK_H).fill(1),
    mask: new Float32Array(MASK_W * MASK_H),   // no occupancy force, isolate the shove
  };
  const before = Array.from(p.x);
  for (let i = 0; i < 20; i++) p.update(flow, seg, i * 16);
  let moved = 0;
  for (let i = 0; i < p.count; i++) if (p.x[i] > before[i]) moved++;
  assert.ok(moved > p.count * 0.9, `expected most particles pushed right, got ${moved}/${p.count}`);
});

test('particles settle back toward rest once the push stops', () => {
  const p = createParticles(200);
  const flow = { vx: new Float32Array(WORK_W * WORK_H).fill(0.02), vy: new Float32Array(WORK_W * WORK_H) };
  const seg = { influence: new Float32Array(MASK_W * MASK_H).fill(1), mask: new Float32Array(MASK_W * MASK_H) };
  const rest = Array.from(p.x);
  for (let i = 0; i < 30; i++) p.update(flow, seg, i * 16);
  const disturbed = Array.from(p.x).reduce((a, v, i) => a + Math.abs(v - rest[i]), 0);

  flow.vx.fill(0);
  const still = { influence: new Float32Array(MASK_W * MASK_H), mask: new Float32Array(MASK_W * MASK_H) };
  const savedDrift = settings.drift; settings.drift = 0;   // isolate the return force
  for (let i = 0; i < 1200; i++) p.update(flow, still, i * 16);
  settings.drift = savedDrift;
  const settled = Array.from(p.x).reduce((a, v, i) => a + Math.abs(v - rest[i]), 0);

  assert.ok(settled < disturbed * 0.5, `should heal: ${disturbed.toFixed(3)} → ${settled.toFixed(3)}`);
});

test('particles stay on screen', () => {
  const p = createParticles(500);
  const flow = { vx: new Float32Array(WORK_W * WORK_H).fill(0.5), vy: new Float32Array(WORK_W * WORK_H).fill(-0.5) };
  const seg = { influence: new Float32Array(MASK_W * MASK_H).fill(1), mask: new Float32Array(MASK_W * MASK_H).fill(1) };
  for (let i = 0; i < 200; i++) p.update(flow, seg, i * 16);
  for (let i = 0; i < p.count; i++) {
    assert.ok(p.x[i] >= 0 && p.x[i] <= 1 && p.y[i] >= 0 && p.y[i] <= 1, `escaped at ${p.x[i]},${p.y[i]}`);
    assert.ok(Number.isFinite(p.x[i]) && Number.isFinite(p.y[i]), 'went non-finite');
  }
});
