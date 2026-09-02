import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateUnseen } from '../src/structured.js';

// A speaker hangs in front of the top of the screen. The camera never saw the
// cells behind it; the hole fill pointed them at neighbouring pixels; the
// photometric pass found those pixels bright and called the cells observable.
// They must be struck, with a margin, and nothing else may be touched.

test('cells the camera never saw are struck from observable, with a margin', () => {
  const w = 40, h = 20;
  const valid = new Uint8Array(w * h).fill(1);
  const observable = new Uint8Array(w * h).fill(1);
  // Speaker: columns 10..19 of rows 0..3 were never decoded.
  for (let y = 0; y <= 3; y++) for (let x = 10; x <= 19; x++) valid[y * w + x] = 0;
  const struck = gateUnseen(observable, valid, w, h, 2);

  assert.ok(struck > 0);
  for (let y = 0; y <= 3; y++) for (let x = 10; x <= 19; x++) assert.equal(observable[y * w + x], 0, `behind speaker ${x},${y}`);
  // Margin of two cells around it.
  assert.equal(observable[5 * w + 15], 0, 'row 5 is within the margin');
  assert.equal(observable[2 * w + 8], 0, 'column 8 is within the margin');
  // Beyond the margin: untouched.
  assert.equal(observable[6 * w + 15], 1, 'row 6 is beyond the margin');
  assert.equal(observable[2 * w + 7], 1, 'column 7 is beyond the margin');
  assert.equal(observable[15 * w + 30], 1);
});

test('a fully seen screen loses nothing', () => {
  const w = 30, h = 10;
  const observable = new Uint8Array(w * h).fill(1);
  assert.equal(gateUnseen(observable, new Uint8Array(w * h).fill(1), w, h, 2), 0);
  assert.ok(observable.every((v) => v === 1));
});
