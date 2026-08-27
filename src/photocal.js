import { MASK_W, MASK_H } from './config.js';
import { patchLayout, calibrationSequence, createAccumulator } from './photometric.js';
import { mSequence, latencySchedule, crossCorrelate } from './latency.js';
import { contourBand } from './field.js';
import { synthPerson } from './renderG.js';
import { save, WORK_W, WORK_H } from './config.js';

// On-rig calibration passes: latency, photometric, registration, loop check,
// stand-in. Each pass paints its own frames on the VISIBLE canvas and pushes
// them into the same frame ring the detector reads, exactly as main.js does
// for the particle scene. That is the whole point: the detector's prediction
// is "what we emitted, lagged", so anything that reaches the projector without
// going through capture() is invisible to it — and a calibration measured
// against frames the detector never saw would be a calibration of nothing.
//
// Safari has no exposure lock. Every pass therefore keeps the total emitted
// light constant from frame to frame (patch sequences at ~6% APL, alternating
// A/B groups for latency) so auto-exposure has nothing to chase, and each pass
// pre-rolls a few dozen frames at its own APL before it starts recording.

// Persistence lives in IndexedDB, not localStorage: a full-resolution D/W/σ
// map serialised as JSON is ≈5.9 MB, past Safari's ~5 MB localStorage quota.
// IndexedDB structured-clones the typed arrays as-is, so nothing is rounded
// and nothing is parsed on the way back.
const DB_NAME = 'silhouette-particles';
const DB_STORE = 'photometric';
const DB_KEY = 'current';
const META_KEYS = ['quadHash', 'deviceId', 'w', 'h', 'mirror'];

// The identity a photometric calibration is valid for. Any of these changing
// (corners moved, other camera, grid, mirror) means every per-cell D/W pairs
// with a different patch of wall, so the stored file must be refused.
export function photoMeta({ calib, camera, settings, w = MASK_W, h = MASK_H }) {
  return {
    version: 1,
    quadHash: JSON.stringify(calib.quad),
    deviceId: camera?.settings?.deviceId ?? '',
    w, h,
    mirror: !!settings.mirror,
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB aborted'));
  });
}

// Resolves true when the record is on disk, false when storage refused it
// (private mode, quota, no IndexedDB) — the calibration is still usable for
// the session either way.
export async function storePhoto(photo) {
  try {
    const db = await openDb();
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put({
      w: photo.w, h: photo.h, meta: { ...photo.meta },
      D: photo.D, W: photo.W, sigmaD: photo.sigmaD, lut: photo.lut, observable: photo.observable,
    }, DB_KEY);
    await txDone(tx);
    db.close();
    return true;
  } catch (e) {
    console.warn('[photocal] could not store photometric calibration', e);
    return false;
  }
}

// Same acceptance rule as photometric.deserialize: the identity keys always
// have to match, plus anything else the caller expects; any shape problem is
// a null, never a partially valid photo.
function acceptRecord(rec, expectMeta = {}) {
  if (!rec || typeof rec !== 'object') return null;
  const meta = rec.meta;
  if (!meta || typeof meta !== 'object') return null;
  const w = rec.w | 0, h = rec.h | 0;
  if (!(w > 0 && h > 0) || meta.w !== w || meta.h !== h) return null;
  const keys = new Set([...META_KEYS, ...Object.keys(expectMeta)]);
  for (const k of keys) {
    const want = k === 'w' ? (expectMeta.w ?? w) : k === 'h' ? (expectMeta.h ?? h) : expectMeta[k];
    if (want === undefined && !(k in expectMeta)) continue;
    if (meta[k] !== want) return null;
  }
  const N = w * h;
  const f32 = (a, len) => (a instanceof Float32Array && a.length === len ? a : null);
  const D = f32(rec.D, N * 3), Wm = f32(rec.W, N * 3), sigmaD = f32(rec.sigmaD, N), lut = f32(rec.lut, 768);
  const observable = rec.observable instanceof Uint8Array && rec.observable.length === N ? rec.observable : null;
  if (!D || !Wm || !sigmaD || !lut || !observable) return null;
  for (let ch = 0; ch < 3; ch++) { lut[ch * 256] = 0; lut[ch * 256 + 255] = 1; }
  return { w, h, D, W: Wm, sigmaD, lut, observable, meta: { ...meta } };
}

