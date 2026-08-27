# Module contracts (occlusion re-architecture)

Every module below is built by a different worker in parallel. Build EXACTLY to these
signatures. Plain ES modules, no dependencies, no TypeScript, Node's built-in test runner
(`node --test test/*.test.mjs`). Pure modules must not touch `document`/`window`.

Conventions: grid **G = 480×270**, `N = 129600`. (Raised from 320×180 so individual
FINGERS resolve: a finger must be ≥ 3 cells wide with ≥ 2-cell gaps at typical scale. Every
module takes `w, h` parameters — never hardcode the grid.) RGB frames are `Uint8Array(N*3)`
interleaved, row-major, camera/render **code** units 0..255. Scalar fields are
`Float32Array(N)`. Binary masks are `Uint8Array(N)` with values 0/1. Timestamps are ms
(`performance.now()` domain). All functions that write into an `out` buffer return it.
Comments explain *why*, not what. No `Date.now()`/`Math.random()` inside pure modules
except where a seed is passed in.

Existing modules you may import (do not modify): `src/field.js` (`boxBlur(src,dst,w,h,r,tmp)`,
`dilate(...)`, `contourBand(mask,dst,w,h,width,gain)`, `sample(field,w,h,u,v)`, `clamp`),
`src/homography.js`. Do NOT import `MASK_W/MASK_H` from `src/config.js` in new modules or
tests (config is being changed concurrently) — take `w, h` as parameters; tests use
`const W = 480, H = 270` locally. `WORK_W=160, WORK_H=90` stays for the motion grid.

**Finger preservation is a hard requirement.** Anything that erodes or closes the MASK must
default to sizes that keep a 3-cell-wide finger with 2-cell gaps: `openR` default 0,
`closeR` default 1 (a 5×5 close would weld fingers together). Noise rejection comes from
the σ gate, hysteresis, `removeSmall` and the temporal median instead of morphology.

---

## src/morph.js  (pure)

```js
export function erode(src, dst, w, h, r, tmp)          // separable min filter; Float32 or Uint8
export function open(bin, dst, w, h, r, tmp)           // erode then dilate, Uint8 0/1
export function close(bin, dst, w, h, r, tmp)          // dilate then erode
export function components(bin, w, h, labels /*Int32Array(N)*/, stack /*Int32Array(N)*/)
  // → { count, areas: Int32Array(count+1), touchesBorder: Uint8Array(count+1) }
  // labels[i] = 0 for background, 1..count for components (4-connected). Iterative, no recursion.
export function removeSmall(bin, labels, areas, minArea)   // in place on bin
export function fillHoles(bin, w, h, { maxArea, accept }, labels, stack, tmp)
  // labels background components of `bin`; for each enclosed one (not touching border)
  // with area <= maxArea and accept({ label, area, cells: Int32Array }) === true, set to 1.
export function hysteresis(seed, cand, w, h, dst, stack)   // BFS from seed cells through cand cells → dst 0/1
export function temporalMedian3(a, b, c, dst)              // per-cell majority of three 0/1 masks
export function linearise(pedestal, gamma, out /*Float32Array(256)*/)
  // out[code] = max(0, (code - pedestal) / (255 - pedestal)) ** gamma
```

## src/frames.js  (pure)

```js
export function createRing({ entries = 24, size }) → {
  push(rgb /*Uint8Array(size)*/, t),                  // copies
  select(t0, t1) → number[],                          // indices with t0 <= t <= t1, oldest first
  minOver(t0, t1, dst) → count,                       // per-byte min over selected; count 0 → dst untouched
  maxOver(t0, t1, dst) → count,
  latest() → { rgb, t } | null,
  clear(),
  get length,
}
```

## src/photometric.js  (pure)

Calibration is a CONSTANT-APL patch sequence (no exposure lock exists in Safari):

