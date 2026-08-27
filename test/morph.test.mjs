import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  erode, open, close, components, removeSmall, fillHoles, hysteresis, temporalMedian3, linearise,
} from '../src/morph.js';

const W = 480, H = 270, N = W * H;

// Deterministic noise so the brute-force comparison is reproducible.
const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

const rect = (bin, w, x0, y0, x1, y1, v = 1) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bin[y * w + x] = v;
  return bin;
};
const count1 = (bin) => bin.reduce((s, v) => s + v, 0);
const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

// Five vertical fingers, 3 cells wide, 2-cell gaps, rising from a palm that
// touches the bottom border. This is the shape every finger test is about.
const FINGER_X0 = 200, FINGER_TOP = 100, PALM_TOP = 180;
const fingerColumns = (k) => [FINGER_X0 + k * 5, FINGER_X0 + k * 5 + 2];
function hand(withPalm = true) {
  const bin = new Uint8Array(N);
  for (let k = 0; k < 5; k++) {
    const [x0, x1] = fingerColumns(k);
    rect(bin, W, x0, FINGER_TOP, x1, withPalm ? H - 1 : PALM_TOP);
  }
  if (withPalm) rect(bin, W, FINGER_X0, PALM_TOP, FINGER_X0 + 22, H - 1);
  return bin;
}

test('erode radius 0 is a copy for Uint8 and Float32', () => {
  const w = 7, h = 5, n = w * h;
  const u = new Uint8Array(n).map((_, i) => i % 2), ud = new Uint8Array(n), ut = new Uint8Array(n);
  assert.equal(erode(u, ud, w, h, 0, ut), ud, 'returns dst');
  assert.ok(same(u, ud));
  const f = new Float32Array(n).map((_, i) => i * 0.5), fd = new Float32Array(n), ft = new Float32Array(n);
  erode(f, fd, w, h, 0, ft);
  assert.ok(same(f, fd));
});

test('erode on Float32 matches a brute-force window min with clamped edges', () => {
  const w = 17, h = 11, n = w * h, r = 2;
  const rnd = lcg(7);
  const src = new Float32Array(n).map(() => rnd());
  const dst = new Float32Array(n), tmp = new Float32Array(n);
  erode(src, dst, w, h, r, tmp);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
          m = Math.min(m, src[yy * w + xx]);
        }
      }
      assert.equal(dst[y * w + x], m, `cell ${x},${y}`);
    }
  }
});

test('erode on Uint8 shrinks a 5x5 block to 3x3 at r=1', () => {
  const w = 9, h = 9, n = w * h;
  const src = rect(new Uint8Array(n), w, 2, 2, 6, 6);
  const dst = new Uint8Array(n), tmp = new Uint8Array(n);
  erode(src, dst, w, h, 1, tmp);
  assert.ok(same(dst, rect(new Uint8Array(n), w, 3, 3, 5, 5)));
});

test('open r=1 removes 1- and 2-wide lines but keeps a 3-wide finger intact', () => {
  const bin = new Uint8Array(N), dst = new Uint8Array(N), tmp = new Uint8Array(N);
  rect(bin, W, 10, 20, 10, 120);   // 1 wide
  rect(bin, W, 30, 20, 31, 120);   // 2 wide
  rect(bin, W, 50, 20, 52, 120);   // 3 wide
  rect(bin, W, 100, 40, 200, 40);  // 1 tall
  rect(bin, W, 100, 60, 200, 61);  // 2 tall
  rect(bin, W, 100, 80, 200, 82);  // 3 tall
  assert.equal(open(bin, dst, W, H, 1, tmp), dst, 'returns dst');
  const expect = new Uint8Array(N);
  rect(expect, W, 50, 20, 52, 120);
  rect(expect, W, 100, 80, 200, 82);
  assert.ok(same(dst, expect), 'thin lines gone, 3-wide lines exactly preserved');
  const before = bin.slice();
  open(bin, dst, W, H, 0, tmp);
  assert.ok(same(dst, bin) && same(bin, before), 'r=0 is identity and does not touch the input');
});

test('open r=1 leaves the whole hand untouched', () => {
  const bin = hand(), dst = new Uint8Array(N), tmp = new Uint8Array(N);
  open(bin, dst, W, H, 1, tmp);
  assert.ok(same(dst, bin));
});

