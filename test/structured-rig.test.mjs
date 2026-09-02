import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder, patternFor, smoothMap } from '../src/structured.js';

// The rig this piece actually runs on: a 5760x1080 edge-blended wall, so a
// 720x134 detector grid, photographed from the back of the room by a camera
// whose frame the screen fills only partly. Every camera pixel then covers
// SEVERAL display cells, the finest gray-code stripes are averaged away, and
// the decoder has to fall back to coarser bits. That fallback has to produce a
// map the wizard accepts and the warp can use — not a technically-correct
// scatter of block centres that the coverage gate then rejects as "no screen".
//
// The camera is modelled honestly: each pixel box-filters the display area it
// covers (that is what a sensor does), then a 3x3 optical blur, a lit floor,
// and a little noise.

const W = 720, H = 134;
const CAM_W = 960, CAM_H = 540;

function rig({ framing, blur = 1, lit = 0.55, noise = 0.02 }) {
  // Screen rectangle in the camera frame, centred, with the wall's aspect.
  const sw = CAM_W * framing, sh = sw * (H / W);
  const x0 = (CAM_W - sw) / 2, y0 = (CAM_H - sh) / 2;
  const truth = (u, v) => [(x0 + u * sw) / (CAM_W - 1), (y0 + v * sh) / (CAM_H - 1)];

  // Per camera pixel, the display cells its footprint covers (4x4 subsamples).
  const SS = 4;
  const foot = new Array(CAM_W * CAM_H).fill(null);
  for (let cy = Math.floor(y0) - 1; cy <= Math.ceil(y0 + sh) + 1; cy++) {
    for (let cx = Math.floor(x0) - 1; cx <= Math.ceil(x0 + sw) + 1; cx++) {
      if (cx < 0 || cy < 0 || cx >= CAM_W || cy >= CAM_H) continue;
      const cells = [];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = cx + (sx + 0.5) / SS, py = cy + (sy + 0.5) / SS;
          const u = (px - x0) / sw, v = (py - y0) / sh;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) { cells.push(-1); continue; }
          cells.push(Math.floor(v * H) * W + Math.floor(u * W));
        }
      }
      foot[cy * CAM_W + cx] = cells;
    }
  }

  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const raw = new Float32Array(CAM_W * CAM_H);
  const cam = new Float32Array(CAM_W * CAM_H);

  function observe(disp, out) {
    const FLOOR = 0.10;
    for (let i = 0; i < raw.length; i++) {
      const f = foot[i];
      if (!f) { raw[i] = FLOOR; continue; }
      let s = 0;
      for (const d of f) s += d < 0 ? 0 : disp[d] / 255;
      raw[i] = FLOOR + lit * (s / f.length);
    }
    // Optical blur, then sensor noise.
    for (let y = 0; y < CAM_H; y++) {
      for (let x = 0; x < CAM_W; x++) {
        let s = 0, c = 0;
        for (let dy = -blur; dy <= blur; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= CAM_H) continue;
          for (let dx = -blur; dx <= blur; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= CAM_W) continue;
            s += raw[yy * CAM_W + xx]; c++;
          }
        }
        out[y * CAM_W + x] = s / c + (rnd() - 0.5) * noise;
      }
    }
    return out;
  }

  return { truth, observe, cam, x0, y0, sw, sh };
}

function measure(framing, harsh = {}) {
  const r = rig({ framing, ...harsh });
  const dec = createDecoder({ w: W, h: H, camW: CAM_W, camH: CAM_H, holdFrames: 1 });
  const disp = new Uint8Array(W * H);
  for (let i = 0; i < dec.sequence.length; i++) {
    const spec = dec.sequence.frame(i);
    patternFor(spec, W, H, disp);
    dec.add(spec, r.observe(disp, r.cam));
  }
  // Exactly what photocal does with the result.
  const map = smoothMap(dec.finish({ minContrast: 0.05 }), 1);
  return { map, r };
}

function mapError(map, truth) {
  let n = 0, sum = 0, worst = 0, zeros = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = y * W + x;
      if (!map.filled[d]) continue;
      if (map.mapU[d] === 0 && map.mapV[d] === 0) zeros++;
      const [tu, tv] = truth(x / (W - 1), y / (H - 1));
      const e = Math.hypot((map.mapU[d] - tu) * (CAM_W - 1), (map.mapV[d] - tv) * (CAM_H - 1));
      sum += e; n++; if (e > worst) worst = e;
    }
  }
  return { n, mean: n ? sum / n : NaN, worst, zeros };
}

for (const framing of [0.25, 0.45]) {
  test(`screen filling ${framing * 100}% of the frame: the decode is accepted and the map is usable`, () => {
    const { map, r } = measure(framing);

    // The wizard's gate. A coarse-but-correct decode must pass it: the whole
    // screen was seen, just not to single-cell precision.
    assert.ok(map.coverage > 0.05,
      `coverage ${(map.coverage * 100).toFixed(2)}% — the wizard would report "no patterns decoded" ` +
      `(located to ${map.resolution.xCells}x${map.resolution.yCells}; rejects ${JSON.stringify(map.rejects)})`);
    // In fact the camera can see the ENTIRE screen here, and the map should say so.
    assert.ok(map.coverage > 0.9, `coverage ${(map.coverage * 100).toFixed(1)}% but the whole screen is in frame`);
    assert.ok(map.reach.spanFrac > 0.97, `span ${map.reach.spanFrac}`);

    // Every display cell must be filled, and none may point at the sensor's
    // corner — that is what the warp samples, and a (0,0) cell reads the wrong
    // part of the room.
    let unfilled = 0;
    for (let d = 0; d < W * H; d++) if (!map.filled[d]) unfilled++;
    assert.equal(unfilled, 0, `${unfilled} cells left unfilled`);
    const e = mapError(map, r.truth);
    assert.equal(e.zeros, 0, `${e.zeros} cells map to the sensor's top-left corner`);

    // Accuracy: a camera pixel here covers ~3 cells, so nothing finer than a
    // couple of camera pixels can be expected — but the map must be that good
    // everywhere, not only where the finest bits happened to resolve.
    assert.ok(e.mean < 1.5, `mean error ${e.mean.toFixed(2)} camera px`);
    assert.ok(e.worst < 6, `worst error ${e.worst.toFixed(2)} camera px`);
  });
}

// A dim room through a soft lens: the projector's light barely clears the
// sensor's noise, so noise alone gets tens of thousands of off-screen pixels
// past the contrast floor. Each decodes to a random cell, and one is enough to
// drag a block of the map across the room. They have to be thrown out.
test('dim and noisy at 25% framing: noise pixels do not corrupt the map', () => {
  const { map, r } = measure(0.25, { blur: 2, lit: 0.2, noise: 0.06 });
  assert.ok(map.coverage > 0.9, `coverage ${(map.coverage * 100).toFixed(1)}%`);
  // Most noise pixels already fail the block test; this catches the ones that
  // happen to decode to a plausible-looking block, which are the ones that
  // used to poison the map.
  assert.ok(map.rejects.stray > 100, `only ${map.rejects.stray} stray pixels rejected — noise was admitted`);
  const e = mapError(map, r.truth);
  assert.ok(e.mean < 2, `mean error ${e.mean.toFixed(2)} camera px`);
  assert.ok(e.worst < 8, `worst error ${e.worst.toFixed(2)} camera px`);
});
