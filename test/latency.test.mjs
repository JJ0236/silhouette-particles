import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mSequence, latencySchedule, crossCorrelate, createLagTracker } from '../src/latency.js';

// ---------------------------------------------------------------------------
// Synthetic camera. Emits an m-sequence at 60 fps (sample-and-hold, chip =
// holdFrames frames), then models what the camera reports per frame:
//   delay by lagMs (+ optional per-frame jitter), box integration over the
//   exposure ending at the frame timestamp, slow multiplicative gain drift,
//   gaussian noise. Everything is seeded so a failure is reproducible.
//
// Ground truth for a measurement is lagMs + exposureMs/2: the camera frame is
// the average of the exposure window, so the rendered frame it best matches
// is the one at the window's centre — which is exactly the lag the detector
// needs. Note that a camera phase-locked to the display samples every chip at
// the same offsets, so a very short exposure leaves the transition times
// ambiguous to ± half a camera interval; the tests sweep the phase and use
// realistic exposures (12 ms at 60 fps, 30 ms at 30 fps) so that ambiguity
// is resolved by the partially-integrated sample straddling each transition.
// ---------------------------------------------------------------------------

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const RENDER_MS = 1000 / 60;

function emit({ bits = 6, holdFrames = 2, reps = 2, seed = 1 } = {}) {
  const seq = mSequence(bits, seed);
  const sched = latencySchedule({ seq, holdFrames, reps });
  const emitted = [];
  for (let i = 0; i < sched.length; i++) emitted.push({ t: i * RENDER_MS, s: sched.frame(i).s });
  return emitted;
}

// Sample-and-hold value of the emitted signal at time t (0 before the first frame).
function heldAt(emitted, t) {
  if (t < emitted[0].t) return 0;
  let lo = 0, hi = emitted.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (emitted[mid].t <= t) lo = mid; else hi = mid - 1; }
  return emitted[lo].s;
}

function observe(emitted, {
  lagMs = 0, fps = 60, exposureMs = 12, snr = 3, drift = 0.3, driftPeriodMs = 3000,
  jitterMs = 0, seed = 7, phaseMs = 5, noise = true, signal = true,
} = {}) {
  const rand = prng(seed);
  const camDt = 1000 / fps;
  const tEnd = emitted[emitted.length - 1].t + RENDER_MS;
  const sim = 0.25;                       // fine step for the exposure integral
  const observed = [];
  // Per-frame lag jitter: the camera pipeline is not perfectly regular.
  let frameLag = lagMs;
  for (let tc = phaseMs; tc <= tEnd + lagMs; tc += camDt) {
    if (jitterMs > 0) frameLag = lagMs + (rand() * 2 - 1) * jitterMs;
    let acc = 0, n = 0;
    for (let t = tc - exposureMs; t < tc; t += sim) { acc += signal ? heldAt(emitted, t - frameLag) : 0; n++; }
    const gain = 1 + drift * Math.sin(2 * Math.PI * tc / driftPeriodMs);
    const y = (acc / n) * gain + (noise ? gaussian(rand) / snr : 0);
    observed.push({ t: tc, y });
  }
  return observed;
}
const truth = (lagMs, exposureMs = 12) => lagMs + exposureMs / 2;

// ---------------------------------------------------------------------------
// mSequence
// ---------------------------------------------------------------------------

test('mSequence: length 2^bits-1, values ±1, +1 count exceeds -1 count by exactly one', () => {
  for (let bits = 3; bits <= 8; bits++) {
    const seq = mSequence(bits);
    assert.equal(seq.length, 2 ** bits - 1, `bits=${bits}`);
    let plus = 0, minus = 0;
    for (const v of seq) { if (v === 1) plus++; else if (v === -1) minus++; else assert.fail(`non-±1 value ${v}`); }
    assert.equal(plus - minus, 1, `bits=${bits}: balanced`);
  }
});

test('mSequence: two-valued circular autocorrelation (off-peak exactly -1)', () => {
  for (let bits = 3; bits <= 8; bits++) {
    const seq = mSequence(bits);
    const L = seq.length;
    for (let lag = 0; lag < L; lag++) {
      let r = 0;
      for (let i = 0; i < L; i++) r += seq[i] * seq[(i + lag) % L];
      if (lag === 0) assert.equal(r, L);
      else assert.equal(r, -1, `bits=${bits} lag=${lag}: off-peak should be -1/(2^bits-1)·length`);
    }
  }
});