test('close r=1 fills 1-cell gaps but does not fill a 2-cell gap', () => {
  const bin = new Uint8Array(N), dst = new Uint8Array(N), tmp = new Uint8Array(N);
  rect(bin, W, 10, 10, 20, 40); rect(bin, W, 22, 10, 32, 40);     // 1-cell vertical gap at x=21
  rect(bin, W, 60, 10, 90, 20); rect(bin, W, 60, 22, 90, 32);     // 1-cell horizontal gap at y=21
  rect(bin, W, 110, 10, 120, 40); rect(bin, W, 123, 10, 133, 40); // 2-cell gap at x=121,122
  rect(bin, W, 160, 10, 190, 20); rect(bin, W, 160, 23, 190, 33); // 2-cell gap at y=21,22
  assert.equal(close(bin, dst, W, H, 1, tmp), dst, 'returns dst');
  for (let y = 10; y <= 40; y++) assert.equal(dst[y * W + 21], 1, `1-cell column gap filled at y=${y}`);
  for (let x = 60; x <= 90; x++) assert.equal(dst[21 * W + x], 1, `1-cell row gap filled at x=${x}`);
  for (let y = 10; y <= 40; y++) {
    assert.equal(dst[y * W + 121], 0, `2-cell column gap survives at y=${y}`);
    assert.equal(dst[y * W + 122], 0);
  }
  for (let x = 160; x <= 190; x++) {
    assert.equal(dst[21 * W + x], 0, `2-cell row gap survives at x=${x}`);
    assert.equal(dst[22 * W + x], 0);
  }
  for (let i = 0; i < N; i++) if (bin[i]) assert.equal(dst[i], 1, 'closing never removes a set cell');
  close(bin, dst, W, H, 0, tmp);
  assert.ok(same(dst, bin), 'r=0 is identity');
});

test('close r=1 keeps the gaps between fingers', () => {
  const bin = hand(), dst = new Uint8Array(N), tmp = new Uint8Array(N);
  close(bin, dst, W, H, 1, tmp);
  assert.ok(same(dst, bin), 'the hand is already closed under r=1');
});

test('components counts five detached fingers and flags the ones touching the border', () => {
  const bin = hand(false), labels = new Int32Array(N), stack = new Int32Array(N);
  // Push fingers 0 and 4 down to the bottom edge so they touch the border.
  for (const k of [0, 4]) { const [x0, x1] = fingerColumns(k); rect(bin, W, x0, PALM_TOP, x1, H - 1); }
  const { count, areas, touchesBorder } = components(bin, W, H, labels, stack);
  assert.equal(count, 5);
  assert.equal(areas.length, 6);
  assert.equal(touchesBorder.length, 6);
  assert.equal(areas[0], N - count1(bin), 'areas[0] is the background');
  const perFinger = 3 * (PALM_TOP - FINGER_TOP + 1);
  const tall = 3 * (H - FINGER_TOP);
  const seen = new Set();
  for (let k = 0; k < 5; k++) {
    const [x0] = fingerColumns(k);
    const l = labels[FINGER_TOP * W + x0];
    assert.ok(l >= 1 && l <= 5, 'labels are 1..count');
    assert.ok(!seen.has(l), 'every finger gets its own label');
    seen.add(l);
    const border = k === 0 || k === 4;
    assert.equal(areas[l], border ? tall : perFinger, `finger ${k} area`);
    assert.equal(touchesBorder[l], border ? 1 : 0, `finger ${k} border flag`);
    // Every cell of the finger carries the same label.
    for (let y = FINGER_TOP; y <= PALM_TOP; y++) for (let x = x0; x < x0 + 3; x++) assert.equal(labels[y * W + x], l);
  }
  for (let i = 0; i < N; i++) if (!bin[i]) assert.equal(labels[i], 0);
});

test('components is 4-connected: diagonal neighbours are separate', () => {
  const w = 4, h = 4, n = w * h;
  const bin = new Uint8Array(n); bin[0] = 1; bin[1 * w + 1] = 1; bin[2 * w + 2] = 1;
  const { count } = components(bin, w, h, new Int32Array(n), new Int32Array(n));
  assert.equal(count, 3);
  const empty = components(new Uint8Array(n), w, h, new Int32Array(n), new Int32Array(n));
  assert.equal(empty.count, 0);
  assert.equal(empty.areas[0], n);
});

