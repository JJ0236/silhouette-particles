import { WORK_W, WORK_H, MASK_W, MASK_H, settings } from './config.js';
import { sample, gradient } from './field.js';

// Positions live in normalised 0..1 space so a resize or a different display
// costs nothing. The renderer maps to pixels.

// Slider values are kept in friendly ranges (0..100) and scaled here, so the
// panel reads sensibly without the physics constants leaking into the UI.
const PUSH_SCALE      = 0.02;
const OCCUPANCY_SCALE = 0.004;
const DRIFT_SCALE     = 0.00030;

export function createParticles(count) {
  let n = 0;
  let x, y, vx, vy, rx, ry, phase;
  const g = new Float32Array(2);

  function allocate(newCount) {
    const nx = new Float32Array(newCount), ny = new Float32Array(newCount);
    const nvx = new Float32Array(newCount), nvy = new Float32Array(newCount);
    const nrx = new Float32Array(newCount), nry = new Float32Array(newCount);
    const np = new Float32Array(newCount);
    const keep = Math.min(n, newCount);
    if (keep) {
      nx.set(x.subarray(0, keep));   ny.set(y.subarray(0, keep));
      nvx.set(vx.subarray(0, keep)); nvy.set(vy.subarray(0, keep));
      nrx.set(rx.subarray(0, keep)); nry.set(ry.subarray(0, keep));
      np.set(phase.subarray(0, keep));
    }
    for (let i = keep; i < newCount; i++) {
      nrx[i] = nx[i] = Math.random();
      nry[i] = ny[i] = Math.random();
      np[i] = Math.random() * Math.PI * 2;
    }
    x = nx; y = ny; vx = nvx; vy = nvy; rx = nrx; ry = nry; phase = np;
    n = newCount;
  }
  allocate(count);

  // `gain` is the presence level: with nobody there it falls to zero, so a
  // stray mask flicker in an empty room can't shove the field around.
  function update(flow, seg, t, gain = 1) {
    const push   = settings.push * PUSH_SCALE * gain;
    const occ    = settings.occupancy * OCCUPANCY_SCALE * gain;
    const ret    = settings.returnForce;
    const damp   = settings.damping;
    const drift  = settings.drift * DRIFT_SCALE;
    const maxSp  = settings.maxSpeed;
    const td     = t * 0.0004;

    for (let i = 0; i < n; i++) {
      const u = x[i], v = y[i];
      let ax = 0, ay = 0;

      // Halo of influence: reaches slightly past your outline, so the push
      // starts just before you visibly touch a particle.
      const inf = sample(seg.influence, MASK_W, MASK_H, u, v);
      if (inf > 0.01) {
        // The shove — particles inherit the direction you moved.
        ax += sample(flow.vx, WORK_W, WORK_H, u, v) * push * inf;
        ay += sample(flow.vy, WORK_W, WORK_H, u, v) * push * inf;

        // "You occupy space": nudge particles down the mask gradient, i.e.
        // outward. Without this, standing still lets particles settle inside
        // your outline and the silhouette reads as broken.
        const m = sample(seg.mask, MASK_W, MASK_H, u, v);
        if (m > 0.01) {
          gradient(seg.influence, MASK_W, MASK_H, u, v, g);
          ax -= g[0] * occ * m;
          ay -= g[1] * occ * m;
        }
      }

      // Idle wander, so the field is never completely dead.
      const p = phase[i];
      ax += Math.cos(td + p) * drift;
      ay += Math.sin(td * 1.3 + p * 1.7) * drift;

      // Ease back toward rest: the piece heals itself after each person.
      ax += (rx[i] - u) * ret;
      ay += (ry[i] - v) * ret;

      let nvx = (vx[i] + ax) * damp;
      let nvy = (vy[i] + ay) * damp;

      // Hard ceiling on speed. Not tuning — a backstop. A bad flow reading
      // once drove terminal velocity to ~40% of the screen per frame and threw
      // the entire field against the walls; nothing upstream should ever be
      // able to do that again, whatever else goes wrong.
      const sp2 = nvx * nvx + nvy * nvy;
      if (sp2 > maxSp * maxSp) {
        const k = maxSp / Math.sqrt(sp2);
        nvx *= k; nvy *= k;
      }

      let nx = u + nvx, ny = v + nvy;

      // Soft walls.
      if (nx < 0) { nx = 0; nvx = -nvx * 0.3; } else if (nx > 1) { nx = 1; nvx = -nvx * 0.3; }
      if (ny < 0) { ny = 0; nvy = -nvy * 0.3; } else if (ny > 1) { ny = 1; nvy = -nvy * 0.3; }

      x[i] = nx; y[i] = ny; vx[i] = nvx; vy[i] = nvy;
    }
  }

  return {
    update,
    get count() { return n; },
    get x() { return x; },
    get y() { return y; },
    setCount(c) { if (c !== n) allocate(c); },
  };
}