export async function loadPhoto(expectMeta) {
  try {
    const db = await openDb();
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(DB_KEY);
    const rec = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return acceptRecord(rec, expectMeta);
  } catch {
    return null;
  }
}

const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Headline numbers for the wizard's report card. Medians rather than means:
// the projector's corner fall-off and any hot spot would otherwise drag the
// "typical" cell around.
export function photoStats(photo) {
  const N = photo.w * photo.h;
  const d = new Float32Array(N), s = new Float32Array(N), rng = new Float32Array(N);
  let obs = 0;
  for (let c = 0, i3 = 0; c < N; c++, i3 += 3) {
    d[c] = lumaOf(photo.D[i3], photo.D[i3 + 1], photo.D[i3 + 2]);
    rng[c] = lumaOf(photo.W[i3] - photo.D[i3], photo.W[i3 + 1] - photo.D[i3 + 1], photo.W[i3 + 2] - photo.D[i3 + 2]);
    s[c] = photo.sigmaD[c];
    obs += photo.observable[c];
  }
  return {
    dMedian: median(d), sigmaMedian: median(s), rangeMedian: median(rng),
    observableFrac: obs / N,
    frames: photo.meta?.frames ?? 0,
  };
}

function median(arr) {
  const a = Float32Array.from(arr).sort();
  const n = a.length;
  return n === 0 ? 0 : n & 1 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createPhotocal({ renderer, camera, warp, calib, ring, occlusion, settings, onProgress }) {
  // The detector's grid is whatever the renderer captures at; the layout and
  // every buffer here follow it rather than restating 480×270.
  const { w: W, h: H } = renderer.captureSize;
  const N = W * H;

  // The renderer only exposes draw() (the particle scene) and capture(). The
  // calibration frames are flat rectangles, so they are painted straight onto
  // the visible canvas here; getContext returns the renderer's own 2d context
  // (a canvas has exactly one), so this is the same surface capture() reads.
  const view = document.getElementById('view');
  const ctx = view.getContext('2d', { alpha: false });

  const layout = patchLayout({ cols: 8, rows: 8, w: W, h: H });
  const obs = new Uint8Array(N * 3);

  let photo = null;
  let depth = 0;          // >0 while a pass is on screen
  let phase = null;
  let cancelled = false;

  const api = {
    paintFrame, paintFloor,
    runLatency, runPhotometric, runRegistration, runLoopCheck, runStandIn,
    cancel, loadStored, expectedMeta,
    onProgress: onProgress ?? null,
    get photo() { return photo; },
    set photo(p) { photo = p; },
    get active() { return depth > 0; },
    get phase() { return phase; },
    get layout() { return layout; },
  };

  function report(ph, frac, text) {
    api.onProgress?.({ phase: ph, frac: clamp(frac, 0, 1), text });
  }

  function expectedMeta() {
    return photoMeta({ calib, camera, settings, w: W, h: H });
  }

  async function loadStored() {
    photo = await loadPhoto(expectedMeta());
    return photo;
  }

  // ---- painting -----------------------------------------------------------

  // Patch p covers grid cells x with floor(x*cols/W) == p%cols; the canvas
  // rectangle is derived from those exact cell bounds so that after capture()
  // downscales the canvas to the grid, the lit cells are precisely
  // layout.cells[p] — the accumulator keys everything off that list.
  function patchRect(p, vw, vh) {
    const cols = layout.cols, rows = layout.rows;
    const c = p % cols, r = (p / cols) | 0;
    const cx0 = Math.ceil(c * W / cols), cx1 = Math.ceil((c + 1) * W / cols);
    const cy0 = Math.ceil(r * H / rows), cy1 = Math.ceil((r + 1) * H / rows);
    const x0 = cx0 * vw / W, x1 = cx1 * vw / W;
    const y0 = cy0 * vh / H, y1 = cy1 * vh / H;
    return [x0, y0, x1 - x0, y1 - y0];
  }

  function beginPaint() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, view.width, view.height);
  }

  // Captures with the same clock the latency pass records against, and
  // returns that timestamp so callers can log "what was on screen when".
  function endPaint() {
    const t = performance.now();
    renderer.capture(ring, t);
    return t;
  }

  // spec: { lit: patch ids, level: 0..255 }. Black everywhere else — the
  // accumulator treats every unlit cell as a dark sample.
  function paintFrame(spec) {
    beginPaint();
    const lv = clamp(spec.level | 0, 0, 255);
    ctx.fillStyle = `rgb(${lv},${lv},${lv})`;
    for (const p of spec.lit) {
      const [x, y, w, h] = patchRect(p, view.width, view.height);
      ctx.fillRect(x, y, w, h);
    }
    return endPaint();
  }

  // What the idle piece emits: black plus the void floor. Painted after every
  // pass so the ring's newest entries describe what is actually on the wall
  // when main.js resumes, and used as the stand-in background.
  function paintFloor() {
    beginPaint();
    if (settings.voidFloor > 0) {
      const v = Math.round(255 * settings.voidFloor / 100);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(0, 0, view.width, view.height);
    }
    return endPaint();
  }

  // ---- pass driver ----------------------------------------------------------

  // One rAF loop plus one camera subscription. `paint(i, now)` runs once per
  // step; steps are paced to at most ~60 Hz because the sequences count hold
  // frames — on a 120 Hz panel a two-frame hold would be shorter than one
  // camera exposure and every camera frame would straddle two specs. After the
  // last step the display holds while camera frames keep arriving for
  // `tailMs`, so the frames still in flight through the lag get counted.
  // Resolves true on completion, false when cancelled.
  function drive({ steps, durationMs, tailMs = 0, paint, onCam, phase: ph }) {
    phase = ph;
    return new Promise((resolve) => {
      let i = 0, raf = 0, lastPaint = -Infinity, t0 = 0, tailStart = 0;
      let done = false;
      const off = camera.onFrame((tCam) => {
        if (done || cancelled) return;
        if (!warp.sampleGrid(camera, calib.H, settings.mirror, obs)) return;
        onCam(obs, tCam);
      });
      const finish = (ok) => {
        done = true;
        cancelAnimationFrame(raf);
        off();
        resolve(ok);
      };
      const tick = (now) => {
        if (cancelled) return finish(false);
        if (!t0) t0 = now;
        const more = steps != null ? i < steps : now - t0 < durationMs;
        if (more) {
          if (now - lastPaint >= 14) {
            paint(i, now);
            lastPaint = now;
            i++;
            report(ph, steps != null ? i / steps : (now - t0) / durationMs);
          }
        } else {
          if (!tailStart) tailStart = now;
          if (now - tailStart >= tailMs) return finish(true);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
  }

  // Wraps a pass: marks it active, and however it ends (done, cancelled,
  // thrown) leaves the display showing the idle floor so main.js takes over
  // from a known frame. Passes resolve null when cancelled.
  async function run(fn) {
    if (depth === 0) cancelled = false;
    depth++;
    try {
      return await fn();
    } finally {
      depth--;
      if (depth === 0) { phase = null; paintFloor(); }
    }
  }

  function cancel() { cancelled = true; }

  // Cells of a set of patches, concatenated once so per-frame means don't
  // walk nested arrays.
  function cellsOf(patches) {
    let n = 0;
    for (const p of patches) n += layout.cells[p].length;
    const out = new Int32Array(n);
    let k = 0;
    for (const p of patches) { out.set(layout.cells[p], k); k += layout.cells[p].length; }
    return out;
  }

  function meanY(rgb, cells) {
    let s = 0;
    for (let k = 0; k < cells.length; k++) {
      const i3 = cells[k] * 3;
      s += lumaOf(rgb[i3], rgb[i3 + 1], rgb[i3 + 2]);
    }
    return cells.length ? s / cells.length : 0;
  }

  // The most recent spec painted at or before t; null before the first paint.
  // Painted entries are contiguous holds, so "last one at or before" is the
  // frame that was on the wall at t.
  function specAt(painted, t) {
    for (let k = painted.length - 1; k >= 0; k--) {
      if (painted[k].t <= t) return painted[k].spec;
    }
    return null;
  }

  const PREROLL = 30;   // frames at the pass's APL before recording — AE settle

  // ---- latency --------------------------------------------------------------

  // Two interleaved groups across the middle rows, eight patches each, so the
  // lit area is constant (12.5% APL) and only WHICH patches are lit changes.
  // Middle rows because that is where the lens is sharpest and where the
  // display is least likely to be clipped by a tight corner fit.
  function latencyGroups() {
    const cols = layout.cols;
    const rA = (layout.rows >> 1) - 1, rB = rA + 1;
    const A = [], B = [];
    for (let c = 0; c < cols; c++) {
      (c & 1 ? B : A).push(rA * cols + c);
      (c & 1 ? A : B).push(rB * cols + c);
    }
    return { A, B };
  }

  async function latencyPass() {
    const seq = mSequence(6);
    const schedule = latencySchedule({ seq, holdFrames: 2, reps: 2 });
    const { A, B } = latencyGroups();
    const cellsA = cellsOf(A), cellsB = cellsOf(B);
    const emitted = [], observed = [];
    let recording = false;

    const ok = await drive({
      steps: PREROLL + schedule.length, tailMs: 500, phase: 'latency',
      paint(i) {
        const f = i < PREROLL ? { group: 'A', s: 1 } : schedule.frame(i - PREROLL);
        const t = paintFrame({ lit: f.group === 'A' ? A : B, level: 255 });
        if (i >= PREROLL) { emitted.push({ t, s: f.s }); recording = true; }
      },
      onCam(rgb, tCam) {
        if (!recording) return;
        observed.push({ t: tCam, y: meanY(rgb, cellsA) - meanY(rgb, cellsB) });
      },
    });
    if (!ok) return null;

    const x = crossCorrelate(emitted, observed, { minLagMs: 0, maxLagMs: 400, stepMs: 4 });
    settings.lagMs = Math.round(x.lagMs);
    save();
    return { lagMs: x.lagMs, confidence: x.confidence, widthMs: x.widthMs, peak: x.peak,
             secondPeak: x.secondPeak, curve: x.curve, samples: observed.length };
  }

  function runLatency() { return run(latencyPass); }

  // ---- photometric ----------------------------------------------------------

  async function photometricPass() {
    // A camera frame is attributed to the spec that was on the wall one lag
    // earlier, so the lag must be known before a single sample is binned.
    if (!(settings.lagMs > 0)) {
      const lat = await latencyPass();
      if (!lat) return null;
    }
    const lag = settings.lagMs;
    const seq = calibrationSequence({ layout, litPerFrame: 4, holdFrames: 2, whiteCycles: 3, levelCycles: 1 });
    const acc = createAccumulator(layout, N);
    const painted = [];
    const first = seq.frame(0);
    let added = 0;

    const ok = await drive({
      steps: PREROLL + seq.length, tailMs: lag + 150, phase: 'photometric',
      paint(i) {
        const spec = i < PREROLL ? first : seq.frame(i - PREROLL);
        const t = paintFrame(spec);
        if (i >= PREROLL) painted.push({ t, spec });
      },
      onCam(rgb, tCam) {
        const spec = specAt(painted, tCam - lag);
        // settle = first frame of a hold: the projector may still be showing
        // the previous step, or the camera exposure straddles the change.
        if (!spec || spec.settle) return;
        acc.add(spec, rgb);
        added++;
      },
    });
    if (!ok) return null;

    const p = acc.finish();
    p.meta = { ...p.meta, ...expectedMeta() };
    // Not stored means it will not survive a reload; the wizard says so.
    p.stored = await storePhoto(p);
    p.stats = photoStats(p);
    p.stats.added = added;
    photo = p;
    return p;
  }

  function runPhotometric() { return run(photometricPass); }

  // ---- registration ---------------------------------------------------------

  const PITCH = 24;   // cells between grid lines

  // Where the offsets are read. Vertical lines are measured along rows that sit
  // midway between horizontal lines, and vice versa, so the crossing itself
  // (where both lines pile up) never enters a profile.
  function registrationSites() {
    const vx = [], hy = [];
    for (let x = PITCH * 4; x < W - PITCH * 2; x += PITCH * 6) vx.push(x);
    for (let y = PITCH * 3; y < H - PITCH * 2; y += PITCH * 3) hy.push(y);
    return { vx, hy };
  }

  // Brightness-weighted centroid of a ±3-cell profile around the expected
  // line, with the profile's minimum taken as background. Null when the ridge
  // is not there at all (mirror wrong, corners wildly off, projector off).
  function ridgeOffset(profile) {
    let bg = Infinity, top = -Infinity;
    for (const v of profile) { if (v < bg) bg = v; if (v > top) top = v; }
    if (top - bg < 6) return null;
    let sw = 0, swk = 0;
    for (let k = 0; k < profile.length; k++) {
      const w = profile[k] - bg;
      sw += w; swk += w * (k - 3);
    }
    return sw > 0 ? swk / sw : null;
  }

  async function registrationPass() {
    const lag = settings.lagMs;
    const Ysum = new Float32Array(N);
    let frames = 0, tPainted = 0;

    const ok = await drive({
      steps: 20, tailMs: lag + 150, phase: 'registration',
      paint(i) {
        beginPaint();
        const sx = view.width / W, sy = view.height / H;
        ctx.fillStyle = '#fff';
        for (let x = PITCH; x < W; x += PITCH) ctx.fillRect(x * sx, 0, sx, view.height);
        for (let y = PITCH; y < H; y += PITCH) ctx.fillRect(0, y * sy, view.width, sy);
        const t = endPaint();
        if (i === 0) tPainted = t;
      },
      onCam(rgb, tCam) {
        // Only frames captured after the grid had been up for a full hold.
        if (!tPainted || tCam - lag < tPainted + 40) return;
        for (let c = 0, i3 = 0; c < N; c++, i3 += 3) Ysum[c] += lumaOf(rgb[i3], rgb[i3 + 1], rgb[i3 + 2]);
        frames++;
      },
    });
    if (!ok) return null;
    if (frames === 0) return { maxResidualCells: NaN, suggestedErode: settings.predErode, found: 0, sites: 0 };

    const inv = 1 / frames;
    const { vx, hy } = registrationSites();
    const residuals = [];
    let sites = 0;
    const profile = new Float32Array(7);

    // Vertical lines at x = vx[], read along rows midway between horizontals.
    for (const x of vx) {
      for (let y = PITCH + (PITCH >> 1); y < H - 2; y += PITCH) {
        sites++;
        profile.fill(0);
        for (let dy = -2; dy <= 2; dy++) {
          for (let k = -3; k <= 3; k++) profile[k + 3] += Ysum[(y + dy) * W + x + k] * inv;
        }
        const o = ridgeOffset(profile);
        if (o !== null) residuals.push(Math.abs(o));
      }
    }
    // Horizontal lines at y = hy[], read down columns midway between verticals.
    for (const y of hy) {
      for (let x = PITCH + (PITCH >> 1); x < W - 2; x += PITCH) {
        sites++;
        profile.fill(0);
        for (let dx = -2; dx <= 2; dx++) {
          for (let k = -3; k <= 3; k++) profile[k + 3] += Ysum[(y + k) * W + x + dx] * inv;
        }
        const o = ridgeOffset(profile);
        if (o !== null) residuals.push(Math.abs(o));
      }
    }

    const found = residuals.length;
    const maxResidualCells = found ? Math.max(...residuals) : NaN;
    // Erode 0 would switch the lens-safety margin off entirely, which no
    // measurement short of a perfect lens justifies; 1 is the floor.
    const suggestedErode = found ? Math.max(1, Math.ceil(maxResidualCells - 1e-3)) : settings.predErode;
    return { maxResidualCells, suggestedErode, found, sites, frames };
  }

  function runRegistration() { return run(registrationPass); }

  // ---- loop check -----------------------------------------------------------

  // Deterministic dense dots: the check must be reproducible run to run, and
  // 20 000 is well past what the installation draws.
  function denseParticles(count) {
    const x = new Float32Array(count), y = new Float32Array(count);
    let s = 12345;
    const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < count; i++) { x[i] = next(); y[i] = next(); }
    return { x, y, count };
  }

  function photoOrThrow(p) {
    const use = p ?? photo;
    if (!use) throw new Error('no photometric calibration — run the photometric step first');
    if (!occlusion) throw new Error('no occlusion detector attached');
    return use;
  }

  async function loopCheckPass({ seconds = 5, photo: p } = {}) {
    const use = photoOrThrow(p);
    const person = synthPerson(W, H, { cx: 0.5, cy: 0.6, scale: 1.2 });
    const rim = contourBand(person, new Float32Array(N), W, H, settings.rimWidth, settings.rimGain);
    let cov = 0;
    for (let i = 0; i < N; i++) cov += person[i];
    const seg = { rim, mask: person, influence: person, coverage: cov / N };
    const particles = denseParticles(20000);
    const flow = { vx: new Float32Array(WORK_W * WORK_H), vy: new Float32Array(WORK_W * WORK_H) };

    // Harsher than the piece ever is: bloom at 2 and every overlay off (an
    // overlay is captured too, but it is not what the piece emits when idle).
    const saved = { glow: settings.glow, showMask: settings.showMask, showFlow: settings.showFlow, showDiag: settings.showDiag };
    settings.glow = Math.max(saved.glow, 2);
    settings.showMask = settings.showFlow = settings.showDiag = false;

    const WARM = 600;   // ms before coverage counts: ring history + temporal median
    let t0 = 0, peak = 0, sum = 0, n = 0, lagStarved = 0;
    const series = [];
    occlusion.reset();
    try {
      const ok = await drive({
        durationMs: seconds * 1000 + WARM, tailMs: 0, phase: 'loop',
        paint() {
          renderer.draw(particles, seg, flow, 1);
          const t = endPaint();
          if (!t0) t0 = t;
        },
        onCam(rgb, tCam) {
          if (!t0) return;
          occlusion.update({ obs: rgb, tCam, ring, photo: use, lagMs: settings.lagMs });
          if (tCam - t0 < WARM) return;
          const c = occlusion.coverage;
          if (c > peak) peak = c;
          sum += c; n++;
          series.push(c);
          if (occlusion.diag?.lagStarved) lagStarved++;
        },
      });
      if (!ok) return null;
    } finally {
      Object.assign(settings, saved);
      occlusion.reset();
    }
    const mean = n ? sum / n : 0;
    return { peak, mean, pass: n > 0 && peak < 0.01, samples: n, lagStarved, series };
  }

  function runLoopCheck(opts) { return run(() => loopCheckPass(opts)); }

  // ---- stand-in -------------------------------------------------------------

  const BINS = 400;   // ratio histogram over [0, 1) at 0.0025

  function percentileOf(hist, lo, hi, q) {
    let total = 0;
    for (let b = lo; b < hi; b++) total += hist[b];
    if (total === 0) return NaN;
    const target = q * total;
    let acc = 0;
    for (let b = lo; b < hi; b++) {
      acc += hist[b];
      if (acc >= target) return (b + 0.5) / BINS;
    }
    return (hi - 0.5) / BINS;
  }

  async function standInPass({ seconds = 6, photo: p } = {}) {
    const use = photoOrThrow(p);
    const hist = new Uint32Array(BINS);
    const WARM = 500;
    let t0 = 0, covSum = 0, n = 0;
    occlusion.reset();
    try {
      const ok = await drive({
        durationMs: seconds * 1000 + WARM, tailMs: 0, phase: 'standin',
        paint() {
          const t = paintFloor();
          if (!t0) t0 = t;
        },
        onCam(rgb, tCam) {
          if (!t0) return;
          occlusion.update({ obs: rgb, tCam, ring, photo: use, lagMs: settings.lagMs });
          if (tCam - t0 < WARM) return;
          const ratio = occlusion.diag.ratio, observable = use.observable;
          // Every other cell: the histogram wants the distribution, not the count.
          for (let i = (n & 1); i < N; i += 2) {
            if (!observable[i]) continue;
            const r = ratio[i];
            if (!(r >= 0) || r >= 0.95) continue;
            hist[(r * BINS) | 0]++;
          }
          covSum += occlusion.coverage; n++;
        },
      });
      if (!ok) return null;
    } finally {
      occlusion.reset();
    }

    const bShadow = Math.round(0.3 * BINS), bBody = Math.round(0.95 * BINS);
    let bodyCount = 0, shadowCount = 0;
    for (let b = 0; b < bShadow; b++) shadowCount += hist[b];
    for (let b = bShadow; b < bBody; b++) bodyCount += hist[b];
    const body = {
      p25: percentileOf(hist, bShadow, bBody, 0.25),
      p50: percentileOf(hist, bShadow, bBody, 0.50),
      p75: percentileOf(hist, bShadow, bBody, 0.75),
      count: bodyCount,
    };
    const shadow = { p50: percentileOf(hist, 0, bShadow, 0.5), count: shadowCount };

    let suggested = null;
    if (bodyCount > 0) {
      const tauHigh = clamp(body.p75 + 0.05, 0.5, 0.8);
      // No shadow seen (lit room, or the body fills the grid): keep the seed
      // threshold where the defaults put it rather than inventing one.
      const shadowRef = shadowCount > 0 ? shadow.p50 : 0.2;
      const tauLow = clamp(shadowRef + 0.15, 0.2, tauHigh - 0.15);
      suggested = { voidFloor: 5, tauLow: round2(tauLow), tauHigh: round2(tauHigh) };
    }
    return { body, shadow, suggested, coverageMean: n ? covSum / n : 0, samples: n };
  }

  const round2 = (v) => Math.round(v * 100) / 100;

  function runStandIn(opts) { return run(() => standInPass(opts)); }

  return api;
}
