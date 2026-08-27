import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlow } from '../src/flow.js';
import { createParticles } from '../src/particles.js';
import { WORK_W, WORK_H, MASK_W, MASK_H, settings } from '../src/config.js';

// Regression suite for the blowout: a blinking mask drove the flow estimator to
// its clamp, which drove terminal particle velocity to ~40% of the screen per
// frame and threw every particle against the walls.

const N = WORK_W * WORK_H;
const blob = (cx, cy, r) => {
  const m = new Float32Array(N);
  for (let y = 0; y < WORK_H; y++) {
    for (let x = 0; x < WORK_W; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) m[y * WORK_W + x] = 1;
    }
  }
  return m;
};
const EMPTY = new Float32Array(N);
const peak = (f) => { let m = 0; for (const v of f) if (Math.abs(v) > m) m = Math.abs(v); return m; };

test('a body translating right produces rightward flow', () => {
  const flow = createFlow();
  for (let i = 0; i < 40; i++) flow.update(blob(40 + i * 2, 45, 12), null);
  let sum = 0, n = 0;
  for (let i = 0; i < N; i++) if (Math.abs(flow.vx[i]) > 1e-6) { sum += flow.vx[i]; n++; }
  assert.ok(n > 0, 'a real movement must register at all');
  assert.ok(sum / n > 0, `mean flow should be rightward, got ${sum / n}`);
});

test('a blinking mask produces almost no flow', () => {
  // The failure mode: segmentation dropping in and out is NOT movement, but
  // the raw estimator reads it as maximum velocity.
  const flow = createFlow();
  for (let i = 0; i < 40; i++) flow.update(i % 2 ? blob(80, 45, 20) : EMPTY, null);
  assert.ok(peak(flow.vx) < 0.002, `blink leaked into vx: ${peak(flow.vx)}`);
  assert.ok(peak(flow.vy) < 0.002, `blink leaked into vy: ${peak(flow.vy)}`);
});

test('a body appearing from nothing does not read as a shove', () => {
  const flow = createFlow();
  for (let i = 0; i < 10; i++) flow.update(EMPTY, null);
  for (let i = 0; i < 5; i++) flow.update(blob(80, 45, 20), null);
  assert.ok(peak(flow.vx) < 0.004, `arrival read as motion: ${peak(flow.vx)}`);
});

test('a body vanishing does not read as a shove', () => {
  const flow = createFlow();
  for (let i = 0; i < 15; i++) flow.update(blob(80, 45, 20), null);
  for (let i = 0; i < 5; i++) flow.update(EMPTY, null);
  assert.ok(peak(flow.vx) < 0.004, `departure read as motion: ${peak(flow.vx)}`);
});

test('translation still registers far more strongly than a blink', () => {
  const moving = createFlow();
  for (let i = 0; i < 40; i++) moving.update(blob(40 + i * 2, 45, 12), null);
  const blinking = createFlow();
  for (let i = 0; i < 40; i++) blinking.update(i % 2 ? blob(80, 45, 12) : EMPTY, null);
  assert.ok(peak(moving.vx) > peak(blinking.vx) * 10,
    `real motion must dominate blink: ${peak(moving.vx)} vs ${peak(blinking.vx)}`);
});

test('particle speed is capped no matter what the flow claims', () => {
  const p = createParticles(400);
  // An absurd reading — far past anything the estimator should ever produce.
  const flow = { vx: new Float32Array(N).fill(5), vy: new Float32Array(N).fill(-5) };
  const seg = {
    influence: new Float32Array(MASK_W * MASK_H).fill(1),
    mask: new Float32Array(MASK_W * MASK_H).fill(1),
  };
  let maxStep = 0;
  for (let i = 0; i < 60; i++) {
    const bx = Array.from(p.x), by = Array.from(p.y);
    p.update(flow, seg, i * 16);
    for (let k = 0; k < p.count; k++) {
      // Ignore wall bounces, which legitimately shorten a step.
      if (p.x[k] <= 0 || p.x[k] >= 1 || p.y[k] <= 0 || p.y[k] >= 1) continue;
      const d = Math.hypot(p.x[k] - bx[k], p.y[k] - by[k]);
      if (d > maxStep) maxStep = d;
    }
  }
  assert.ok(maxStep <= settings.maxSpeed * 1.05,
    `step ${maxStep.toFixed(4)} exceeded the ${settings.maxSpeed} ceiling`);
});

test('the ceiling is low enough that a wipe is impossible', () => {
  // At 1920px wide, the ceiling must keep a particle to a sane distance per
  // frame. The bug allowed ~806px.
  assert.ok(settings.maxSpeed * 1920 < 120,
    `${Math.round(settings.maxSpeed * 1920)}px per frame is still a wipe`);
});
