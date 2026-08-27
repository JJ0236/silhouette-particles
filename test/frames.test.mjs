import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRing } from '../src/frames.js';

const SIZE = 12;
const frame = (v) => new Uint8Array(SIZE).map((_, i) => (v * 7 + i * 13) & 255);

test('push copies the frame and length grows up to the entry count', () => {
  const ring = createRing({ entries: 4, size: SIZE });
  assert.equal(ring.length, 0);
  assert.equal(ring.latest(), null);
  const f = frame(1);
  ring.push(f, 100);
  f.fill(0);
  assert.equal(ring.length, 1);
  assert.deepEqual(Array.from(ring.latest().rgb), Array.from(frame(1)), 'the ring holds its own copy');
  assert.equal(ring.latest().t, 100);
  for (let i = 2; i <= 6; i++) ring.push(frame(i), 100 * i);
  assert.equal(ring.length, 4, 'capped at entries');
});

test('wrap-around keeps the newest entries and drops the oldest', () => {
  const ring = createRing({ entries: 3, size: SIZE });
  for (let i = 1; i <= 5; i++) ring.push(frame(i), i * 10);
  assert.equal(ring.latest().t, 50);
  assert.deepEqual(Array.from(ring.latest().rgb), Array.from(frame(5)));
  const sel = ring.select(-Infinity, Infinity);
  assert.equal(sel.length, 3);
  const dst = new Uint8Array(SIZE);
  assert.equal(ring.minOver(0, 25, dst), 0, 'frames at t=10 and t=20 were overwritten');
  assert.equal(ring.minOver(30, 30, dst), 1, 'the oldest survivor is t=30');
  assert.deepEqual(Array.from(dst), Array.from(frame(3)));
});

test('select is inclusive at both window edges and ordered oldest first', () => {
  const ring = createRing({ entries: 8, size: SIZE });
  for (let i = 0; i < 6; i++) ring.push(frame(i), 100 + i * 10);   // t = 100..150
  const sel = ring.select(110, 130);
  assert.equal(sel.length, 3);
  const dst = new Uint8Array(SIZE);
  // The indices are opaque, so check ordering through the frames they select.
  for (let k = 0; k < sel.length; k++) {
    const t = 110 + k * 10;
    assert.equal(ring.minOver(t, t, dst), 1);
    assert.deepEqual(Array.from(dst), Array.from(frame(k + 1)), `entry ${k} is t=${t}`);
  }
  assert.equal(ring.select(131, 139).length, 0);
  assert.equal(ring.select(150, 150).length, 1);
  assert.equal(ring.select(100, 100).length, 1);
  assert.equal(ring.select(200, 100).length, 0, 'inverted window selects nothing');
});

test('select order follows push order even after wrap-around', () => {
  const ring = createRing({ entries: 4, size: SIZE });
  for (let i = 0; i < 7; i++) ring.push(frame(i), i);
  const sel = ring.select(0, 100);
  assert.equal(sel.length, 4);
  // Oldest surviving push is t=3; verify by building a probe around each index.
  const dst = new Uint8Array(SIZE);
  const ts = [];
  for (let t = 3; t <= 6; t++) { assert.equal(ring.minOver(t, t, dst), 1); ts.push(dst[0]); }
  assert.deepEqual(ts, [3, 4, 5, 6].map((v) => frame(v)[0]));
});

test('minOver and maxOver match a brute-force per-byte reduction', () => {
  const ring = createRing({ entries: 6, size: SIZE });
  const frames = [];
  let seed = 3;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) & 255;
  for (let i = 0; i < 9; i++) {
    const f = new Uint8Array(SIZE).map(() => rnd());
    frames.push({ f, t: 1000 + i * 16 });
    ring.push(f, 1000 + i * 16);
  }
  const t0 = 1000 + 4 * 16, t1 = 1000 + 7 * 16;
  const inWin = frames.filter(({ t }) => t >= t0 && t <= t1);
  assert.equal(inWin.length, 4);
  const mn = new Uint8Array(SIZE), mx = new Uint8Array(SIZE);
  assert.equal(ring.minOver(t0, t1, mn), 4);
  assert.equal(ring.maxOver(t0, t1, mx), 4);
  for (let i = 0; i < SIZE; i++) {
    assert.equal(mn[i], Math.min(...inWin.map(({ f }) => f[i])), `min byte ${i}`);
    assert.equal(mx[i], Math.max(...inWin.map(({ f }) => f[i])), `max byte ${i}`);
  }
});

test('an empty window returns 0 and leaves dst untouched', () => {
  const ring = createRing({ entries: 4, size: SIZE });
  const dst = new Uint8Array(SIZE).fill(77);
  assert.equal(ring.minOver(0, 100, dst), 0, 'empty ring');
  assert.equal(ring.maxOver(0, 100, dst), 0);
  ring.push(frame(1), 50);
  assert.equal(ring.minOver(60, 100, dst), 0, 'no entry in window');
  assert.equal(ring.maxOver(0, 40, dst), 0);
  assert.ok(dst.every((v) => v === 77));
});

test('clear resets the ring', () => {
  const ring = createRing({ entries: 4, size: SIZE });
  for (let i = 0; i < 6; i++) ring.push(frame(i), i);
  ring.clear();
  assert.equal(ring.length, 0);
  assert.equal(ring.latest(), null);
  assert.equal(ring.select(-Infinity, Infinity).length, 0);
  const dst = new Uint8Array(SIZE).fill(9);
  assert.equal(ring.minOver(-Infinity, Infinity, dst), 0);
  assert.ok(dst.every((v) => v === 9));
  ring.push(frame(9), 999);
  assert.equal(ring.length, 1);
  assert.equal(ring.latest().t, 999);
});

test('non-monotonic timestamps still select by value', () => {
  const ring = createRing({ entries: 8, size: SIZE });
  const ts = [50, 20, 80, 10, 60];
  ts.forEach((t, i) => ring.push(frame(i), t));
  assert.equal(ring.select(15, 55).length, 2, 't=50 and t=20');
  const dst = new Uint8Array(SIZE);
  assert.equal(ring.minOver(15, 55, dst), 2);
  for (let i = 0; i < SIZE; i++) assert.equal(dst[i], Math.min(frame(0)[i], frame(1)[i]));
  assert.equal(ring.latest().t, 60, 'latest is the most recent push, not the largest timestamp');
  assert.equal(ring.select(80, 80).length, 1);
});

test('default entry count is 24', () => {
  const ring = createRing({ size: SIZE });
  for (let i = 0; i < 30; i++) ring.push(frame(i), i);
  assert.equal(ring.length, 24);
});
