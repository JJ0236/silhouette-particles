// The occlusion detector: "anything the camera reads DARKER than a lower bound
// of what we projected is an object".
//
// A projector can only add light, so nothing this piece renders can ever make a
// wall cell read darker than predicted. Every step that builds the prediction
// therefore under-estimates on purpose (min over the lag window, erode, β < 1),
// and the evidence is strictly one-sided: obs must be BELOW g·pred_lo by more
// than the noise could explain. That asymmetry is what makes feedback through
// the display structurally impossible rather than merely unlikely. The only
// stage allowed to grow the mask from a non-darker signal is the enclosed-hole
// fill, which by construction cannot move the outer boundary.
//
// Pure module: no DOM, no clock, no allocation in the per-frame path.

import { OCCLUSION_DEFAULTS } from './occlusion-defaults.js';
import { erode, open, close, components, removeSmall, fillHoles, hysteresis,
         temporalMedian3, linearise } from './morph.js';
import { predictLow } from './photometric.js';
import { boxBlur, dilate, contourBand, sample, clamp } from './field.js';
import { signedDistance } from './distance.js';

export { OCCLUSION_DEFAULTS };

// Linear-light values below this carry no information about darkness; a cell
// whose prediction is that dark cannot produce evidence either way.
const TINY = 1e-5;
// The per-band gain absorbs auto-exposure, iris and AWB drift. It is clamped so
// a genuine lighting change (lights off) cannot be explained away as exposure
// and instead reaches the global veto.
const GAIN_MIN = 0.5, GAIN_MAX = 2.0;
// Percentiles and medians of ratios are taken from a log histogram; 0.5% bins
// over e^-3..e^3 are finer than any threshold in the pipeline.
const LOG_LO = -3, LOG_HI = 3, NBINS = 1200, LOG_STEP = (LOG_HI - LOG_LO) / NBINS;
const RATIO_MIN = Math.exp(LOG_LO), RATIO_MAX = Math.exp(LOG_HI);
const hist = new Int32Array(NBINS);   // shared scratch; the module is single-threaded
// A band estimate from fewer cells than this is noise; hold the previous one.
const MIN_BAND_CELLS = 32;
// Quantisation alone gives half a code of uncertainty even on a noiseless camera.
const SIGMA_FLOOR_CODES = 0.5;
// Shot-noise growth with signal is modelled as sqrt(pred/dark); the factor is
// capped so a bright cell keeps a finite, meaningful gate.
const SIGMA_SCALE_MAX = 8;
// A cell must beat the dark level by this many σ before its ratio is trusted
// to carry information about exposure gain.
const GAIN_MIN_SNR = 2.5;
// How far a single band's exposure gain may sit from the frame's consensus.
// Rolling-shutter and mains banding are a few percent; more than this means an
// occluder is skewing that band, not that the sensor is.
const BAND_SPREAD = 0.08;
// Renderer captures roughly this often; the lag window can never usefully be
// narrower than the interval between the frames it is selecting from.
const CAPTURE_PERIOD_MS = 30;
const RATIO_BINS = 512, PCT_MAX = 4;
const COLD = 0.004;   // below this the mask is visually gone
const HOLE_ACCEPT_RATIO = 1.05;
const SMOOTH_TOL = 0.15;
const LUMA_R = 0.299, LUMA_G = 0.587, LUMA_B = 0.114;

const clampGain = (g) => (g < GAIN_MIN ? GAIN_MIN : g > GAIN_MAX ? GAIN_MAX : g);
const clampRatio = (r) => (r < RATIO_MIN ? RATIO_MIN : r > RATIO_MAX ? RATIO_MAX : r);

function logBin(r) {
  const b = ((Math.log(clampRatio(r)) - LOG_LO) / LOG_STEP) | 0;
  return b < 0 ? 0 : b >= NBINS ? NBINS - 1 : b;
}
const binValue = (b) => Math.exp(LOG_LO + (b + 0.5) * LOG_STEP);

function percentileFromHist(count, q) {
  const target = Math.max(1, Math.ceil(count * q));
  let acc = 0;
  for (let b = 0; b < NBINS; b++) { acc += hist[b]; if (acc >= target) return binValue(b); }
  return 1;
}