test('mSequence: seed rotates the sequence; zero seed is still a valid (non-stuck) sequence', () => {
  const a = mSequence(6, 1), b = mSequence(6, 5);
  assert.notDeepEqual(Array.from(a), Array.from(b));
  const rotated = (() => {
    for (let k = 0; k < a.length; k++) {
      let ok = true;
      for (let i = 0; i < a.length && ok; i++) if (a[(i + k) % a.length] !== b[i]) ok = false;
      if (ok) return true;
    }
    return false;
  })();
  assert.ok(rotated, 'different seeds give rotations of the same m-sequence');
  const z = mSequence(4, 0);
  let plus = 0; for (const v of z) if (v === 1) plus++;
  assert.equal(plus, 8, 'a zero seed must not produce the stuck all-zero state');
});

test('mSequence: rejects unsupported bit widths', () => {
  assert.throws(() => mSequence(2));
  assert.throws(() => mSequence(9));
});

// ---------------------------------------------------------------------------
// latencySchedule
// ---------------------------------------------------------------------------

test('latencySchedule: length, hold, repeat, and A/B follow the sequence sign', () => {
  const seq = mSequence(4);
  const sched = latencySchedule({ seq, holdFrames: 3, reps: 2 });
  assert.equal(sched.length, 15 * 3 * 2);
  for (let i = 0; i < sched.length; i++) {
    const f = sched.frame(i);
    const chip = Math.floor(i / 3) % 15;
    assert.equal(f.s, seq[chip], `frame ${i} carries chip ${chip}`);
    assert.equal(f.group, seq[chip] > 0 ? 'A' : 'B');
  }
});

test('latencySchedule: exactly one group lit per frame (constant total light) and both groups used', () => {
  const sched = latencySchedule({ seq: mSequence(5) });
  const seen = new Set();
  for (let i = 0; i < sched.length; i++) {
    const f = sched.frame(i);
    assert.ok(f.group === 'A' || f.group === 'B');
    assert.ok(f.s === 1 || f.s === -1);
    seen.add(f.group);
  }
  assert.equal(seen.size, 2);
});

test('latencySchedule: defaults are holdFrames 2, reps 2', () => {
  const seq = mSequence(3);
  const sched = latencySchedule({ seq });
  assert.equal(sched.length, 7 * 2 * 2);
  assert.equal(sched.frame(0).s, sched.frame(1).s);
  assert.equal(sched.frame(0).s, sched.frame(14).s, 'second rep restarts the sequence');
});

// ---------------------------------------------------------------------------
// crossCorrelate
// ---------------------------------------------------------------------------

test('crossCorrelate: recovers lag 0/33/117/250 ms within ±4 ms through exposure integration, SNR 3 noise and ×(1±0.3) drift', () => {
  const emitted = emit();
  for (const lagMs of [0, 33, 117, 250]) {
    for (const seed of [7, 11, 23]) {
      for (const phaseMs of [0, 5, 11]) {
        const observed = observe(emitted, { lagMs, seed, phaseMs });
        const r = crossCorrelate(emitted, observed);
        assert.ok(Math.abs(r.lagMs - truth(lagMs)) <= 4,
          `lag ${lagMs} seed ${seed} phase ${phaseMs}: got ${r.lagMs.toFixed(2)}, want ${truth(lagMs)} (peak ${r.peak.toFixed(3)}, conf ${r.confidence.toFixed(2)})`);
        assert.ok(r.peak > 0.5 && r.peak <= 1, `strong, bounded peak (${r.peak})`);
        assert.ok(r.confidence > 0.5, `clear peak should be confident (${r.confidence})`);
      }
    }
  }
});

test('crossCorrelate: result shape', () => {
  const emitted = emit();
  const r = crossCorrelate(emitted, observe(emitted, { lagMs: 100 }), { minLagMs: 0, maxLagMs: 400, stepMs: 4 });
  assert.ok(r.curve instanceof Float32Array);
  assert.equal(r.curve.length, 101, 'one sample per step over [min, max] inclusive');
  for (const k of ['lagMs', 'peak', 'secondPeak', 'confidence', 'widthMs']) assert.ok(Number.isFinite(r[k]), k);
  assert.ok(r.peak >= 0 && r.peak <= 1);
  assert.ok(r.secondPeak >= 0 && r.secondPeak <= r.peak);
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  assert.ok(r.widthMs > 0);
  // The curve's own argmax agrees with lagMs to within one step.
  let best = 0; for (let i = 1; i < r.curve.length; i++) if (r.curve[i] > r.curve[best]) best = i;
  assert.ok(Math.abs(best * 4 - r.lagMs) <= 4);
  assert.ok(Math.abs(r.lagMs - truth(100)) <= 4);
});

