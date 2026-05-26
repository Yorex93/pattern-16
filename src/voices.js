// Pattern-16 voice library. Each trigger function builds a short-lived graph
// of nodes that ends at `dest` (a gain already scaled by row volume × velocity
// and fanned to dry / reverb / delay sends). All envelopes are self-terminating.
//
// Common signature: trigger(ctx, time, velocity, dest, opts)
//   opts = { note?, fromPitch?, filter?, chord?, tunable? }
//   - note: MIDI int on pitched voices
//   - fromPitch: MIDI int. Present when glide should slide from this pitch
//     to `note` over ~30ms. Pitched voices honor this; non-pitched ignore.
//   - filter: { cutoff:0-1, resonance:0-1 } for filtered voices
//   - chord: chord-type string ('major'|'minor'|'sus4'|'m7'|'maj7')
//   - tunable: 'low'|'mid'|'high' for conga

const GLIDE_TIME = 0.030;

export function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function whiteNoise(ctx, dur) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

// ---------------- Drums ----------------

function triggerKick(ctx, time, velocity, dest) {
  const loud = velocity === 2, soft = velocity === 0;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(loud ? 175 : (soft ? 140 : 155), time);
  osc.frequency.exponentialRampToValueAtTime(loud ? 40 : (soft ? 48 : 42), time + (loud ? 0.07 : 0.08));
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(1.0, time + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + (loud ? 0.5 : soft ? 0.38 : 0.45));
  osc.connect(gain).connect(dest);
  osc.start(time); osc.stop(time + 0.55);

  const click = whiteNoise(ctx, 0.012);
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(loud ? 0.55 : (soft ? 0.18 : 0.35), time);
  cg.gain.exponentialRampToValueAtTime(0.001, time + 0.012);
  const cf = ctx.createBiquadFilter();
  cf.type = 'highpass'; cf.frequency.value = 800;
  click.connect(cf).connect(cg).connect(dest);
  click.start(time); click.stop(time + 0.02);
}

function triggerSnare(ctx, time, velocity, dest) {
  const n = whiteNoise(ctx, 0.25);
  const ng = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 1200;
  ng.gain.setValueAtTime(0.7, time);
  ng.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
  n.connect(hp).connect(ng).connect(dest);
  n.start(time); n.stop(time + 0.2);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(220, time);
  osc.frequency.exponentialRampToValueAtTime(140, time + 0.08);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.55, time);
  og.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
  osc.connect(og).connect(dest);
  osc.start(time); osc.stop(time + 0.13);
}

// Rim/sidestick: tight noise burst, narrow bandpass ~2 kHz, very short.
function triggerRim(ctx, time, velocity, dest) {
  const n = whiteNoise(ctx, 0.06);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 2000; bp.Q.value = 6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.85, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
  n.connect(bp).connect(g).connect(dest);
  n.start(time); n.stop(time + 0.06);

  // Tiny wood-tap thump for body
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 800;
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.25, time);
  og.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
  osc.connect(og).connect(dest);
  osc.start(time); osc.stop(time + 0.025);
}

function triggerClap(ctx, time, velocity, dest) {
  const offsets = [0, 0.012, 0.024, 0.04];
  offsets.forEach((off, i) => {
    const n = whiteNoise(ctx, 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.2;
    const g = ctx.createGain();
    const amp = i === offsets.length - 1 ? 0.55 : 0.32;
    g.gain.setValueAtTime(amp, time + off);
    g.gain.exponentialRampToValueAtTime(0.001, time + off + (i === offsets.length - 1 ? 0.18 : 0.04));
    n.connect(bp).connect(g).connect(dest);
    n.start(time + off); n.stop(time + off + 0.2);
  });
}

function triggerTom(ctx, time, velocity, dest) {
  const loud = velocity === 2, soft = velocity === 0;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(loud ? 210 : (soft ? 160 : 180), time);
  osc.frequency.exponentialRampToValueAtTime(loud ? 85 : (soft ? 95 : 90), time + (loud ? 0.18 : 0.2));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(0.9, time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.35);
  osc.connect(g).connect(dest);
  osc.start(time); osc.stop(time + 0.4);

  const n = whiteNoise(ctx, 0.05);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 250; bp.Q.value = 2;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.2, time);
  ng.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
  n.connect(bp).connect(ng).connect(dest);
  n.start(time); n.stop(time + 0.05);
}

