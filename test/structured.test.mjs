import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitsFor, grayEncode, grayDecode, grayDecodeFrom, patternSequence, patternFor, createDecoder, smoothMap } from '../src/structured.js';

test('gray code round-trips and neighbours differ by one bit', () => {
  const bits = 9;
  for (let x = 0; x < 416; x++) assert.equal(grayDecode(grayEncode(x), bits), x);
  // This is the property the whole scheme rests on: a camera pixel straddling a
  // stripe edge misreads one bit and lands next door, not anywhere.
  for (let x = 1; x < 416; x++) {
    const diff = grayEncode(x) ^ grayEncode(x - 1);
    assert.equal(diff & (diff - 1), 0, `codes for ${x - 1}->${x} differ in more than one bit`);
  }
});

test('bitsFor covers the grid', () => {
  assert.ok((1 << bitsFor(416)) >= 416);
  assert.ok((1 << bitsFor(234)) >= 234);
  assert.equal(bitsFor(256), 8);
});

test('the sequence covers every bit of both axes, each with its inverse', () => {
  const seq = patternSequence({ w: 416, h: 234, holdFrames: 2 });
  const seen = new Map();
  for (let i = 0; i < seq.length; i++) {
    const f = seq.frame(i);
    if (f.kind === 'x' || f.kind === 'y') seen.set(`${f.kind}${f.bit}${f.invert}`, true);
  }
  assert.equal(seen.size, (seq.bitsX + seq.bitsY) * 2);
  assert.equal(seq.steps, 2 + (seq.bitsX + seq.bitsY) * 2);
});

test('a pattern and its inverse are exact complements', () => {
  const w = 64, h = 32;
  const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  patternFor({ kind: 'x', bit: 2, invert: false }, w, h, a);
  patternFor({ kind: 'x', bit: 2, invert: true }, w, h, b);
  for (let i = 0; i < a.length; i++) assert.equal(a[i] + b[i], 255);
});

// The real test: run the whole thing through a synthetic CURVED screen and check
// the recovered map matches the truth a homography cannot represent.
function curvedCamera(w, h, camW, camH) {
  const arc = 120 * Math.PI / 180, R = 1, camZ = -2.2, SH = 1.2;
  return (u, v) => {
    const ang = (u - 0.5) * arc;
    const x = R * Math.sin(ang), z = R * Math.cos(ang), y = (v - 0.5) * SH;
    const d = z - camZ;
    return [0.5 + 0.6 * x / d, 0.5 + 0.6 * y / d];
  };
}

test('recovers the display map through a 120-degree curved screen', () => {
  const w = 96, h = 54, camW = 160, camH = 120;
  const truth = curvedCamera(w, h, camW, camH);
  // Precompute, for each camera pixel, which display cell it sees (nearest).
  const owner = new Int32Array(camW * camH).fill(-1);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const [cu, cv] = truth(dx / (w - 1), dy / (h - 1));
      const cx = Math.round(cu * (camW - 1)), cy = Math.round(cv * (camH - 1));
      if (cx < 0 || cx >= camW || cy < 0 || cy >= camH) continue;
      owner[cy * camW + cx] = dy * w + dx;
    }
  }
  const dec = createDecoder({ w, h, camW, camH, holdFrames: 1 });
  const disp = new Uint8Array(w * h);
  const cam = new Float32Array(camW * camH);
  const seq = dec.sequence;
  for (let i = 0; i < seq.length; i++) {
    const spec = seq.frame(i);
    patternFor(spec, w, h, disp);
    cam.fill(0);
    for (let p = 0; p < owner.length; p++) {
      const d = owner[p];
      cam[p] = d < 0 ? 0 : (disp[d] / 255) * 0.9 + 0.05;   // lit surface, some floor
    }
    dec.add(spec, cam);
  }
  const map = smoothMap(dec.finish({ minContrast: 0.02 }), 1);

  assert.ok(map.coverage > 0.25, `coverage only ${(map.coverage * 100).toFixed(0)}%`);
  let worst = 0, n = 0, sum = 0;
  for (let dy = 2; dy < h - 2; dy++) {
    for (let dx = 2; dx < w - 2; dx++) {
      const d = dy * w + dx;
      if (!map.valid[d]) continue;
      const [tu, tv] = truth(dx / (w - 1), dy / (h - 1));
      const e = Math.hypot(map.mapU[d] - tu, map.mapV[d] - tv);
      worst = Math.max(worst, e); sum += e; n++;
    }
  }
  const meanCells = (sum / n) * camW;
  assert.ok(n > 100, 'enough cells measured');
  // A homography on this same screen was 9 cells out at centre; measuring must
  // do far better than that or there is no point.
  assert.ok(meanCells < 1.5, `mean error ${meanCells.toFixed(2)} camera px — should beat a homography easily`);
});

