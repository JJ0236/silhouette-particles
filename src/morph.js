// Binary morphology and labelling for the occlusion mask. Pure, allocation-free
// in the per-frame paths (the label/stack/tmp scratch is passed in by the caller).
//
// Finger preservation drives every size choice here: a finger is 3 cells wide
// with 2-cell gaps at grid G, and the mask stages must not weld or amputate it.

import { dilate } from './field.js';

// Separable min filter over a (2r+1)^2 window, edges clamped so a border cell
// sees only in-bounds neighbours. Works for Float32 (prediction images) and
// Uint8 (masks) alike; `tmp` must be the same kind as `dst`.
export function erode(src, dst, w, h, r, tmp) {
  r = Math.max(0, Math.round(r));
  if (r === 0) { dst.set(src); return dst; }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x - r > 0 ? x - r : 0, x1 = x + r < w - 1 ? x + r : w - 1;
      let m = src[row + x0];
      for (let i = x0 + 1; i <= x1; i++) { const v = src[row + i]; if (v < m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = y - r > 0 ? y - r : 0, y1 = y + r < h - 1 ? y + r : h - 1;
      let m = tmp[y0 * w + x];
      for (let j = y0 + 1; j <= y1; j++) { const v = tmp[j * w + x]; if (v < m) m = v; }
      dst[y * w + x] = m;
    }
  }
  return dst;
}

// Opening with the symmetric (2r+1)^2 square: strips anything thinner than
// 2r+1 cells and hands back everything wider unchanged, so r=1 removes 1- and
// 2-wide slivers but returns a 3-wide finger exactly. The dilate pass can read
// and write `dst` because each separable pass consumes its input fully before
// the next one writes.
export function open(bin, dst, w, h, r, tmp) {
  r = Math.max(0, Math.round(r));
  if (r === 0) { dst.set(bin); return dst; }
  erode(bin, dst, w, h, r, tmp);
  dilate(dst, dst, w, h, r, tmp);
  return dst;
}

// Closing whose reach is r cells, not 2r. A closing with a symmetric (2r+1)^2
// square fills every gap up to 2r wide, so even r=1 would weld 3-wide fingers
// across their 2-cell gaps. Using an (r+1)^2 structuring element instead (max
// over [x, x+r], then min over [x-r, x]) fills gaps <= r completely and leaves
// wider gaps completely alone, which is the guarantee closeR=1 needs.
export function close(bin, dst, w, h, r, tmp) {
  r = Math.max(0, Math.round(r));
  if (r === 0) { dst.set(bin); return dst; }
  // Dilate: forward-looking max, x then y. tmp <- bin, dst <- tmp.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x1 = x + r < w - 1 ? x + r : w - 1;
      let m = 0;
      for (let i = x; i <= x1; i++) if (bin[row + i]) { m = 1; break; }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y1 = y + r < h - 1 ? y + r : h - 1;
      let m = 0;
      for (let j = y; j <= y1; j++) if (tmp[j * w + x]) { m = 1; break; }
      dst[y * w + x] = m;
    }
  }
  // Erode with the reflected element: backward-looking min. tmp <- dst, dst <- tmp.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x - r > 0 ? x - r : 0;
      let m = 1;
      for (let i = x0; i <= x; i++) if (!dst[row + i]) { m = 0; break; }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = y - r > 0 ? y - r : 0;
      let m = 1;
      for (let j = y0; j <= y; j++) if (!tmp[j * w + x]) { m = 0; break; }
      dst[y * w + x] = m;
    }
  }
  return dst;
}

// 4-connected labelling by iterative flood fill. Each cell is pushed at most
// once (it is labelled on push), so an N-entry stack can never overflow, and
// there is no recursion to blow the JS stack on a full-frame component.
// areas[0] counts the background so callers can read coverage for free.
export function components(bin, w, h, labels, stack) {
  const n = w * h;
  labels.fill(0);
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (!bin[s] || labels[s]) continue;
    const label = ++count;
    labels[s] = label;
    let sp = 0;
    stack[sp++] = s;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      if (x > 0 && bin[i - 1] && !labels[i - 1]) { labels[i - 1] = label; stack[sp++] = i - 1; }
      if (x < w - 1 && bin[i + 1] && !labels[i + 1]) { labels[i + 1] = label; stack[sp++] = i + 1; }
      if (i >= w && bin[i - w] && !labels[i - w]) { labels[i - w] = label; stack[sp++] = i - w; }
      if (i + w < n && bin[i + w] && !labels[i + w]) { labels[i + w] = label; stack[sp++] = i + w; }
    }
  }
  // Second pass for the per-component stats: cheaper than growing arrays while
  // filling, and the count is only known once labelling is done.
  const areas = new Int32Array(count + 1);
  const touchesBorder = new Uint8Array(count + 1);
  for (let i = 0; i < n; i++) areas[labels[i]]++;
  for (let x = 0; x < w; x++) { touchesBorder[labels[x]] = 1; touchesBorder[labels[n - w + x]] = 1; }
  for (let y = 0; y < h; y++) { touchesBorder[labels[y * w]] = 1; touchesBorder[labels[y * w + w - 1]] = 1; }
  touchesBorder[0] = 0;
  return { count, areas, touchesBorder };
}

