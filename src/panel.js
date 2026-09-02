import { settings, save, reset } from './config.js';

// Hidden until you press D. Exists because a room's lighting is never what
// you tuned for — being able to see the raw mask and the flow vectors turns
// "it looks wrong" into "the threshold is 0.1 too high".

const SLIDERS = [
  ['— particles —'],
  ['particles',     1000, 40000, 500,   'count'],
  ['push',          0,    100,   1,     'push strength'],
  ['outlinePull',   0,    3,     0.05,  'body sweeps out'],
  ['returnForce',   0,    0.05,  0.001, 'return to rest'],
  ['damping',       0.70, 0.99,  0.005, 'damping'],
  ['maxSpeed',      0.002, 0.10, 0.002, 'speed limit'],
  ['drift',         0,    1,     0.01,  'idle drift'],
  ['particleSize',  0.5,  5,     0.1,   'dot size'],
  ['particleAlpha', 0.05, 1,     0.01,  'dot brightness'],
  ['particleHue',   0,    360,   1,     'dot hue'],
  ['particleSpread', 0,   360,   5,     'rainbow spread'],
  ['particleCycle', 0,    6,     0.1,   'rainbow speed'],
  ['— silhouette —'],
  ['maskSmooth',    0,    0.95,  0.01,  'edge steadiness'],
  ['rimWidth',      0.2,  4,     0.05,  'outline width'],
  ['rimGain',       0.5,  5,     0.1,   'outline brightness'],
  ['influence',     0,    8,     0.5,   'push halo'],
  ['outlineHue',    0,    360,   1,     'outline hue'],
  ['— occlusion —'],
  ['voidFloor',     0,    12,    0.5,   'void floor %'],
  ['tauLow',        0.1,  0.6,   0.01,  'seed below'],
  ['tauHigh',       0.3,  0.9,   0.01,  'candidate below'],
  ['noiseK',        1,    6,     0.1,   'noise gate'],
  ['growIters',     0,    20,    1,     'body grow steps'],
  ['tauGrow',       0.8,  1.05,  0.01,  'grow below'],
  ['contentTrust',  0.3,  1,     0.05,  'content trust'],
  ['predErode',     0,    3,     1,     'predict erode'],
  ['regTol',        0,    5,     0.25,  'misregistration'],
  ['lagWindowMs',   0,    60,    1,     'lag window ms'],
  ['lagMs',         0,    400,   1,     'lag ms'],
  ['openR',         0,    2,     1,     'open (kills fingers!)'],
  ['closeR',        0,    2,     1,     'close'],
  ['holeMaxFrac',   0,    0.05,  0.001, 'hole fill max'],
  ['gainBands',     1,    12,    1,     'gain bands'],
  ['camGamma',      1.6,  2.6,   0.05,  'camera gamma'],
  ['camPedestal',   0,    40,    1,     'camera pedestal'],
  ['maskMaxCoverage', 0.05, 1,   0.01,  'max body size'],
  ['— presence —'],
  ['presenceEnter', 0.002, 0.15,  0.001, 'arrive above'],
  ['presenceExit',  0.001, 0.10,  0.001, 'leave below'],
  ['presenceHold',  0,     10000, 250,   'idle after (ms)'],
  ['— motion —'],
  ['flowSmooth',    0,    0.95,  0.01,  'push weight'],
  ['flowGain',      0.1,  6,     0.1,   'motion gain'],
  ['flowScale',     0,    8,     1,     'swipe range'],
  ['flowBlur',      0,    5,     1,     'flow smoothing'],
  ['motionSmooth',  0,    0.9,   0.01,  'motion lag'],
  ['— look —'],
  ['glow',          0,    2,     0.05,  'glow'],
  ['renderScale',   0.25, 2.5,   0.05,  'render detail'],
];

const TOGGLES = [
  ['mirror',         'mirror image'],
  ['brightField',    'bright field (white)'],
  ['temporalMedian', 'temporal median'],
  ['fillHoles',      'fill enclosed holes'],
  ['showMask',       'show raw mask'],
  ['showFlow',       'show flow vectors'],
  ['showDiag',       'show diagnostics'],
  ['sim',            'simulated figure'],
];