test('components handles one component covering the whole grid without recursion', () => {
  const bin = new Uint8Array(N).fill(1);
  const { count, areas, touchesBorder } = components(bin, W, H, new Int32Array(N), new Int32Array(N));
  assert.equal(count, 1);
  assert.equal(areas[1], N);
  assert.equal(touchesBorder[1], 1);
});

test('removeSmall drops components below minArea in place', () => {
  const w = 20, h = 10, n = w * h;
  const bin = new Uint8Array(n);
  rect(bin, w, 1, 1, 2, 2);      // area 4
  rect(bin, w, 6, 1, 8, 3);      // area 9
  rect(bin, w, 12, 1, 16, 1);    // area 5
  const labels = new Int32Array(n), stack = new Int32Array(n);
  const { areas } = components(bin, w, h, labels, stack);
  assert.equal(removeSmall(bin, labels, areas, 5), bin, 'returns bin');
  const expect = new Uint8Array(n);
  rect(expect, w, 6, 1, 8, 3);
  rect(expect, w, 12, 1, 16, 1);
  assert.ok(same(bin, expect), 'area 4 removed, areas 5 and 9 kept');
});

// A closed ring with a 5x2 hole, plus a bay open to the frame edge.
function ringWithHole(w, h) {
  const bin = new Uint8Array(w * h);
  rect(bin, w, 5, 5, 15, 12);
  rect(bin, w, 8, 8, 12, 9, 0);    // 10-cell hole
  rect(bin, w, 20, 0, 30, 6);
  rect(bin, w, 23, 0, 27, 3, 0);   // 20-cell bay touching the top border
  return bin;
}

test('fillHoles fills an enclosed 10-cell hole but not a hole touching the border', () => {
  const w = 40, h = 20, n = w * h;
  const bin = ringWithHole(w, h);
  const before = bin.slice();
  const out = fillHoles(bin, w, h, { maxArea: 50, accept: () => true }, new Int32Array(n), new Int32Array(n), new Uint8Array(n));
  assert.equal(out, bin, 'returns bin');
  const expect = before.slice();
  rect(expect, w, 8, 8, 12, 9);
  assert.ok(same(bin, expect), 'hole filled, bay untouched, nothing else changed');
});

test('fillHoles respects maxArea', () => {
  const w = 40, h = 20, n = w * h;
  const bin = ringWithHole(w, h);
  const before = bin.slice();
  fillHoles(bin, w, h, { maxArea: 9, accept: () => true }, new Int32Array(n), new Int32Array(n), new Uint8Array(n));
  assert.ok(same(bin, before), 'a 10-cell hole is left alone when maxArea is 9');
  fillHoles(bin, w, h, { maxArea: 10, accept: () => true }, new Int32Array(n), new Int32Array(n), new Uint8Array(n));
  assert.equal(count1(bin), count1(before) + 10, 'maxArea is inclusive');
});

test('fillHoles consults accept with the label, area and the exact cells of the hole', () => {
  const w = 40, h = 20, n = w * h;
  const bin = ringWithHole(w, h);
  rect(bin, w, 5, 14, 9, 18); rect(bin, w, 7, 16, 7, 16, 0);   // second hole: 1 cell
  const before = bin.slice();
  const calls = [];
  const labels = new Int32Array(n), stack = new Int32Array(n), tmp = new Uint8Array(n);
  fillHoles(bin, w, h, {
    maxArea: 50,
    accept: ({ label, area, cells }) => {
      assert.ok(cells instanceof Int32Array);
      assert.equal(cells.length, area);
      for (const i of cells) assert.equal(before[i], 0, 'cells are background cells of the input');
      calls.push({ label, area, cells: Array.from(cells).sort((a, b) => a - b) });
      return area === 1;   // only the tiny hole
    },
  }, labels, stack, tmp);
  assert.equal(calls.length, 2, 'only enclosed holes are offered');
  const big = calls.find((c) => c.area === 10), small = calls.find((c) => c.area === 1);
  assert.ok(big && small);
  const holeCells = []; for (let y = 8; y <= 9; y++) for (let x = 8; x <= 12; x++) holeCells.push(y * w + x);
  assert.deepEqual(big.cells, holeCells);
  assert.deepEqual(small.cells, [16 * w + 7]);
  assert.ok(big.label !== small.label && big.label >= 1 && small.label >= 1);
  const expect = before.slice(); expect[16 * w + 7] = 1;
  assert.ok(same(bin, expect), 'only the accepted hole is filled');
});

