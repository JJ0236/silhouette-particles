// A pure stand-in for render.js at grid resolution G. Same ingredients —
// void floor, additive contour in the outline hue, amber particle dots, a
// box-blur bloom — deliberately erring bright and wide. The closed-loop tests
// feed this to the simulated camera; if the piece is immune to a renderer at
// least as bright as the real one, it is immune to the real one.
//
// Pure: no DOM. w/h may be passed in the options; otherwise they are inferred
// from the buffer length assuming 16:9 (480×270 → N = 129600).

import { boxBlur } from './field.js';

export const RENDER_DEFAULTS = Object.freeze({
  voidFloor: 5, outlineHue: 190, particleHue: 45, particleAlpha: 0.55,
  particleSize: 1.6, glow: 0.35, rimGain: 1.7,
});

const clamp255 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

export function hsl(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((v) => Math.round(v * 255));
}
function hue(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function inferSize(N, w, h) {
  if (w && h) return [w, h];
  if (w) return [w, Math.round(N / w)];
  if (h) return [Math.round(N / h), h];
  const gw = Math.round(Math.sqrt((N * 16) / 9));
  return [gw, Math.round(N / gw)];
}

// Scratch buffers keyed by cell count so repeated frames allocate nothing.
const scratch = new Map();
function scratchFor(N) {
  let s = scratch.get(N);
  if (!s) {
    s = { lit: new Float32Array(N * 3), plane: new Float32Array(N), blur: new Float32Array(N), tmp: new Float32Array(N) };
    scratch.set(N, s);
  }
  return s;
}

export function renderFrame({ rim, particles = null, presence = 1, settings = {}, w, h, bloomRadius = 2 }, out) {
  const s = settings === RENDER_DEFAULTS ? settings : { ...RENDER_DEFAULTS, ...settings };
  const N = rim ? rim.length : (out.length / 3) | 0;
  if (!out) out = new Uint8Array(N * 3);
  [w, h] = inferSize(N, w, h);
  const { lit, plane, blur, tmp } = scratchFor(N);
  lit.fill(0);

  const floor = clamp255((s.voidFloor / 100) * 255);

  // Contour: 'lighter' compositing adds colour × alpha, alpha capped at 1.
  if (rim) {
    const [rr, rg, rb] = hsl(s.outlineHue, 0.85, 0.6);
    const k = presence * s.rimGain;
    for (let i = 0, o = 0; i < N; i++, o += 3) {
      let a = rim[i] * k;
      if (a <= 0) continue;
      if (a > 1) a = 1;
      lit[o] += rr * a; lit[o + 1] += rg * a; lit[o + 2] += rb * a;
    }
  }

  // Particles: the real renderer draws sub-cell squares at 1920 wide; here a
  // dot always covers at least one whole cell at full alpha — brighter.
  if (particles && particles.count > 0) {
    const [pr, pg, pb] = hsl(s.particleHue, 0.9, 0.62);
    const a = s.particleAlpha;
    const size = Math.max(1, Math.round((s.particleSize * w) / 1920));
    const xs = particles.x, ys = particles.y, n = particles.count;
    for (let i = 0; i < n; i++) {
      const px = Math.floor(xs[i] * w), py = Math.floor(ys[i] * h);
      for (let dy = 0; dy < size; dy++) {
        const y = py + dy; if (y < 0 || y >= h) continue;
        for (let dx = 0; dx < size; dx++) {
          const x = px + dx; if (x < 0 || x >= w) continue;
          const o = (y * w + x) * 3;
          lit[o] += pr * a; lit[o + 1] += pg * a; lit[o + 2] += pb * a;
        }
      }
    }
  }

  // Bloom of the whole scene including the floor, as the real one blurs the
  // finished scene; the floor therefore reads floor × (1 + glow).
  const glow = s.glow;
  for (let ch = 0; ch < 3; ch++) {
    if (glow > 0 && bloomRadius > 0) {
      for (let i = 0; i < N; i++) plane[i] = lit[i * 3 + ch] + floor;
      boxBlur(plane, blur, w, h, bloomRadius, tmp);
      for (let i = 0; i < N; i++) out[i * 3 + ch] = clamp255(floor + lit[i * 3 + ch] + glow * blur[i]);
    } else {
      for (let i = 0; i < N; i++) out[i * 3 + ch] = clamp255(floor + lit[i * 3 + ch]);
    }
  }
  return out;
}

// Flat calibration patches: lit patches at `level`, everything else black.
// What the wizard shows during the photometric step.
export function renderPatches(layout, spec, out) {
  out.fill(0);
  const level = spec.level;
  for (const p of spec.lit) {
    const cs = layout.cells[p];
    for (let k = 0; k < cs.length; k++) { const o = cs[k] * 3; out[o] = level; out[o + 1] = level; out[o + 2] = level; }
  }
  return out;
}

// --- test occluders ----------------------------------------------------------

// A person-shaped occluder with an outstretched hand. The fingers are the
// whole point: exactly 3 cells wide with 2-cell gaps regardless of scale, so
// a test can assert segmentation keeps them apart. `scale` sizes the body;
// fingers stay at the minimum the contract demands.
export function synthPerson(w, h, { cx, cy, scale = 1, fingers = true } = {}) {
  const N = w * h;
  const occ = new Float32Array(N);
  cx = cx ?? w * 0.4; cy = cy ?? h * 0.55;
  const s = scale;
  const fill = (x, y) => { if (x >= 0 && x < w && y >= 0 && y < h) occ[y * w + x] = 1; };

  const ellipse = (ex, ey, rx, ry) => {
    const x0 = Math.max(0, Math.floor(ex - rx)), x1 = Math.min(w - 1, Math.ceil(ex + rx));
    const y0 = Math.max(0, Math.floor(ey - ry)), y1 = Math.min(h - 1, Math.ceil(ey + ry));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const u = (x - ex) / rx, v = (y - ey) / ry;
      if (u * u + v * v <= 1) occ[y * w + x] = 1;
    }
  };
  const rect = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, Math.round(y0)); y <= Math.min(h - 1, Math.round(y1)); y++)
      for (let x = Math.max(0, Math.round(x0)); x <= Math.min(w - 1, Math.round(x1)); x++) occ[y * w + x] = 1;
  };
  const capsule = (ax, ay, bx, by, r) => {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let t = ((x - ax) * dx + (y - ay) * dy) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx - x, py = ay + t * dy - y;
      if (px * px + py * py <= r * r) occ[y * w + x] = 1;
    }
  };

  ellipse(cx, cy, 20 * s, 48 * s);                                       // torso
  ellipse(cx, cy - 62 * s, 15 * s, 15 * s);                              // head
  rect(cx - 18 * s, cy + 36 * s, cx - 4 * s, cy + 95 * s);               // legs
  rect(cx + 4 * s, cy + 36 * s, cx + 18 * s, cy + 95 * s);
  capsule(cx + 14 * s, cy - 36 * s, cx + 62 * s, cy - 50 * s, 6 * s);    // arm

  // Hand: palm block then five fingers reaching right.
  const fingerRows = 3, gapRows = 2, count = 5;
  const blockH = count * fingerRows + (count - 1) * gapRows;              // 23
  const fingerTop = Math.round(cy - 50 * s - blockH / 2);
  const palmL = Math.round(cx + 58 * s), palmR = Math.round(cx + 72 * s);
  rect(palmL, fingerTop - 1, palmR, fingerTop + blockH);
  const fingerCells = [], gapCells = [];
  if (fingers) {
    const fx0 = palmR + 1, fx1 = fx0 + Math.max(6, Math.round(14 * s)) - 1;
    for (let f = 0; f < count; f++) {
      const y0 = fingerTop + f * (fingerRows + gapRows);
      const cells = [];
      for (let y = y0; y < y0 + fingerRows; y++) for (let x = fx0; x <= fx1; x++) {
        if (x < w && y < h && x >= 0 && y >= 0) { fill(x, y); cells.push(y * w + x); }
      }
      fingerCells.push(Int32Array.from(cells));
      if (f < count - 1) {
        const g = [];
        for (let y = y0 + fingerRows; y < y0 + fingerRows + gapRows; y++) for (let x = fx0; x <= fx1; x++) {
          if (x < w && y < h && x >= 0 && y >= 0) g.push(y * w + x);
        }
        gapCells.push(Int32Array.from(g));
      }
    }
  }
  synthPerson.last = { fingerCells, gapCells, cx, cy, scale: s };
  return occ;
}
synthPerson.last = { fingerCells: [], gapCells: [] };

