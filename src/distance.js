// Signed distance from the body's outline, in cells: negative inside the
// mask, positive outside, zero on the edge.
//
// The particles need to know two things about the body — "am I inside it"
// and "which way is the edge, and how far" — and a distance field answers both
// with one sample and one gradient. The mask gradient the old occupancy nudge
// used is only non-zero in a thin band at the edge, so a particle deep inside
// the body felt nothing and sat there; the distance field points at the edge
// from everywhere.
//
// Chamfer 3-4 in two passes, which is within a few percent of Euclidean and
// costs two sweeps over the grid. Distances are capped at `maxDist` on both
// sides; beyond that the field is flat and particles are on their own.

export function signedDistance(bin, w, h, out, maxDist = 16) {
  const N = w * h;
  // Outside, the field is capped at `maxDist`: past that the outline has no
  // hold on a particle. Inside it is never capped — a particle deep in the
  // body must still be told which way out, and a flat cap there is exactly
  // the "no force in the interior" failure the field exists to fix.
  const BIG = (w + h) * 4;   // in chamfer units (3 per cell)
  // dOut: distance from every cell to the nearest INSIDE cell (0 inside).
  // dIn:  distance from every cell to the nearest OUTSIDE cell (0 outside).
  // Only one of them is non-zero at any cell; the signed result is their
  // difference, shifted half a cell so the edge sits between the two.
  chamfer(bin, w, h, out, BIG, 1);      // out = dOut
  const tmp = signedDistance.tmp && signedDistance.tmp.length === N ? signedDistance.tmp : (signedDistance.tmp = new Float32Array(N));
  chamfer(bin, w, h, tmp, BIG, 0);      // tmp = dIn
  const cap = maxDist;
  for (let i = 0; i < N; i++) {
    // The crossing lies between an inside cell and an outside one, so each
    // side is half a cell nearer the edge than its chamfer distance says.
    const d = bin[i] ? -(tmp[i] / 3 - 0.5) : (out[i] / 3 - 0.5);
    out[i] = d > cap ? cap : d;
  }
  return out;
}

// Distance (chamfer units) from each cell to the nearest cell whose bin
// value equals `seed`.
function chamfer(bin, w, h, d, BIG, seed) {
  const N = w * h;
  for (let i = 0; i < N; i++) d[i] = bin[i] === seed ? 0 : BIG;
  // Forward pass: up-left, up, up-right, left.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0 && d[i - 1] + 3 < v) v = d[i - 1] + 3;
      if (y > 0) {
        if (d[i - w] + 3 < v) v = d[i - w] + 3;
        if (x > 0 && d[i - w - 1] + 4 < v) v = d[i - w - 1] + 4;
        if (x < w - 1 && d[i - w + 1] + 4 < v) v = d[i - w + 1] + 4;
      }
      d[i] = v;
    }
  }
  // Backward pass: down-right, down, down-left, right.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1 && d[i + 1] + 3 < v) v = d[i + 1] + 3;
      if (y < h - 1) {
        if (d[i + w] + 3 < v) v = d[i + w] + 3;
        if (x < w - 1 && d[i + w + 1] + 4 < v) v = d[i + w + 1] + 4;
        if (x > 0 && d[i + w - 1] + 4 < v) v = d[i + w - 1] + 4;
      }
      d[i] = v;
    }
  }
}