```js
export function patchLayout({ cols = 8, rows = 8, w = 480, h = 270 })
  // → { count, cells: Int32Array[] /*per patch*/, patchOf: Int16Array(w*h) }
export function calibrationSequence({ layout, litPerFrame = 4, holdFrames = 2,
                                      whiteCycles = 3, levels = LEVELS17, levelCycles = 1 })
  // → { length, frame(i) → { lit: number[] /*patch ids*/, level: 0..255, phase: 'white'|'stair', settle: boolean } }
  // Every patch is lit at 255 `whiteCycles` times; every patch is lit at each of `levels`
  // `levelCycles` times; at most `litPerFrame` patches lit per frame (APL ≈ litPerFrame/count).
  // `settle` = first frame of a hold (transition; accumulator must skip it).
export const LEVELS17   // [0,16,...,255]
export function createAccumulator(layout, N) → {
  add(frameSpec, obsRGB /*Uint8Array(N*3)*/),        // unlit cells → dark samples; lit@255 → white; lit@level → LUT
  finish() → photo
}
// photo = { w, h, D: Float32Array(N*3), W: Float32Array(N*3), sigmaD: Float32Array(N) /*Y code σ*/,
//           lut: Float32Array(3*256) /*render code → fraction of (W−D), monotone, lut[0]=0, lut[255]=1*/,
//           observable: Uint8Array(N) /*(W−D)_Y >= minRange (default 12 codes)*/, meta: {} }
export function fitLut(levels /*number[]*/, responses /*number[] normalised*/) → Float32Array(256)   // PAVA + interp
export function predictLow(photo, Rlow /*Uint8Array(N*3)*/, beta, out /*Float32Array(N*3)*/)
  // out[i] = D[i] + beta * (W[i] − D[i]) * lut[ch*256 + Rlow[i]]   (camera CODE units)
export function predictHigh(photo, Rhigh, beta, out)   // same with 1/beta (clamped ≤ 255), for hole-fill acceptance
export function serialize(photo, meta) → string
export function deserialize(json, expectMeta) → photo | null   // null on any meta mismatch or bad shape
```

## src/latency.js  (pure)

```js
export function mSequence(bits = 6, seed = 1) → Int8Array(2**bits − 1)   // values ±1, maximal-length LFSR
export function latencySchedule({ seq, holdFrames = 2, reps = 2 })
  // → { length, frame(i) → { group: 'A'|'B', s: ±1 } }   // A lit when s=+1, B lit when s=−1 (constant total light)
export function crossCorrelate(emitted /*{t,s}[]*/, observed /*{t,y}[]*/,
                               { minLagMs = 0, maxLagMs = 400, stepMs = 4 } = {})
  // → { lagMs, peak, secondPeak, confidence /*peak/secondPeak-ish, 0..1*/, widthMs, curve: Float32Array }
  // Resample both to stepMs, zero-mean, normalise, correlate, parabolic sub-step refinement.
export function createLagTracker({ lagMs, candidatesMs = [-66,-33,0,33,66], everyN = 60, holdMs = 5000 }) → {
  observe(residualByCandidate /*number[] same length as candidatesMs*/, now),
  get drifted, get suggestedLagMs, get lagMs, accept(),
}
```

## src/simcam.js  (pure) — INDEPENDENT camera model; must not import photometric.js

```js
export function createSimCamera(params) → { observe(R /*Uint8Array(N*3) rendered*/, occluder /*Float32Array(N) 0..1*/, i, out /*Uint8Array(N*3)*/), params }
export const IDEAL, ADVERSARIAL   // param presets
// params: { w:480, h:270,
//   wallAlbedo: 0.8, dark:[r,g,b] /*projector black, linear, 0..1 of white*/, white:[1,1,1],
//   gammaProj: 2.2, gammaCam: 2.2, pedestal: 0, gain: 1,
//   latencyFrames: 3, latencyJitter: 0 /*frames, deterministic pattern*/,
//   gainFn: i=>1, awbFn: i=>[1,1,1], ambientFn: i=>0 /*linear, fraction of white*/,
//   noiseSigma: 0 /*code units, deterministic PRNG seeded*/, seed: 1,
//   bodyAlbedo: 0.3, bodyK: 2 /*projector irradiance factor on body*/,
//   shadowShift:[dx,dy] /*cells*/, contentShift:[dx,dy], misreg:[dx,dy] /*sub-cell*/,
//   blurRadius: 0, irisFn: apl=>1, bandsFn: (i,row)=>1, glare: { radius: 0, gain: 0 } }
// Model per cell: proj = LUTproj(R delayed by latency, shifted by misreg) * irisFn(apl) ;
//   wall  = wallAlbedo * (ambient + dark + proj)
//   body  = bodyAlbedo * (ambient + bodyK * (dark + proj shifted by contentShift))     where occluder>0
//   shadow(cells = occluder shifted by shadowShift, not body) = wallAlbedo * ambient
//   then + glare halo (blur of bright content × gain), × bandsFn, camera gamma, pedestal, awb, gain, noise, quantise.
// IDEAL: dark 0.003, no shifts, latency 3, no noise. ADVERSARIAL: gammaProj 2.4, gammaCam 1.8, pedestal 12,
//   latency 3.4 + jitter 0.5, misreg [0.7,0.9], contentShift [4,2], shadowShift [6,3], awb drift ±10%,
//   noiseSigma 3, irisFn apl<0.05 ? 0.6 : 1, bands ±8% on rows 60–90, glare {radius 4, gain 0.05}.
```

## src/renderG.js  (pure) — stand-in for render.js at G