test('crossCorrelate: sub-step refinement lands between grid points', () => {
  const emitted = emit();
  const r = crossCorrelate(emitted, observe(emitted, { lagMs: 118, noise: false, drift: 0 }), { stepMs: 8 });
  assert.ok(Math.abs(r.lagMs - truth(118)) <= 4, `got ${r.lagMs}, want ${truth(118)}`);
  assert.notEqual(r.lagMs % 8, 0, 'parabolic refinement should not snap to the 8 ms grid');
});

test('crossCorrelate: confidence is low on pure noise', () => {
  const emitted = emit();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const observed = observe(emitted, { signal: false, seed });
    const r = crossCorrelate(emitted, observed);
    assert.ok(r.confidence < 0.3, `seed ${seed}: confidence ${r.confidence} (peak ${r.peak}, second ${r.secondPeak})`);
    assert.ok(r.peak < 0.4, `seed ${seed}: noise should not correlate strongly (${r.peak})`);
  }
});

test('crossCorrelate: widthMs grows when the lag jitters frame to frame', () => {
  const emitted = emit();
  const clean = crossCorrelate(emitted, observe(emitted, { lagMs: 100, noise: false, drift: 0 }));
  const jittery = crossCorrelate(emitted, observe(emitted, { lagMs: 100, noise: false, drift: 0, jitterMs: 25 }));
  assert.ok(clean.widthMs > 15 && clean.widthMs < 60, `clean width ≈ chip width (${clean.widthMs})`);
  assert.ok(jittery.widthMs > clean.widthMs * 1.15, `jitter must widen the peak: ${jittery.widthMs} vs ${clean.widthMs}`);
  assert.ok(Math.abs(jittery.lagMs - truth(100)) <= 8, 'mean lag still recovered under jitter');
});

test('crossCorrelate: camera at 30 fps against a 60 fps emitter recovers lag within ±8 ms', () => {
  // A 30 fps camera sees each 33 ms chip exactly once, so its exposure has to
  // do the work of locating transitions: 30 ms (1/33 s, ordinary indoors).
  const emitted = emit();
  const exposureMs = 30;
  for (const lagMs of [33, 117, 250]) {
    for (const seed of [3, 9]) {
      for (const phaseMs of [0, 9, 17, 26]) {
        const r = crossCorrelate(emitted, observe(emitted, { lagMs, fps: 30, exposureMs, seed, phaseMs }));
        assert.ok(Math.abs(r.lagMs - truth(lagMs, exposureMs)) <= 8,
          `lag ${lagMs} seed ${seed} phase ${phaseMs}: got ${r.lagMs.toFixed(2)}, want ${truth(lagMs, exposureMs)}`);
      }
    }
  }
});

test('crossCorrelate: honours the lag window and reports the edge when the true lag lies outside it', () => {
  const emitted = emit();
  const r = crossCorrelate(emitted, observe(emitted, { lagMs: 117 }), { minLagMs: 60, maxLagMs: 200, stepMs: 2 });
  assert.equal(r.curve.length, 71);
  assert.ok(Math.abs(r.lagMs - truth(117)) <= 4, `got ${r.lagMs}`);
  const out = crossCorrelate(emitted, observe(emitted, { lagMs: 300 }), { minLagMs: 0, maxLagMs: 200 });
  assert.ok(out.lagMs >= 0 && out.lagMs <= 200, 'lagMs stays within the requested window');
});

test('crossCorrelate: degenerate input does not throw', () => {
  const r = crossCorrelate([{ t: 0, s: 1 }], [{ t: 0, y: 0 }]);
  assert.equal(r.peak, 0);
  assert.equal(r.confidence, 0);
  const flat = crossCorrelate(emit(), [{ t: 0, y: 1 }, { t: 5000, y: 1 }]);
  assert.equal(flat.peak, 0, 'a constant observation carries no information');
});

// ---------------------------------------------------------------------------
// createLagTracker
// ---------------------------------------------------------------------------

