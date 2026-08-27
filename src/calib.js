import { DEFAULT_QUAD, isUsableQuad, squareToQuad } from './homography.js';

// Where the display lives inside the camera's view, in camera-frame
// normalised coordinates. Persisted separately from the look settings — you
// retune the look often, you calibrate the rig once.

const KEY = 'silhouette-particles/calibration';

export function createCalibration() {
  let quad = load();
  let H = squareToQuad(quad);
  let calibrated = hasStored();

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && isUsableQuad(raw.quad)) return raw.quad.map(p => [p[0], p[1]]);
    } catch {}
    return DEFAULT_QUAD.map(p => [p[0], p[1]]);
  }

  function hasStored() {
    try { return !!JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return false; }
  }

  function setCorner(i, x, y) {
    const next = quad.map(p => [p[0], p[1]]);
    next[i] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
    // Refuse the edit rather than accept a quad that warps to nonsense.
    if (!isUsableQuad(next)) return false;
    quad = next;
    H = squareToQuad(quad);
    return true;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ quad })); calibrated = true; } catch {}
  }

  function reset() {
    quad = DEFAULT_QUAD.map(p => [p[0], p[1]]);
    H = squareToQuad(quad);
    try { localStorage.removeItem(KEY); } catch {}
    calibrated = false;
  }

  function nearestCorner(x, y, maxDist) {
    let best = -1, bestD = maxDist * maxDist;
    for (let i = 0; i < 4; i++) {
      const dx = quad[i][0] - x, dy = quad[i][1] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  return {
    get quad() { return quad; },
    get H() { return H; },
    get calibrated() { return calibrated; },
    setCorner, save, reset, nearestCorner,
  };
}
