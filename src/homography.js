// Maps the unit square (display space) onto an arbitrary quadrilateral
// (where the display sits in the camera's view).
//
// A plain crop can't do this. The camera looks at the display from across the
// room and slightly off-axis, so the display's outline in the camera image is
// a trapezoid, not a rectangle. Only a projective transform straightens that
// out — an affine one leaves the keystone in, and you'd see it as a silhouette
// that drifts out of alignment toward the edges of the screen.
//
// Heckbert's square-to-quad solution. Corners are ordered:
//   p0 = (0,0) top-left, p1 = (1,0) top-right, p2 = (1,1) bottom-right, p3 = (0,1) bottom-left

export function squareToQuad(quad) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;

  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;

  // A parallelogram needs no perspective term; solving for one would divide by
  // a vanishing determinant.
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    return { a: x1 - x0, b: x2 - x1, c: x0,
             d: y1 - y0, e: y2 - y1, f: y0,
             g: 0,       h: 0 };
  }

  const dx1 = x1 - x2, dx2 = x3 - x2;
  const dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;   // degenerate quad

  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;

  return {
    a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
    d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0,
    g, h,
  };
}

// Display space (u,v) -> camera image space, both normalised 0..1.
export function project(H, u, v, out) {
  const w = H.g * u + H.h * v + 1;
  const iw = Math.abs(w) < 1e-12 ? 0 : 1 / w;
  out[0] = (H.a * u + H.b * v + H.c) * iw;
  out[1] = (H.d * u + H.e * v + H.f) * iw;
  return out;
}

export const DEFAULT_QUAD = [[0.30, 0.30], [0.70, 0.30], [0.70, 0.70], [0.30, 0.70]];

// Guards against a quad that's been dragged inside out or collapsed — a
// degenerate one would warp to garbage rather than fail loudly.
export function isUsableQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return false;
  for (const p of quad) {
    if (!Array.isArray(p) || p.length !== 2) return false;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
  }
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = quad[i], [x2, y2] = quad[(i + 1) % 4];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2) > 0.002 && squareToQuad(quad) !== null;
}