test('cells the camera cannot see are marked, not invented', () => {
  const w = 32, h = 16, camW = 40, camH = 30;
  const dec = createDecoder({ w, h, camW, camH, holdFrames: 1 });
  const cam = new Float32Array(camW * camH);   // camera sees nothing at all
  const disp = new Uint8Array(w * h);
  for (let i = 0; i < dec.sequence.length; i++) {
    const spec = dec.sequence.frame(i);
    patternFor(spec, w, h, disp);
    dec.add(spec, cam);
  }
  const map = dec.finish();
  assert.equal(map.coverage, 0, 'nothing should be claimed as measured');
  assert.ok(map.valid.every((v) => v === 0));
});

test('decodes through auto-exposure that flattens white against black', () => {
  // The real failure: the camera stops down on a full-white frame and opens up
  // on a full-black one, so white-minus-black comes back near zero and almost
  // the whole screen looks unreadable. On the rig it left ~1% usable.
  //
  // Here AE is modelled as a gain that normalises each frame toward a fixed
  // mean brightness — the worst case for a white/black reference, and harmless
  // for a pattern and its inverse, which have the same mean by construction.
  const w = 96, h = 54, camW = 160, camH = 120;
  const truth = curvedCamera(w, h, camW, camH);
  const owner = new Int32Array(camW * camH).fill(-1);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const [cu, cv] = truth(dx / (w - 1), dy / (h - 1));
      const cx = Math.round(cu * (camW - 1)), cy = Math.round(cv * (camH - 1));
      if (cx >= 0 && cx < camW && cy >= 0 && cy < camH) owner[cy * camW + cx] = dy * w + dx;
    }
  }
  const dec = createDecoder({ w, h, camW, camH, holdFrames: 1 });
  const disp = new Uint8Array(w * h);
  const cam = new Float32Array(camW * camH);
  const seq = dec.sequence;
  const TARGET = 0.35;
  for (let i = 0; i < seq.length; i++) {
    const spec = seq.frame(i);
    patternFor(spec, w, h, disp);
    let sum = 0;
    for (let p = 0; p < owner.length; p++) {
      const d = owner[p];
      cam[p] = d < 0 ? 0.10 : (disp[d] / 255) * 0.8 + 0.08;
      sum += cam[p];
    }
    // Auto-exposure: rescale so every frame reads the same average.
    const gain = TARGET / Math.max(1e-6, sum / cam.length);
    for (let p = 0; p < cam.length; p++) cam[p] = Math.min(1, cam[p] * gain);
    dec.add(spec, cam);
  }
  const map = smoothMap(dec.finish({ minContrast: 0.04 }), 1);
  assert.ok(map.coverage > 0.25,
    `AE flattened the read: only ${(map.coverage * 100).toFixed(1)}% decoded ` +
    `(contrast p50 ${map.contrast.p50.toFixed(3)})`);
});

