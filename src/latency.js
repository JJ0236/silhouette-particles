// Display-to-camera latency measurement.
//
// The occlusion detector compares each camera frame against the rendered frame
// from `lagMs` ago, so the lag has to be known to a few milliseconds, not
// guessed. We measure it by emitting a maximal-length sequence: two patch
// groups A and B alternate (A lit on +1, B lit on −1) so the total light never
// changes and auto-exposure has nothing to react to, while the *difference*
// meanY(A) − meanY(B) carries a ±1 code with a sharp autocorrelation. Cross-
// correlating that observation against the emitted code gives a peak at the
// lag. Everything here is pure and seeded; no DOM, no clocks.

// Feedback taps (1-indexed, from the standard maximal-length table). Each set
// yields a full-period 2^bits − 1 sequence for any non-zero start state.
const TAPS = {
  3: [3, 2],
  4: [4, 3],
  5: [5, 3],
  6: [6, 5],
  7: [7, 6],
  8: [8, 6, 5, 4],
};

export function mSequence(bits = 6, seed = 1) {
  const taps = TAPS[bits];
  if (!taps) throw new RangeError(`mSequence: bits must be 3..8, got ${bits}`);
  const length = 2 ** bits - 1;
  // A zero state is a fixed point of the LFSR; fold any seed into 1..length.
  let state = ((Math.abs(seed | 0) % length) + 1) | 0;
  const out = new Int8Array(length);
  let plus = 0;
  for (let i = 0; i < length; i++) {
    const bit = state & 1;
    out[i] = bit ? 1 : -1;
    plus += bit;
    let fb = 0;
    for (const tap of taps) fb ^= (state >> (bits - tap)) & 1;
    state = (state >> 1) | (fb << (bits - 1));
  }
  // A maximal-length sequence has one more 1 than 0; anything else means the
  // taps are wrong and the correlation would have side-lobes.
  if (plus - (length - plus) !== 1) throw new Error(`mSequence: not maximal-length for bits=${bits}`);
  return out;
}

