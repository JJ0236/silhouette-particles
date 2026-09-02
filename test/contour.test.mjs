import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceIsolines } from '../src/contour.js';
import { signedDistance } from '../src/distance.js';

const W = 96, H = 54;

function disc(cx, cy, r, soft = 1.5) {
  const m = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy) - r;
    m[y * W + x] = Math.min(1, Math.max(0, 0.5 - d / soft));
  }
  return m;
}

function loopLength(pts, closed) {
  let s = 0;
  const n = pts.length / 2;
  for (let k = 1; k < n; k++) s += Math.hypot((pts[k * 2] - pts[k * 2 - 2]) * W, (pts[k * 2 + 1] - pts[k * 2 - 1]) * H);
  if (closed) s += Math.hypot((pts[0] - pts[n * 2 - 2]) * W, (pts[1] - pts[n * 2 - 1]) * H);
  return s;
}

test('a soft disc traces to one closed loop of about the right perimeter', () => {
  const loops = traceIsolines(disc(48, 27, 14), W, H);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].closed);
  const len = loopLength(loops[0].pts, true);
  const expect = 2 * Math.PI * 14;
  assert.ok(Math.abs(len - expect) / expect < 0.08, `perimeter ${len.toFixed(1)} vs ${expect.toFixed(1)}`);
  // Every vertex sits within half a cell of the true circle: sub-cell, not
  // stepped cell to cell.
  const pts = loops[0].pts;
  for (let k = 0; k < pts.length; k += 2) {
    const r = Math.hypot(pts[k] * W - 0.5 - 48, pts[k + 1] * H - 0.5 - 27);
    assert.ok(Math.abs(r - 14) < 0.6, `vertex at radius ${r.toFixed(2)}`);
  }
});

test('speckle below the minimum length is dropped, the body is kept', () => {
  const m = disc(48, 27, 14);
  m[5 * W + 5] = 1;   // one lone cell
  const loops = traceIsolines(m, W, H, { minLength: 6 });
  assert.equal(loops.length, 1);
});

test('a body cut by the frame edge traces as an open chain, not nothing', () => {
  const loops = traceIsolines(disc(0, 27, 14), W, H);
  assert.ok(loops.length >= 1);
  assert.ok(loops.some((l) => !l.closed));
});

test('an empty mask traces to nothing', () => {
  assert.equal(traceIsolines(new Float32Array(W * H), W, H).length, 0);
});

test('signed distance: negative inside, positive outside, near zero at the edge', () => {
  const bin = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 48, y - 27) <= 14) bin[y * W + x] = 1;
  const sd = signedDistance(bin, W, H, new Float32Array(W * H), 16);
  // Inside is never capped: the centre of a 14-cell disc is ~13.5 cells in.
  assert.ok(sd[27 * W + 48] < -12.5 && sd[27 * W + 48] > -15, `centre ${sd[27 * W + 48]}`);
  assert.ok(sd[27 * W + 48 + 20] > 5 && sd[27 * W + 48 + 20] < 7, `outside ${sd[27 * W + 68]}`);
  assert.ok(Math.abs(sd[27 * W + 48 + 14]) < 1, `edge ${sd[27 * W + 62]}`);
  assert.equal(sd[0], 16, 'capped far away');
});

test('signed distance of an empty mask is the cap everywhere', () => {
  const sd = signedDistance(new Uint8Array(W * H), W, H, new Float32Array(W * H), 10);
  assert.ok(sd.every((v) => v === 10));
});