// ---------------- Cymbals ----------------

function triggerCHH(ctx, time, velocity, dest) {
  const n = whiteNoise(ctx, 0.06);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.45, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.045);
  n.connect(hp).connect(g).connect(dest);
  n.start(time); n.stop(time + 0.06);
}

function triggerOHH(ctx, time, velocity, dest) {
  const n = whiteNoise(ctx, 0.35);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 6500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.4, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
  n.connect(hp).connect(g).connect(dest);
  n.start(time); n.stop(time + 0.35);
}

// Ride: white-noise wash + inharmonic partials, slow tail (~400ms).
function triggerRide(ctx, time, velocity, dest) {
  // Wash
  const n = whiteNoise(ctx, 0.45);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 4500; bp.Q.value = 2;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, time);
  ng.gain.exponentialRampToValueAtTime(0.35, time + 0.005);
  ng.gain.exponentialRampToValueAtTime(0.001, time + 0.4);
  n.connect(bp).connect(ng).connect(dest);
  n.start(time); n.stop(time + 0.45);

  // Bell partials (inharmonic)
  const partials = [3050, 4120, 5320, 6210];
  for (const f of partials) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, time);
    og.gain.exponentialRampToValueAtTime(0.08, time + 0.004);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
    o.connect(og).connect(dest);
    o.start(time); o.stop(time + 0.35);
  }
}

// Shaker: HPed noise with a soft pitch-character envelope on the filter.
function triggerShaker(ctx, time, velocity, dest) {
  const n = whiteNoise(ctx, 0.08);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(6000, time);
  hp.frequency.linearRampToValueAtTime(8500, time + 0.03);
  hp.frequency.linearRampToValueAtTime(7000, time + 0.07);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.5, time + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
  n.connect(hp).connect(g).connect(dest);
  n.start(time); n.stop(time + 0.08);
}

// Tambourine: bandpass-resonant noise burst with two-stage envelope.
function triggerTambourine(ctx, time, velocity, dest) {
  const n = whiteNoise(ctx, 0.15);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 8200; bp.Q.value = 5;
  const g = ctx.createGain();
  // sharp attack, quick decay to a sustain shelf, short release
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.7, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.18, time + 0.04);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.13);
  n.connect(bp).connect(g).connect(dest);
  n.start(time); n.stop(time + 0.15);

  // High shimmer partial for the jingle
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = 9300;
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, time);
  og.gain.exponentialRampToValueAtTime(0.05, time + 0.003);
  og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
  o.connect(og).connect(dest);
  o.start(time); o.stop(time + 0.12);
}

// ---------------- Percussion ----------------

// Cowbell: two square oscillators at ~560 Hz and ~840 Hz, short decay, no noise.
function triggerCowbell(ctx, time, velocity, dest) {
  const freqs = [560, 840];
  for (const f of freqs) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, time);
    og.gain.linearRampToValueAtTime(0.18, time + 0.002);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    o.connect(og).connect(dest);
    o.start(time); o.stop(time + 0.2);
  }
}

// Conga: pitched sine, quick downward sweep. tunable low/mid/high.
function triggerConga(ctx, time, velocity, dest, opts = {}) {
  const baseFreq = opts.tunable === 'low' ? 180 : opts.tunable === 'high' ? 360 : 250;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(baseFreq * 1.5, time);
  osc.frequency.exponentialRampToValueAtTime(baseFreq, time + 0.03);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.85, time + 0.003);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
  osc.connect(g).connect(dest);
  osc.start(time); osc.stop(time + 0.22);
}

// Woodblock: short pitched click with prominent attack.
function triggerWoodblock(ctx, time, velocity, dest) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(1400, time);
  o.frequency.exponentialRampToValueAtTime(1200, time + 0.01);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 3;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.9, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
  o.connect(bp).connect(g).connect(dest);
  o.start(time); o.stop(time + 0.06);
}