// Median of ratio over an explicit cell list (the hole-fill acceptance test).
function medianOver(ratio, cells) {
  const n = cells.length;
  if (n === 0) return 1;
  hist.fill(0);
  for (let k = 0; k < n; k++) hist[logBin(ratio[cells[k]])]++;
  return percentileFromHist(n, 0.5);
}

// ---------------------------------------------------------------------------
// Exported internals. obsLin / predLin are PLANAR linear-light images,
// channel ch of cell i at [ch*N + i]; gains are [band*3 + ch].

// Per horizontal band and channel, the 45th percentile of log(obs/pred) over
// the eligible (reference) cells. A percentile a little below the median leans
// the gain low, i.e. toward under-predicting, and survives ~30% outliers on
// either side. When the reference set is too small (a large occluder) the
// previous gains are held, allowed to drift toward the fresh estimate by at
// most `slew` per update; a band with almost no reference cells holds exactly.
export function estimateGains(obsLin, predLin, eligible, w, h, bands, prev, slew, refMinFrac, out,
                              bandSpread = BAND_SPREAD) {
  const n = w * h;
  let elig = 0;
  for (let i = 0; i < n; i++) if (eligible[i]) elig++;
  const refFrac = elig / n;
  const starved = refFrac < refMinFrac;
  for (let b = 0; b < bands; b++) {
    const y0 = Math.floor((b * h) / bands), y1 = Math.floor(((b + 1) * h) / bands);
    for (let ch = 0; ch < 3; ch++) {
      const base = ch * n;
      hist.fill(0);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = row + x;
          if (!eligible[i]) continue;
          const p = predLin[base + i];
          if (!(p > TINY)) continue;
          const o = obsLin[base + i];
          hist[logBin(o > 0 ? o / p : 0)]++;
          count++;
        }
      }
      const k = b * 3 + ch;
      let pv = prev ? prev[k] : 1;
      if (!(pv > 0)) pv = 1;
      let g;
      if (count < MIN_BAND_CELLS) g = pv;
      else {
        const est = clampGain(percentileFromHist(count, 0.45));
        g = starved ? pv * clamp(est / pv, 1 - slew, 1 + slew) : est;
      }
      out[k] = clampGain(g);
    }
  }

  // No band may wander far from the frame as a whole.
  //
  // A band estimates exposure from its own rows, so a band containing a person
  // has its statistics pulled by that person and drifts away from its
  // neighbours. Its threshold moves with it, so the bands holding a body stop
  // seeing that body while the bands beside them keep seeing it — the person
  // comes out sliced into horizontal strips.
  //
  // What bands legitimately correct is rolling-shutter and mains-flicker
  // banding, which is a few percent. A band diverging further than that is
  // being poisoned by an occluder, not tracking one, so it gets pulled back to
  // the frame's consensus. Real banding still passes through untouched.
  if (Number.isFinite(bandSpread)) for (let ch = 0; ch < 3; ch++) {
    for (let b = 0; b < bands; b++) bandScratch[b] = out[b * 3 + ch];
    const med = medianOf(bandScratch, bands);
    if (!(med > 0)) continue;
    const lo = med * (1 - bandSpread), hi = med * (1 + bandSpread);
    for (let b = 0; b < bands; b++) {
      const k = b * 3 + ch;
      out[k] = out[k] < lo ? lo : out[k] > hi ? hi : out[k];
    }
  }
  return refFrac;
}

const bandScratch = new Float64Array(64);
function medianOf(a, n) {
  const v = Array.prototype.slice.call(a, 0, n).sort((x, y) => x - y);
  return n === 0 ? 1 : (n % 2 ? v[(n - 1) >> 1] : 0.5 * (v[n / 2 - 1] + v[n / 2]));
}

