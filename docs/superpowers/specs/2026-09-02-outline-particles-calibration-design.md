# Solid outline, outline-gathering particles, one-button calibration

Date: 2026-09-02. Approved in conversation; built the same day.

## Problem

- The silhouette outline was a raster band painted per detector cell (about eight
  wall pixels on the 5760x1080 rig) and read as chunky and wavering.
- Particles inside the body lingered: the only outward force was the mask gradient,
  which is zero in the interior, while return-to-rest held them in place.
- "Calibrate everything" skipped registration and the stand-in, and only marked the
  rig calibrated when the operator pressed Done, so a failed loop check or a cancel
  discarded a good map and photo.

## Design

**Outline** (`src/contour.js`, `src/render.js`): marching squares on the smoothed
mask at 0.5 with edge interpolation; Chaikin smoothing (2 passes); loops with
perimeter under 6 cells dropped; open chains kept where the body meets the frame
edge. The renderer strokes the loops with `outline width` (cells, doubled to a full
width) in `outline hue`, alpha from presence and `outline brightness`; the existing
bloom supplies the halo. The detector's raster `rim` field is still produced for
tests and diagnostics but no longer drawn.

**Particles** (`src/distance.js`, `src/particles.js`, `src/occlusion.js`): the
detector publishes a signed distance field `sdf` (chamfer 3-4; negative inside,
uncapped; positive outside, capped at `outlineReach` cells). Each particle within
reach feels a force toward distance zero along the field gradient, magnitude
`outlinePull` per cell (clamped at 4 cells), and its return-to-rest pull is scaled
by `1 - held` where `held` is 1 inside and fades to 0 at reach. Settings
`outlinePull` (default 1.0) and `outlineReach` (default 12) replace `occupancy`.

**Calibration** (`src/photocal.js`, `src/calibrate.js`): `runAuto` now runs
latency, geometry, photometric, registration (suggested lens margin applied and
saved), loop check. The wizard saves the corner state and settings as soon as
geometry (coverage > 5%) and photometry succeed, then arms a stand-in pass
(Start / Skip), applies its thresholds, and shows all rows with a Close button.

## Revision, same day

- Particles: no inward pull. Inside the body a particle is driven out; once
  0..2.5 cells outside it parks (rest suspended) until the body moves away.
  Particles already outside are never touched. `outlineReach` removed; the
  detector's distance cap is a fixed 16 cells.
- Blind cells: `gateUnseen` strikes cells the geometry map never saw directly,
  plus a two-cell margin, from the photometric `observable` mask. Fixes the
  permanent false outlines along the band where the speakers hang.

## Tests

`test/contour.test.mjs`: disc traces to one loop of the right perimeter with
sub-cell vertices; speckle dropped; frame-cut body traced open; empty mask traces to
nothing; signed distance signs, edge, cap. `test/outline-particles.test.mjs`:
particles inside a body leave and gather on the outline; gathered particles return
to rest when the body leaves. Existing suites unchanged.