// ---------------- Helpers for pitched voices ----------------

// Schedule frequency: if glide, ramp from fromPitch to target over GLIDE_TIME.
// Otherwise set immediately.
function setPitch(oscOrParam, time, targetMidi, fromMidi) {
  const target = midiToFreq(targetMidi);
  const param = oscOrParam.frequency ?? oscOrParam; // accepts osc or param directly
  if (fromMidi != null) {
    param.setValueAtTime(midiToFreq(fromMidi), time);
    param.exponentialRampToValueAtTime(target, time + GLIDE_TIME);
  } else {
    param.setValueAtTime(target, time);
  }
}

// Cubic soft-clip waveshaper for gentle saturation (~+6dB headroom).
function makeSaturation(ctx, amount = 0.6) {
  const ws = ctx.createWaveShaper();
  const N = 1024;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    const k = 1 + amount * 4;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  ws.curve = curve;
  return ws;
}

// ---------------- Bass ----------------

// 808: sine with a +12 → note pitch envelope (40ms) and gentle saturation.
// With glide, replace the +12 sweep with fromPitch → note (30ms).
function trigger808(ctx, time, velocity, dest, opts = {}) {
  const note = opts.note ?? 36;
  const from = opts.fromPitch;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  if (from != null) {
    osc.frequency.setValueAtTime(midiToFreq(from), time);
    osc.frequency.exponentialRampToValueAtTime(midiToFreq(note), time + GLIDE_TIME);
  } else {
    // Signature: start an octave above, glide down to note over 40ms
    osc.frequency.setValueAtTime(midiToFreq(note + 12), time);
    osc.frequency.exponentialRampToValueAtTime(midiToFreq(note), time + 0.04);
  }
  // Decay length scales gently with how low the note is (low notes ring longer)
  const decay = Math.min(2.0, 0.6 + (60 - note) * 0.03);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(0.95, time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  const sat = makeSaturation(ctx, 0.45);
  osc.connect(sat).connect(g).connect(dest);
  osc.start(time); osc.stop(time + decay + 0.05);
}

// Sub bass: pure sine, no pitch envelope, ~400ms decay.
function triggerSubBass(ctx, time, velocity, dest, opts = {}) {
  const note = opts.note ?? 36;
  const from = opts.fromPitch;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  setPitch(osc, time, note, from);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(1.0, time + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.42);
  osc.connect(g).connect(dest);
  osc.start(time); osc.stop(time + 0.45);
}

// Synth bass: saw through resonant lowpass with downward filter envelope.
function triggerSynthBass(ctx, time, velocity, dest, opts = {}) {
  const note = opts.note ?? 36;
  const from = opts.fromPitch;
  const filterParams = opts.filter ?? { cutoff: 0.5, resonance: 0.2 };
  const cutoff01 = filterParams.cutoff;
  const reso01 = filterParams.resonance;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  setPitch(osc, time, note, from);

  // Cutoff floor scales exponentially with the cutoff knob (~80Hz to ~4kHz),
  // and velocity opens the filter slightly so loud notes sound brighter.
  const baseHz = 80 * Math.pow(50, cutoff01);
  const velBoost = 1 + (velocity === 2 ? 0.6 : velocity === 0 ? -0.25 : 0);
  const peakHz = Math.min(8000, baseHz * 4 * velBoost);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1 + reso01 * 14;
  lp.frequency.setValueAtTime(peakHz, time);
  lp.frequency.exponentialRampToValueAtTime(Math.max(60, baseHz), time + 0.18);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.6, time + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.32);

  osc.connect(lp).connect(g).connect(dest);
  osc.start(time); osc.stop(time + 0.35);
}

// ---------------- Tonal ----------------

const CHORD_INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  sus4:  [0, 5, 7],
  m7:    [0, 3, 7, 10],
  maj7:  [0, 4, 7, 11],
};

