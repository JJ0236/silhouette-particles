// Matching a camera frame to the pattern that was on the wall when it was
// exposed.
//
// Small, but it is the seam where the whole structured-light pass lives or dies:
// get it wrong and the decoder is either starved of frames or fed the wrong
// pattern, and both look identical from outside — zero coverage.

// Two painted frames belong to the same hold when they show the same pattern.
// `settle` is deliberately not compared: it differs between the first frame of a
// hold and the rest, which is exactly the boundary this must see through.
export function sameHold(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'white' || a.kind === 'black') return a.step === b.step;
  return a.bit === b.bit && a.invert === b.invert && a.step === b.step;
}

// The pattern in force at time t, or null before the first paint.
export function specAt(painted, t) {
  for (let k = painted.length - 1; k >= 0; k--) {
    if (painted[k].t <= t) return painted[k].spec;
  }
  return null;
}

// How long that pattern had ALREADY BEEN on the wall at time t.
//
// Measured from when the pattern last changed, not from the last repaint. The
// driver repaints every frame — roughly every 16ms — so an age measured from
// the last paint is essentially always under 16ms, and a settle window of 60ms
// then discards every camera frame ever captured. The decoder is fed nothing
// and coverage is structurally zero, whatever the room or the optics do.
export function holdAgeAt(painted, t) {
  let k = painted.length - 1;
  while (k >= 0 && painted[k].t > t) k--;
  if (k < 0) return 0;
  const cur = painted[k].spec;
  let start = painted[k].t;
  for (let j = k - 1; j >= 0; j--) {
    if (!sameHold(painted[j].spec, cur)) break;
    start = painted[j].t;
  }
  return t - start;
}
