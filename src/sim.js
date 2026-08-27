import { MASK_W, MASK_H, WORK_W, WORK_H } from './config.js';
import { sample } from './field.js';

// A synthetic figure that walks and swings an arm. Lets the whole pipeline —
// flow estimation, push direction, particle response, rendering — be verified
// deterministically, with no camera and nobody standing in the room.

export function createSim() {
  const c = document.createElement('canvas');
  c.width = MASK_W; c.height = MASK_H;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  const mask = new Float32Array(MASK_W * MASK_H);
  const luma = new Float32Array(WORK_W * WORK_H);

  function update(t) {
    const s = t * 0.001;
    const cx = MASK_W * (0.5 + 0.3 * Math.sin(s * 0.6));
    const cy = MASK_H * 0.62;
    const armAngle = Math.sin(s * 2.2) * 1.3 - 0.4;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, MASK_W, MASK_H);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';

    ctx.beginPath();                                        // torso
    ctx.ellipse(cx, cy, MASK_W * 0.045, MASK_H * 0.20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();                                        // head
    ctx.arc(cx, cy - MASK_H * 0.25, MASK_H * 0.062, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = MASK_H * 0.045;                         // swinging arm
    ctx.beginPath();
    ctx.moveTo(cx, cy - MASK_H * 0.10);
    ctx.lineTo(cx + Math.cos(armAngle) * MASK_W * 0.16, cy - MASK_H * 0.10 + Math.sin(armAngle) * MASK_H * 0.26);
    ctx.stroke();
    ctx.lineWidth = MASK_H * 0.05;                          // legs
    ctx.beginPath();
    ctx.moveTo(cx, cy + MASK_H * 0.16);
    ctx.lineTo(cx - MASK_W * 0.02, cy + MASK_H * 0.36);
    ctx.moveTo(cx, cy + MASK_H * 0.16);
    ctx.lineTo(cx + MASK_W * 0.02, cy + MASK_H * 0.36);
    ctx.stroke();

    const d = ctx.getImageData(0, 0, MASK_W, MASK_H).data;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) mask[i] = d[p] / 255;

    for (let y = 0; y < WORK_H; y++) {
      const v = y / (WORK_H - 1);
      for (let x = 0; x < WORK_W; x++) {
        luma[y * WORK_W + x] = sample(mask, MASK_W, MASK_H, x / (WORK_W - 1), v) * 0.9 + 0.05;
      }
    }
    return { mask, luma };
  }

  return { update, mask, luma };
}