// Chord stab: detuned saws per chord interval through lowpass, slight chorus.
function triggerChordStab(ctx, time, velocity, dest, opts = {}) {
  const root = opts.note ?? 48;
  const from = opts.fromPitch;
  const filterParams = opts.filter ?? { cutoff: 0.5, resonance: 0.2 };
  const intervals = CHORD_INTERVALS[opts.chord] ?? CHORD_INTERVALS.minor;
  const cutoff01 = filterParams.cutoff;
  const reso01 = filterParams.resonance;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 200 + 7000 * cutoff01 * (1 + (velocity === 2 ? 0.4 : velocity === 0 ? -0.2 : 0));
  lp.Q.value = 0.7 + reso01 * 8;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.45, time + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);

  lp.connect(g).connect(dest);

  // Two detuned oscs per chord note → chorusy character
  const detunes = [-6, +6];
  for (const interval of intervals) {
    for (const detuneCents of detunes) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = detuneCents;
      const noteMidi = root + interval;
      const fromMidi = from != null ? from + interval : null;
      setPitch(osc, time, noteMidi, fromMidi);
      const og = ctx.createGain();
      og.gain.value = 0.32 / intervals.length;
      osc.connect(og).connect(lp);
      osc.start(time); osc.stop(time + 0.26);
    }
  }
}

// Pluck: single saw through fast lowpass + fast amp envelope.
function triggerPluck(ctx, time, velocity, dest, opts = {}) {
  const note = opts.note ?? 48;
  const from = opts.fromPitch;
  const filterParams = opts.filter ?? { cutoff: 0.55, resonance: 0.1 };
  const cutoff01 = filterParams.cutoff;
  const reso01 = filterParams.resonance;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  setPitch(osc, time, note, from);

  const baseHz = 200 * Math.pow(40, cutoff01);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.8 + reso01 * 8;
  lp.frequency.setValueAtTime(Math.min(9000, baseHz * 5 * (velocity === 2 ? 1.3 : 1)), time);
  lp.frequency.exponentialRampToValueAtTime(Math.max(150, baseHz), time + 0.08);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.55, time + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);

  osc.connect(lp).connect(g).connect(dest);
  osc.start(time); osc.stop(time + 0.2);
}

// Vinyl crackle: brief noisy texture with random pops, ~150ms.
function triggerVinylCrackle(ctx, time, velocity, dest) {
  // Build a small buffer with sparse spikes for the pops
  const dur = 0.18;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    // hiss + occasional pops
    const hiss = (Math.random() * 2 - 1) * 0.15;
    const pop = Math.random() < 0.005 ? (Math.random() * 2 - 1) : 0;
    d[i] = hiss + pop;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 1200;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.4, time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, time + dur);
  src.connect(hp).connect(g).connect(dest);
  src.start(time); src.stop(time + dur + 0.02);
}

// Noise sweep: noise through a bandpass swept from low → high.
function triggerNoiseSweep(ctx, time, velocity, dest) {
  const dur = 0.7;
  const n = whiteNoise(ctx, dur);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 6;
  bp.frequency.setValueAtTime(300, time);
  bp.frequency.exponentialRampToValueAtTime(8000, time + dur * 0.9);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.5, time + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, time + dur);
  n.connect(bp).connect(g).connect(dest);
  n.start(time); n.stop(time + dur + 0.02);
}

// ---------------- Sample playback (overrides the assigned voice) ----------------

export function triggerSample(ctx, time, dest, buffer) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  src.start(time);
  src.stop(time + buffer.duration + 0.05);
}

// ---------------- Export voice map ----------------

export const VOICES = {
  kick: triggerKick,
  snare: triggerSnare,
  rim: triggerRim,
  clap: triggerClap,
  tom: triggerTom,
  chh: triggerCHH,
  ohh: triggerOHH,
  ride: triggerRide,
  shaker: triggerShaker,
  tambourine: triggerTambourine,
  cowbell: triggerCowbell,
  conga: triggerConga,
  woodblock: triggerWoodblock,
  '808': trigger808,
  'sub-bass': triggerSubBass,
  'synth-bass': triggerSynthBass,
  'chord-stab': triggerChordStab,
  pluck: triggerPluck,
  'vinyl-crackle': triggerVinylCrackle,
  'noise-sweep': triggerNoiseSweep,
};
