import { project } from './homography.js';

// Pulls the display's region out of the wide camera view and straightens it
// into the detector's grid (G = w×h, RGB interleaved, camera code units).
//
// RESOLUTION decides whether the detector works at all on this rig. The
// display is a small part of a wide-angle frame. Reading it off a downscaled
// copy of the whole frame meant handing the detector a blurry 2x upscale of an
// already-discarded image — washed out, and mostly sensor noise once the piece
// renders its black void. This reads just the quad's bounding box, at the
// camera's native detail, which is also LESS pixel readback than grabbing the
// whole frame.
//
// No photometric correction happens here any more: the occlusion detector
// compares raw camera codes against its own prediction of what the wall should
// look like, so anything "helpful" done to the codes on the way in would have
// to be undone on the other side.

// The quad's bounding box in the sensor frame, padded a little so a warp
// sample can't fall outside what we read back. Pure, so it can be unit tested.
export function quadBoxOf(H, pad = 0.02) {
  const corner = [0, 0];
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    project(H, u, v, corner);
    if (corner[0] < x0) x0 = corner[0];
    if (corner[0] > x1) x1 = corner[0];
    if (corner[1] < y0) y0 = corner[1];
    if (corner[1] > y1) y1 = corner[1];
  }
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
  const w = Math.max(0.01, x1 - x0), h = Math.max(0.01, y1 - y0);
  return { x: x0, y: y0, w, h };
}