export function createPanel(hooks) {
  const el = document.createElement('div');
  el.id = 'panel';
  el.hidden = true;

  const status = document.createElement('div');
  status.className = 'status';
  el.appendChild(status);

  const camRow = document.createElement('div');
  camRow.className = 'row';
  const camLabel = document.createElement('label');
  camLabel.textContent = 'camera';
  const camSelect = document.createElement('select');
  camSelect.addEventListener('change', () => hooks.onCamera(camSelect.value));
  camRow.append(camLabel, camSelect);
  el.appendChild(camRow);

  // Particle colour is a choice, not a magnitude, so it gets a picker rather
  // than a slider that would land on meaningless in-between values.
  const colRow = document.createElement('div');
  colRow.className = 'row';
  const colLabel = document.createElement('label');
  colLabel.textContent = 'particles';
  const colSelect = document.createElement('select');
  for (const [v, label] of [['single', 'single hue'], ['rainbow', 'rainbow'], ['shift', 'rainbow shifting']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    colSelect.appendChild(o);
  }
  colSelect.value = settings.particleColour;
  colSelect.addEventListener('change', () => { settings.particleColour = colSelect.value; save(); });
  colRow.append(colLabel, colSelect);
  el.appendChild(colRow);

  for (const spec of SLIDERS) {
    if (spec.length === 1) {
      const h = document.createElement('div');
      h.className = 'head';
      h.textContent = spec[0];
      el.appendChild(h);
      continue;
    }
    const [key, min, max, step, label] = spec;
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = settings[key];
    const out = document.createElement('span');
    out.className = 'val';
    out.textContent = fmt(settings[key]);
    input.addEventListener('input', () => {
      const v = key === 'particles' ? Math.round(+input.value) : +input.value;
      settings[key] = v;
      out.textContent = fmt(v);
      if (key === 'particles') hooks.onParticleCount(v);
      save();
    });
    row.append(lab, input, out);
    el.appendChild(row);
    spec.push(input, out);
  }

  const togWrap = document.createElement('div');
  togWrap.className = 'toggles';
  for (const [key, label] of TOGGLES) {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('on', !!settings[key]);
    b.addEventListener('click', () => {
      settings[key] = !settings[key];
      b.classList.toggle('on', settings[key]);
      save();
      hooks.onToggle?.(key, settings[key]);
    });
    togWrap.appendChild(b);
    TOGGLES_BTN.set(key, b);
  }
  el.appendChild(togWrap);

  const actions = document.createElement('div');
  actions.className = 'toggles';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'reset all';
  resetBtn.addEventListener('click', () => {
    reset();
    for (const spec of SLIDERS) {
      if (spec.length === 1) continue;
      const [key, , , , , input, out] = spec;
      input.value = settings[key];
      out.textContent = fmt(settings[key]);
    }
    for (const [key, b] of TOGGLES_BTN) b.classList.toggle('on', !!settings[key]);
    hooks.onParticleCount(settings.particles);
  });
  const fsBtn = document.createElement('button');
  fsBtn.textContent = 'fullscreen';
  fsBtn.addEventListener('click', () => hooks.onFullscreen());
  const calBtn = document.createElement('button');
  calBtn.textContent = 'calibrate';
  calBtn.addEventListener('click', () => hooks.onCalibrate());
  const photoBtn = document.createElement('button');
  photoBtn.textContent = 're-photometric';
  photoBtn.addEventListener('click', () => hooks.onPhotometric?.());
  const darkBtn = document.createElement('button');
  darkBtn.textContent = 're-dark';
  darkBtn.addEventListener('click', () => hooks.onDarkFrame?.());
  actions.append(calBtn, photoBtn, darkBtn, resetBtn, fsBtn);
  el.appendChild(actions);

  const help = document.createElement('div');
  help.className = 'help';
  help.textContent = 'D panel · C calibrate · P photometric · I diagnostics · M mask · V flow · F fullscreen · S sim · R reset';
  el.appendChild(help);

  document.body.appendChild(el);

  function setDevices(devices, current) {
    camSelect.innerHTML = '';
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `camera ${i + 1}`;
      camSelect.appendChild(o);
    });
    if (current) camSelect.value = current;
  }

  function setStatus(text, bad) {
    status.textContent = text;
    status.classList.toggle('bad', !!bad);
  }

  function syncToggle(key) {
    TOGGLES_BTN.get(key)?.classList.toggle('on', !!settings[key]);
  }

  return {
    el,
    setDevices,
    setStatus,
    syncToggle,
    toggle() { el.hidden = !el.hidden; },
    get visible() { return !el.hidden; },
  };
}

const TOGGLES_BTN = new Map();
const fmt = v => (Number.isInteger(v) ? v : (+v).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
