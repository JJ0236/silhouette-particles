// Small grid helpers shared by the mask, flow and particle stages.
// Everything here is pure: same input, same output, no state. Easy to test.

// Separable box blur with a running sum. Radius in cells.
export function boxBlur(src, dst, w, h, radius, tmp) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) { dst.set(src); return dst; }
  const norm = 1 / (2 * r + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * norm;
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return dst;
}

// Separable max filter — morphological dilation. Used to grow the self-light
// mask so it covers the bloom halo around what was actually drawn.
export function dilate(src, dst, w, h, radius, tmp) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) { dst.set(src); return dst; }

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let i = -r; i <= r; i++) { const v = src[row + clamp(x + i, 0, w - 1)]; if (v > m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      for (let i = -r; i <= r; i++) { const v = tmp[clamp(y + i, 0, h - 1) * w + x]; if (v > m) m = v; }
      dst[y * w + x] = m;
    }
  }
  return dst;
}

// The contour, as a band around the mask's 0.5 isoline.
//
// The old approach (mask minus an eroded copy) could not draw a line thinner
// than one grid cell, because erosion works in whole cells. This measures the
// distance to the isoline instead — |mask - 0.5| divided by the local gradient
// — so `width` is continuous and sub-cell widths are available. It also
// anti-aliases for free, which the erosion difference never did.
export function contourBand(mask, dst, w, h, width, gain) {
  const iw = 1 / Math.max(0.05, width);
  dst.fill(0);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (mask[i + 1] - mask[i - 1]) * 0.5;
      const gy = (mask[i + w] - mask[i - w]) * 0.5;
      const g = Math.sqrt(gx * gx + gy * gy);
      if (g < 1e-4) continue;                 // flat region: no contour here
      const d = Math.abs(mask[i] - 0.5) / g;  // cells to the isoline
      const v = 1 - d * iw;
      if (v > 0) dst[i] = Math.min(1, v * gain);
    }
  }
  return dst;
}

// Bilinear sample. u,v are normalised 0..1 across the grid.
export function sample(field, w, h, u, v) {
  const fx = clampf(u, 0, 1) * (w - 1);
  const fy = clampf(v, 0, 1) * (h - 1);
  const x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0;
  const a = field[y0 * w + x0], b = field[y0 * w + x1];
  const c = field[y1 * w + x0], d = field[y1 * w + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// Central-difference gradient at a normalised position, in field units.
export function gradient(field, w, h, u, v, out) {
  const ex = 1 / (w - 1), ey = 1 / (h - 1);
  out[0] = (sample(field, w, h, u + ex, v) - sample(field, w, h, u - ex, v)) * 0.5;
  out[1] = (sample(field, w, h, u, v + ey) - sample(field, w, h, u, v - ey)) * 0.5;
  return out;
}

export const clamp  = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clampf = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
