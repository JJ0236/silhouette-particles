// Trace the outline of a soft mask as closed vector loops.
//
// The outline used to be a raster band painted one detector cell at a time and
// stretched up to the wall. On a 720x134 grid a cell is about eight wall
// pixels, so the band came out chunky, and every cell that flickered across the
// threshold showed as a wobble in the line. Tracing the 0.5 isoline with
// marching squares puts the vertex where the mask actually crosses 0.5 BETWEEN
// two cells, so the line has sub-cell precision, and a run of corner-cutting
// smooths what remains. Loops shorter than a few cells are speckle, not people,
// and are dropped.
//
// Coordinates are normalised 0..1 across the grid, cell centres at
// (x + 0.5) / w, which is where the renderer's stretched image put them.

// Marching-squares case table: for each of the 16 corner configurations, the
// pairs of edges (0 top, 1 right, 2 bottom, 3 left) a segment joins.
const SEGMENTS = [
  [], [[3, 2]], [[2, 1]], [[3, 1]],
  [[0, 1]], [[3, 0], [2, 1]], [[0, 2]], [[3, 0]],
  [[0, 3]], [[0, 2]], [[0, 1], [3, 2]], [[0, 1]],
  [[1, 3]], [[1, 2]], [[2, 3]], [],
];

export function traceIsolines(mask, w, h, { level = 0.5, minLength = 6, smooth = 2 } = {}) {
  // Edge ids are shared between the two squares an edge borders, so the
  // segments chain into loops by looking up the edge on the other side.
  // Horizontal edge (x, y) is the top edge of square (x, y); vertical edge
  // (x, y) is the left edge of square (x, y).
  const hid = (x, y) => (y * (w + 1) + x) * 2;
  const vid = (x, y) => (y * (w + 1) + x) * 2 + 1;
  const edgeOf = (e, x, y) => (e === 0 ? hid(x, y) : e === 1 ? vid(x + 1, y) : e === 2 ? hid(x, y + 1) : vid(x, y));

  // Point on an edge where the mask crosses `level`, in cell-centre coords.
  const px = new Map();   // edge id -> [u, v] in cell units
  const crossing = (e, x, y) => {
    const id = edgeOf(e, x, y);
    let p = px.get(id);
    if (p) return p;
    let ax, ay, bx, by;
    if (e === 0) { ax = x; ay = y; bx = x + 1; by = y; }
    else if (e === 1) { ax = x + 1; ay = y; bx = x + 1; by = y + 1; }
    else if (e === 2) { ax = x; ay = y + 1; bx = x + 1; by = y + 1; }
    else { ax = x; ay = y; bx = x; by = y + 1; }
    const va = mask[ay * w + ax], vb = mask[by * w + bx];
    const t = va === vb ? 0.5 : Math.min(1, Math.max(0, (level - va) / (vb - va)));
    p = [ax + (bx - ax) * t, ay + (by - ay) * t];
    px.set(id, p);
    return p;
  };

  // Segments as adjacency: edge id -> list of neighbouring edge ids.
  const adj = new Map();
  const link = (a, b) => {
    let la = adj.get(a); if (!la) adj.set(a, (la = []));
    let lb = adj.get(b); if (!lb) adj.set(b, (lb = []));
    la.push(b); lb.push(a);
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const c = (mask[i] >= level ? 8 : 0) | (mask[i + 1] >= level ? 4 : 0)
              | (mask[i + w + 1] >= level ? 2 : 0) | (mask[i + w] >= level ? 1 : 0);
      const segs = SEGMENTS[c];
      if (!segs.length) continue;
      for (const [ea, eb] of segs) {
        crossing(ea, x, y); crossing(eb, x, y);
        link(edgeOf(ea, x, y), edgeOf(eb, x, y));
      }
    }
  }

  // Walk the adjacency into loops. Open chains (touching the grid border)
  // are kept as open polylines.
  const loops = [];
  const seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // Walk back to an end if this is an open chain, so it is traced whole.
    let head = start, prev = -1;
    for (let guard = 0; guard < adj.size; guard++) {
      const nb = adj.get(head);
      if (nb.length !== 2) break;
      const next = nb[0] === prev ? nb[1] : nb[0];
      if (next === start) break;
      prev = head; head = next;
    }
    const pts = [];
    let cur = head, from = -1;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      pts.push(px.get(cur));
      const nb = adj.get(cur);
      const next = nb[0] !== from ? nb[0] : nb[1];
      from = cur; cur = next;
      if (cur === head) break;
    }
    const closed = cur === head;
    if (perimeter(pts, closed) < minLength) continue;
    loops.push({ closed, pts: smoothLoop(pts, closed, smooth) });
  }

  // Normalise to 0..1, cell centres at (x + 0.5) / w.
  for (const loop of loops) {
    const out = new Float32Array(loop.pts.length * 2);
    for (let k = 0; k < loop.pts.length; k++) {
      out[k * 2] = (loop.pts[k][0] + 0.5) / w;
      out[k * 2 + 1] = (loop.pts[k][1] + 0.5) / h;
    }
    loop.pts = out;
  }
  return loops;
}

function perimeter(pts, closed) {
  let s = 0;
  for (let k = 1; k < pts.length; k++) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  if (closed && pts.length > 1) s += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  return s;
}

// Chaikin corner cutting. Each pass replaces every vertex with two points a
// quarter of the way along its edges, which rounds the stair-steps that
// marching squares leaves on a diagonal without moving the line off the
// crossings by more than a fraction of a cell.
export function smoothLoop(pts, closed, passes) {
  let cur = pts;
  for (let p = 0; p < passes && cur.length > 2; p++) {
    const next = [];
    const n = cur.length;
    const last = closed ? n : n - 1;
    if (!closed) next.push(cur[0]);
    for (let k = 0; k < last; k++) {
      const a = cur[k], b = cur[(k + 1) % n];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push(cur[n - 1]);
    cur = next;
  }
  return cur;
}
