import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParticles } from '../src/particles.js';
import { signedDistance } from '../src/distance.js';
import { MASK_W, MASK_H, WORK_W, WORK_H, settings, DEFAULTS } from '../src/config.js';

// A body on the wall: particles inside it must leave, particles nearby must
// gather on its outline, and nothing may linger in the interior.

const N = MASK_W * MASK_H;
const CX = 0.5, CY = 0.5, R = 0.12;   // normalised; the disc's radius in cells is R*MASK_W

function body() {
  const bin = new Uint8Array(N), mask = new Float32Array(N);
  for (let y = 0; y < MASK_H; y++) for (let x = 0; x < MASK_W; x++) {
    const u = x / (MASK_W - 1), v = y / (MASK_H - 1);
    // Cells are square on the wall; measure the disc in cells so it is round.
    const d = Math.hypot((u - CX) * MASK_W, (v - CY) * MASK_H) - R * MASK_W;
    if (d <= 0) { bin[y * MASK_W + x] = 1; mask[y * MASK_W + x] = 1; }
  }
  const sdf = signedDistance(bin, MASK_W, MASK_H, new Float32Array(N), settings.outlineReach);
  return { mask, influence: mask, sdf, coverage: 0.05 };
}

const stillFlow = { vx: new Float32Array(WORK_W * WORK_H), vy: new Float32Array(WORK_W * WORK_H) };
const distCells = (p, i) => Math.hypot((p.x[i] - CX) * MASK_W, (p.y[i] - CY) * MASK_H) - R * MASK_W;

test('particles inside the body are driven out and gather on the outline', () => {
  Object.assign(settings, DEFAULTS);
  settings.drift = 0;
  const p = createParticles(2000);
  const seg = body();
  let insideBefore = 0;
  for (let i = 0; i < p.count; i++) if (distCells(p, i) < 0) insideBefore++;
  assert.ok(insideBefore > 50, `test needs particles inside to start with, got ${insideBefore}`);

  for (let f = 0; f < 240; f++) p.update(stillFlow, seg, f * 33);

  let lingering = 0, onLine = 0, near = 0;
  for (let i = 0; i < p.count; i++) {
    const d = distCells(p, i);
    if (d < -2) lingering++;
    if (Math.abs(d) <= 1.5) onLine++;
    if (Math.abs(d) <= settings.outlineReach) near++;
  }
  assert.equal(lingering, 0, `${lingering} particles still inside the body`);
  // Everything that was inside, plus whatever started within reach, should be
  // sitting on the line now.
  assert.ok(onLine >= near * 0.8, `${onLine} on the outline of ${near} within reach`);
  assert.ok(onLine >= insideBefore, `${onLine} on the outline but ${insideBefore} started inside`);
});

test('when the body leaves, the gathered particles return to rest', () => {
  Object.assign(settings, DEFAULTS);
  settings.drift = 0;
  const p = createParticles(1000);
  const rest = Array.from(p.x);
  const seg = body();
  for (let f = 0; f < 200; f++) p.update(stillFlow, seg, f * 33);
  const disturbed = p.x.reduce((a, v, i) => a + Math.abs(v - rest[i]), 0);
  assert.ok(disturbed > 0, 'the body should have moved something');

  const empty = { mask: new Float32Array(N), influence: new Float32Array(N), sdf: new Float32Array(N).fill(settings.outlineReach), coverage: 0 };
  for (let f = 0; f < 1500; f++) p.update(stillFlow, empty, f * 33);
  const settled = p.x.reduce((a, v, i) => a + Math.abs(v - rest[i]), 0);
  assert.ok(settled < disturbed * 0.3, `should heal: ${disturbed.toFixed(3)} → ${settled.toFixed(3)}`);
});
