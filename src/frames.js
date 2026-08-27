// A ring of rendered frames indexed by timestamp. The occlusion detector asks
// for the per-byte min (or max) of every frame rendered within a window around
// the camera's exposure time, which is how it brackets an uncertain latency.

export function createRing({ entries = 24, size } = {}) {
  // Every slot is allocated up front; push copies into the slot so the caller
  // may keep reusing its own buffer.
  const bufs = new Array(entries);
  for (let i = 0; i < entries; i++) bufs[i] = new Uint8Array(size);
  const times = new Float64Array(entries);
  let head = 0;    // next slot to write
  let count = 0;   // live entries, <= entries

  // Slot of the k-th oldest live entry (k = 0 is the oldest).
  const slotOf = (k) => (head - count + k + entries) % entries;

  function push(rgb, t) {
    bufs[head].set(rgb);
    times[head] = t;
    head = (head + 1) % entries;
    if (count < entries) count++;
  }

  // Order is push order, not timestamp order: "oldest" means pushed first,
  // which stays meaningful even when a clock hiccup makes timestamps go
  // backwards. Selection itself is purely by timestamp value.
  function select(t0, t1) {
    const out = [];
    for (let k = 0; k < count; k++) {
      const s = slotOf(k);
      const t = times[s];
      if (t >= t0 && t <= t1) out.push(s);
    }
    return out;
  }

  // The reductions walk the ring directly rather than through select() so the
  // per-frame path allocates nothing.
  function minOver(t0, t1, dst) {
    let n = 0;
    for (let k = 0; k < count; k++) {
      const s = slotOf(k);
      const t = times[s];
      if (t < t0 || t > t1) continue;
      const src = bufs[s];
      if (n === 0) dst.set(src);
      else for (let i = 0; i < size; i++) if (src[i] < dst[i]) dst[i] = src[i];
      n++;
    }
    return n;
  }

  function maxOver(t0, t1, dst) {
    let n = 0;
    for (let k = 0; k < count; k++) {
      const s = slotOf(k);
      const t = times[s];
      if (t < t0 || t > t1) continue;
      const src = bufs[s];
      if (n === 0) dst.set(src);
      else for (let i = 0; i < size; i++) if (src[i] > dst[i]) dst[i] = src[i];
      n++;
    }
    return n;
  }

  // The returned rgb is the live slot, not a copy: it is valid until `entries`
  // more pushes overwrite it.
  function latest() {
    if (count === 0) return null;
    const s = (head - 1 + entries) % entries;
    return { rgb: bufs[s], t: times[s] };
  }

  function clear() { head = 0; count = 0; }

  return { push, select, minOver, maxOver, latest, clear, get length() { return count; } };
}
