// Every tunable in one place. The debug panel mutates `settings` live and
// persists it, so the installation comes back up already dialled in.

import { OCCLUSION_DEFAULTS } from './occlusion-defaults.js';

export const WORK_W = 160, WORK_H = 90;    // luma + optical-flow grid
// The detector grid follows the DISPLAY's shape, not a fixed 16:9.
//
// On a 5760x1080 wall — three projectors edge-blended — a 16:9 grid makes every
// cell wildly non-square: vertical detail is wasted while horizontal, which is
// where people and their hands actually move, is starved. Cells should be
// roughly square so a finger is the same number of cells whichever way it lies.
//
// Total cell count is held roughly constant instead, because that is what costs
// time: the detector runs a few dozen passes over every cell on every camera
// frame.
const GRID_CELLS = 97000;

function gridFor(aspect) {
  const a = Number.isFinite(aspect) && aspect > 0.2 && aspect < 20 ? aspect : 16 / 9;
  let h = Math.round(Math.sqrt(GRID_CELLS / a));
  h = Math.max(72, Math.min(400, h));
  let w = Math.round(h * a);
  return [w - (w % 2), h - (h % 2)];
}

function displayAspect() {
  try {
    const o = JSON.parse(localStorage.getItem('silhouette-particles/grid') || 'null');
    if (o && o.aspect) return o.aspect;
  } catch {}
  try {
    if (typeof window !== 'undefined') {
      if (window.innerWidth > 0 && window.innerHeight > 0) return window.innerWidth / window.innerHeight;
      if (window.screen?.width > 0) return window.screen.width / window.screen.height;
    }
  } catch {}
  return 16 / 9;
}

export const [MASK_W, MASK_H] = gridFor(displayAspect());

export const DEFAULTS = {
  // particles
  particles:     12000,
  push:          30,     // how hard your motion throws them
  occupancy:     0.9,    // how hard your body displaces them while still
  returnForce:   0.006,  // pull back toward rest position
  damping:       0.90,
  maxSpeed:      0.030,  // ceiling, screen widths per frame (~58px at 1920)
  drift:         0.10,   // idle wander so it never looks frozen
  particleHue:   45,
  // 'single' one hue · 'rainbow' fixed spectrum across the field · 'shift' the
  // same spectrum rotating over time
  particleColour: 'rainbow',
  particleSpread: 300,     // degrees of hue the field spans in rainbow modes
  particleCycle:  1.0,     // rotation speed for 'shift'
  particleAlpha: 0.55,
  particleSize:  3.2,

  // silhouette: the detector owns its own tunables (thresholds, morphology,
  // veto, smoothing, rim, influence) — see occlusion-defaults.js
  ...OCCLUSION_DEFAULTS,
  outlineHue:    190,
  lagMs:         0,      // measured projector→camera latency, ms; 0 = not yet measured
  brighterDetector: false,

  // motion
  flowSmooth:    0.45,   // temporal smoothing on the flow field
  flowGain:      2.4,    // doubled: the loop now ticks at 30 Hz, so per-tick displacement halved
  flowScale:     3,      // input blur: raise to catch faster swipes
  flowBlur:      1,      // output smoothing across cells

  // presence
  presenceEnter: 0.015,  // fraction of the display area that counts as arrival
  presenceExit:  0.007,  // must drop below this to count as gone
  presenceMax:   0.9,    // above this it's a lighting change, not a person
  presenceHold:  2500,   // ms of absence before it idles

  // look
  glow:          0.35,
  lagWidthMs:    0,
  renderScale:   1.0,    // multiplier on the render pixel budget; lower if it stutters

  // rig
  mirror:        false,
  showMask:      false,
  showFlow:      false,
  showDiag:      false,
  sim:           false,
};

const KEY = 'silhouette-particles/settings/v12';

// Older stores, newest first. Tuning is carried forward across a version bump
// rather than thrown away — a room's sensitivity settings are hard-won.
// Deliberately empty: the occlusion re-architecture changed what several of
// these values mean, so v9 starts clean rather than inheriting tuning that was
// compensating for a different detector. Calibration lives under its own key
// and survives.
const LEGACY_KEYS = [];
const STALE_KEYS = [
  'silhouette-particles/settings/v11',
  'silhouette-particles/settings/v10',
  'silhouette-particles/settings/v9',
  'silhouette-particles/settings/v8',
  'silhouette-particles/settings/v7',
  'silhouette-particles/settings/v6',
  'silhouette-particles/settings/v5',
  'silhouette-particles/settings/v4',
  'silhouette-particles/settings/v3',
  'silhouette-particles/settings/v2',
  'silhouette-particles/settings',
];

// Values whose defaults changed for a reason. A migrated store must NOT win on
// these, or the stored value silently reinstates the thing that was fixed.
const FORCE_DEFAULT_ON_MIGRATE = [
  'rimWidth', 'glow', 'flowSmooth', 'flowGain',
  'maxSpeed', 'presenceMax', 'maskSmooth', 'motionSmooth', 'maskMaxCoverage',
];

// Diagnostics, never persisted. localStorage is shared across every tab on the
// origin, so a preview tab opened with ?sim=1 would otherwise write sim:true
// into the store and the real installation would come up showing the demo
// figure. Same hazard for the debug overlays: a power-cycled installation must
// never wake up with the mask overlay stuck on. These always start off.
const TRANSIENT = new Set(['sim', 'showMask', 'showFlow', 'showDiag']);

export const settings = load();
applyUrlOverrides();

// ?sim=1  preview with a synthetic figure, no camera and no permission prompt
// ?reset  ignore stored tuning and come up on the defaults
function applyUrlOverrides() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('reset')) Object.assign(settings, DEFAULTS);
    if (q.has('sim')) settings.sim = q.get('sim') !== '0';
  } catch { /* not a browser (tests) */ }
}

function readStore(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }   // corrupt or unavailable storage
}

function load() {
  const s = { ...DEFAULTS };

  let saved = readStore(KEY);
  if (!saved) {
    for (const k of STALE_KEYS) { try { localStorage.removeItem(k); } catch {} }
  }
  let migrated = false;
  if (!saved) {
    for (const legacy of LEGACY_KEYS) {
      saved = readStore(legacy);
      if (saved) { migrated = true; break; }
    }
  }
  if (!saved) return s;

  for (const k of Object.keys(DEFAULTS)) {
    if (TRANSIENT.has(k)) continue;
    if (migrated && FORCE_DEFAULT_ON_MIGRATE.includes(k)) continue;
    if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
  }
  return s;
}

export function save() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (!TRANSIENT.has(k)) out[k] = settings[k];
  }
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch {}
}

// Exported for tests: which keys deliberately never reach storage.
export const TRANSIENT_KEYS = TRANSIENT;

export function reset() {
  Object.assign(settings, DEFAULTS);
  save();
}
