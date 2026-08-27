# Silhouette Particles

Stand in front of the display: your outline appears as a glowing contour in a black
void, and the particle field takes the push of whatever direction you moved.

## Run it

```
npm start                       # serves on http://localhost:8777
open -a Safari http://localhost:8777/
```

Click **Begin**, allow the camera, press `F` for fullscreen. That's the installation.

It has to be served over `http://localhost` — the camera needs a secure context, and
`file://` isn't one. Nothing leaves the machine; the segmentation model and its runtime
are vendored in `vendor/`, so it runs with the network unplugged.

## Calibrating: press one button

`C` → **Calibrate everything**. It measures the display latency, then the
screen's shape, then its brightness, then checks the piece cannot see its own
output, and prints what it found. About a minute, no input, nobody in front of
the screen.

The order is forced by dependency rather than preference: structured light has
to know when a pattern reaches the camera, photometry is measured per display
cell so it needs the geometry first, and the loop check comes last because it is
the only step that confirms a result rather than producing one.

Latency is measured by modulating the whole screen and reading the whole sensor,
so it needs no geometry — which is what makes the chain able to bootstrap
itself. That does provoke auto-exposure, unlike the patch-based version used
later, but it does not matter: AE reacts over hundreds of milliseconds while the
m-sequence carries its energy far faster, and correlating against a
pseudo-random sequence ignores slow drift by construction.

The report includes **how much of the sensor the screen occupies**. If that is
small, the detector grid is being upscaled from very few camera pixels and no
software will recover detail that was never captured — move the camera closer or
zoom in.

## Curved and multi-projector screens

The geometry step measures the display→camera mapping with **gray-code
structured light** rather than fitting four corners. That matters as soon as the
screen is not flat: a homography maps planes to planes, so on a 120° curved
screen the error peaks in the middle — where people stand — at roughly **9 cells
on a 416-wide grid**, against a detector that tolerates one or two. Corner
dragging cannot fix that, because the model itself is wrong.

Measuring does not care what the surface is. It gives, per display cell, where
the camera actually sees it — so curvature, lens distortion, and the seam
between edge-blended projectors are all already in the answer. The photometric
map is per-cell too, so each projector's different black level and the blend
overlap are absorbed the same way.

Gray code specifically: consecutive values differ in exactly one bit, so a
camera pixel straddling a stripe edge misreads at most one bit and lands on a
neighbouring cell. Plain binary would have a carry flip every bit at once and
land somewhere arbitrary. Each pattern is shown with its inverse and thresholded
against it, which makes the read independent of how brightly that part of the
surface happens to be lit — necessary on a curve, where the edges are far dimmer
than the centre.

Cells no camera pixel landed on are filled from their neighbours; cells the
camera genuinely cannot see are marked unobservable rather than invented, and
the wizard reports what fraction was measured directly.

Corner marking is still there as a fallback, for a rig where the pattern
sequence cannot get a clean read.

## Calibrating the rig

The camera sees the whole room; the display is a small trapezoid somewhere inside
that view. Until you tell it which trapezoid, nothing lines up — and segmentation
is poor, because the model is being handed a person 30px tall in a room-wide frame.

Press `C`. You get the live camera feed with four handles. Drag them onto the
corners of the display **as the camera sees it**. The inset bottom-right shows the
warped result — that's exactly what the piece will use. Save & run.

It's a projective correction, not a crop, so it handles the camera viewing the
display off-axis. The thirds grid inside the quad is the check: if those lines look
straight and evenly spaced against the display, the keystone fit.

Calibration is stored separately from the look settings — you retune the look
often, you calibrate the rig once. It runs automatically the first time.

**If your silhouette comes out too large**, drag the corners wider than the display.
You stand nearer the camera than the screen does, so you project bigger than life —
widening the quad scales you back down. Some of this is unavoidable and reads as a
cast shadow, which is arguably the nicer effect.

**Mirroring is off by default**, because the camera sits behind you facing the
display: you and it face the same way, so a mirrored image would be backwards.
If you move the camera to the display looking back at you, turn mirroring on.

## The feedback loop