// The person walking at `speedCells` per frame, bouncing between margins that
// keep the hand inside the frame.
export function movingPerson(w, h, i, { speedCells = 3, x0 = 80, cy, scale = 1, fingers = true, bounce = true } = {}) {
  const xMin = 40 * scale, xMax = w - 100 * scale;
  let cx = x0 + speedCells * i;
  if (bounce) {
    const span = xMax - xMin;
    let u = (cx - xMin) % (2 * span); if (u < 0) u += 2 * span;
    cx = xMin + (u <= span ? u : 2 * span - u);
  }
  return synthPerson(w, h, { cx: Math.round(cx), cy: cy ?? Math.round(h * 0.55), scale, fingers });
}

export function randomParticles(count, seed = 1) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const x = new Float32Array(count), y = new Float32Array(count);
  for (let i = 0; i < count; i++) { x[i] = rand(); y[i] = rand(); }
  return { x, y, count };
}

// Particles drifting at a constant velocity (normalised units per frame),
// wrapping — so the ring sees moving dots like the real piece does.
export function driftParticles(base, i, { vx = 0.0015, vy = 0.0007 } = {}, out) {
  const n = base.count;
  if (!out) out = { x: new Float32Array(n), y: new Float32Array(n), count: n };
  for (let k = 0; k < n; k++) {
    out.x[k] = (((base.x[k] + vx * i) % 1) + 1) % 1;
    out.y[k] = (((base.y[k] + vy * i) % 1) + 1) % 1;
  }
  return out;
}