export function createWarp({ w = 480, h = 270 } = {}) {
  // A measured display->camera map, when we have one. It supersedes the
  // homography because it is not a model at all: it is the correspondence the
  // camera actually reported, so a curved screen, a blend seam between two
  // projectors and the lens's own distortion are all already in it.
  let map = null;
  const src = document.createElement('canvas');
  const sctx = src.getContext('2d', { willReadFrequently: true });
  let srcData = null, srcW = 0, srcH = 0;
  let box = { x: 0, y: 0, w: 1, h: 1 };

  const pt = [0, 0];
  const rgb = [0, 0, 0];

  function ensureSource(camera, H) {
    const vw = camera.video.videoWidth, vh = camera.video.videoHeight;
    if (!vw || !vh) return false;

    box = quadBoxOf(H);
    // Native pixels of the region, capped so a huge sensor can't blow up the
    // readback cost. 1024 rather than 768 because fingers need the detail;
    // the region is only the quad's bounding box, so even at the cap this is
    // still less than a full frame.
    const rw = Math.max(32, Math.min(1024, Math.round(box.w * vw)));
    const rh = Math.max(32, Math.min(1024, Math.round(box.h * vh)));
    if (src.width !== rw || src.height !== rh) { src.width = rw; src.height = rh; }
    srcW = rw; srcH = rh;
    return camera.drawRegion(sctx, rw, rh, box.x, box.y, box.w, box.h);
  }

  // Bilinear fetch. (u,v) are FULL-FRAME normalised; the readback covers only
  // the bounding box, so they're rebased here.
  function sampleRGB(u, v, out) {
    const bu = (u - box.x) / box.w;
    const bv = (v - box.y) / box.h;
    const fx = Math.min(srcW - 1, Math.max(0, bu * (srcW - 1)));
    const fy = Math.min(srcH - 1, Math.max(0, bv * (srcH - 1)));
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < srcW ? x0 + 1 : x0;
    const y1 = y0 + 1 < srcH ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * srcW + x0) * 4, i10 = (y0 * srcW + x1) * 4;
    const i01 = (y1 * srcW + x0) * 4, i11 = (y1 * srcW + x1) * 4;
    for (let c = 0; c < 3; c++) {
      const a = srcData[i00 + c] + (srcData[i10 + c] - srcData[i00 + c]) * tx;
      const b = srcData[i01 + c] + (srcData[i11 + c] - srcData[i01 + c]) * tx;
      out[c] = a + (b - a) * ty;
    }
    return out;
  }

  // Resamples the current camera frame into `out` (Uint8Array(w*h*3)). Each
  // grid cell is a 2x2 supersample — four projected sub-positions a quarter
  // cell off centre, averaged. A single bilinear tap per cell aliases on the
  // finger-scale edges the detector depends on; the supersample is cheaper
  // than a wider readback and keeps the sampling footprint about one cell.
  // Returns false (out untouched) when the camera has no frame yet.
  function setMap(m) {
    map = m && m.w === w && m.h === h ? m : null;
    return !!map;
  }

  // Bounding box straight from the measured correspondence, so the readback
  // still covers only the part of the sensor the screen occupies.
  function mapBox(pad = 0.02) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0, any = false;
    for (let i = 0; i < w * h; i++) {
      if (!map.filled[i]) continue;
      const u = map.mapU[i], v = map.mapV[i];
      if (u < x0) x0 = u; if (u > x1) x1 = u;
      if (v < y0) y0 = v; if (v > y1) y1 = v;
      any = true;
    }
    if (!any) return { x: 0, y: 0, w: 1, h: 1 };
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
    return { x: x0, y: y0, w: Math.max(0.01, x1 - x0), h: Math.max(0.01, y1 - y0) };
  }

  function sampleGridMapped(camera, mirror, out) {
    const vw = camera.video.videoWidth, vh = camera.video.videoHeight;
    if (!vw || !vh) return false;
    box = mapBox();
    const sw = Math.max(32, Math.min(1024, Math.round(box.w * vw)));
    const sh = Math.max(32, Math.min(1024, Math.round(box.h * vh)));
    if (src.width !== sw || src.height !== sh) { src.width = sw; src.height = sh; }
    srcW = sw; srcH = sh;
    if (!camera.drawRegion(sctx, sw, sh, box.x, box.y, box.w, box.h)) return false;
    srcData = sctx.getImageData(0, 0, srcW, srcH).data;

    let o = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Mirroring is a display-space flip, so it indexes the map rather than
        // transforming its output.
        const d = y * w + (mirror ? w - 1 - x : x);
        sampleRGB(map.mapU[d], map.mapV[d], rgb);
        out[o] = rgb[0] + 0.5 | 0;
        out[o + 1] = rgb[1] + 0.5 | 0;
        out[o + 2] = rgb[2] + 0.5 | 0;
        o += 3;
      }
    }
    return true;
  }

  function sampleGrid(camera, H, mirror, out) {
    if (map) return sampleGridMapped(camera, mirror, out);
    if (!H || !ensureSource(camera, H)) return false;
    srcData = sctx.getImageData(0, 0, srcW, srcH).data;

    // Incremental projection, one sample per cell.
    //
    // This runs on every camera frame over the whole grid, so it was the single
    // most expensive thing in the pipeline: 4 supersamples x 129,600 cells is
    // half a million projections and bilinear fetches per frame.
    //
    // Two savings, neither of which costs accuracy here. The supersampling was
    // redundant — the detector already pools 3x3 before comparing anything, so
    // it was averaging twice. And a projective map is linear in both numerator
    // and denominator along a row, so stepping u by a constant lets the whole
    // row be walked with two adds and one divide per cell instead of a full
    // matrix evaluation.
    const { a, b, c, d, e, f, g, h: hh } = H;
    const stepU = 1 / (w - 1);
    let o = 0;
    for (let y = 0; y < h; y++) {
      const v = y / (h - 1);
      // Row constants: everything that does not vary with u.
      const bx = b * v + c, by = e * v + f, bd = hh * v + 1;
      // Mirroring walks the row backwards rather than flipping each sample.
      const du = mirror ? -stepU : stepU;
      let u = mirror ? 1 : 0;
      let nx = a * u + bx, ny = d * u + by, den = g * u + bd;
      const dnx = a * du, dny = d * du, dden = g * du;
      for (let x = 0; x < w; x++) {
        const iw = den !== 0 ? 1 / den : 0;
        sampleRGB(nx * iw, ny * iw, rgb);
        out[o] = rgb[0] + 0.5 | 0;
        out[o + 1] = rgb[1] + 0.5 | 0;
        out[o + 2] = rgb[2] + 0.5 | 0;
        o += 3;
        nx += dnx; ny += dny; den += dden;
      }
    }
    return true;
  }


  return { sampleGrid, setMap, get hasMap() { return !!map; }, get box() { return box; } };
}