The camera can see the display. The display shows a glowing, human-shaped contour.
A person-segmentation model then does exactly what it was built to do and finds a
person there — so the piece outlines its own outline. Left alone it trails and grows.

Three independent defences, in order of how much work they do:

**1. Subtract what we drew** (`selflight.js`). The one that does the real work. It
measures the *actual rendered framebuffer* — bloom, particles and all — and subtracts
that from the camera feed before segmentation.

Two earlier attempts failed here, and both failures are worth knowing:

- *Reconstructing the mask from `rim` under-covered it.* What reaches the display is
  rim plus its bloom halo plus particles, so a rim-shaped mask never covered the light
  that was actually there. The loop survived and crept outward each frame — it looked
  like a flame wicking up.
- *Masking the region toward black erased the person too.* That starved the segmenter,
  so the mask collapsed, so the glow moved, so it detected again. Endless oscillation.

The fix for the second is that this **subtracts** rather than masks. Light is additive:
the camera sees (person) + (display), so removing exactly our contribution sends our
glow to black while leaving a person standing in front of it with their own brightness
intact. It's per channel, so amber particles don't eat blue.

History covers camera latency (~100ms), and dilation covers the bloom halo.

**2. Motion is gated by the silhouette** (`flow.js`), and reads the body mask rather
than camera luma — so the piece's own particles can never register as a push.

**3. Colour keying** (`selfkey.js`) mops up residue. On its own it is *not* enough,
and it's worth knowing why: the bloom is composited additively, so the brightest part
of the contour clips toward white — and white has no hue and no saturation, so a
colour key skips exactly the part the segmenter latches onto hardest.

### If the display looks degraded

A banner appears bottom-left when the segmentation model failed to load and the piece
fell back to background subtraction. On this rig that mode will trail and grow, so it
says so rather than leaving you to diagnose it. It also warns when the rig is
uncalibrated.

### If it still grows

Press `L` to see the self-light overlay — the magenta region is what's being
subtracted. It should cover the glow with a visible margin. If the glow pokes out
past it, raise **halo cover**. If suppression lags behind a moving outline, raise
**latency frames**. **subtract own glow** at 0 disables it entirely, which is a quick
way to confirm whether it's doing anything.

## Presence

The piece idles when the room is empty and wakes when someone steps in. Coverage
(what fraction of the display area reads as body) drives it, with hysteresis: it
arrives above one threshold and leaves below a lower one, then waits out a hold
before idling. Coverage is smoothed asymmetrically — fast on the rise so stepping in
registers immediately, slow on the fall so a one-frame segmentation wobble can't flip
the state. That combination is what stops it strobing when someone stands right
at the edge of detection, and stops a half-second segmentation dropout from blanking
the display mid-use. Coverage above `presenceMax` is rejected as a lighting change
rather than believed as a very large person.

Live coverage is shown in the panel status line, which is the number to watch when
tuning the thresholds for your room. A `±` figure appears beside it when the raw
per-frame coverage is diverging from the smoothed value — that's the direct readout of
segmentation instability, so if the piece is behaving oddly, look there first.

## Controls

| key | |
|---|---|
| `D` | tuning panel |
| `F` | fullscreen |
| `C` | calibrate: mark where the display is in the camera view |
| `M` | raw mask overlay — what the camera thinks your body is |
| `V` | flow vectors — what it thinks you're doing |
| `L` | self-light overlay — what's being subtracted from the camera |
| `S` | simulated figure, no camera |
| `R` | reset all tuning |

`?sim=1` previews the piece with a synthetic figure — no camera, no permission prompt.
`?reset` ignores stored tuning and comes up on defaults.

Tuning persists to localStorage, so the machine comes back up already dialled in.

## Dialling it in for your room

Press `D`, then `M` to see the raw mask. Work in this order:

0. **Calibrate first** (`C`). Everything below is wasted effort on an uncalibrated rig.
1. **sensitivity** — until your body is solid white and the background is black.
   If it's inverted (background lit, you dark), hit **invert mask**.