// Components with area strictly below minArea are cleared; a component of
// exactly minArea survives so `minComponentFrac * N` reads as "at least".
export function removeSmall(bin, labels, areas, minArea) {
  for (let i = 0; i < bin.length; i++) if (bin[i] && areas[labels[i]] < minArea) bin[i] = 0;
  return bin;
}

// Labels the background of `bin` (via `tmp`, a Uint8Array(N)) and fills the
// enclosed pockets that are small enough and that `accept` approves. The cell
// lists handed to `accept` are views into `stack`, grouped by label with a
// counting sort, so no per-hole arrays are built. `stack` is free for reuse
// once components() has returned.
export function fillHoles(bin, w, h, { maxArea = Infinity, accept } = {}, labels, stack, tmp) {
  const n = w * h;
  for (let i = 0; i < n; i++) tmp[i] = bin[i] ? 0 : 1;
  const { count, areas, touchesBorder } = components(tmp, w, h, labels, stack);
  if (count === 0) return bin;
  // Only enclosed, small-enough pockets need their cells enumerated.
  let any = false;
  for (let l = 1; l <= count; l++) if (!touchesBorder[l] && areas[l] <= maxArea) { any = true; break; }
  if (!any) return bin;
  const start = new Int32Array(count + 2);
  for (let l = 1; l <= count; l++) start[l + 1] = start[l] + areas[l];
  const cursor = start.slice();
  for (let i = 0; i < n; i++) { const l = labels[i]; if (l) stack[cursor[l]++] = i; }
  for (let l = 1; l <= count; l++) {
    const area = areas[l];
    if (touchesBorder[l] || area > maxArea) continue;
    const cells = stack.subarray(start[l], start[l] + area);
    if (accept && accept({ label: l, area, cells }) !== true) continue;
    for (let k = 0; k < cells.length; k++) bin[cells[k]] = 1;
  }
  return bin;
}

// Flood from every seed cell through 4-connected candidate cells. Seeds are
// kept whether or not they are candidates (in the detector seed ⊂ cand, so
// this only matters for callers passing inconsistent masks). Marking on push
// bounds the stack at N entries.
export function hysteresis(seed, cand, w, h, dst, stack) {
  const n = w * h;
  dst.fill(0);
  let sp = 0;
  for (let s = 0; s < n; s++) {
    if (!seed[s] || dst[s]) continue;
    dst[s] = 1;
    stack[sp++] = s;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      let j;
      if (x > 0) { j = i - 1; if (!dst[j] && (cand[j] || seed[j])) { dst[j] = 1; stack[sp++] = j; } }
      if (x < w - 1) { j = i + 1; if (!dst[j] && (cand[j] || seed[j])) { dst[j] = 1; stack[sp++] = j; } }
      if (i >= w) { j = i - w; if (!dst[j] && (cand[j] || seed[j])) { dst[j] = 1; stack[sp++] = j; } }
      if (i + w < n) { j = i + w; if (!dst[j] && (cand[j] || seed[j])) { dst[j] = 1; stack[sp++] = j; } }
    }
  }
  return dst;
}

// Majority vote of three 0/1 masks: a cell that flickers on for one frame or
// off for one frame is overruled by its neighbours in time.
export function temporalMedian3(a, b, c, dst) {
  for (let i = 0; i < dst.length; i++) dst[i] = a[i] + b[i] + c[i] >= 2 ? 1 : 0;
  return dst;
}

// Camera code → linear light, as a 256-entry table. Codes at or below the
// pedestal are black; 255 maps to exactly 1. The pedestal is capped so the
// normalisation never divides by zero.
export function linearise(pedestal, gamma, out) {
  const p = Math.min(254, Math.max(0, pedestal));
  const inv = 1 / (255 - p);
  for (let c = 0; c < 256; c++) {
    const v = (c - p) * inv;
    out[c] = v > 0 ? Math.pow(v, gamma) : 0;
  }
  return out;
}
