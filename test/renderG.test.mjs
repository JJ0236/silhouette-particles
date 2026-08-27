import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrame, synthPerson, movingPerson, randomParticles, driftParticles, renderPatches, RENDER_DEFAULTS, hsl } from '../src/renderG.js';

const W = 480, H = 270, N = W * H;
const S = RENDER_DEFAULTS;
const px = (out, x, y, ch = 1) => out[(y * W + x) * 3 + ch];

test('void floor: 5% of 255 everywhere with no content (glow off), and never below it with glow', () => {
  const rim = new Float32Array(N);
  const out = renderFrame({ rim, settings: { ...S, glow: 0 } }, new Uint8Array(N * 3));
  assert.ok(out.every((v) => v === 13), 'floor = round(0.05·255) = 13');
  const out2 = renderFrame({ rim, settings: S }, new Uint8Array(N * 3));
  const v = out2[0];
  assert.ok(v >= 13 && out2.every((x) => x === v), `uniform and at least the floor, got ${v}`);
  const out3 = renderFrame({ rim, settings: { ...S, voidFloor: 0, glow: 0 } }, new Uint8Array(N * 3));
  assert.ok(out3.every((x) => x === 0), 'floor 0 renders black');
});

test('rim cells come out in the outline hue, brighter than the floor, scaled by presence and rimGain', () => {
  const rim = new Float32Array(N);
  rim[100 * W + 200] = 1;
  const out = renderFrame({ rim, settings: { ...S, glow: 0 } }, new Uint8Array(N * 3));
  const [r, g, b] = hsl(S.outlineHue, 0.85, 0.6);
  assert.ok(px(out, 200, 100, 1) > 13 && px(out, 200, 100, 2) > 13, 'brighter than floor');
  assert.ok(px(out, 200, 100, 2) >= px(out, 200, 100, 0), 'cyan: blue ≥ red');
  assert.equal(px(out, 200, 100, 1), Math.min(255, 13 + g), 'alpha caps at 1 (rim 1 × gain 1.7 → 1)');
  rim[100 * W + 200] = 0.3;
  const half = renderFrame({ rim, settings: { ...S, glow: 0 } }, new Uint8Array(N * 3));
  assert.ok(Math.abs(px(half, 200, 100, 1) - (13 + g * 0.3 * S.rimGain)) <= 1, 'rim × rimGain when unsaturated');
  const faded = renderFrame({ rim, presence: 0, settings: { ...S, glow: 0 } }, new Uint8Array(N * 3));
  assert.equal(px(faded, 200, 100, 1), 13, 'presence 0 hides the rim');
  void r; void b;
});

test('particles are drawn as amber cells at (x·w, y·h) with particleAlpha', () => {
  const rim = new Float32Array(N);
  const parts = { x: Float32Array.from([0.5, 0.1]), y: Float32Array.from([0.5, 0.9]), count: 2 };
  const out = renderFrame({ rim, particles: parts, settings: { ...S, glow: 0 } }, new Uint8Array(N * 3));
  const [pr, pg, pb] = hsl(S.particleHue, 0.9, 0.62);
  const x = Math.floor(0.5 * W), y = Math.floor(0.5 * H);
  assert.ok(Math.abs(px(out, x, y, 0) - (13 + pr * S.particleAlpha)) <= 1, 'red channel');
  assert.ok(Math.abs(px(out, x, y, 1) - (13 + pg * S.particleAlpha)) <= 1, 'green channel');
  assert.ok(px(out, x, y, 0) > px(out, x, y, 2), 'amber: red > blue');
  assert.ok(px(out, Math.floor(parts.x[1] * W), Math.floor(parts.y[1] * H), 0) > 13, 'second dot');
  assert.equal(px(out, x + 3, y, 0), 13, 'nothing next to it');
  void pb;
});

test('bloom widens the lit content by the blur radius and scales with glow', () => {
  const rim = new Float32Array(N);
  rim[100 * W + 200] = 1;
  const off = renderFrame({ rim, settings: { ...S, glow: 0 } }, new Uint8Array(N * 3));
  const on = renderFrame({ rim, settings: S }, new Uint8Array(N * 3));
  const far = px(on, 300, 100, 1);
  assert.equal(px(off, 202, 100, 1), 13, 'no bloom without glow');
  assert.ok(px(on, 202, 100, 1) > far, 'two cells away is lit by the bloom');
  assert.ok(px(on, 200, 102, 1) > far, 'vertically too');
  assert.equal(px(on, 203, 100, 1), far, 'three cells away is outside radius 2');
  assert.ok(px(on, 200, 100, 1) >= px(off, 200, 100, 1), 'bloom only adds');
  const more = renderFrame({ rim, settings: { ...S, glow: 0.8 } }, new Uint8Array(N * 3));
  assert.ok(px(more, 202, 100, 1) > px(on, 202, 100, 1), 'more glow, more bloom');
});