```js
export function renderFrame({ rim /*Float32Array(N)*/, particles /*{x,y,count}|null, normalised 0..1*/,
                              presence = 1, settings }, out /*Uint8Array(N*3)*/)
  // floor fill (settings.voidFloor % → code), additive rim in outlineHue (settings.rimGain), amber dots
  // (particleAlpha, particleSize), bloom = boxBlur(radius 2) × settings.glow added. Clamp 255.
  // MUST be at least as bright and as wide as the real renderer for the same inputs.
export function synthPerson(w, h, { cx, cy, scale = 1, fingers = true }) → Float32Array(w*h)
  // test occluder: torso + head + an arm ending in a hand with FIVE fingers, each 3 cells wide,
  // separated by 2-cell gaps; also return metadata: { fingerCells: Int32Array[], gapCells: Int32Array[] }
  // via synthPerson.last so tests can assert fingers stay 1 and gaps stay 0 after segmentation.
```

## src/occlusion.js  (pure) — the detector

```js
export const OCCLUSION_DEFAULTS = {
  voidFloor: 5, tauLow: 0.35, tauHigh: 0.60, noiseK: 3, contentTrust: 0.7, predErode: 1,
  lagWindowMs: 25, lagMode: 'auto', lagManualMs: 0, openR: 0, closeR: 1, minComponentFrac: 0.0001,
  temporalMedian: true, fillHoles: true, holeMaxFrac: 0.015, gainBands: 6, camGamma: 2.2, camPedestal: 8,
  vetoCoverage: 0.92, vetoSmooth: 0.8, refMinFrac: 0.3, gainSlew: 0.15, poolRadius: 1,
  maskSmooth: 0.7, motionSmooth: 0.5, influence: 2.5, rimWidth: 0.7, rimGain: 1.7, maskMaxCoverage: 0.85,
};
export function createOcclusion({ w = 480, h = 270, workW = 160, workH = 90, settings }) → {
  update({ obs /*Uint8Array(N*3)*/, tCam, ring /*frames.js*/, photo /*photometric.js*/, lagMs }),
  mask: Float32Array(N), bin: Uint8Array(N), rim: Float32Array(N), influence: Float32Array(N),
  motion: Float32Array(workW*workH), coverage: number,
  suppress(ms), reset(),
  diag: { pred: Float32Array(N) /*Y linear*/, obsLin: Float32Array(N), ratio: Float32Array(N),
          strength: Float32Array(N), seed: Uint8Array(N), cand: Uint8Array(N),
          gains: Float32Array(gainBands*3), refFrac, lagStarved, veto, vetoReason, observableFrac, lagMs, suppressed },
}
// Exported internals for unit tests:
export function estimateGains(obsLin, predLin, eligible, w, h, bands, prev, slew, refMinFrac, out) → refFrac
export function evidence(obsLin, predLin, sigma, gains, w, h, bands, { tauLow, tauHigh, noiseK }, strength, seed, cand)
export function smoothness(ratio, eligible) → 0..1   // fraction of eligible cells within ±15% of median ratio
```
Stage order in `update`: window = `[tCam − lag − lagWindowMs, tCam − lag + lagWindowMs]`;
`ring.minOver(window, Rlow)` (0 entries → `latest()`, `lagStarved=true`); `erode(Rlow, predErode)`
per channel; `predictLow(photo, Rlow, contentTrust)`; linearise obs and pred (camGamma, camPedestal);
box-pool both (poolRadius); eligible = observable ∧ ¬dilate(prevBin, 3) ∧ obsCode < 250;
`estimateGains` (per horizontal band, 45th-percentile of log ratio, hold+slew if refFrac < refMinFrac);
ratio = max over channels of obs/(g·pred); deficit gate `(g·pred − obs) > noiseK·σ(c)·sqrt(pred/D)`;
strength = clamp((tauHigh − ratio)/(tauHigh − tauLow)); seed = ratio < tauLow; cand = ratio < tauHigh;
`hysteresis` → open(openR, skip if 0) → close(closeR, skip if 0) → removeSmall(minComponentFrac·N) → fillHoles (enclosed,
≤ holeMaxFrac·N, accept iff median ratio in hole > 1.05) → temporalMedian3 → veto (coverage > vetoCoverage
∧ smoothness > vetoSmooth → zero, vetoReason='global') → bin. Then EMA `maskSmooth` → mask,
EMA `motionSmooth` → fast; `contourBand(mask, rim, w, h, rimWidth, rimGain)`; `boxBlur(mask → influence, influence)`;
resample fast → motion (workW×workH); coverage = mean(bin). While `suppressed` (tCam < suppressUntil):
skip evidence, keep previous bin.

---

## Settings keys added to config.js (S7) — spread from OCCLUSION_DEFAULTS plus:
`lagMs` (stored measured latency, ms), `showDiag` (TRANSIENT), `brighterDetector` false.
Removed: selfLight*, selfKey*, autoLevels*, maskThreshold, maskBlur, invertMask, showSelfLight,
showInput, flowScale/flowBlur unchanged, SEG_SIZE removed. KEY → v9, v8 → STALE_KEYS.