2. **edge steadiness** — up if the contour shimmers, down if it feels laggy.
3. **outline width / brightness** — the look of the line itself.
4. Press `M` off, `V` on, wave an arm. Vectors should point the way you moved.
   If a fast swipe barely registers, raise **swipe range** — that widens the gradient
   support the estimator uses, which is what sets the largest movement it can measure.
   If pushes feel weak generally, raise **motion gain**. If gestures feel smeared or
   late, lower **push weight** and **motion lag**.
5. **push strength** for how hard you throw particles, **return to rest** for how fast
   the field heals afterwards.
6. If the outline starts growing or duplicating itself, that's the feedback loop —
   check **ignore own glow** is on and widen `hue width` until it stops.

Two things that matter physically: get some light on the person (the segmenter needs to
see them, and a dark room full of bright display is the hard case), and if the outline
doesn't line up with your body, it's camera placement — the closer the camera sits to the
display's centre and the more it matches the display's framing, the better it registers.

## How it works

```
webcam frame
   ├─► segmenter ──► mask ──► rim band ──► glowing outline
   │                  │
   │                  └────────┐  (mask gates the flow)
   └─► flow ──► motion field ──┘
                      │
                      ▼
                 particles ──► bloom ──► display
```

- **`homography.js` / `calib.js` / `warp.js`** — find the display inside the camera
  view and straighten it out. A plain crop can't do this: the camera sees the display
  off-axis, so its outline is a trapezoid and only a projective transform removes the
  keystone. The warp runs in JS because the targets are tiny (~80k samples/frame) and
  Canvas 2D can't express a projective transform anyway.
- **`flow.js`** — reads the BODY MASK, not camera luma. Readings are gated by
  *persistence*: a cell only contributes if the body was there in both frames. The
  flow constraint assumes the field changes smoothly, and a mask that blinks on or
  off breaks that badly — you get a huge temporal difference against a real gradient,
  so the estimator returns near-maximum velocity out of nowhere. That once drove
  terminal particle velocity to ~40% of the screen per frame and threw the whole
  field against the walls. `particles.js` also enforces a hard `maxSpeed` ceiling as
  a backstop, so no future upstream bug can repeat it. Luma flow needs the person to
  have texture and the room to be lit evenly; a dark sleeve against a dark room gives
  almost no gradient, so arm swipes came out weak. The mask is high-contrast by
  construction and moves exactly with the person, so a limb's edge always produces a
  strong gradient — and it can't see the display's content at all.
- **`selflight.js`** — subtracts the piece's own output from the camera feed.
- **`presence.js`** — hysteresis + hold, so an empty room stays dark and a brief
  dropout doesn't blank the piece mid-use.
- **`segmenter.js`** — MediaPipe selfie segmentation → body mask, smoothed over time
  because raw per-frame masks jitter and jitter on a glowing line is very visible.
  The contour is the distance to the mask's 0.5 isoline (`contourBand`), not an
  erosion difference. Erosion works in whole grid cells, so it could not draw a line
  thinner than one cell — about 12px on a 4K display — no matter what width was asked
  for. The distance form gives continuous, sub-cell width and anti-aliases for free. Falls back to background subtraction if the model won't load, so a failure
  degrades instead of going black.
- **`flow.js`** — per-cell normal flow, **gated by the silhouette**. That gate is the
  load-bearing part: the camera can see the display, and the display is full of moving
  particles, so an ungated field would read the piece's own output as motion and feed
  back into itself. Only motion inside your body counts as a push — which also means a
  person walking past in the background can't disturb it.
- **`particles.js`** — each particle samples the flow field, gets thrown, drifts, and
  eases back toward its rest position. A weak outward nudge along the mask gradient
  keeps your body from filling with stuck dots when you stand still.
- **`render.js`** — bloom by downscale/upscale ping-pong rather than `ctx.filter`,
  which is both universal across browsers and much cheaper at 1080p.

## Tests

```
npm test
```

60 tests over the pure logic: blur and erosion behaviour, the rim landing on the contour
rather than the interior, and — the one that matters for feel — that a pattern moving
right produces flow pointing right at roughly the right magnitude, that particles in that
field actually travel right, settle back afterwards, and never escape the screen or go NaN.