test('decodes when the camera cannot resolve the finest stripes', () => {
  // The rig failure: the screen covers a fraction of the frame, so bit 0 —
  // which alternates every display cell — is far below what the camera
  // resolves. Rejecting a pixel whenever any bit is ambiguous rejected every
  // pixel and reported 0% while latency, needing only a global average, worked.
  const w = 96, h = 54;
  const camW = 72, camH = 40;              // far too few pixels to resolve bit 0
  const truth = curvedCamera(w, h, camW, camH);
  const dec = createDecoder({ w, h, camW, camH, holdFrames: 1 });
  const disp = new Uint8Array(w * h);
  const cam = new Float32Array(camW * camH);
  const seq = dec.sequence;

  // Each camera pixel integrates every display cell that falls inside it, which
  // is what destroys the fine bits.
  const members = Array.from({ length: camW * camH }, () => []);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const [cu, cv] = truth(dx / (w - 1), dy / (h - 1));
      const cx = Math.round(cu * (camW - 1)), cy = Math.round(cv * (camH - 1));
      if (cx >= 0 && cx < camW && cy >= 0 && cy < camH) members[cy * camW + cx].push(dy * w + dx);
    }
  }
  for (let i = 0; i < seq.length; i++) {
    const spec = seq.frame(i);
    patternFor(spec, w, h, disp);
    for (let p = 0; p < cam.length; p++) {
      const m = members[p];
      if (!m.length) { cam[p] = 0.05; continue; }
      let s = 0;
      for (const d of m) s += disp[d] / 255;
      cam[p] = (s / m.length) * 0.8 + 0.08;
    }
    dec.add(spec, cam);
  }
  const map = dec.finish({ minContrast: 0.03 });
  assert.ok(map.coverage > 0, `nothing decoded at all (contrast p90 ${map.contrast.p90.toFixed(3)})`);
  assert.ok(map.resolution.xCells >= 1, 'reports the resolution actually achieved');
  // Coarse is fine; wrong is not. Check the recovered map is monotonic across
  // the screen, i.e. it really is a correspondence and not noise.
  let checked = 0, monotonic = 0;
  for (let dy = 10; dy < h - 10; dy += 4) {
    for (let dx = 10; dx < w - 12; dx += 4) {
      const a = dy * w + dx, b = dy * w + dx + 8;
      // `filled` is what the warp actually samples through — direct hits are
      // sparse when the camera has few pixels, and interpolation is the point.
      if (!map.filled[a] || !map.filled[b]) continue;
      checked++;
      if (map.mapU[b] > map.mapU[a]) monotonic++;
    }
  }
  assert.ok(checked > 10, 'enough pairs to judge');
  // Coarse is acceptable; incoherent is not. The recovered map must still be a
  // monotonic correspondence across the screen, which is what the warp relies
  // on — an under-resolved map that still runs left-to-right is usable, a
  // scrambled one is worse than none.
  assert.ok(monotonic / checked > 0.9,
    `map is not a coherent correspondence: only ${monotonic}/${checked} pairs ordered`);
});

test('a bit whose pair never completes is reported, not silently decoded as zero', () => {
  // The defect: an unpaired half used to leave that bit zero for every pixel
  // with no floor raised, and forcing a gray bit to zero folds the decoded
  // position into half the axis — a confident, badly wrong map that nothing in
  // the diagnostics could see.
  const w = 64, h = 32, camW = 80, camH = 60;
  const dec = createDecoder({ w, h, camW, camH, holdFrames: 1 });
  const disp = new Uint8Array(w * h), cam = new Float32Array(camW * camH);
  const seq = dec.sequence;
  for (let i = 0; i < seq.length; i++) {
    const spec = seq.frame(i);
    // Drop the inverse half of x bit 2 entirely, as a dropped frame would.
    if (spec.kind === 'x' && spec.bit === 2 && spec.invert) continue;
    patternFor(spec, w, h, disp);
    for (let p = 0; p < cam.length; p++) {
      const dx = Math.round((p % camW) / (camW - 1) * (w - 1));
      const dy = Math.round(Math.floor(p / camW) / (camH - 1) * (h - 1));
      cam[p] = (disp[dy * w + dx] / 255) * 0.8 + 0.1;
    }
    dec.add(spec, cam);
  }
  const map = dec.finish({ minContrast: 0.02 });
  assert.ok(map.missingBits.includes('x2'),
    `the unpaired bit must be named, got ${JSON.stringify(map.missingBits)}`);
  // And it must not be trusted: no pixel may be located more finely than that bit.
  assert.ok(map.resolution.xCells >= 8,
    `a missing bit 2 must floor the X resolution, got ${map.resolution.xCells}`);
});

test('the block centre stays on the axis at the far edge', () => {
  // grayDecodeFrom centres within the block the dropped low bits would select.
  // Unclamped, the last block of an axis that is not a multiple of the block
  // size lands past the end and the pixel is thrown away — losing exactly the
  // right and bottom edges, the ones the operator is told to aim at.
  for (const [len, bits] of [[720, 10], [134, 8], [96, 7]]) {
    for (let floor = 1; floor <= 6; floor++) {
      for (let x = 0; x < len; x++) {
        const got = grayDecodeFrom(grayEncode(x), bits, floor, len);
        assert.ok(got >= 0 && got < len,
          `len ${len} floor ${floor} x ${x} decoded to ${got}, off the axis`);
      }
    }
  }
});
