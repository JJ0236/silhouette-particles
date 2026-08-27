import { settings, save, reset, MASK_W, MASK_H, WORK_W, WORK_H } from './config.js';
import { createCamera } from './camera.js';
import { createWarp } from './warp.js';
import { createRing } from './frames.js';
import { createOcclusion } from './occlusion.js';
import { createFlow } from './flow.js';
import { createParticles } from './particles.js';
import { createRenderer } from './render.js';
import { createPanel } from './panel.js';
import { createCalibration } from './calib.js';
import { createCalibrator } from './calibrate.js';
import { createPhotocal, loadPhoto } from './photocal.js';
import { createPresence } from './presence.js';
import { createSimCamera, IDEAL } from './simcam.js';
import { movingPerson } from './renderG.js';
import { patchLayout, calibrationSequence, createAccumulator } from './photometric.js';

// Two loops, deliberately decoupled:
//   camera frames (~30 Hz, requestVideoFrameCallback) → sample → detect → presence → flow
//   rAF (~60 Hz)                                      → particles → draw → capture into ring
// The ring of captured frames is what the detector compares the camera against,
// so capture must be the LAST thing each rendered frame does.

const N = MASK_W * MASK_H;

const view       = document.getElementById('view');
const overlay    = document.getElementById('overlay');
const startBtn   = document.getElementById('start');
const overlayMsg = document.getElementById('overlay-msg');
const warnEl     = document.getElementById('warn');

const camera    = createCamera();
const warp      = createWarp({ w: MASK_W, h: MASK_H });
const ring      = createRing({ entries: 24, size: N * 3 });
const occlusion = createOcclusion({ w: MASK_W, h: MASK_H, workW: WORK_W, workH: WORK_H, settings });
const flow      = createFlow();
const particles = createParticles(settings.particles);
const renderer  = createRenderer(view);
const calib     = createCalibration();
const presence  = createPresence();

const obs = new Uint8Array(N * 3);
let photo = null;
let simRig = null;

// Identity of a photometric calibration: which camera, which quad, which
// grid. photocal owns the definition so the stored and expected forms can't
// drift apart.
const photoMeta = () => photocal.expectedMeta();

const photocal = createPhotocal({
  renderer, camera, warp, calib, ring, occlusion, settings,
  onProgress: p => panel?.setStatus(`${p.phase} ${Math.round((p.frac ?? 0) * 100)}%`),
});

const calibrator = createCalibrator({
  camera, calib, warp, ring, occlusion, renderer, photocal, settings,
  onExit: () => { resetDetection(); loadPhoto(photoMeta()).then(p => { photo = p; }); },
  onPhoto: p => { photo = p; resetDetection(); },
});

const panel = createPanel({
  onParticleCount: c => particles.setCount(c),
  onCamera: id => startCamera(id),
  onFullscreen: () => toggleFullscreen(),
  onCalibrate: () => calibrator.open(1),
  onPhotometric: () => calibrator.open(2),
  onDarkFrame: () => calibrator.open(2),
  onToggle: key => {
    if (key === 'sim' || key === 'mirror') { resetDetection(); if (key === 'sim') setupSim(); }
    // Any overlay change alters what's on the wall, so the ring briefly holds
    // frames the camera will never see again; hold the mask until it flushes.
    if (key === 'showMask' || key === 'showFlow' || key === 'showDiag') occlusion.suppress(settings.lagMs + 100);
  },
});

function resetDetection() {
  occlusion.reset(); flow.reset(); presence.reset(); ring.clear();
}

let currentDevice = null;
let rafRunning = false;
let offFrame = null;
let fps = 0, lastT = 0, acc = 0, frames = 0, camFps = 0, camFrames = 0, camAcc = 0, camLast = 0;
let level = 0;
let lastCapture = -1e9;
const CAPTURE_MS = 25;

async function startCamera(deviceId) {
  try {
    if (offFrame) { offFrame(); offFrame = null; }
    await camera.start(deviceId);
    currentDevice = deviceId || null;
    resetDetection();
    const devices = await camera.listDevices();
    panel.setDevices(devices, currentDevice || devices[0]?.deviceId);
    if (!currentDevice && devices[0]) currentDevice = devices[0].deviceId;
    photo = await loadPhoto(photoMeta());
    // Geometry is stored under its own key: the light gets re-measured far more
    // often than the camera gets moved.
    await photocal.loadMap(photoMeta()).catch(() => null);
    offFrame = camera.onFrame(onCameraFrame);
    return true;
  } catch (e) {
    panel.setStatus(`camera error: ${e.name}`, true);
    return false;
  }
}