The homography is pinned down hard, since a silent error there misaligns everything
downstream: unit-square corners must land exactly on the quad corners, straight lines must
stay straight, keystone must actually foreshorten, and degenerate quads must be rejected
rather than warped into garbage.

Presence is tested for the failure modes that only show up in a room: hovering between
thresholds must not strobe, a half-second dropout must not blank the display, and a
whole-frame lighting change must not read as a person.

Self-light is tested for the ones that only show up on a rig: suppression has to
outlive camera latency, has to expire so it can't blind the piece permanently, has to
cover the bloom halo and not just the drawn core, and has to suppress nothing at all
when the display is idle.

`blowout.test.mjs` is the regression suite for the wipe: a blinking mask must produce
almost no flow, a body arriving or vanishing must not read as a shove, real translation
must still dominate a blink by 10x, and particle speed must stay under the ceiling even
when handed an absurd flow reading.

The colour key's trade-off is tested rather than assumed: skin tones across five
shades survive, as do grey, navy, off-white and pale blue — but a saturated cyan
garment is suppressed, which is why the outline hue should stay off-palette.

`?sim=1` is the other half of that: a synthetic walking figure drives the whole pipeline
so the piece can be verified end to end with nobody in the room.

---

## Windows installation build

The piece ships as a Windows app so it can own a display, keep the camera
without prompting, and update itself.

**Why Electron rather than a system WebView.** It runs the same Chromium engine
that powers Edge, but pinned to a known version. This is a vision system tuned
against specific rendering and timing behaviour; a browser updating overnight
should not be able to change how it behaves on a wall somewhere. Electron also
grants the camera up front — an installation gets power-cycled and has to come
back with nobody there to click Allow — and can put itself on a chosen display,
which a browser cannot.

**Camera exposure.** Chromium can lock exposure and white balance; Safari
cannot. That matters more here than it sounds: the detector predicts what the
camera *should* read, so auto-exposure hunting as the piece brightens and
darkens is a moving target it has to model and undo. On launch the app asks the
camera for manual exposure, white balance and focus, and takes whatever it is
offered. It is best-effort and per-camera — a camera that refuses is no worse
off, because the software compensation is still there.

### Releasing

```
npm version patch      # or minor / major
git push --follow-tags
```

That is the whole process. Pushing a `v*` tag runs the test suite, builds the
installer on a Windows runner, and publishes it to Releases. Installed copies
check on launch and hourly, download in the background, and install on quit —
so a running installation is never interrupted mid-show.

Building on Windows in CI is not a preference: NSIS installers produced under
wine are unreliable, and CI keeps releases reproducible rather than dependent
on one laptop.

### Where the installer lives

Under **Releases**, not in the file tree — GitHub keeps build artefacts separate
from source. Latest installer:

https://github.com/JJ0236/silhouette-particles/releases/latest

Note `releaseType: "release"` in the build config. electron-builder defaults to
publishing a *draft*, which is invisible on the repo page and, more importantly,
is skipped by electron-updater — so every build would publish an installer that
nothing could download and no machine would ever update to.

### How updating actually behaves

Launch, quit, launch. On launch it checks GitHub and downloads a newer version
in the background; the install happens **on quit**, so a running installation is
never interrupted mid-show; the next launch is on the new version. One restart
downloads, the second applies.

A banner appears when an update has been downloaded and is waiting, and another
if the check failed. That distinction matters: an installation silently failing
to update looks exactly like one that is already current, and the two need very
different responses. Version and update state are also logged to the console.

Only the installed app updates — not a copy run from source — and it needs
internet at launch.

### First install

The build is unsigned, so Windows SmartScreen will show
**"Windows protected your PC" → More info → Run anyway** the first time.
Updates after that are silent. Signing removes the warning and needs a
certificate; it wires into CI as a repo secret whenever you want it.

### Known gaps

Four closed-loop tests are marked `todo` rather than deleted, with their
reasons in the test file. All are detection quality, none are safety — every
feedback-immunity test passes. The most interesting one is physics rather than
code: with a light-coloured top the body reflects *more* light than the wall
(measured at 1.96x, because the projector is nearer the viewer than the wall),
and a darker-than-predicted test cannot see that at all.