test('synthPerson: five fingers, 3 cells wide, 2-cell gaps, all inside the occluder', () => {
  const occ = synthPerson(W, H, { cx: 200, cy: 150 });
  const { fingerCells, gapCells } = synthPerson.last;
  assert.equal(fingerCells.length, 5);
  assert.equal(gapCells.length, 4);
  for (const f of fingerCells) {
    const rows = new Set(), cols = new Set();
    for (const c of f) { rows.add(Math.floor(c / W)); cols.add(c % W); assert.equal(occ[c], 1); }
    assert.equal(rows.size, 3, 'finger is 3 rows tall');
    assert.ok(cols.size >= 6, 'and has length');
  }
  for (const g of gapCells) {
    const rows = new Set();
    for (const c of g) { rows.add(Math.floor(c / W)); assert.equal(occ[c], 0, 'gap cell is empty'); }
    assert.equal(rows.size, 2, 'gap is 2 rows');
  }
  // consecutive fingers are separated by exactly the gap
  for (let k = 0; k < 4; k++) {
    const top = (f) => Math.min(...Array.from(f, (c) => Math.floor(c / W)));
    assert.equal(top(fingerCells[k + 1]) - top(fingerCells[k]), 5);
  }
  assert.equal(occ[150 * W + 200], 1, 'torso');
  assert.equal(occ[(150 - 62) * W + 200], 1, 'head');
  assert.equal(occ[(150 + 80) * W + (200 - 11)], 1, 'leg');
  assert.equal(occ[10 * W + 10], 0, 'background');
  assert.ok(occ.every((v) => v === 0 || v === 1));
  const area = occ.reduce((s, v) => s + v, 0);
  assert.ok(area > 5000 && area < 20000, `plausible area ${area}`);
  const noFingers = synthPerson(W, H, { cx: 200, cy: 150, fingers: false });
  assert.equal(synthPerson.last.fingerCells.length, 0);
  assert.ok(noFingers.reduce((s, v) => s + v, 0) < area);
  const big = synthPerson(W, H, { cx: 200, cy: 150, scale: 1.3 });
  assert.ok(big.reduce((s, v) => s + v, 0) > area, 'scale enlarges the body');
  assert.equal(synthPerson.last.fingerCells.length, 5, 'fingers survive scaling');
});

test('movingPerson advances speedCells per frame and bounces inside the frame', () => {
  const left = (occ) => { for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (occ[y * W + x]) return x; return -1; };
  const a = left(movingPerson(W, H, 10, { speedCells: 3 }));
  const b = left(movingPerson(W, H, 11, { speedCells: 3 }));
  assert.equal(b - a, 3);
  for (let i = 0; i < 400; i += 37) {
    const occ = movingPerson(W, H, i, { speedCells: 3 });
    assert.equal(synthPerson.last.fingerCells.length, 5);
    for (const f of synthPerson.last.fingerCells) for (const c of f) assert.equal(occ[c], 1, `frame ${i}: fingers stay inside the grid`);
  }
});

test('randomParticles and driftParticles are deterministic', () => {
  const a = randomParticles(50, 9), b = randomParticles(50, 9), c = randomParticles(50, 10);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.x, c.x);
  assert.ok(Array.from(a.x).every((v) => v >= 0 && v < 1));
  const d = driftParticles(a, 100);
  assert.ok(Array.from(d.x).every((v) => v >= 0 && v < 1) && d.x[0] !== a.x[0]);
  assert.deepEqual(driftParticles(a, 100), d);
});

test('renderPatches lights the listed patches at the level and nothing else', () => {
  const layout = { cells: [Int32Array.from([0, 1, 2]), Int32Array.from([10, 11])] };
  const out = renderPatches(layout, { lit: [1], level: 128 }, new Uint8Array(12 * 3).fill(7));
  assert.equal(out[0], 0);
  assert.equal(out[10 * 3], 128); assert.equal(out[11 * 3 + 2], 128);
});
