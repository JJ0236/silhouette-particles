import { WORK_W, WORK_H, MASK_W, MASK_H, settings } from './config.js';
import { boxBlur, sample } from './field.js';

// Estimates which way the body is moving, per cell, in normalised screen units
// (1.0 = a full screen width per frame).
//
// It reads the BODY MASK, not camera luma. Luma flow depends on the person
// having texture and on the room being lit evenly; a dark sleeve against a
// dark room gives almost no gradient, so arm swipes came out weak and noisy.
// The mask is high-contrast by construction and moves exactly with the person,
// so a limb's edge always produces a strong gradient. It also cannot see the
// display's own content, which removes a whole class of feedback.
//
// Estimator is normal flow from Ix*u + Iy*v + It = 0. The input is deliberately
// blurred first: gradient methods only hold while the displacement is small
// relative to the gradient's support, so widening the support is what lets a
// fast swipe be measured instead of clipped. It's the cheap stand-in for a
// proper coarse-to-fine pyramid.

export function createFlow() {
  const N = WORK_W * WORK_H;
  const prev  = new Float32Array(N);
  const cur   = new Float32Array(N);
  const vx    = new Float32Array(N);
  const vy    = new Float32Array(N);
  const rawX  = new Float32Array(N);
  const rawY  = new Float32Array(N);
  const tmp   = new Float32Array(N);
  const smX   = new Float32Array(N);
  const smY   = new Float32Array(N);
  let primed = false;

  const EPS = 0.0006;
  const BIRTH_LO = 0.06, BIRTH_HI = 0.30;   // persistence needed to trust a reading
  const MAX_CELLS = 5;   // generous enough for a swipe, low enough to stay sane

  function update(motion, influence) {
    boxBlur(motion, cur, WORK_W, WORK_H, settings.flowScale, tmp);
    if (!primed) { prev.set(cur); primed = true; return; }

    for (let y = 1; y < WORK_H - 1; y++) {
      const v = y / (WORK_H - 1);
      for (let x = 1; x < WORK_W - 1; x++) {
        const i = y * WORK_W + x;
        const gate = influence ? sample(influence, MASK_W, MASK_H, x / (WORK_W - 1), v) : 1;
        if (gate < 0.02) { rawX[i] = 0; rawY[i] = 0; continue; }

        // Motion is only meaningful where the body EXISTED IN BOTH FRAMES.
        //
        // The flow constraint assumes the field changes smoothly. A mask that
        // blinks on or off breaks that badly: at the edges you get a huge
        // temporal difference against a real gradient, so the estimator
        // returns near-maximum velocity out of nowhere. That is what threw
        // every particle against the walls.
        //
        // A translating edge still passes — the input is pre-blurred, so both
        // frames overlap across the transition. A blink does not, because one
        // of the two frames is empty there.
        const persist = prev[i] < cur[i] ? prev[i] : cur[i];
        if (persist <= BIRTH_LO) { rawX[i] = 0; rawY[i] = 0; continue; }
        const trust = persist >= BIRTH_HI ? 1 : (persist - BIRTH_LO) / (BIRTH_HI - BIRTH_LO);

        const ix = (cur[i + 1] - cur[i - 1]) * 0.5;
        const iy = (cur[i + WORK_W] - cur[i - WORK_W]) * 0.5;
        const it = cur[i] - prev[i];
        const m2 = ix * ix + iy * iy + EPS;

        let u = -(it * ix) / m2;
        let w = -(it * iy) / m2;
        if (u >  MAX_CELLS) u =  MAX_CELLS; else if (u < -MAX_CELLS) u = -MAX_CELLS;
        if (w >  MAX_CELLS) w =  MAX_CELLS; else if (w < -MAX_CELLS) w = -MAX_CELLS;

        rawX[i] = u * gate * trust;
        rawY[i] = w * gate * trust;
      }
    }
    prev.set(cur);

    boxBlur(rawX, smX, WORK_W, WORK_H, settings.flowBlur, tmp);
    boxBlur(rawY, smY, WORK_W, WORK_H, settings.flowBlur, tmp);

    // Temporal smoothing gives the push weight, but too much of it averages a
    // swipe away — this is the knob that decides whether a gesture lands.
    const k = 1 - settings.flowSmooth;
    const g = settings.flowGain;
    for (let i = 0; i < N; i++) {
      vx[i] += (smX[i] * g / WORK_W - vx[i]) * k;
      vy[i] += (smY[i] * g / WORK_H - vy[i]) * k;
    }
  }

  function reset() { primed = false; vx.fill(0); vy.fill(0); prev.fill(0); }

  return { update, reset, vx, vy };
}