export function latencySchedule({ seq, holdFrames = 2, reps = 2 }) {
  const chips = seq.length;
  const length = chips * holdFrames * reps;
  return {
    length,
    frame(i) {
      const s = seq[Math.floor(i / holdFrames) % chips];
      return { group: s > 0 ? 'A' : 'B', s };
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-correlation
// ---------------------------------------------------------------------------

function median(arr) {
  const a = Float64Array.from(arr).sort();
  const n = a.length;
  return n === 0 ? 0 : n & 1 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

// Shortest run of a constant emitted value — the chip width. The correlation
// peak is a triangle this wide, which sets how far apart two peaks must be to
// count as distinct.
function chipWidthMs(emitted) {
  let best = Infinity, runStart = emitted[0].t;
  for (let i = 1; i < emitted.length; i++) {
    if (emitted[i].s !== emitted[i - 1].s) {
      best = Math.min(best, emitted[i].t - runStart);
      runStart = emitted[i].t;
    }
  }
  if (Number.isFinite(best)) return best;
  return emitted.length > 1 ? (emitted[emitted.length - 1].t - emitted[0].t) / (emitted.length - 1) : 1;
}

function medianInterval(pts) {
  if (pts.length < 2) return 0;
  const d = new Float64Array(pts.length - 1);
  for (let i = 1; i < pts.length; i++) d[i - 1] = pts[i].t - pts[i - 1].t;
  return median(d);
}

// Sample-and-hold onto a grid starting at t0. The last frame is held for one
// typical frame interval; outside the emitted span the grid is marked invalid.
function holdOnGrid(emitted, t0, step, n, vals, valid) {
  const hold = medianInterval(emitted);
  const tEnd = emitted[emitted.length - 1].t + hold;
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * step;
    if (t < emitted[0].t || t > tEnd) continue;
    while (j + 1 < emitted.length && emitted[j + 1].t <= t) j++;
    vals[k] = emitted[j].s;
    valid[k] = 1;
  }
}

function interpOnGrid(observed, t0, step, n, vals, valid) {
  const last = observed.length - 1;
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * step;
    if (t < observed[0].t || t > observed[last].t) continue;
    while (j < last && observed[j + 1].t < t) j++;
    if (j >= last) { vals[k] = observed[last].y; valid[k] = 1; continue; }
    const a = observed[j], b = observed[j + 1];
    const span = b.t - a.t;
    const f = span > 0 ? (t - a.t) / span : 0;
    vals[k] = a.y + (b.y - a.y) * f;
    valid[k] = 1;
  }
}

// Zero-mean over valid samples and scale to unit RMS. Returns false when the
// series carries no variance (nothing to correlate against).
function standardise(vals, valid) {
  let n = 0, sum = 0;
  for (let k = 0; k < vals.length; k++) if (valid[k]) { n++; sum += vals[k]; }
  if (n === 0) return false;
  const mean = sum / n;
  let ss = 0;
  for (let k = 0; k < vals.length; k++) if (valid[k]) { vals[k] -= mean; ss += vals[k] * vals[k]; }
  if (ss <= 1e-12 * n) return false;
  const inv = Math.sqrt(n / ss);
  for (let k = 0; k < vals.length; k++) vals[k] = valid[k] ? vals[k] * inv : 0;
  return true;
}

function emptyResult(nLag) {
  return { lagMs: 0, peak: 0, secondPeak: 0, confidence: 0, widthMs: 0, curve: new Float32Array(nLag) };
}

export function crossCorrelate(emitted, observed, { minLagMs = 0, maxLagMs = 400, stepMs = 4 } = {}) {
  const nLag = Math.max(1, Math.floor((maxLagMs - minLagMs) / stepMs + 1e-9) + 1);
  if (!emitted || !observed || emitted.length < 2 || observed.length < 2) return emptyResult(nLag);

  // Common grid. The observed grid is offset by minLagMs so that lag index L
  // is an integer shift of L samples: obs(t + minLag + L·step) vs emit(t).
  const t0 = Math.min(emitted[0].t, observed[0].t);
  const t1 = Math.max(emitted[emitted.length - 1].t, observed[observed.length - 1].t);
  const n = Math.floor((t1 - t0) / stepMs) + 2;
  const E = new Float64Array(n), Ev = new Uint8Array(n);
  const O = new Float64Array(n), Ov = new Uint8Array(n);
  holdOnGrid(emitted, t0, stepMs, n, E, Ev);
  interpOnGrid(observed, t0 + minLagMs, stepMs, n, O, Ov);
  if (!standardise(E, Ev) || !standardise(O, Ov)) return emptyResult(nLag);

  // One extra lag on each side so a peak on the window edge can still be
  // refined; only [minLag, maxLag] is reported.
  const ext = new Float64Array(nLag + 2);
  for (let L = -1; L <= nLag; L++) {
    let num = 0, ee = 0, oo = 0;
    for (let k = 0; k < n; k++) {
      const m = k + L;
      if (m < 0 || m >= n || !Ev[k] || !Ov[m]) continue;
      const e = E[k], o = O[m];
      num += e * o; ee += e * e; oo += o * o;
    }
    ext[L + 1] = ee > 0 && oo > 0 ? num / Math.sqrt(ee * oo) : 0;
  }
  const curve = new Float32Array(nLag);
  for (let L = 0; L < nLag; L++) curve[L] = ext[L + 1];

  let best = 0;
  for (let L = 1; L < nLag; L++) if (curve[L] > curve[best]) best = L;
  const peakRaw = curve[best];
  const peak = Math.max(0, Math.min(1, peakRaw));

  // Parabolic refinement through the three samples around the maximum.
  const ym = ext[best], y0 = ext[best + 1], yp = ext[best + 2];
  const denom = ym - 2 * y0 + yp;
  let delta = denom < 0 ? 0.5 * (ym - yp) / denom : 0;
  if (!Number.isFinite(delta)) delta = 0;
  delta = Math.max(-0.5, Math.min(0.5, delta));
  const lagMs = Math.max(minLagMs, Math.min(maxLagMs, minLagMs + (best + delta) * stepMs));

  // Second peak: the best other local maximum at least two chip widths away,
  // far enough that the main peak's own triangle cannot count as a rival.
  const exclusion = 2 * chipWidthMs(emitted);
  let secondRaw = -Infinity;
  for (let L = 0; L < nLag; L++) {
    if (Math.abs((L - best) * stepMs) < exclusion) continue;
    const left = L === 0 ? -Infinity : curve[L - 1];
    const right = L === nLag - 1 ? -Infinity : curve[L + 1];
    if (curve[L] > left && curve[L] >= right && curve[L] > secondRaw) secondRaw = curve[L];
  }
  const secondPeak = Number.isFinite(secondRaw) ? Math.max(0, Math.min(peak, secondRaw)) : 0;

  // Confidence: how far the peak stands above its best rival. On pure noise
  // the rival is the noise itself — a lone bump on a random curve can be the
  // only local maximum, which would make secondPeak 0 and confidence 1 — so
  // the rival is never taken below the curve's noise floor (baseline + 3
  // robust sigma).
  const baseline = median(curve);
  const dev = new Float64Array(nLag);
  for (let L = 0; L < nLag; L++) dev[L] = Math.abs(curve[L] - baseline);
  const noiseFloor = baseline + 3 * 1.4826 * median(dev);
  const rival = Math.min(peak, Math.max(secondPeak, noiseFloor));
  const confidence = Math.max(0, Math.min(1, (peak - rival) / Math.max(peak, 1e-6)));

  // Full width at half the peak's height above the curve's baseline.
  const half = baseline + 0.5 * (peakRaw - baseline);
  let left = best, right = best;
  let leftX = 0, rightX = nLag - 1;
  while (left > 0 && curve[left] >= half) left--;
  if (curve[left] < half) leftX = left + (half - curve[left]) / (curve[left + 1] - curve[left]);
  while (right < nLag - 1 && curve[right] >= half) right++;
  if (curve[right] < half) rightX = right - (half - curve[right]) / (curve[right - 1] - curve[right]);
  const widthMs = peakRaw > baseline ? Math.max(0, (rightX - leftX) * stepMs) : 0;

  return { lagMs, peak, secondPeak, confidence, widthMs, curve };
}

// ---------------------------------------------------------------------------
// Drift tracking
// ---------------------------------------------------------------------------
//
// Once running, the detector periodically scores its residual at a few lag
// offsets around the adopted lag. If some non-zero offset keeps winning for
// holdMs the camera pipeline has drifted and we suggest re-basing. Symmetric
// hysteresis: the flag also needs holdMs of zero-offset wins to clear on its
// own, so a noisy boundary cannot flicker it.

export function createLagTracker({ lagMs, candidatesMs = [-66, -33, 0, 33, 66], everyN = 60, holdMs = 5000 }) {
  const zeroIdx = candidatesMs.indexOf(0);
  let drifted = false;
  let suggestedLagMs = null;
  let spanOff = null;      // start time of the current run of off-zero wins
  let spanZero = null;     // start time of the current run of zero wins

  function observe(residualByCandidate, now) {
    let best = -1;
    for (let i = 0; i < candidatesMs.length; i++) {
      const r = residualByCandidate[i];
      if (!Number.isFinite(r)) continue;
      if (best < 0 || r < residualByCandidate[best]) best = i;
    }
    if (best < 0) return;
    if (best === zeroIdx) {
      spanOff = null;
      if (spanZero === null) spanZero = now;
      if (drifted && now - spanZero >= holdMs) { drifted = false; suggestedLagMs = null; }
      return;
    }
    spanZero = null;
    if (spanOff === null) spanOff = now;
    if (now - spanOff >= holdMs) {
      drifted = true;
      suggestedLagMs = lagMs + candidatesMs[best];
    }
  }

  function accept() {
    if (suggestedLagMs !== null) lagMs = suggestedLagMs;
    drifted = false;
    suggestedLagMs = null;
    spanOff = null;
    spanZero = null;
  }

  return {
    observe, accept,
    get drifted() { return drifted; },
    get suggestedLagMs() { return suggestedLagMs; },
    get lagMs() { return lagMs; },
    get candidatesMs() { return candidatesMs; },
    get everyN() { return everyN; },
  };
}
