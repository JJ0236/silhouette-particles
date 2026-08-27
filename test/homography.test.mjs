import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squareToQuad, project, isUsableQuad, DEFAULT_QUAD } from '../src/homography.js';

const p = (H, u, v) => project(H, u, v, [0, 0]);
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

test('unit square corners land exactly on the quad corners', () => {
  // A deliberately keystoned quad: the display seen from off-axis, its far
  // edge shorter than its near edge.
  const quad = [[0.20, 0.30], [0.80, 0.34], [0.86, 0.70], [0.14, 0.66]];
  const H = squareToQuad(quad);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  corners.forEach(([u, v], i) => {
    const [x, y] = p(H, u, v);
    assert.ok(near(x, quad[i][0], 1e-9), `corner ${i} x: ${x} vs ${quad[i][0]}`);
    assert.ok(near(y, quad[i][1], 1e-9), `corner ${i} y: ${y} vs ${quad[i][1]}`);
  });
});

test('an axis-aligned rectangle degenerates to a plain crop', () => {
  const quad = [[0.25, 0.10], [0.75, 0.10], [0.75, 0.60], [0.25, 0.60]];
  const H = squareToQuad(quad);
  assert.equal(H.g, 0, 'no perspective term needed');
  assert.equal(H.h, 0);
  const [x, y] = p(H, 0.5, 0.5);
  assert.ok(near(x, 0.50), `centre x ${x}`);
  assert.ok(near(y, 0.35), `centre y ${y}`);
});

test('keystone actually bends the midline — an affine fit could not', () => {
  // Top edge much narrower than the bottom: a display viewed from below/side.
  const quad = [[0.40, 0.20], [0.60, 0.20], [0.90, 0.80], [0.10, 0.80]];
  const H = squareToQuad(quad);
  const [, midY] = p(H, 0.5, 0.5);
  // Under a projective map the halfway point sits nearer the narrow (far) end
  // than the arithmetic mean of 0.2 and 0.8.
  assert.ok(midY < 0.5, `expected foreshortening, got ${midY}`);
  assert.ok(midY > 0.2, `should stay inside the quad, got ${midY}`);
});

test('straight lines stay straight through the warp', () => {
  const quad = [[0.20, 0.30], [0.80, 0.34], [0.86, 0.70], [0.14, 0.66]];
  const H = squareToQuad(quad);
  const a = p(H, 0, 0.5), b = p(H, 0.5, 0.5), c = p(H, 1, 0.5);
  // Collinearity via cross product of (b-a) and (c-a).
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  assert.ok(Math.abs(cross) < 1e-12, `line bowed: ${cross}`);
});

test('the default quad is usable', () => {
  assert.ok(isUsableQuad(DEFAULT_QUAD));
});

test('degenerate quads are rejected rather than warping to garbage', () => {
  assert.ok(!isUsableQuad([[0, 0], [0, 0], [0, 0], [0, 0]]), 'collapsed to a point');
  assert.ok(!isUsableQuad([[0.1, 0.1], [0.2, 0.1], [0.2, 0.1001], [0.1, 0.1001]]), 'near-zero area');
  assert.ok(!isUsableQuad([[0, 0], [1, 0], [1, NaN], [0, 1]]), 'non-finite corner');
  assert.ok(!isUsableQuad([[0, 0], [1, 0]]), 'wrong corner count');
  assert.ok(!isUsableQuad(null), 'null');
});

test('round trip: a point sampled from display space is inside the quad', () => {
  const quad = [[0.20, 0.30], [0.80, 0.34], [0.86, 0.70], [0.14, 0.66]];
  const H = squareToQuad(quad);
  for (const [u, v] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2], [0.3, 0.8]]) {
    const [x, y] = p(H, u, v);
    assert.ok(x > 0.10 && x < 0.90, `x out of quad bounds: ${x}`);
    assert.ok(y > 0.28 && y < 0.72, `y out of quad bounds: ${y}`);
  }
});