// One-sided evidence. ratio = max over channels of obs/(g·pred): an occluder is
// darker in every channel, while a colour-model error is usually confined to
// one, so the max is the conservative choice. The deficit gate then demands
// the luma shortfall exceed noiseK·σ; both conditions must hold for a cell to
// be a seed (ratio < tauLow) or candidate (ratio < tauHigh). Nothing brighter
// than prediction can ever pass. `ratioOut` is an optional diagnostic output.
export function evidence(obsLin, predLin, sigma, gains, w, h, bands,
                         { tauLow, tauHigh, noiseK }, strength, seed, cand, ratioOut) {
  const n = w * h;
  const span = tauHigh - tauLow;
  const inv = span > 1e-6 ? 1 / span : 0;
  for (let y = 0; y < h; y++) {
    // Gain is interpolated between band centres, not held constant per band.
    //
    // Piecewise-constant bands put a step change of threshold at every band
    // boundary, which shows up in the mask as hard horizontal bars — and a
    // person standing across a boundary is judged by two different exposures at
    // once. Bands exist to track rolling-shutter and DLP banding, which vary
    // smoothly down the frame, so a smooth reconstruction is also the more
    // faithful one.
    const fb = (y + 0.5) * bands / h - 0.5;
    let b0 = Math.floor(fb);
    let t = fb - b0;
    if (b0 < 0) { b0 = 0; t = 0; }
    else if (b0 >= bands - 1) { b0 = bands - 1; t = 0; }
    const b1 = b0 + 1 < bands ? b0 + 1 : b0;
    const i0 = b0 * 3, i1 = b1 * 3;
    const gr = gains[i0] + (gains[i1] - gains[i0]) * t;
    const gg = gains[i0 + 1] + (gains[i1 + 1] - gains[i0 + 1]) * t;
    const gb = gains[i0 + 2] + (gains[i1 + 2] - gains[i0 + 2]) * t;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const pr = gr * predLin[i], pg = gg * predLin[n + i], pb = gb * predLin[2 * n + i];
      const or = obsLin[i], og = obsLin[n + i], ob = obsLin[2 * n + i];
      let r = 0, any = false, q;
      if (pr > TINY) { any = true; q = or / pr; if (q > r) r = q; }
      if (pg > TINY) { any = true; q = og / pg; if (q > r) r = q; }
      if (pb > TINY) { any = true; q = ob / pb; if (q > r) r = q; }
      if (!any) r = 1;   // nothing predicted: no evidence either way
      if (ratioOut) ratioOut[i] = r;
      const predY = LUMA_R * pr + LUMA_G * pg + LUMA_B * pb;
      const obsY = LUMA_R * or + LUMA_G * og + LUMA_B * ob;

      // The gate is against the GAINED prediction, which is only safe because
      // the gain itself is only estimated from cells carrying real signal (see
      // GAIN_MIN_SNR). Left unrestricted, the gain absorbs one-sided noise on a
      // near-black frame and then redefines "dark" as "dimmer than the frame's
      // consensus" — manufacturing occluders out of the cells that happen to sit
      // closest to prediction. With the restriction, a black frame simply holds
      // the gain at unity and nothing is manufactured, while a lit frame still
      // has its exposure drift normalised away.
      const gate = any && (predY - obsY) > noiseK * sigma[i];
      if (!gate) { strength[i] = 0; seed[i] = 0; cand[i] = 0; continue; }
      strength[i] = inv > 0 ? clamp((tauHigh - r) * inv, 0, 1) : (r < tauHigh ? 1 : 0);
      seed[i] = r < tauLow ? 1 : 0;
      cand[i] = r < tauHigh ? 1 : 0;
    }
  }
}

// Fraction of eligible cells within ±15% of the median ratio. A global
// lighting change moves every cell by the same factor (smooth ≈ 1); a body
// or shadow is a shape against a background (smooth well below 1).
export function smoothness(ratio, eligible) {
  const n = ratio.length;
  hist.fill(0);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (eligible && !eligible[i]) continue;
    hist[logBin(ratio[i])]++;
    count++;
  }
  if (count === 0) return 0;
  const med = percentileFromHist(count, 0.5);
  const lo = med * (1 - SMOOTH_TOL), hi = med * (1 + SMOOTH_TOL);
  let within = 0;
  for (let i = 0; i < n; i++) {
    if (eligible && !eligible[i]) continue;
    const r = clampRatio(ratio[i]);
    if (r >= lo && r <= hi) within++;
  }
  return within / count;
}

// ---------------------------------------------------------------------------