test('hysteresis keeps candidates connected to a seed and drops detached blobs', () => {
  const w = 30, h = 12, n = w * h;
  const seed = new Uint8Array(n), cand = new Uint8Array(n), dst = new Uint8Array(n), stack = new Int32Array(n);
  rect(cand, w, 2, 2, 12, 8); rect(seed, w, 5, 4, 6, 5);            // blob with a seed inside
  rect(cand, w, 16, 2, 26, 8);                                       // detached blob, no seed
  rect(cand, w, 13, 5, 15, 5); cand[5 * w + 14] = 0;                 // broken bridge between them
  assert.equal(hysteresis(seed, cand, w, h, dst, stack), dst, 'returns dst');
  const expect = new Uint8Array(n); rect(expect, w, 2, 2, 12, 8); expect[5 * w + 13] = 1;
  assert.ok(same(dst, expect), 'reachable candidates survive, detached blob dropped');
  cand[5 * w + 14] = 1;                                              // repair the bridge
  hysteresis(seed, cand, w, h, dst, stack);
  rect(expect, w, 13, 5, 15, 5); rect(expect, w, 16, 2, 26, 8);
  assert.ok(same(dst, expect), 'once connected, the second blob is kept too');
});

test('hysteresis is 4-connected and never propagates through non-candidates', () => {
  const w = 5, h = 5, n = w * h;
  const seed = new Uint8Array(n), cand = new Uint8Array(n), dst = new Uint8Array(n), stack = new Int32Array(n);
  seed[0] = 1; cand[0] = 1; cand[1 * w + 1] = 1; cand[2 * w + 2] = 1;
  hysteresis(seed, cand, w, h, dst, stack);
  assert.equal(count1(dst), 1, 'diagonal-only candidates are not reached');
  const none = hysteresis(new Uint8Array(n), cand, w, h, dst, stack);
  assert.equal(count1(none), 0, 'no seed → nothing');
});

test('hysteresis at full grid size covers everything from a single seed', () => {
  const seed = new Uint8Array(N), cand = new Uint8Array(N).fill(1), dst = new Uint8Array(N), stack = new Int32Array(N);
  seed[N - 1] = 1;
  hysteresis(seed, cand, W, H, dst, stack);
  assert.equal(count1(dst), N);
});

test('temporalMedian3 is the per-cell majority', () => {
  const a = Uint8Array.from([0, 0, 0, 0, 1, 1, 1, 1]);
  const b = Uint8Array.from([0, 0, 1, 1, 0, 0, 1, 1]);
  const c = Uint8Array.from([0, 1, 0, 1, 0, 1, 0, 1]);
  const dst = new Uint8Array(8);
  assert.equal(temporalMedian3(a, b, c, dst), dst, 'returns dst');
  assert.deepEqual(Array.from(dst), [0, 0, 0, 1, 0, 1, 1, 1]);
});

test('linearise is monotone with out[pedestal]=0 and out[255]=1', () => {
  const out = new Float32Array(256);
  assert.equal(linearise(8, 2.2, out), out, 'returns out');
  assert.equal(out[8], 0);
  for (let c = 0; c < 8; c++) assert.equal(out[c], 0, 'below the pedestal is clamped to 0');
  assert.ok(Math.abs(out[255] - 1) < 1e-6);
  for (let c = 1; c < 256; c++) assert.ok(out[c] >= out[c - 1], `monotone at ${c}`);
  assert.ok(out[9] > 0 && out[128] > out[64]);
  assert.ok(Math.abs(out[132] - ((132 - 8) / 247) ** 2.2) < 1e-6, 'follows the contract formula');
  linearise(0, 1, out);
  assert.ok(Math.abs(out[51] - 0.2) < 1e-6, 'gamma 1, pedestal 0 is a straight ramp');
});