function onCameraFrame(tCam) {
  if (calibrator.active || photocal.active || settings.sim) return;
  if (!warp.sampleGrid(camera, calib.H, settings.mirror, obs)) return;
  occlusion.update({ obs, tCam, ring, photo, lagMs: settings.lagMs });
  level = presence.update(occlusion.mask, tCam);
  flow.update(occlusion.motion, occlusion.influence);

  camFrames++; camAcc += tCam - camLast; camLast = tCam;
  if (camAcc > 500) { camFps = Math.round(camFrames * 1000 / camAcc); camFrames = 0; camAcc = 0; }
}

// The packaged app grants the camera itself, so a failure there is a real
// fault — a camera in use by something else, unplugged, or blocked by Windows
// privacy settings — not a permission prompt the user needs to click. Telling a
// Windows user to open Safari settings sends them somewhere that does not exist.
function cameraHelp() {
  const packaged = typeof window !== 'undefined' && !!window.installation;
  if (packaged) {
    return 'No camera. Check it is plugged in, not in use by another app, and '
         + 'allowed under Windows Settings → Privacy & security → Camera. '
         + 'Press D to pick a different camera.';
  }
  const ua = navigator.userAgent;
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  return isSafari
    ? 'Camera blocked. Allow it in Safari → Settings for This Website, then reload.'
    : 'Camera blocked. Allow camera access for this site, then reload.';
}

async function begin(silent) {
  if (!silent) overlayMsg.textContent = 'starting camera…';
  if (!await startCamera(null)) {
    if (!silent) overlayMsg.textContent = cameraHelp();
    return false;
  }
  overlay.hidden = true;
  document.body.classList.add('running');
  if (!rafRunning) { rafRunning = true; requestAnimationFrame(frame); }
  // Nothing works until the rig is mapped and photometrically calibrated.
  if (!calib.calibrated) calibrator.open(1);
  else if (!photo) calibrator.open(2);
  return true;
}

// ---- sim mode: a real closed loop through the real renderer -----------------

function setupSim() {
  if (!settings.sim) { simRig = null; return; }
  const sim = createSimCamera({ ...IDEAL, w: MASK_W, h: MASK_H });
  simRig = { sim, i: 0, obs: new Uint8Array(N * 3), photo: calibrateThroughSim(sim), lagMs: IDEAL.latencyFrames * (1000 / 60) };
}

// Run the actual patch calibration THROUGH the simulated camera, so the sim's
// photo is produced the same way the rig's is — not copied from the sim's own
// parameters, which would make the loop trivially consistent.
function calibrateThroughSim(sim) {
  const layout = patchLayout({ cols: 8, rows: 8, w: MASK_W, h: MASK_H });
  const seq = calibrationSequence({ layout, litPerFrame: 4, holdFrames: 2, whiteCycles: 2, levelCycles: 1 });
  const acc = createAccumulator(layout, N);
  const R = new Uint8Array(N * 3), o = new Uint8Array(N * 3);
  const empty = new Float32Array(N);
  const pending = [];
  for (let i = 0; i < seq.length + 8; i++) {
    const spec = i < seq.length ? seq.frame(i) : { lit: [], level: 0, settle: true };
    R.fill(0);
    for (const p of spec.lit) for (const c of layout.cells[p]) { R[c * 3] = R[c * 3 + 1] = R[c * 3 + 2] = spec.level; }
    sim.observe(R, empty, i, o);
    pending.push(spec);
    // The camera shows the frame from latencyFrames ago.
    const seen = pending[pending.length - 1 - IDEAL.latencyFrames];
    if (seen && !seen.settle) acc.add(seen, o);
  }
  const p = acc.finish();
  p.meta = { ...photoMeta(), sim: true };
  return p;
}

// ---- render loop --------------------------------------------------------------