const residualsFavouring = (idx, n = 5) => Array.from({ length: n }, (_, i) => (i === idx ? 0.2 : 1));

test('createLagTracker: exposes its configuration and starts clean', () => {
  const tr = createLagTracker({ lagMs: 120 });
  assert.equal(tr.lagMs, 120);
  assert.equal(tr.drifted, false);
  assert.equal(tr.suggestedLagMs, null);
});

test('createLagTracker: flips only after the best candidate has been off-zero for holdMs', () => {
  const tr = createLagTracker({ lagMs: 120, candidatesMs: [-66, -33, 0, 33, 66], holdMs: 5000 });
  tr.observe(residualsFavouring(2), 0);
  assert.equal(tr.drifted, false);
  for (let t = 100; t < 5000; t += 100) {
    tr.observe(residualsFavouring(3), t);
    assert.equal(tr.drifted, false, `t=${t}: not yet held for holdMs`);
  }
  tr.observe(residualsFavouring(3), 5100);
  assert.equal(tr.drifted, true);
  assert.equal(tr.suggestedLagMs, 153, 'suggestion = lagMs + winning candidate');
  assert.equal(tr.lagMs, 120, 'the adopted lag does not change until accept()');
});

test('createLagTracker: a brief excursion that returns to zero does not flip', () => {
  const tr = createLagTracker({ lagMs: 120, holdMs: 5000 });
  for (let t = 0; t < 3000; t += 100) tr.observe(residualsFavouring(3), t);
  tr.observe(residualsFavouring(2), 3100);         // back to the current lag
  for (let t = 3200; t < 8000; t += 100) tr.observe(residualsFavouring(3), t);
  assert.equal(tr.drifted, false, 'the off-zero span restarted at 3200; only 4800 ms held');
  tr.observe(residualsFavouring(3), 8300);
  assert.equal(tr.drifted, true);
});

test('createLagTracker: a span split across different off-zero candidates still counts as drift', () => {
  const tr = createLagTracker({ lagMs: 120, holdMs: 5000 });
  for (let t = 0; t < 3000; t += 100) tr.observe(residualsFavouring(3), t);
  for (let t = 3000; t <= 5100; t += 100) tr.observe(residualsFavouring(4), t);
  assert.equal(tr.drifted, true);
  assert.equal(tr.suggestedLagMs, 186, 'suggests the candidate that is currently best');
});

test('createLagTracker: accept() adopts the suggestion and clears drifted', () => {
  const tr = createLagTracker({ lagMs: 120, holdMs: 1000 });
  for (let t = 0; t <= 1100; t += 100) tr.observe(residualsFavouring(1), t);
  assert.equal(tr.drifted, true);
  assert.equal(tr.suggestedLagMs, 87);
  tr.accept();
  assert.equal(tr.lagMs, 87);
  assert.equal(tr.drifted, false);
  assert.equal(tr.suggestedLagMs, null);
  // The held span restarts after accepting: the same residual pattern needs a full holdMs again.
  tr.observe(residualsFavouring(1), 1200);
  assert.equal(tr.drifted, false);
  tr.accept();
  assert.equal(tr.lagMs, 87, 'accept() with nothing suggested is a no-op');
});

test('createLagTracker: drifted clears once zero has been best again for holdMs', () => {
  const tr = createLagTracker({ lagMs: 120, holdMs: 1000 });
  for (let t = 0; t <= 1100; t += 100) tr.observe(residualsFavouring(3), t);
  assert.equal(tr.drifted, true);
  for (let t = 1200; t < 2200; t += 100) tr.observe(residualsFavouring(2), t);
  assert.equal(tr.drifted, true, 'hysteresis: not cleared yet');
  tr.observe(residualsFavouring(2), 2300);
  assert.equal(tr.drifted, false);
  assert.equal(tr.suggestedLagMs, null);
});

test('createLagTracker: ignores calls with no finite residuals', () => {
  const tr = createLagTracker({ lagMs: 120, holdMs: 1000 });
  for (let t = 0; t <= 1100; t += 100) tr.observe([NaN, NaN, NaN, NaN, NaN], t);
  assert.equal(tr.drifted, false);
  for (let t = 1200; t <= 2300; t += 100) tr.observe([NaN, 0.1, NaN, NaN, NaN], t);
  assert.equal(tr.drifted, true, 'partial residuals are fine: the finite one wins');
  assert.equal(tr.suggestedLagMs, 87);
});
