import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameHold, specAt, holdAgeAt } from '../src/timeline.js';

// Reproduce the driver's behaviour: it repaints every frame (~16ms), showing the
// same pattern for a whole hold before moving on.
function paintLog({ holds = 4, holdFrames = 11, paintMs = 16 } = {}) {
  const painted = [];
  let t = 0;
  for (let h = 0; h < holds; h++) {
    for (let f = 0; f < holdFrames; f++) {
      painted.push({
        t,
        spec: { kind: 'x', bit: 3, invert: h % 2 === 1, step: h, settle: f === 0 },
      });
      t += paintMs;
    }
  }
  return { painted, span: t };
}

test('a hold is recognised across its repaints', () => {
  const a = { kind: 'x', bit: 3, invert: false, step: 7, settle: true };
  const b = { kind: 'x', bit: 3, invert: false, step: 7, settle: false };
  // settle differs between the first frame of a hold and the rest, which is
  // exactly the boundary this has to see through.
  assert.ok(sameHold(a, b));
  assert.ok(!sameHold(a, { ...a, invert: true }));
  assert.ok(!sameHold(a, { ...a, bit: 4 }));
  assert.ok(!sameHold(a, { ...a, step: 8 }));
  assert.ok(!sameHold(a, null));
});

test('age is measured from the pattern change, not the last repaint', () => {
  // The bug: measuring from the last repaint caps age at the paint interval, so
  // a settle window wider than one frame rejects EVERY camera frame and the
  // decoder is never fed anything. Coverage is then structurally zero, which is
  // indistinguishable from an optical failure.
  const { painted } = paintLog({ holdFrames: 11, paintMs: 16 });
  const holdMs = 11 * 16;
  // Just after a hold begins: young.
  assert.ok(holdAgeAt(painted, holdMs + 5) < 40);
  // Late in the same hold: old, even though a repaint happened 1ms ago.
  assert.ok(holdAgeAt(painted, holdMs * 2 - 5) > 140,
    `expected the age to grow across a hold, got ${holdAgeAt(painted, holdMs * 2 - 5)}`);
});

test('a realistic 30fps camera gets usable frames from every hold', () => {
  const SETTLE = 60;
  const { painted, span } = paintLog({ holds: 6, holdFrames: 11, paintMs: 16 });
  const accepted = new Map();
  for (let t = 0; t < span; t += 1000 / 30) {
    const spec = specAt(painted, t);
    if (!spec || spec.settle) continue;
    if (holdAgeAt(painted, t) < SETTLE) continue;
    accepted.set(spec.step, (accepted.get(spec.step) ?? 0) + 1);
  }
  // Every hold must yield at least one usable frame, or that bit is never read.
  for (let h = 0; h < 6; h++) {
    assert.ok((accepted.get(h) ?? 0) >= 1, `hold ${h} yielded no usable camera frame`);
  }
});

test('nothing is attributed before the first paint', () => {
  const { painted } = paintLog();
  assert.equal(specAt(painted, -1), null);
  assert.equal(holdAgeAt(painted, -1), 0);
});

test('the settle window still rejects a frame caught mid-transition', () => {
  const { painted } = paintLog({ holdFrames: 11, paintMs: 16 });
  const holdMs = 11 * 16;
  // A frame exposed 10ms after the pattern changed saw both patterns.
  assert.ok(holdAgeAt(painted, holdMs + 10) < 60);
});

test('the attribution window is two-sided: a lag UNDER-estimate is caught too', () => {
  // The defect: comparing an age measured at the shifted instant catches a lag
  // OVER-estimate (corrupted frames land at the start of the next hold, inside
  // the settle window) but admits every frame of an UNDER-estimate, which lands
  // near the end of the previous hold — comfortably past settle. The latency
  // correlation has no sign constraint, so half of all runs got no protection,
  // and one misattributed frame reduces a bit to noise for every pixel at once.
  const holdFrames = 12, paintMs = 16;
  const { painted } = paintLog({ holds: 6, holdFrames, paintMs });
  const holdMs = holdFrames * paintMs;
  const U = 60;

  const oneSided = (at) => {
    const spec = specAt(painted, at);
    return !!spec && !spec.settle && holdAgeAt(painted, at) >= U;
  };
  const twoSided = (at) => {
    const rec = specAt(painted, at), lo = specAt(painted, at - U), hi = specAt(painted, at + U);
    return !!rec && !!lo && !!hi && sameHold(lo, rec) && sameHold(rec, hi);
  };

  // A frame whose true exposure is near a hold boundary, mis-shifted by -40ms
  // so it is labelled with the PREVIOUS hold.
  const nearEnd = holdMs * 3 - 10;
  assert.equal(oneSided(nearEnd), true, 'the one-sided guard admits it');
  assert.equal(twoSided(nearEnd), false, 'the two-sided guard rejects it');

  // Deep inside a hold, both accept — the fix must not starve the decoder.
  const middle = holdMs * 3 + holdMs / 2;
  assert.equal(twoSided(middle), true, 'a frame safely inside a hold is still used');
});

test('a wider uncertainty window still leaves usable frames per hold', () => {
  // Sizing the window from the measured correlation width must not push it past
  // the hold length, or every frame is rejected and we are back at zero.
  for (const U of [60, 90, 120]) {
    const holdFrames = Math.max(11, Math.ceil((2 * U + 60) / 16.7));
    const { painted, span } = paintLog({ holds: 4, holdFrames, paintMs: 16 });
    const perHold = new Map();
    for (let t = 0; t < span; t += 1000 / 30) {
      const rec = specAt(painted, t), lo = specAt(painted, t - U), hi = specAt(painted, t + U);
      if (!rec || !lo || !hi || !sameHold(lo, rec) || !sameHold(rec, hi)) continue;
      perHold.set(rec.step, (perHold.get(rec.step) ?? 0) + 1);
    }
    for (let h = 1; h < 3; h++) {
      assert.ok((perHold.get(h) ?? 0) >= 1, `U=${U}: hold ${h} yielded no usable frame`);
    }
  }
});