function frame(t) {
  requestAnimationFrame(frame);
  const aspect = renderer.width / renderer.height;

  if (calibrator.active) { calibrator.draw(aspect); return; }
  if (photocal.active) return;   // photocal paints its own frames

  if (settings.sim && simRig) {
    // Detect against the last frame we actually put on screen.
    const latest = ring.latest();
    if (latest) {
      const occluder = movingPerson(MASK_W, MASK_H, simRig.i, { speedCells: 2 });
      simRig.sim.observe(latest.rgb, occluder, simRig.i, simRig.obs);
      occlusion.update({ obs: simRig.obs, tCam: t, ring, photo: simRig.photo, lagMs: simRig.lagMs });
      level = presence.update(occlusion.mask, t);
      flow.update(occlusion.motion, occlusion.influence);
      simRig.i++;
    }
  }

  particles.update(flow, occlusion, t, settings.sim ? 1 : level);
  renderer.draw(particles, occlusion, flow, settings.sim ? 1 : level, settings.showDiag ? occlusion.diag : null);
  // Capture at ~40 Hz, not every rendered frame.
  //
  // capture() reads pixels back off the GPU, which stalls the pipeline; doing it
  // 60 times a second was costing more than it bought. The ring only needs
  // enough temporal resolution to match the measured latency window, and the
  // detector runs at camera rate (~30 Hz) anyway.
  if (t - lastCapture >= CAPTURE_MS) {
    lastCapture = t;
    renderer.capture(ring, t);   // must stay last: this is what the detector compares against
  }

  if (occlusion.diag.lagStarved) starvedFor += t - (lastStarveT || t);
  else starvedFor = 0;
  lastStarveT = t;
  updateWarning();

  frames++; acc += t - lastT; lastT = t;
  if (acc > 500) { fps = Math.round(frames * 1000 / acc); frames = 0; acc = 0; }
  if (panel.visible) {
    const d = occlusion.diag;
    const who = settings.sim ? 'sim'
      : presence.present ? `present ${(presence.coverage * 100).toFixed(1)}%`
      : `idle ${(presence.coverage * 100).toFixed(1)}%`;
    panel.setStatus(
      `${fps}/${camFps} fps · ${camera.describe?.() ?? ''} · ${particles.count.toLocaleString()} · ${who}` +
      ` · lag ${Math.round(settings.lagMs)}ms · ref ${(d.refFrac * 100).toFixed(0)}%` +
      ` · ratio p5 ${Number.isFinite(d.ratioP5) ? d.ratioP5.toFixed(2) : '--'}` +
      ` (tau ${settings.tauLow}/${settings.tauHigh})` +
      (d.veto ? ' · VETO' : '') + (d.lagStarved ? ' · LAG-STARVED' : '') +
      (calib.calibrated ? '' : ' · UNCALIBRATED') + (photo ? '' : ' · NO PHOTO'),
      d.veto || !calib.calibrated || !photo);
  }
}

// A single missed frame is phase, not a fault; only sustained starvation is
// worth telling anyone about. Without this the banner flickered on and off
// while the piece was running perfectly.
let starvedFor = 0;
let lastStarveT = 0;
let lastWarn = null;
function updateWarning() {
  let msg = null;
  if (!settings.sim) {
    if (!calib.calibrated) msg = 'Not calibrated. Press C and mark the display in the camera view.';
    else if (!photo) msg = 'No photometric calibration for this camera/quad. Press P to run it (nobody in frame).';
    else if (occlusion.diag.veto) msg = 'Whole display reads darker than expected — lighting changed? Mask held off. Press P to re-take the dark frame.';
    else if (starvedFor > 1500) msg = 'No rendered frame matches the measured latency — the render loop is being throttled.';
  }
  if (msg === lastWarn) return;
  lastWarn = msg;
  warnEl.textContent = msg || '';
  warnEl.hidden = !msg;
}

function toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const k = e.key.toLowerCase();
  if (k === 'escape' && calibrator.active) { calibrator.close(); return; }
  if (calibrator.active || photocal.active) return;

  if (k === 'd') panel.toggle();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'c') calibrator.open(1);
  else if (k === 'p') calibrator.open(2);
  else if (k === 'i') { settings.showDiag = !settings.showDiag; panel.syncToggle('showDiag'); occlusion.suppress(settings.lagMs + 100); }
  else if (k === 'm') { settings.showMask = !settings.showMask; panel.syncToggle('showMask'); occlusion.suppress(settings.lagMs + 100); }
  else if (k === 'v') { settings.showFlow = !settings.showFlow; panel.syncToggle('showFlow'); occlusion.suppress(settings.lagMs + 100); }
  else if (k === 's') { settings.sim = !settings.sim; panel.syncToggle('sim'); resetDetection(); setupSim(); }
  else if (k === 'r') { reset(); location.reload(); }
});

startBtn.addEventListener('click', () => begin(false));

if (settings.sim) {
  // Sim needs no camera and no permission, so it comes straight up.
  overlay.hidden = true;
  document.body.classList.add('running');
  setupSim();
  rafRunning = true;
  requestAnimationFrame(frame);
} else {
  // Installations get power-cycled: once the camera has been granted, come up
  // with no click. The overlay only exists to collect the gesture Safari needs
  // for the first grant.
  begin(true).catch(() => {});
}
