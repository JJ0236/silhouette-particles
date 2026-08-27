import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPresence } from '../src/presence.js';
import { createCalibration } from '../src/calib.js';
import { settings, DEFAULTS, TRANSIENT_KEYS } from '../src/config.js';
import { DEFAULT_QUAD } from '../src/homography.js';

const N = 1000;
const maskWith = (fraction) => {
  const m = new Float32Array(N);
  m.fill(1, 0, Math.round(fraction * N));
  return m;
};
// Settle the eased level without advancing past the idle hold.
const run = (p, mask, frames, t0 = 0, step = 16) => {
  let lvl = 0;
  for (let i = 0; i < frames; i++) lvl = p.update(mask, t0 + i * step);
  return lvl;
};

test('an empty room never lights the display', () => {
  const p = createPresence();
  const lvl = run(p, maskWith(0), 60);
  assert.equal(p.present, false);
  assert.equal(lvl, 0, `expected fully dark, got ${lvl}`);
});

test('noise below the arrival threshold is ignored', () => {
  const p = createPresence();
  run(p, maskWith(settings.presenceEnter * 0.5), 60);
  assert.equal(p.present, false, 'sub-threshold speckle should not read as a person');
});

test('someone stepping in wakes it, and the fade eases rather than snaps', () => {
  const p = createPresence();
  const first = p.update(maskWith(0.10), 0);
  assert.equal(p.present, true, 'should register immediately');
  assert.ok(first > 0 && first < 1, `should ease in, got ${first}`);
  const settled = run(p, maskWith(0.10), 120);
  assert.ok(settled > 0.95, `should reach full presence, got ${settled}`);
});

test('hysteresis: hovering between the two thresholds does not strobe', () => {
  const p = createPresence();
  run(p, maskWith(0.10), 60);                       // establish presence
  const between = (settings.presenceEnter + settings.presenceExit) / 2;
  assert.ok(between < settings.presenceEnter && between > settings.presenceExit);
  for (let i = 0; i < 100; i++) {
    p.update(maskWith(between), 1000 + i * 16);
    assert.equal(p.present, true, `dropped out at frame ${i} — that would flicker`);
  }
});

test('a whole-frame lighting change is rejected, not treated as a person', () => {
  const p = createPresence();
  run(p, maskWith(0.95), 30);
  assert.equal(p.present, false, 'coverage above presenceMax is a lighting shift');
});

test('a brief segmentation dropout does not idle the display', () => {
  const p = createPresence();
  let t = 0;
  const body = maskWith(0.10), empty = maskWith(0);
  for (let i = 0; i < 120; i++) { p.update(body, t); t += 16; }
  assert.equal(p.present, true);

  // The model loses them for half a second — common when someone turns side-on.
  for (let i = 0; i < 30; i++) { p.update(empty, t); t += 16; }
  assert.equal(p.present, true, 'a short dropout must not blank the piece');
  assert.ok(p.level > 0.9, `level should barely move, got ${p.level}`);
});

test('it idles once the hold expires, then fades fully dark', () => {
  const p = createPresence();
  let t = 0;
  const body = maskWith(0.10), empty = maskWith(0);
  for (let i = 0; i < 120; i++) { p.update(body, t); t += 16; }

  // Coverage decays rather than snapping to zero, so the hold only starts once
  // it has fallen past the exit threshold — allow for both.
  const frames = Math.ceil(settings.presenceHold / 16) + 120;
  for (let i = 0; i < frames; i++) { p.update(empty, t); t += 16; }
  assert.equal(p.present, false, 'should idle after the hold');

  let lvl = 1;
  for (let i = 0; i < 600; i++) { lvl = p.update(empty, t); t += 16; }
  assert.equal(lvl, 0, `should fade fully dark, got ${lvl}`);
});

test('calibration rejects a corner drag that would collapse the quad', () => {
  const c = createCalibration();
  const before = c.quad.map(p => [...p]);
  const ok = c.setCorner(0, c.quad[2][0], c.quad[2][1]);   // drag TL onto BR
  assert.equal(ok, false, 'should refuse a degenerate quad');
  assert.deepEqual(c.quad, before, 'quad must be left untouched');
});

test('calibration accepts a normal drag and clamps to frame bounds', () => {
  const c = createCalibration();
  assert.ok(c.setCorner(0, 0.10, 0.12));
  assert.deepEqual(c.quad[0], [0.10, 0.12]);
  c.setCorner(1, 5, -3);
  assert.deepEqual(c.quad[1], [1, 0], 'off-frame drags clamp into the sensor');
});

test('nearestCorner grabs the closest handle and nothing far away', () => {
  const c = createCalibration();
  c.reset();
  const [x, y] = DEFAULT_QUAD[2];
  assert.equal(c.nearestCorner(x + 0.005, y + 0.005, 0.045), 2);
  assert.equal(c.nearestCorner(0.5, 0.5, 0.045), -1, 'empty space grabs nothing');
});

test('diagnostic flags are never persisted', () => {
  // Regression: a preview tab opened with ?sim=1 wrote sim:true into the
  // shared origin store, and the real installation came up showing the demo
  // figure instead of the camera.
  for (const k of ['sim', 'showMask', 'showFlow', 'showDiag']) {
    assert.ok(TRANSIENT_KEYS.has(k), `${k} must not reach localStorage`);
    assert.equal(DEFAULTS[k], false, `${k} must default to off`);
  }
  // Look settings must still persist, or tuning is lost on every reload.
  for (const k of ['rimWidth', 'glow', 'push', 'tauLow', 'mirror']) {
    assert.ok(!TRANSIENT_KEYS.has(k), `${k} must persist`);
  }
});
