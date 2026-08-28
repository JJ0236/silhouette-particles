import { MASK_W, MASK_H, WORK_W, WORK_H, settings } from './config.js';

// Black void, additive light. The bloom is done with a downscale/upscale
// ping-pong rather than ctx.filter — that trick works in every browser
// (Safari's canvas filter support arrived late) and is markedly faster at
// 1080p, since the expensive blur happens at a fraction of the resolution.

// Budget the backing store by PIXEL COUNT, not by width.
//
// A width cap is wrong for a wide wall: 5760x1080 hit the 1920 limit and got
// rendered at 1920x360 then stretched back out — a third of the horizontal
// resolution and a third of the vertical, on a display that had the pixels all
// along. Counting pixels caps the actual cost (fill rate and the bloom chain)
// while letting an unusual shape use the resolution it has. 5760x1080 is 6.2M
// pixels, comfortably inside this; a 4K panel at 8.3M is scaled slightly.
// Default render budget. 5760x1080 is 6.2 megapixels, and the compositor makes
// several full-frame passes per frame — rim, particles, bloom down, bloom up,
// the final composite, the bright-field inversion — so rendering a wall at full
// native resolution costs roughly nine times what a 1920-wide render did, which
// is exactly what made it lag.
//
// The content is a soft glow and small dots, neither of which carries detail at
// the pixel level, so rendering below native and letting the display scale is
// nearly invisible. Exposed as `renderScale` so it can be traded against
// smoothness on the actual machine.
const DEFAULT_MAX_PIXELS = 2.6e6;

// The occlusion detector predicts what the camera should see from what we
// emitted, so it needs a copy of every finished frame at its own grid. This is
// that grid; it matches MASK_W×MASK_H so the prediction lines up cell-for-cell.
// The capture must be the detector's grid exactly: these frames ARE the
// prediction it compares the camera against.
const CAP_W = MASK_W, CAP_H = MASK_H;