export function createOcclusion({ w = 480, h = 270, workW = 160, workH = 90, settings = {} } = {}) {
  const N = w * h, N3 = N * 3, NW = workW * workH;
  const cfg = (k) => (settings[k] !== undefined ? settings[k] : OCCLUSION_DEFAULTS[k]);

  // Outputs.
  const mask = new Float32Array(N);
  const bin = new Uint8Array(N);
  const rim = new Float32Array(N);
  const influence = new Float32Array(N);
  const SDF_CAP = 16;   // cells outside the body past which the field is flat
  const sdf = new Float32Array(N).fill(SDF_CAP);
  const motion = new Float32Array(NW);
  const fast = new Float32Array(N);

  // Prediction path.
  const Rlow = new Uint8Array(N3);
  const RlowE = new Uint8Array(N3);
  const plane = new Uint8Array(N), planeE = new Uint8Array(N), tmpU8 = new Uint8Array(N);
  const predCode = new Float32Array(N3);
  const obsLinP = new Float32Array(N3), predLinP = new Float32Array(N3);   // planar
  const obsPool = new Float32Array(N3), predPool = new Float32Array(N3);
  const tmpF = new Float32Array(N);
  const obsYcode = new Float32Array(N);

  // Evidence path.
  const predY = new Float32Array(N), obsY = new Float32Array(N);
  const ratio = new Float32Array(N), strength = new Float32Array(N);
  const seed = new Uint8Array(N), cand = new Uint8Array(N);
  const eligible = new Uint8Array(N), vetoElig = new Uint8Array(N), prevDil = new Uint8Array(N);
  const sigmaEff = new Float32Array(N);
  const gainElig = new Uint8Array(N);
  const pctHist = new Int32Array(RATIO_BINS);
  const frontier = new Int32Array(N);
  const gains = new Float32Array(cfg('gainBands') * 3).fill(1);

  // Per-photo tables (rebuilt when the photo or the camera curve changes).
  const linTab = new Float32Array(256);
  const sigLin = new Float32Array(N), darkLin = new Float32Array(N);
  let tabGamma = NaN, tabPedestal = NaN, photoRef = null, observableFrac = 0;

  // Mask path.
  const rawA = new Uint8Array(N), rawB = new Uint8Array(N);
  const labels = new Int32Array(N), stack = new Int32Array(N);
  const medHist = [new Uint8Array(N), new Uint8Array(N), new Uint8Array(N)];
  let medHead = 0;
  const holeOpts = { maxArea: 0, accept: ({ cells }) => medianOver(ratio, cells) > HOLE_ACCEPT_RATIO };

  let suppressUntil = -Infinity, lastTCam = 0;

  const diag = {
    pred: predY, obsLin: obsY, ratio, strength, seed, cand, gains,
    refFrac: 0, lagStarved: false, veto: false, vetoReason: '', observableFrac: 0,
    lagMs: 0, suppressed: false, smoothness: 0,
  };
  const self = { update, mask, bin, rim, influence, sdf, motion, coverage: 0, suppress, reset, diag };

  // Linear light for a fractional camera code (the prediction is not integer).
  function linF(code) {
    if (code <= 0) return linTab[0];
    if (code >= 255) return linTab[255];
    const c0 = code | 0, t = code - c0;
    return linTab[c0] + (linTab[c0 + 1] - linTab[c0]) * t;
  }

  function ensureTables(photo) {
    const gamma = cfg('camGamma'), pedestal = cfg('camPedestal');
    const curveChanged = gamma !== tabGamma || pedestal !== tabPedestal;
    if (curveChanged) { linearise(pedestal, gamma, linTab); tabGamma = gamma; tabPedestal = pedestal; }
    if (!curveChanged && photo === photoRef) return;
    photoRef = photo;
    const { D, sigmaD, observable } = photo;
    let obsCount = 0;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const dY = LUMA_R * D[i3] + LUMA_G * D[i3 + 1] + LUMA_B * D[i3 + 2];
      const s = sigmaD[i] > SIGMA_FLOOR_CODES ? sigmaD[i] : SIGMA_FLOOR_CODES;
      const dl = linF(dY);
      darkLin[i] = dl;
      // The gate is on a DEFICIT, so the relevant excursion is the one below
      // the dark level. On the camera curve that is smaller than the upward
      // one, and noiseK× of it still over-estimates a noiseK·σ code excursion.
      sigLin[i] = dl - linF(dY - s);
      if (observable[i]) obsCount++;
    }
    observableFrac = obsCount / N;
  }

  // True when the smoothed mask has already decayed to nothing, so there is no
  // fade left to render either.
  function maskIsCold() {
    for (let i = 0; i < N; i++) if (mask[i] > COLD) return false;
    return true;
  }

  // Everything an empty frame needs: decay to zero, report nothing, and leave
  // the previous-mask exclusion clean for the next frame.
  function finishIdle() {
    mask.fill(0); fast.fill(0); rim.fill(0); influence.fill(0); motion.fill(0);
    bin.fill(0); sdf.fill(SDF_CAP);
    self.coverage = 0;
    diag.veto = false; diag.vetoReason = '';
    for (const m of medHist) m.fill(0);
  }

  function finishOutputs() {
    const ms = cfg('maskSmooth'), fs = cfg('motionSmooth');
    const km = 1 - ms, kf = 1 - fs;
    for (let i = 0; i < N; i++) {
      const b = bin[i];
      mask[i] += (b - mask[i]) * km;
      fast[i] += (b - fast[i]) * kf;
    }
    contourBand(mask, rim, w, h, cfg('rimWidth'), cfg('rimGain'));
    boxBlur(mask, influence, w, h, cfg('influence'), tmpF);
    // The particles' view of the body: how far to the edge, and which way.
    signedDistance(bin, w, h, sdf, SDF_CAP);
    const iw = workW > 1 ? 1 / (workW - 1) : 0, ih = workH > 1 ? 1 / (workH - 1) : 0;
    for (let y = 0; y < workH; y++) {
      const v = y * ih;
      for (let x = 0; x < workW; x++) motion[y * workW + x] = sample(fast, w, h, x * iw, v);
    }
    let sum = 0;
    for (let i = 0; i < N; i++) sum += bin[i];
    self.coverage = sum / N;

    // Ratio percentiles, by histogram and only when someone is looking.
    //
    // These answer "why is nothing detected": if the darkest few percent of the
    // frame still read near 1.0 with a person standing there, the body is not
    // darker than the wall on this rig and no threshold will find it. Useful —
    // but it was costing a full 130k-element sort on every frame, which is a
    // large slice of a 33 ms budget spent on a number nobody was reading. A
    // histogram is O(n) and the whole thing is skipped unless the diagnostics
    // overlay is up.
    if (settings.showDiag) {
      const r = diag.ratio, ob = photoRef ? photoRef.observable : null;
      const B = RATIO_BINS, top = PCT_MAX;
      pctHist.fill(0);
      let n = 0;
      for (let i = 0; i < N; i++) {
        const v = r[i];
        if (!Number.isFinite(v) || (ob && !ob[i])) continue;
        let b = (v / top * B) | 0;
        if (b < 0) b = 0; else if (b >= B) b = B - 1;
        pctHist[b]++; n++;
      }
      if (n > 0) {
        const at = (q) => {
          let want = n * q, acc = 0;
          for (let b = 0; b < B; b++) { acc += pctHist[b]; if (acc >= want) return (b + 0.5) * top / B; }
          return top;
        };
        diag.ratioP1 = at(0.01); diag.ratioP5 = at(0.05); diag.ratioP50 = at(0.5);
      } else {
        diag.ratioP1 = diag.ratioP5 = diag.ratioP50 = NaN;
      }
    }
  }

  function update({ obs, tCam, ring, photo, lagMs }) {
    lastTCam = tCam;
    diag.suppressed = tCam < suppressUntil;
    diag.lagStarved = false;

    if (!photo) {
      // Uncalibrated: there is no lower bound to compare against, so there is
      // no evidence. Silence, not a guess.
      bin.fill(0);
      diag.veto = false; diag.vetoReason = ''; diag.refFrac = 0; diag.observableFrac = 0;
      finishOutputs();
      return;
    }
    ensureTables(photo);
    diag.observableFrac = observableFrac;

    if (diag.suppressed) {
      // The ring holds frames we know are wrong (overlay toggled, reset):
      // keep the last decision rather than reading against a bad prediction.
      finishOutputs();
      return;
    }

    // --- Prediction: a lower bound on what an unoccluded cell reads. ---
    const lag = cfg('lagMode') === 'manual' ? cfg('lagManualMs') : (lagMs ?? settings.lagMs ?? 0);
    diag.lagMs = lag;
    const win = cfg('lagWindowMs');
    // Widen the window to at least the capture interval before giving up.
    //
    // Frames are captured every ~25 ms, so a window narrower than that will
    // periodically contain no frame at all through nothing but phase — which
    // used to raise a starvation warning once or twice a second while the
    // system was working perfectly well. Widening first, and only reporting
    // starvation when the ring genuinely has nothing near the target, keeps the
    // warning meaningful.
    const winEff = win > CAPTURE_PERIOD_MS ? win : CAPTURE_PERIOD_MS;
    let got = ring ? ring.minOver(tCam - lag - winEff, tCam - lag + winEff, Rlow) : 0;
    if (got === 0) {
      const last = ring ? ring.latest() : null;
      if (last) Rlow.set(last.rgb); else Rlow.fill(0);
      diag.lagStarved = true;
    }
    const pe = cfg('predErode');
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0, j = ch; i < N; i++, j += 3) plane[i] = Rlow[j];
      erode(plane, planeE, w, h, pe, tmpU8);
      for (let i = 0, j = ch; i < N; i++, j += 3) RlowE[j] = planeE[i];
    }
    predictLow(photo, RlowE, cfg('contentTrust'), predCode);


    // --- Linearise and pool. ---
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const r = obs[i3], g = obs[i3 + 1], b = obs[i3 + 2];
      obsLinP[i] = linTab[r]; obsLinP[N + i] = linTab[g]; obsLinP[2 * N + i] = linTab[b];
      obsYcode[i] = LUMA_R * r + LUMA_G * g + LUMA_B * b;
      predLinP[i] = linF(predCode[i3]);
      predLinP[N + i] = linF(predCode[i3 + 1]);
      predLinP[2 * N + i] = linF(predCode[i3 + 2]);
    }
    const pr = cfg('poolRadius');
    for (let ch = 0; ch < 3; ch++) {
      const a = ch * N, z = a + N;
      boxBlur(obsLinP.subarray(a, z), obsPool.subarray(a, z), w, h, pr, tmpF);
      boxBlur(predLinP.subarray(a, z), predPool.subarray(a, z), w, h, pr, tmpF);
    }
    // Pooling averages independent noise down by the kernel size.
    const poolK = 2 * Math.max(0, Math.round(pr)) + 1;
    const sigmaPool = 1 / poolK;

    // --- Reference set for the gain, and the σ gate per cell. ---
    dilate(bin, prevDil, w, h, 2, tmpU8);
    const observable = photo.observable;
    for (let i = 0; i < N; i++) {
      const py = LUMA_R * predPool[i] + LUMA_G * predPool[N + i] + LUMA_B * predPool[2 * N + i];
      predY[i] = py;
      obsY[i] = LUMA_R * obsPool[i] + LUMA_G * obsPool[N + i] + LUMA_B * obsPool[2 * N + i];
      const ok = observable[i] && obsYcode[i] < 250 && py > TINY ? 1 : 0;
      vetoElig[i] = ok;
      eligible[i] = ok && !prevDil[i] ? 1 : 0;
      const dl = darkLin[i] > TINY ? darkLin[i] : TINY;
      let sc = Math.sqrt(py / dl);
      if (sc < 1) sc = 1; else if (sc > SIGMA_SCALE_MAX) sc = SIGMA_SCALE_MAX;
      sigmaEff[i] = sigLin[i] * sc * sigmaPool;

      // Only cells that are actually RECEIVING light may vote on exposure gain.
      //
      // A ratio in linear space is meaningless where the prediction sits on the
      // dark level: the camera curve is steep there, so a couple of codes of
      // noise becomes tens of percent of ratio, and the median of those ratios
      // is biased far above the true gain. Measured on the closed loop, a black
      // void with 2 codes of noise produced a gain of 1.46 instead of 1.00 —
      // which then manufactured a deficit large enough to clear the σ gate.
      //
      // Requiring the predicted signal to stand clear of the dark level by a
      // few σ keeps the estimator on cells where a ratio means something. When
      // too few qualify — a nearly black frame, which is this piece's normal
      // state — refFrac falls below refMinFrac and the gain holds instead of
      // being invented.
      // Gain eligibility only asks "is this cell receiving light", so the
      // pooled prediction answers it directly. The beta discount is a constant
      // scale and does not change the answer, which is why the separate
      // undiscounted prediction (a full predict plus three blur passes every
      // frame) was pure cost.
      const gy = py;
      gainElig[i] = eligible[i] && (gy - dl) > GAIN_MIN_SNR * sigmaEff[i] ? 1 : 0;
    }
    // Misregistration tolerance, targeted where it is actually needed.
    //
    // A homography cannot model lens distortion, so the prediction sits a cell
    // or two off the observation. That only matters where the prediction has a
    // steep spatial gradient — the edge of the contour — because a shift there
    // compares a bright cell against a dark one and manufactures a deficit. On
    // flat regions, which is where a body stands, a shift changes nothing.
    // So the noise allowance grows with the local gradient rather than the
    // threshold dropping globally, which would cost real detection everywhere
    // to fix a problem that only exists at edges.
    const regTol = cfg('regTol');
    if (regTol > 0) {
      const nk = Math.max(0.5, cfg('noiseK'));
      for (let y = 0; y < h; y++) {
        const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
        for (let x = 0; x < w; x++) {
          const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x;
          const gx = predY[y * w + x1] - predY[y * w + x0];
          const gy = predY[y1 * w + x] - predY[y0 * w + x];
          const gm = Math.sqrt(gx * gx + gy * gy) * 0.5;
          sigmaEff[y * w + x] += (regTol / nk) * gm;
        }
      }
    }

    const bands = gains.length / 3;
    // Gain uses the SAME denominator as the ratio, so an unoccluded wall lands
    // at 1.0 by construction and the thresholds mean what they say. (The
    // separate honest reference existed only to survive predErode deleting
    // sparse content from the prediction; with erosion off it is unnecessary,
    // and using a different denominator here would offset the whole ratio
    // scale.)
    diag.refFrac = estimateGains(obsPool, predPool, gainElig, w, h, bands, gains,
                                 cfg('gainSlew'), cfg('refMinFrac'), gains);

    // --- Evidence. ---
    evidence(obsPool, predPool, sigmaEff, gains, w, h, bands,
             { tauLow: cfg('tauLow'), tauHigh: cfg('tauHigh'), noiseK: cfg('noiseK') },
             strength, seed, cand, ratio);
    for (let i = 0; i < N; i++) if (!observable[i]) { seed[i] = 0; cand[i] = 0; strength[i] = 0; }

    // --- Mask chain. Every stage here shrinks or keeps the candidate set,
    // except the enclosed-hole fill which cannot reach the outer boundary. ---
    // Idle fast path.
    //
    // With nobody in front of the screen there are no seeds, and every stage
    // below — hysteresis, morphology, connected components, hole filling,
    // region growing, the contour — is a full pass over ~100k cells producing
    // an empty result. That is the state the piece spends most of its life in,
    // so it is worth not paying for it. The moment a single seed appears the
    // full chain runs again.
    let anySeed = false;
    for (let i = 0; i < N; i++) if (seed[i]) { anySeed = true; break; }
    if (!anySeed && maskIsCold()) {
      rawA.fill(0);
      finishIdle();
      return;
    }

    hysteresis(seed, cand, w, h, rawA, stack);
    let cur = rawA, other = rawB;
    const oR = cfg('openR');
    if (oR > 0) { open(cur, other, w, h, oR, tmpU8); [cur, other] = [other, cur]; }
    const cR = cfg('closeR');
    if (cR > 0) { close(cur, other, w, h, cR, tmpU8); [cur, other] = [other, cur]; }
    const { areas } = components(cur, w, h, labels, stack);
    removeSmall(cur, labels, areas, cfg('minComponentFrac') * N);

    // Bounded region growing: reach the rest of the body.
    //
    // A torso seeds strongly, but arms and hands catch more of the projector's
    // light — they are nearer it and angled towards it — so they sit just above
    // the candidate threshold and get cut off. Growing outward from a CONFIRMED
    // region into neighbours that are at all darker than the wall recovers them.
    //
    // This cannot flood, for two reasons: it only ever grows from a component
    // that already survived seeding and area rejection, and it stops after a
    // fixed number of one-cell steps. A wall cell reads ~1.0 and so fails
    // tauGrow, which is why the growth dies at the body's real edge instead of
    // running off across the frame.
    const grow = cfg('growIters') | 0;
    if (grow > 0) {
      const tg = cfg('tauGrow');
      const nb = gains.length / 3;

      // Frontier walk, not repeated dilation.
      //
      // Growth only ever happens at the edge of what is already confirmed, so
      // dilating the whole frame once per step was doing ~130k cells of work to
      // discover a few hundred. This walks the actual boundary instead, which
      // makes the cost proportional to the body's perimeter rather than to the
      // grid.
      //
      // It also judges on UNPOOLED data: the pooled ratio smears a finger's
      // darkness into the gaps beside it, and growing on that welds the fingers
      // into a mitten. Unpooled, a gap still reads as wall and growth stops.
      let head = 0, tail = 0;
      for (let i = 0; i < N; i++) if (cur[i]) frontier[tail++] = i;
      let levelEnd = tail;
      for (let step = 0; step < grow && head < tail; step++) {
        while (head < levelEnd) {
          const i = frontier[head++];
          const x = i % w, y = (i / w) | 0;
          for (let k = 0; k < 4; k++) {
            const nx2 = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
            const ny2 = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
            if (nx2 < 0 || nx2 >= w || ny2 < 0 || ny2 >= h) continue;
            const j = ny2 * w + nx2;
            if (cur[j] || !vetoElig[j]) continue;
            let bnd = ((ny2 * nb) / h) | 0;
            if (bnd >= nb) bnd = nb - 1;
            let r = 0, any = false;
            for (let ch = 0; ch < 3; ch++) {
              const pv = gains[bnd * 3 + ch] * predLinP[ch * N + j];
              if (pv > TINY) { any = true; const q = obsLinP[ch * N + j] / pv; if (q > r) r = q; }
            }
            if (any && r < tg) { cur[j] = 1; frontier[tail++] = j; }
          }
        }
        levelEnd = tail;
      }
    }
    if (cfg('fillHoles')) {
      holeOpts.maxArea = cfg('holeMaxFrac') * N;
      fillHoles(cur, w, h, holeOpts, labels, stack, tmpU8);
    }
    medHist[medHead].set(cur);
    medHead = (medHead + 1) % 3;
    if (cfg('temporalMedian')) temporalMedian3(medHist[0], medHist[1], medHist[2], bin);
    else bin.set(cur);

    // --- Global veto: everything darker AND featureless is a lighting change. ---
    let sum = 0;
    for (let i = 0; i < N; i++) sum += bin[i];
    const cov = sum / N;
    diag.veto = false; diag.vetoReason = ''; diag.smoothness = 0;
    if (cov > cfg('vetoCoverage')) {
      const sm = smoothness(ratio, vetoElig);
      diag.smoothness = sm;
      if (sm > cfg('vetoSmooth')) { bin.fill(0); diag.veto = true; diag.vetoReason = 'global'; }
    }

    finishOutputs();
  }

  function suppress(ms) {
    const until = lastTCam + ms;
    if (until > suppressUntil) suppressUntil = until;
  }

  function reset() {
    mask.fill(0); bin.fill(0); rim.fill(0); influence.fill(0); motion.fill(0); fast.fill(0);
    sdf.fill(SDF_CAP);
    for (const m of medHist) m.fill(0);
    medHead = 0;
    gains.fill(1);
    ratio.fill(0); strength.fill(0); seed.fill(0); cand.fill(0); predY.fill(0); obsY.fill(0);
    suppressUntil = -Infinity;
    self.coverage = 0;
    diag.refFrac = 0; diag.lagStarved = false; diag.veto = false; diag.vetoReason = '';
    diag.suppressed = false; diag.smoothness = 0;
  }

  return self;
}
