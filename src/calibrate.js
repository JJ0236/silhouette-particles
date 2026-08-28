import { settings as globalSettings, save } from './config.js';
import { createPhotocal } from './photocal.js';

// Calibration wizard. Step 1 is the corner drag over the raw camera feed;
// steps 2–4 hand the display over to photocal, which paints its own frames on
// the piece's canvas. While a pass runs the wizard panel is hidden and the
// cursor removed: the panel is light the camera sees but the detector never
// captured, so leaving it up would put an unpredicted bright box into the
// photometric map and the loop check.
//
// main.js pauses its own loop while `active`; draw() is called in its place.

const LABELS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const HIT = 0.045;   // grab radius, in frame-normalised units

const TITLES = ['Mark the display', 'Photometric', 'Loop check', 'Stand-in'];
const PHASE_LABEL = {
  latency: 'measuring latency', photometric: 'photometric patches',
  registration: 'registration grid', loop: 'loop check', standin: 'stand-in',
};

export function createCalibrator({ camera, calib, warp, ring, occlusion, renderer, photocal,
                                   settings = globalSettings, onExit, onPhoto }) {
  photocal = photocal ?? createPhotocal({ renderer, camera, warp, calib, ring, occlusion, settings });

  const root = document.createElement('div');
  root.id = 'calib';
  root.hidden = true;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  root.appendChild(canvas);

  const ui = document.createElement('div');
  ui.className = 'calib-ui';
  ui.innerHTML = `
    <div class="calib-steps"></div>
    <h2></h2>
    <div class="calib-body"></div>
    <div class="calib-actions"></div>`;
  root.appendChild(ui);
  document.body.appendChild(root);

  const stepsEl = ui.querySelector('.calib-steps');
  const titleEl = ui.querySelector('h2');
  const bodyEl  = ui.querySelector('.calib-body');
  const actEl   = ui.querySelector('.calib-actions');

  const api = {
    open, close, draw,
    get active() { return active; },
    get step() { return step; },
    get photocal() { return photocal; },
    onExit: onExit ?? null,
    onPhoto: onPhoto ?? null,
  };

  let active = false;
  let step = 1;
  let gen = 0;         // bumps on every step change/close; async flows check it
  let dragging = -1;
  let fit = { x: 0, y: 0, w: 1, h: 1 };
  const results = { latency: null, registration: null, loop: null, standIn: null };

  // The live inset is the detector's own grid, built from sampleGrid, so what
  // the operator sees framed is exactly what the detector will be handed.
  const gw = photocal.layout.w, gh = photocal.layout.h;
  const inset = document.createElement('canvas');
  inset.width = gw; inset.height = gh;
  const ictx = inset.getContext('2d');
  const insetImg = ictx.createImageData(gw, gh);
  const obs = new Uint8Array(gw * gh * 3);
  let insetTick = 0;

  photocal.onProgress = ({ phase, frac }) => {
    const bar = bodyEl.querySelector('.calib-progress .bar');
    const label = bodyEl.querySelector('.calib-phase');
    if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
    if (label) label.textContent = PHASE_LABEL[phase] ?? phase;
  };

  // ---- actions ---------------------------------------------------------------

  ui.addEventListener('click', (e) => {
    const act = e.target?.closest?.('button')?.dataset?.act;
    if (!act) return;
    switch (act) {
      case 'next':   if (step === 1) calib.save(); showStep(step + 1); break;
      case 'back':   showStep(step - 1); break;
      case 'skip':   showStep(step + 1); break;
      case 'start':  fireStart(); break;
      case 'measure': runGeometry(); break;
      case 'auto': runAutoAll(); break;
      case 'white': toggleWhite(); break;
      case 'corners': manualCorners = true; renderCorners(); break;
      case 'retry':  showStep(step); break;
      case 'reset':  calib.reset(); break;
      case 'save':   calib.save(); close(); break;
      case 'cancel': close(); break;
      case 'erode':  applyErode(); break;
      case 'apply':  applyStandIn(); break;
    }
  });

  addEventListener('keydown', (e) => {
    if (active && e.key === 'Escape') close();
  });

  function setActions(list) {
    actEl.innerHTML = list.map(b =>
      `<button data-act="${b.act}"${b.primary ? ' class="primary"' : ''}${b.disabled ? ' disabled' : ''}>${b.label}</button>`
    ).join('');
  }

  function enable(act, on = true) {
    const b = actEl.querySelector(`button[data-act="${act}"]`);
    if (b) b.disabled = !on;
  }

  function showSteps() {
    stepsEl.innerHTML = TITLES.map((t, i) =>
      `<span class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}">${i + 1} ${t}</span>`
    ).join('');
    titleEl.textContent = TITLES[step - 1];
  }

  // ---- step flow ---------------------------------------------------------------

  function showStep(n) {
    gen++;
    cancelArm();
    if (photocal.active) photocal.cancel();
    step = Math.max(1, Math.min(4, n));
    root.classList.toggle('run', step !== 1);
    root.classList.remove('dark', 'dim');
    canvas.hidden = step !== 1;
    showSteps();
    if (step === 1) { manualCorners ? renderCorners() : renderGeometry(); }
    else if (step === 2) runPhotometricStep(gen);
    else if (step === 3) runLoopStep(gen);
    else runStandInStep(gen);
  }

  const stale = (g) => g !== gen || !active;

  // Each measurement pass waits for an explicit Start.
  //
  // These passes need the operator OUT of the camera's view, and the previous
  // three-second auto-countdown was not enough time to walk out of frame — it
  // began measuring while whoever pressed the key was still standing in it.
  // Arming the pass instead of starting it also means Back/Cancel are usable
  // while you get into position, and a pass can be re-run without leaving and
  // re-entering the step.
  // Structured light is the default geometry path; the corner UI stays as a
  // fallback for a projector or camera that the pattern sequence cannot get a
  // clean read from.
  let manualCorners = false;
  let geoResult = null;

  async function runAutoAll() {
    const g = gen;
    enable('auto', false); enable('measure', false); enable('corners', false); enable('white', false);
    if (whiteOn) toggleWhite();
    beginPass();
    let rep = null;
    try {
      rep = await photocal.runAuto();
    } catch (e) {
      console.warn('[calibrate] auto failed:', e);
    }
    endPass();
    if (stale(g)) return;
    const card = bodyEl.querySelector('.calib-card');
    if (!rep) {
      card.innerHTML = '<div class="calib-warn">Cancelled.</div>';
      renderGeometryActions();
      return;
    }
    const rows = rep.steps.map((st) =>
      `<div class="calib-row ${st.ok ? 'ok' : 'bad'}"><b>${st.name}</b>
         <span>${st.value}</span><i>${st.note ?? ''}</i></div>`).join('');
    card.innerHTML = `<div class="${rep.ok ? 'calib-ok' : 'calib-warn'}">
        ${rep.ok ? 'Calibrated' : 'Finished with problems'}</div>${rows}`;
    if (rep.ok) onPhoto?.(rep.photo);
    setActions([
      ...(rep.ok ? [{ act: 'save', label: 'Done', primary: true }] : []),
      { act: 'auto', label: 'Run again', primary: !rep.ok },
      { act: 'corners', label: 'Mark corners instead' },
      { act: 'cancel', label: 'Cancel' },
    ]);
  }

  function renderGeometryActions() {
    setActions([
      { act: 'auto', label: 'Calibrate everything', primary: true },
      { act: 'white', label: whiteOn ? 'Stop white field' : 'Show white field' },
      { act: 'measure', label: 'Screen geometry only' },
      { act: 'corners', label: 'Mark corners instead' },
      ...(photocal.hasGeometry ? [{ act: 'next', label: 'Next: photometric' }] : []),
      { act: 'cancel', label: 'Cancel' },
    ]);
  }

  // A flat white field, for white-balancing the camera and for judging by eye
  // whether the room light is swamping the projector. If white and black look
  // similar on the wall, no amount of software will separate them.
  let whiteOn = false;
  function toggleWhite() {
    whiteOn = !whiteOn;
    if (whiteOn) {
      // Same layering problem as the pattern passes: the preview canvas sits on
      // top of the surface being painted, so it has to come down.
      canvas.hidden = true;
      photocal.holdField(255);
      whiteTimer = setInterval(() => photocal.holdField(255), 200);
    } else {
      clearInterval(whiteTimer); whiteTimer = 0;
      if (active && step === 1 && !manualCorners) canvas.hidden = false;
    }
    renderGeometryActions();
  }
  let whiteTimer = 0;

  // While a measurement pass runs, the wizard must get out of the way entirely.
  //
  // photocal paints its patterns onto the main view canvas; this wizard draws
  // its preview onto its own canvas at z-index 30, with an opaque background,
  // directly on top. So the patterns were being displayed correctly and covered
  // up — and worse, the camera was photographing the live preview instead of the
  // patterns, which is why nothing decoded. The overlay is hidden and the
  // preview loop stops for the duration.
  let passRunning = false;
  function beginPass() {
    passRunning = true;
    canvas.hidden = true;
    root.classList.add('dark');
  }
  function endPass() {
    passRunning = false;
    root.classList.remove('dark');
    if (active && step === 1 && !manualCorners) canvas.hidden = false;
  }

  function renderGeometry() {
    canvas.hidden = false;   // the live camera view stays up while aiming
    root.classList.add('run');
    bodyEl.innerHTML = `
      <p class="calib-big">Calibrate. Stand clear of the screen.</p>
      <p>The display flashes about forty patterns, roughly three seconds, and
         reads back which part of the screen the camera sees where. This
         replaces dragging corners and works on a curved or multi-projector
         screen, where four corners cannot: a corner fit assumes the surface is
         flat, and on a 120° screen that is around nine cells out in the middle
         — exactly where people stand.</p>
      <p><b>Calibrate everything</b> measures latency, then the screen's shape,
         then its brightness, then checks the piece cannot see its own output —
         about a minute, no input needed. Nothing between the camera and the
         screen while it runs.</p>
      <div class="calib-count"></div>
      <div class="calib-progress"><div class="bar"></div></div>
      <div class="calib-card"></div>`;
    renderGeometryActions();
  }

  async function runGeometry() {
    const g = gen;
    enable('measure', false); enable('corners', false); enable('white', false);
    if (whiteOn) toggleWhite();
    beginPass();
    let map = null;
    try {
      map = await photocal.runStructured();
    } catch (e) {
      map = null;
      console.warn('[calibrate] structured light failed:', e);
    }
    endPass();
    if (stale(g)) return;
    geoResult = map;
    const card = bodyEl.querySelector('.calib-card');
    if (map && map.coverage > 0.05) {
      const pct = (map.coverage * 100).toFixed(0);
      const c = map.contrast;
      card.innerHTML = `<div class="calib-ok">Screen measured</div>
        <div>${pct}% of the display was seen directly; the rest was filled in from
             its neighbours, which is sound because a physical surface is smooth.</div>
        <div class="calib-sub">pattern response: median ${(c.p50 * 100).toFixed(1)}%,
             strongest ${(c.max * 100).toFixed(1)}%</div>`;
      setActions([
        { act: 'next', label: 'Next: photometric', primary: true },
        { act: 'measure', label: 'Measure again' },
        { act: 'corners', label: 'Use corners instead' },
        { act: 'cancel', label: 'Cancel' },
      ]);
    } else {
      const c = map?.contrast;
      const detail = c
        ? `Strongest response was ${(c.max * 100).toFixed(1)}% and the median pixel
           ${(c.p50 * 100).toFixed(1)}%, against a ${(c.threshold * 100).toFixed(0)}% threshold.`
        : '';
      const why = !c ? ''
        : c.max < c.threshold
          ? 'The camera barely saw the patterns at all — the screen is probably out of frame, or room light is swamping the projector. Try the white field button: if white and black look similar on the wall, no software can separate them.'
          : 'The camera saw the patterns but could not decode them, which usually means the latency estimate is wrong. Run Calibrate everything, which measures latency first.';
      card.innerHTML = `<div class="calib-warn">Could not read the patterns.</div>
        <div>${detail}</div><div>${why}</div>`;
      setActions([
        { act: 'measure', label: 'Try again', primary: true },
        { act: 'corners', label: 'Use corners instead' },
        { act: 'cancel', label: 'Cancel' },
      ]);
    }
  }

  let armResolve = null;
  function armed(g) {
    return new Promise((resolve) => {
      armResolve = (ok) => { armResolve = null; resolve(ok && !stale(g)); };
    });
  }
  function fireStart() { if (armResolve) armResolve(true); }
  function cancelArm() { if (armResolve) armResolve(false); }

  function countdown(seconds, g) {
    const el = bodyEl.querySelector('.calib-count');
    return new Promise((resolve) => {
      let n = seconds;
      const tick = () => {
        if (stale(g)) return resolve(false);
        if (n <= 0) { if (el) el.textContent = ''; return resolve(true); }
        if (el) el.textContent = `starting in ${n}…`;
        n--;
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '?');
  const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '?');

  // A photo whose corners no longer match is a map of a different patch of
  // wall per cell; it has to be redone, and the operator should know why.
  function photoStale() {
    const p = photocal.photo;
    return !!p && p.meta?.quadHash !== JSON.stringify(calib.quad);
  }

  // ---- step 1: corners ----------------------------------------------------------

  function renderCorners() {
    bodyEl.innerHTML = `
      <p>Drag the four handles onto the corners of the display, as the camera sees it.
         The inset shows what the detector will actually use.</p>
      <p><strong>Framing decides detection quality.</strong> In the inset, a person
         standing at the display should fill a good part of the frame. If they come
         out small, or cut off at an edge, pull the handles in tighter around where
         people actually stand &mdash; even if that crops the display.</p>
      ${photoStale() ? '<p class="calib-warn">Corners have moved since the photometric calibration — step 2 must be run again.</p>' : ''}
      <p class="hint">Tip: if your silhouette comes out too large, drag the corners
         wider than the display — you stand nearer the camera than the screen does.</p>`;
    setActions([
      { act: 'next', label: 'Next: photometric', primary: true },
      { act: 'reset', label: 'Reset corners' },
      ...(photocal.photo && !photoStale() ? [{ act: 'save', label: 'Save & run' }] : []),
      { act: 'cancel', label: 'Cancel' },
    ]);
  }

  // ---- step 2: latency → photometric → registration -------------------------------

  async function runPhotometricStep(g) {
    bodyEl.innerHTML = `
      <p class="calib-big">Step out of frame, then press Start.</p>
      <p>Latency, photometric patches and a registration grid — about 25 s. Nothing
         may stand between the camera and the display while it runs, so take your
         time getting clear; it will not begin until you say so. The panel hides
         itself during the measurement.</p>
      <div class="calib-count"></div>
      <div class="calib-progress"><div class="bar"></div></div>
      <div class="calib-phase"></div>
      <div class="calib-card"></div>`;
    setActions([
      { act: 'back', label: 'Back' },
      { act: 'start', label: 'Start measuring', primary: true },
      ...(photocal.photo && !photoStale() ? [{ act: 'skip', label: 'Skip' }] : []),
      { act: 'next', label: 'Next: loop check', disabled: true },
      { act: 'cancel', label: 'Cancel' },
    ]);
    if (!await armed(g)) return;
    enable('start', false);
    enable('back', false);
    if (!await countdown(3, g)) return;

    root.classList.add('dark');
    let lat = null, photo = null, reg = null;
    try {
      lat = await photocal.runLatency();
      if (stale(g) || !lat) return;
      photo = await photocal.runPhotometric();
      if (stale(g) || !photo) return;
      reg = await photocal.runRegistration();
      if (stale(g)) return;
    } catch (e) {
      if (stale(g)) return;
      root.classList.remove('dark');
      bodyEl.querySelector('.calib-card').innerHTML = `<p class="calib-warn">Calibration failed: ${e.message}</p>`;
      return;
    } finally {
      if (!stale(g)) root.classList.remove('dark');
    }
    results.latency = lat;
    results.registration = reg;
    api.onPhoto?.(photo);
    renderPhotoCard(lat, photo, reg);
    enable('next');
  }

  function renderPhotoCard(lat, photo, reg) {
    const st = photo.stats;
    const warns = [];
    if (lat.confidence < 0.5) warns.push('Weak latency peak — is the whole display inside the corners, and lit?');
    if (lat.widthMs > 60) warns.push(`Latency peak is ${fmt(lat.widthMs)} ms wide: the pipeline jitters; the lag window will have to cover it.`);
    if (st.observableFrac < 0.8) warns.push('Much of the display is unobservable — the camera reads too little white-minus-black. Check exposure and the corners.');
    if (reg && reg.found === 0) warns.push('Registration grid not found — mirror setting or corners are wrong.');
    if (!photo.stored) warns.push('Calibration could not be stored (IndexedDB unavailable) — it will not survive a reload.');

    const erodeRow = reg && reg.found > 0
      ? `max residual ${fmt(reg.maxResidualCells, 2)} cells (${reg.found}/${reg.sites} lines) → erode ${reg.suggestedErode}
         · current ${settings.predErode}
         ${reg.suggestedErode !== settings.predErode ? '<button data-act="erode">apply</button>' : ''}`
      : 'no lines found';

    bodyEl.querySelector('.calib-card').innerHTML = `
      <dl>
        <dt>lag</dt><dd>${fmt(lat.lagMs)} ms · confidence ${fmt(lat.confidence, 2)} · width ${fmt(lat.widthMs)} ms</dd>
        <dt>dark</dt><dd>D median ${fmt(st.dMedian, 1)} codes · σ median ${fmt(st.sigmaMedian, 2)}</dd>
        <dt>range</dt><dd>W−D median ${fmt(st.rangeMedian, 1)} codes · observable ${pct(st.observableFrac, 0)}</dd>
        <dt>frames</dt><dd>${st.added} accumulated${photo.stored ? ' · stored' : ''}</dd>
        <dt>registration</dt><dd class="calib-erode">${erodeRow}</dd>
      </dl>
      ${warns.map(w => `<p class="calib-warn">${w}</p>`).join('')}`;
  }

  function applyErode() {
    const reg = results.registration;
    if (!reg || !(reg.suggestedErode > 0)) return;
    settings.predErode = reg.suggestedErode;
    save();
    const el = bodyEl.querySelector('.calib-erode');
    if (el) el.innerHTML = `max residual ${fmt(reg.maxResidualCells, 2)} cells → erode ${reg.suggestedErode} · applied`;
  }

  // ---- step 3: loop check --------------------------------------------------------

  async function runLoopStep(g) {
    if (!photocal.photo) {
      bodyEl.innerHTML = '<p class="calib-warn">No photometric calibration yet — run step 2 first.</p>';
      setActions([{ act: 'back', label: 'Back' }, { act: 'cancel', label: 'Cancel' }]);
      return;
    }
    bodyEl.innerHTML = `
      <p class="calib-big">Nobody in front of the display.</p>
      <p>For 5 s the piece draws an aggressive synthetic figure — contour, bloom,
         20 000 particles — and the detector must not see it. This is the proof that
         the piece cannot feed back on itself on this rig.</p>
      <div class="calib-count"></div>
      <div class="calib-progress"><div class="bar"></div></div>
      <div class="calib-phase"></div>
      <div class="calib-card"></div>`;
    setActions([
      { act: 'back', label: 'Back' },
      { act: 'start', label: 'Start loop check', primary: true },
      { act: 'retry', label: 'Retry', disabled: true },
      { act: 'next', label: 'Next: stand-in', disabled: true },
      { act: 'save', label: 'Save & run', primary: true, disabled: true },
      { act: 'cancel', label: 'Cancel' },
    ]);
    if (!await armed(g)) return;
    enable('start', false);
    enable('back', false);
    if (!await countdown(3, g)) return;

    root.classList.add('dark');
    let res = null;
    try {
      res = await photocal.runLoopCheck({ seconds: 5 });
    } catch (e) {
      if (stale(g)) return;
      bodyEl.querySelector('.calib-card').innerHTML = `<p class="calib-warn">Loop check failed: ${e.message}</p>`;
      enable('retry');
      return;
    } finally {
      if (!stale(g)) root.classList.remove('dark');
    }
    if (stale(g) || !res) return;
    results.loop = res;
    renderLoopCard(res);
    enable('retry'); enable('next'); enable('save');
  }

  function renderLoopCard(res) {
    const hints = res.pass ? '' : `
      <p>Press <b>I</b> after saving and look at the ratio panel while the figure is drawn:</p>
      <ul class="calib-hints">
        <li><b>Horizontal stripes</b> — projector or rolling-shutter bands. Raise <i>gainBands</i>.</li>
        <li><b>A thin line hugging the contour</b> — the prediction is dimmer or narrower than
            what reaches the wall. Raise <i>contentTrust</i> or <i>predErode</i>; check the lag width.</li>
        <li><b>The whole figure</b> — the map is off: recheck the corners and redo step 2.</li>
      </ul>`;
    bodyEl.querySelector('.calib-card').innerHTML = `
      <div class="calib-verdict ${res.pass ? 'pass' : 'fail'}">${res.pass ? 'PASS' : 'FAIL'}</div>
      <div class="calib-peak">peak coverage ${pct(res.peak, 2)} · mean ${pct(res.mean, 2)}
        · ${res.samples} frames${res.lagStarved ? ` · ${res.lagStarved} lag-starved` : ''}</div>
      ${hints}`;
  }

  // ---- step 4: stand-in -----------------------------------------------------------

  async function runStandInStep(g) {
    if (!photocal.photo) {
      bodyEl.innerHTML = '<p class="calib-warn">No photometric calibration yet — run step 2 first.</p>';
      setActions([{ act: 'back', label: 'Back' }, { act: 'cancel', label: 'Cancel' }]);
      return;
    }
    bodyEl.innerHTML = `
      <p class="calib-big">Stand in front of the display.</p>
      <p>6 s on the empty void floor. Wear the lightest top you expect on a
         visitor — the thresholds have to catch that one; a dark top is the easy case.</p>
      <div class="calib-count"></div>
      <div class="calib-progress"><div class="bar"></div></div>
      <div class="calib-phase"></div>
      <div class="calib-card"></div>`;
    setActions([
      { act: 'back', label: 'Back' },
      { act: 'start', label: 'Start measuring', primary: true },
      { act: 'retry', label: 'Retry', disabled: true },
      { act: 'apply', label: 'Apply', disabled: true },
      { act: 'save', label: 'Save & run', primary: true },
      { act: 'cancel', label: 'Cancel' },
    ]);
    if (!await armed(g)) return;
    enable('start', false);
    if (!await countdown(3, g)) return;

    // Dimmed rather than hidden: the operator is in frame and needs to see the
    // bar, and what little the panel emits is brighter than predicted, which
    // the ratio report ignores by construction.
    root.classList.add('dim');
    let res = null;
    try {
      res = await photocal.runStandIn({ seconds: 6 });
    } catch (e) {
      if (stale(g)) return;
      bodyEl.querySelector('.calib-card').innerHTML = `<p class="calib-warn">Stand-in failed: ${e.message}</p>`;
      enable('retry');
      return;
    } finally {
      if (!stale(g)) root.classList.remove('dim');
    }
    if (stale(g) || !res) return;
    results.standIn = res;
    renderStandInCard(res);
    enable('retry');
    if (res.suggested) enable('apply');
  }

  function renderStandInCard(res) {
    const { body, shadow, suggested } = res;
    const sug = suggested
      ? `void floor ${suggested.voidFloor}% · τ<sub>low</sub> ${fmt(suggested.tauLow, 2)} · τ<sub>high</sub> ${fmt(suggested.tauHigh, 2)}
         <span class="muted">(now ${settings.voidFloor}% · ${fmt(settings.tauLow, 2)} · ${fmt(settings.tauHigh, 2)})</span>`
      : 'nobody detected — stand closer, or the map is off';
    bodyEl.querySelector('.calib-card').innerHTML = `
      <dl>
        <dt>body</dt><dd>ratio p25 ${fmt(body.p25, 2)} · p50 ${fmt(body.p50, 2)} · p75 ${fmt(body.p75, 2)}
          <span class="muted">(${body.count} samples)</span></dd>
        <dt>shadow</dt><dd>${shadow.count ? `ratio p50 ${fmt(shadow.p50, 2)}` : 'none seen'}
          <span class="muted">(${shadow.count} samples)</span></dd>
        <dt>coverage</dt><dd>${pct(res.coverageMean)} mean</dd>
        <dt>suggested</dt><dd class="calib-suggest">${sug}</dd>
      </dl>
      ${suggested && body.p75 > 0.85 ? '<p class="calib-warn">A light top reads close to the wall (p75 > 0.85). A higher void floor gives the camera more to lose.</p>' : ''}`;
  }

  function applyStandIn() {
    const s = results.standIn?.suggested;
    if (!s) return;
    settings.voidFloor = s.voidFloor;
    settings.tauLow = s.tauLow;
    settings.tauHigh = s.tauHigh;
    save();
    const el = bodyEl.querySelector('.calib-suggest');
    if (el) el.innerHTML = `void floor ${s.voidFloor}% · τ<sub>low</sub> ${fmt(s.tauLow, 2)} · τ<sub>high</sub> ${fmt(s.tauHigh, 2)} · applied`;
    enable('apply', false);
  }

  // ---- corner canvas (step 1) ------------------------------------------------------

  // Canvas px -> frame-normalised, undoing the contain-fit letterbox.
  function toFrame(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const px = (clientX - r.left) * (canvas.width / r.width);
    const py = (clientY - r.top) * (canvas.height / r.height);
    return [(px - fit.x) / fit.w, (py - fit.y) / fit.h];
  }

  canvas.addEventListener('pointerdown', (e) => {
    const [u, v] = toFrame(e.clientX, e.clientY);
    dragging = calib.nearestCorner(u, v, HIT);
    if (dragging >= 0) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging < 0) return;
    const [u, v] = toFrame(e.clientX, e.clientY);
    calib.setCorner(dragging, u, v);
  });
  const release = () => { dragging = -1; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  function open(startStep = 1) {
    active = true;
    root.hidden = false;
    document.body.classList.add('calibrating');
    showStep(startStep);
    // A stored calibration decides whether Skip / Save & run are offered.
    if (!photocal.photo) {
      const g = gen;
      photocal.loadStored().then(p => { if (p && !stale(g) && step === 1) renderCorners(); });
    }
  }

  function close() {
    if (!active) return;
    gen++;
    if (photocal.active) photocal.cancel();
    active = false;
    root.hidden = true;
    root.classList.remove('run', 'dark', 'dim');
    document.body.classList.remove('calibrating');
    api.onExit?.();
  }

  // Every other frame: a full 2×2-supersampled grid is ~half a million
  // projections, and the camera only delivers 30 a second anyway.
  function updateInset() {
    if (insetTick++ & 1) return;
    if (!warp.sampleGrid(camera, calib.H, settings.mirror, obs)) return;
    const d = insetImg.data;
    for (let i = 0, p = 0, q = 0; i < gw * gh; i++, p += 4, q += 3) {
      d[p] = obs[q]; d[p + 1] = obs[q + 1]; d[p + 2] = obs[q + 2]; d[p + 3] = 255;
    }
    ictx.putImageData(insetImg, 0, 0);
  }

  // displayAspect is accepted for main.js's sake; the inset is the detector's
  // grid, whose aspect is fixed by the capture size.
  function draw(displayAspect) {
    if (!active || step !== 1) return;
    // The white field and the pattern passes both own the screen while they are
    // up; redrawing over either would defeat the point.
    if (whiteOn || passRunning) return;
    const w = window.innerWidth, h = window.innerHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    ctx.fillStyle = '#05080b';
    ctx.fillRect(0, 0, w, h);

    const vw = camera.video.videoWidth, vh = camera.video.videoHeight;
    if (!vw || !vh) return;

    // Contain-fit so nothing is cropped out of reach of a handle.
    const s = Math.min(w / vw, h / vh);
    fit = { w: vw * s, h: vh * s, x: (w - vw * s) / 2, y: (h - vh * s) / 2 };
    ctx.drawImage(camera.video, fit.x, fit.y, fit.w, fit.h);

    // Structured light needs no quad, so the preview stays clean: this view
    // exists to aim the camera, and handles over it only invite dragging them.
    if (!manualCorners) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(fit.x, fit.y + fit.h - 34, fit.w, 34);
      ctx.fillStyle = 'rgba(159,232,255,0.9)';
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('live camera — aim so the screen fills as much of this as possible',
                   fit.x + fit.w / 2, fit.y + fit.h - 17);
      return;
    }

    // Dim outside the quad so the marked region reads clearly.
    const q = calib.quad.map(([u, v]) => [fit.x + u * fit.w, fit.y + v * fit.h]);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(q[0][0], q[0][1]);
    for (let i = 3; i >= 1; i--) ctx.lineTo(q[i][0], q[i][1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(q[0][0], q[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]);
    ctx.closePath();
    ctx.strokeStyle = '#4fc9ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Thirds inside the quad — a straight-looking grid means the keystone fit.
    ctx.strokeStyle = 'rgba(79,201,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 1; k <= 2; k++) {
      const t = k / 3;
      const a = lerp(q[0], q[1], t), b = lerp(q[3], q[2], t);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      const c = lerp(q[0], q[3], t), d = lerp(q[1], q[2], t);
      ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
    }
    ctx.stroke();

    q.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, dragging === i ? 13 : 9, 0, Math.PI * 2);
      ctx.fillStyle = dragging === i ? '#9fe8ff' : 'rgba(79,201,255,0.85)';
      ctx.fill();
      ctx.fillStyle = '#05080b';
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y);
      ctx.fillStyle = 'rgba(159,232,255,0.8)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(LABELS[i], x, y + 16);
    });

    // Live warped preview: exactly what the detector will be handed.
    updateInset();
    const pw = Math.min(360, w * 0.28), ph = pw * gh / gw;
    const px = w - pw - 24, py = h - ph - 24;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(inset, px, py, pw, ph);
    ctx.strokeStyle = 'rgba(79,201,255,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, pw, ph);
    ctx.fillStyle = 'rgba(159,232,255,0.85)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('what the detector sees', px, py - 6);
    ctx.restore();
  }

  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  return api;
}