export function createRenderer(view) {
  const ctx = view.getContext('2d', { alpha: false });

  const scene  = document.createElement('canvas');
  const sctx   = scene.getContext('2d', { alpha: false });
  const bloomA = document.createElement('canvas');
  const actx   = bloomA.getContext('2d');
  const bloomB = document.createElement('canvas');
  const bctx   = bloomB.getContext('2d');

  const rimCanvas = document.createElement('canvas');
  rimCanvas.width = MASK_W; rimCanvas.height = MASK_H;
  const rctx = rimCanvas.getContext('2d');
  const rimImage = rctx.createImageData(MASK_W, MASK_H);

  // Diagnostics get their own scratch canvas so painting three panels never
  // races the rim image, which is still needed for the mask overlay.
  const diagCanvas = document.createElement('canvas');
  diagCanvas.width = MASK_W; diagCanvas.height = MASK_H;
  const dctx = diagCanvas.getContext('2d');
  const diagImage = dctx.createImageData(MASK_W, MASK_H);

  // willReadFrequently keeps the capture canvas on the CPU path, so every
  // getImageData isn't a GPU readback stall. The RGB buffer is preallocated:
  // 30 allocations a second of 390 KB is exactly the kind of GC churn that
  // shows up as a hitch in a long-running installation.
  const capCanvas = document.createElement('canvas');
  capCanvas.width = CAP_W; capCanvas.height = CAP_H;
  const cctx = capCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  const capRGB = new Uint8Array(CAP_W * CAP_H * 3);

  let W = 0, H = 0;

  function resize() {
    const cssW = view.clientWidth || window.innerWidth;
    const cssH = view.clientHeight || window.innerHeight;
    const budget = (settings.renderScale > 0 ? settings.renderScale : 1) * DEFAULT_MAX_PIXELS;
    const scale = Math.min(1, Math.sqrt(budget / Math.max(1, cssW * cssH)));
    W = Math.max(2, Math.round(cssW * scale));
    H = Math.max(2, Math.round(cssH * scale));
    view.width = W; view.height = H;
    scene.width = W; scene.height = H;
    bloomA.width = Math.max(1, W >> 2); bloomA.height = Math.max(1, H >> 2);
    bloomB.width = Math.max(1, W >> 3); bloomB.height = Math.max(1, H >> 3);
  }

  function paintRim(rim, r, g, b, alpha) {
    const d = rimImage.data;
    for (let i = 0, p = 0; i < rim.length; i++, p += 4) {
      const a = rim[i] * alpha;
      d[p] = r; d[p + 1] = g; d[p + 2] = b;
      d[p + 3] = a > 1 ? 255 : a < 0 ? 0 : (a * 255) | 0;
    }
    rctx.putImageData(rimImage, 0, 0);
  }

  function draw(particles, seg, flow, presence = 1, diag = null) {
    if (view.width !== W || !W) resize();

    sctx.globalCompositeOperation = 'source-over';
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, W, H);
    sctx.globalCompositeOperation = 'lighter';

    // Silhouette contour, faded by presence so an empty room stays empty.
    const [orr, org, orb] = hsl(settings.outlineHue, 0.85, 0.6);
    paintRim(seg.rim, orr, org, orb, presence);
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(rimCanvas, 0, 0, W, H);

    // Particles.
    const s = Math.max(1, settings.particleSize * (W / 1920));
    const xs = particles.x, ys = particles.y, n = particles.count;
    const alpha = settings.particleAlpha;
    const mode = settings.particleColour;

    if (mode === 'single') {
      // One fillStyle for the whole field: by far the cheapest path, so it
      // stays the default shape of the loop.
      const [pr, pg, pb] = hsl(settings.particleHue, 0.9, 0.62);
      sctx.fillStyle = `rgba(${pr},${pg},${pb},${alpha})`;
      for (let i = 0; i < n; i++) sctx.fillRect(xs[i] * W, ys[i] * H, s, s);
    } else {
      // Rainbow. Changing fillStyle per particle would cost more than drawing
      // them, so the spectrum is quantised into buckets and each bucket is
      // drawn in one pass — the eye cannot tell 48 hues from 12,000, and it
      // keeps this to 48 style changes instead of 12,000.
      //
      // 'rainbow' assigns a hue by particle index, so a given dot keeps its
      // colour and the field reads as a stable spectrum you can watch move.
      // 'shift' rotates every hue together over time, so the whole field
      // cycles while each dot still holds its place in the spectrum.
      const buckets = RAINBOW_BUCKETS;
      const spin = mode === 'shift'
        ? (performance.now() * settings.particleCycle * 0.018) % 360 : 0;
      const spread = settings.particleSpread;
      const base = settings.particleHue;
      for (let b = 0; b < buckets; b++) {
        const frac = b / buckets;
        const [cr, cg, cb] = hsl(base + spin + frac * spread, 0.95, 0.6);
        sctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`;
        for (let i = b; i < n; i += buckets) sctx.fillRect(xs[i] * W, ys[i] * H, s, s);
      }
    }

    // Bloom: down, down, back up. Two hops widen the blur cheaply.
    actx.globalCompositeOperation = 'source-over';
    actx.clearRect(0, 0, bloomA.width, bloomA.height);
    actx.drawImage(scene, 0, 0, bloomA.width, bloomA.height);
    bctx.clearRect(0, 0, bloomB.width, bloomB.height);
    bctx.drawImage(bloomA, 0, 0, bloomB.width, bloomB.height);
    actx.clearRect(0, 0, bloomA.width, bloomA.height);
    actx.drawImage(bloomB, 0, 0, bloomA.width, bloomA.height);

    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(scene, 0, 0);
    if (settings.glow > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = settings.glow;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bloomA, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // Void floor. A body in front of pure black is invisible to the camera —
    // there is no light for it to block — so the "empty" display emits a faint
    // grey the detector can watch go dark. Additive so it can never darken
    // anything already drawn; the detector treats it as part of the known frame.
    if (settings.voidFloor > 0) {
      const v = Math.round(255 * settings.voidFloor / 100);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    // Bright-field mode: invert the whole composite.
    //
    // With the camera behind the viewer the display IS the backlight, so a white
    // field is worth far more than a black one. It does not change a body's
    // ratio against the wall — that is set by albedo and geometry — but it makes
    // every absolute deficit large compared with camera noise, and it turns the
    // viewer's cast shadow into a deep signal instead of a marginal one. That is
    // what the classic backlit installations rely on.
    //
    // Inverting the finished frame is enough: the piece keeps its own geometry
    // and motion, the contour becomes dark on white, and the particles come out
    // as colour on white. The detector needs no change at all, because it
    // predicts from the frame we actually captured — which is this one.
    if (settings.brightField) {
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    if (settings.showMask) drawMask(seg.mask);
    if (settings.showFlow) drawFlow(flow);
    if (settings.showDiag && diag) drawDiag(diag, seg);
  }

  // Copy the finished frame into the detector's frame ring at capture size.
  //
  // main.js MUST call this as the LAST thing after draw(), never from inside
  // it. Everything on this display is light the camera sees, so anything drawn
  // but not captured is guaranteed unpredicted feedback: the mask overlay is a
  // white human silhouette on screen — the camera would see it, the detector
  // would flag it, the mask would grow, the overlay would redraw bigger.
  // Capture whatever is actually emitted, overlays included.
  function capture(ring, t) {
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(view, 0, 0, CAP_W, CAP_H);
    const d = cctx.getImageData(0, 0, CAP_W, CAP_H).data;
    for (let i = 0, p = 0, q = 0; i < CAP_W * CAP_H; i++, p += 4, q += 3) {
      capRGB[q] = d[p]; capRGB[q + 1] = d[p + 1]; capRGB[q + 2] = d[p + 2];
    }
    ring.push(capRGB, t);   // the ring copies, so the buffer is safe to reuse
  }

  function drawMask(mask) {
    const img = rctx.createImageData(MASK_W, MASK_H);
    const d = img.data;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const v = Math.min(255, Math.max(0, mask[i] * 255)) | 0;
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 210;
    }
    rctx.putImageData(img, 0, 0);
    const w = W * 0.25, h = H * 0.25;
    ctx.drawImage(rimCanvas, 8, 8, w, h);
    ctx.strokeStyle = '#0ff'; ctx.lineWidth = 1;
    ctx.strokeRect(8, 8, w, h);
  }

  // What the detector saw, what it expected, and how they compare. When the
  // mask misbehaves this is the picture that says why: a lag mismatch shows as
  // a ghost between the first two panels, a gain error tints the whole ratio
  // panel, a real body is a solid red patch.
  const RAINBOW_BUCKETS = 48;

  const fmtR = (v) => (Number.isFinite(v) ? v.toFixed(2) : '--');

  function drawDiag(diag, seg) {
    const pw = Math.min(360, W * 0.24), ph = pw * 9 / 16;
    const gap = 8, top = 16;
    const x0 = W - 16 - 3 * pw - 2 * gap;

    // sqrt tone-map: linear light crushes everything but the highlights into
    // the bottom few codes, and the interesting detail is in the shadows.
    paintLinear(diag.obsLin);
    panel(x0, top, pw, ph, 'observed Y');
    paintLinear(diag.pred);
    panel(x0 + pw + gap, top, pw, ph, 'predicted Y');
    paintRatio(diag.ratio, settings.tauLow, settings.tauHigh);
    panel(x0 + 2 * (pw + gap), top, pw, ph, 'obs / pred');

    const g = diag.gains ? gainSummary(diag.gains) : '-';
    const cov = ((seg && seg.coverage) || 0) * 100;
    const ref = (diag.refFrac || 0) * 100;
    const veto = diag.veto ? (diag.vetoReason || 'yes') : 'no';
    const lag = diag.lagMs == null ? '?' : Math.round(diag.lagMs);
    const line = `g=[${g}] lag=${lag}ms cov=${cov.toFixed(1)}% ref=${ref.toFixed(0)}% veto=${veto}` +
      `  ratio p1=${fmtR(diag.ratioP1)} p5=${fmtR(diag.ratioP5)} p50=${fmtR(diag.ratioP50)}` +
      `  tau=${settings.tauLow}/${settings.tauHigh}`
      + (diag.lagStarved ? ' LAG-STARVED' : '') + (diag.suppressed ? ' SUPPRESSED' : '');
    ctx.fillStyle = 'rgba(255,180,84,0.9)';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(line, x0, top + ph + 18);
  }

  function panel(x, y, w, h, label) {
    ctx.drawImage(diagCanvas, x, y, w, h);
    ctx.strokeStyle = 'rgba(255,180,84,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,180,84,0.9)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(label, x, y + h + 4);
  }

  function paintLinear(field) {
    const d = diagImage.data;
    for (let i = 0, p = 0; i < field.length; i++, p += 4) {
      const y = field[i];
      const v = y > 0 ? Math.min(255, Math.sqrt(y > 1 ? 1 : y) * 255) | 0 : 0;
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
    dctx.putImageData(diagImage, 0, 0);
  }

  // Ratio bands, in the order the detector reads them: red is a confident
  // seed, amber is a candidate that only survives if it touches a seed, grey
  // is undecided, dark is "as predicted", blue is brighter than predicted —
  // which the frame can't cause, so it's glare, a gain error, or the lag.
  function paintRatio(ratio, tauLow, tauHigh) {
    const d = diagImage.data;
    for (let i = 0, p = 0; i < ratio.length; i++, p += 4) {
      const r = ratio[i];
      let cr, cg, cb;
      if (!(r >= 0))       { cr = 0;   cg = 0;   cb = 0;   }   // NaN / unobservable
      else if (r < tauLow) { cr = 220; cg = 40;  cb = 40;  }
      else if (r < tauHigh){ cr = 240; cg = 170; cb = 40;  }
      else if (r < 1)      { cr = 110; cg = 110; cb = 110; }
      else if (r <= 1.05)  { cr = 35;  cg = 35;  cb = 35;  }
      else                 { cr = 70;  cg = 110; cb = 220; }
      d[p] = cr; d[p + 1] = cg; d[p + 2] = cb; d[p + 3] = 255;
    }
    dctx.putImageData(diagImage, 0, 0);
  }

  // gains is band-major, three channels per band; one number per band is
  // enough to see whether the camera's exposure has wandered.
  function gainSummary(gains) {
    const out = [];
    for (let b = 0; b + 2 < gains.length; b += 3) {
      out.push(((gains[b] + gains[b + 1] + gains[b + 2]) / 3).toFixed(2));
    }
    return out.join(' ');
  }

  function drawFlow(flow) {
    ctx.strokeStyle = 'rgba(0,255,180,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 4, k = 5000;
    for (let y = 0; y < WORK_H; y += step) {
      for (let x = 0; x < WORK_W; x += step) {
        const i = y * WORK_W + x;
        const px = (x / (WORK_W - 1)) * W, py = (y / (WORK_H - 1)) * H;
        ctx.moveTo(px, py);
        ctx.lineTo(px + flow.vx[i] * k, py + flow.vy[i] * k);
      }
    }
    ctx.stroke();
  }

  function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map(v => Math.round(v * 255));
  }
  function hue(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  resize();
  window.addEventListener('resize', resize);
  return {
    draw, capture, resize,
    get width() { return W; }, get height() { return H; },
    get captureSize() { return { w: CAP_W, h: CAP_H }; },
  };
}
