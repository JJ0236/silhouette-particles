// Detector tunables, kept in their own module so config.js can spread them
// into DEFAULTS without importing the (heavier) detector itself. occlusion.js
// re-exports this object under the same name; edit it HERE, not there.
// brightField inverts the finished frame, so the wall is WHITE and the piece
// draws dark-on-light. The camera sits behind the viewer, which makes the
// display a backlight: a bright field maximises the light a body blocks, so the
// cast shadow becomes a strong signal and every deficit clears the noise gate
// easily. voidFloor is therefore 0 — inversion already supplies the light, and
// a floor would only reduce peak white.
//
// The note below applies to the black-void look (brightField off):
// voidFloor is 10% rather than pure black for a measured reason: in a black
// void the absolute light is so small that a 20% RELATIVE deficit from a body
// is comparable to camera noise, and the σ gate rejects it. On the closed-loop
// rig model, lifting the floor from 5% to 10% took finger detection from
// 122/210 cells to 210/210 with immunity unchanged. Drop it back toward 0 only
// if the room is dark enough that detection survives — the stand-in step in
// calibration measures exactly that.
// Thresholds are measured, not guessed. With the gain sharing the ratio's
// denominator an unoccluded wall lands at 1.00 by construction; on the rig
// model a dark top reads 0.21, a medium top 0.73, and a light top 1.17 —
// brighter than the wall, which a darker-than-predicted test cannot see at all.
// The scattered low tail an adversarial camera produces is rejected by
// component area, not by threshold, which is why tauHigh can sit this close
// to 1. The stand-in step in calibration re-measures all of this on the real
// rig and proposes values.
//
// contentTrust (beta) discounts the predicted content so an unoccluded wall
// reads a ratio of ~1/beta, safely above threshold, while a real occluder still
// falls below it. It must stay ABOVE the body ratio the rig produces: medium
// clothing measures ~0.71, and at beta 0.7 that becomes 0.71/0.7 = 1.02 — above
// tauHigh, i.e. a person who cannot be seen. 0.85 puts them at 0.84.
export const OCCLUSION_DEFAULTS = {
  voidFloor: 0, brightField: true, tauLow: 0.80, tauHigh: 0.95, noiseK: 3, contentTrust: 0.85, predErode: 0, regTol: 0,
  lagWindowMs: 25, lagMode: 'auto', lagManualMs: 0, openR: 0, closeR: 1, minComponentFrac: 0.0008,
  growIters: 8, tauGrow: 0.98,
  temporalMedian: true, fillHoles: true, holeMaxFrac: 0.015, gainBands: 6, camGamma: 2.2, camPedestal: 8,
  vetoCoverage: 0.92, vetoSmooth: 0.8, refMinFrac: 0.3, gainSlew: 0.15, poolRadius: 1,
  maskSmooth: 0.7, motionSmooth: 0.5, influence: 2.5, rimWidth: 0.7, rimGain: 1.7, maskMaxCoverage: 0.85,
};
