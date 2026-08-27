import { settings } from './config.js';

// Decides whether anyone is actually there.
//
// A room-wide camera picks up lighting shifts, people crossing the back, and
// the occasional segmentation misfire. Without this the display would flash
// phantom outlines at an empty room. Hysteresis (enter high, leave low, then
// hold) keeps it from strobing when someone stands right at the threshold.

export function createPresence() {
  let present = false;
  let level = 0;          // eased 0..1, what the renderer actually fades on
  let lastSeen = 0;
  let coverage = 0;   // smoothed; raw per-frame coverage is far too jumpy
  let raw = 0;

  function update(mask, now) {
    let sum = 0;
    for (let i = 0; i < mask.length; i++) sum += mask[i];
    raw = sum / mask.length;

    // Asymmetric smoothing: rise fast so stepping in is felt immediately, fall
    // slowly so a one-frame segmentation wobble can't flip the state. A
    // decision this visible should never ride on a single frame.
    coverage += (raw - coverage) * (raw > coverage ? 0.5 : 0.1);

    // An implausibly large "body" means the lights changed or the whole frame
    // shifted, not that someone walked up.
    //
    // Vetoed on the RAW value, deliberately. The smoothed one ramps up into a
    // sudden flash, so it passes through the plausible band on the way and
    // would trip presence before the veto ever applied.
    const plausible = raw <= settings.presenceMax && coverage <= settings.presenceMax;
    const enough = coverage >= (present ? settings.presenceExit : settings.presenceEnter);

    if (plausible && enough) { present = true; lastSeen = now; }
    else if (present && now - lastSeen > settings.presenceHold) { present = false; }

    const target = present ? 1 : 0;
    const rate = present ? 0.12 : 0.02;   // wake quickly, fade out gently
    level += (target - level) * rate;
    if (level < 0.001) level = 0;

    return level;
  }

  function reset() { present = false; level = 0; coverage = 0; raw = 0; }

  return {
    update, reset,
    get level() { return level; },
    get present() { return present; },
    get coverage() { return coverage; },
    get rawCoverage() { return raw; },
  };
}
