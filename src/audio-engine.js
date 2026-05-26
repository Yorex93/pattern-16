// Pattern-16 audio engine — slot-indexed (0..7) routing, swing/velocity/probability
// scheduling, sample override per slot, reverb + delay sends, offline render.

import { VOICES, triggerSample } from './voices.js';
import { isContinuous } from './sounds.js';
import { SCALES, rootSemitone, chordRootMidi, DEFAULT_MELODY_KEY } from './scales.js';

// Compute the semitone offset that a follow-chord pitched slot should apply to
// every note it plays, given the bank's chord. Returns 0 when the bank has no
// chord (v4 compatibility) or when the slot doesn't follow.
function chordTransposeOffset(slot, bank) {
  if (!slot || !slot.followChord || !bank?.chord) return 0;
  const keyName = slot.melodyKey || DEFAULT_MELODY_KEY;
  const slotRoot = SCALES[keyName]?.root ?? 9;
  const bankRoot = rootSemitone(bank.chord.root);
  if (bankRoot == null) return 0;
  return bankRoot - slotRoot;
}

export const SLOT_COUNT = 8;
const SLOT_INDICES = Array.from({ length: SLOT_COUNT }, (_, i) => i);

const VEL_GAIN = [0.5, 0.85, 1.0]; // soft / med / loud
const DELAY_FRACTIONS = { '1/8': 0.5, '1/4': 1, '3/8': 1.5, '1/2': 2 };

// ----- IR + delay-time helpers -----
function makeIR(ctx, duration = 2.4, decay = 2.2) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * duration);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay);
      data[i] = (Math.random() * 2 - 1) * env * (i > rate * 0.02 ? 1 : 0.2);
    }
  }
  return buf;
}

function delaySeconds(bpm, frac) {
  const quarter = 60 / bpm;
  return quarter * (DELAY_FRACTIONS[frac] ?? 1.5);
}

// Build a "trigger destination". The persistent per-slot chain
//   velTrim → slotVol[i] → slotDrive[i] → slotDucker[i] → fan(bus + sends)
// is owned by the routing object. Each trigger only adds the per-trigger
// velocity-gain node; everything downstream is pre-built.
function makeDest(routing, slotIdx, velGain) {
  const trim = routing.ctx.createGain();
  trim.gain.value = velGain;
  trim.connect(routing.slotVol[slotIdx]);
  return trim;
}

// ---------- Mix-chain helpers (master GLUE) ----------
function makeSaturationCurve(amount) {
  // amount in 0..1. Higher = more harmonic content + soft clipping.
  const N = 4096;
  const curve = new Float32Array(N);
  const k = 1 + amount * 10;
  const norm = Math.tanh(k);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

// Apply a unified GLUE (0..1) across compressor + saturator. Limiter is always
// on regardless. Tasteful curve: 0 → near-bypass; 0.35 → mix "snap"; 0.7 →
// audible harmonics; 1 → distorted.
function applyGlue(routing, glue) {
  routing.glue = glue;
  const g = Math.max(0, Math.min(1, glue));
  // Compressor threshold: -3 dB (gentle) → -22 dB (heavy bus pump)
  if (routing.compressor) routing.compressor.threshold.value = -3 - g * 19;
  // Saturator drive scales nonlinearly so subtle settings stay clean
  if (routing.saturator) routing.saturator.curve = makeSaturationCurve(g * 0.55);
}

function setSlotDrive(routing, slotIdx, drive) {
  const shaper = routing.slotDrive[slotIdx];
  if (!shaper) return;
  // Per-slot drive curve. Pass-through at 0; up to mild crunch at 1.
  const N = 1024;
  const curve = new Float32Array(N);
  const k = 1 + Math.max(0, Math.min(1, drive)) * 6;
  const norm = Math.tanh(k);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  shaper.curve = curve;
}

function setSlotVolume(routing, slotIdx, vol) {
  const g = routing.slotVol[slotIdx];
  if (g) g.gain.value = vol;
}
function setSlotRevSend(routing, slotIdx, v) {
  const g = routing.slotRevSend[slotIdx];
  if (g) g.gain.value = v;
}
function setSlotDelSend(routing, slotIdx, v) {
  const g = routing.slotDelSend[slotIdx];
  if (g) g.gain.value = v;
}

// Schedule a sidechain duck event at `time` on the slot's ducker gain. amount
// is 0..1 (depth); ducker dives to (1-amount) at the trigger time and recovers
// linearly over `recoveryMs`.
function triggerDuck(routing, slotIdx, time, amount, recoveryMs = 150) {
  const d = routing.slotDucker[slotIdx];
  if (!d) return;
  const minGain = Math.max(0, 1 - amount);
  try { d.gain.cancelScheduledValues(time); } catch {}
  d.gain.setValueAtTime(1, Math.max(0, time - 0.0001));
  d.gain.linearRampToValueAtTime(minGain, time + 0.005);
  d.gain.linearRampToValueAtTime(1, time + recoveryMs / 1000);
}

// Compute per-step glide source pitches for a pitched slot, considering the
// "previous step on this slot was also active" rule (consecutive only, with
// wrap-around between bar boundaries).
function computeGlideSource(slot) {
  if (!slot.glide) return null;
  const pattern = slot.pattern;
  const out = new Array(16).fill(null);
  for (let i = 0; i < 16; i++) {
    if (!pattern[i].on) continue;
    const prev = pattern[(i - 1 + 16) % 16];
    if (prev.on) out[i] = prev.note ?? slot.defaultNote ?? 36;
  }
  return out;
}

function triggerSlot(routing, slotIdx, time, cell, slot, samples, barSec, bank) {
  if (slot.mute) return;
  const velocity = cell.velocity ?? 1;
  const velGain = VEL_GAIN[velocity] ?? 0.85;
  const dest = makeDest(routing, slotIdx, velGain);

  const buf = samples[slotIdx];
  if (buf) {
    triggerSample(routing.ctx, time, dest, buf);
    return;
  }
  const fn = VOICES[slot.sound];
  if (!fn) return;

  // v5 chord routing:
  //   - chord-stab plays the bank's chord (root + type), voiced in the C4
  //     octave. When the bank has no chord (v4 import path), fall back to the
  //     slot's legacy chordType + defaultNote.
  //   - Pitched slots with followChord=true transpose every note by
  //     (bankRoot - slotMelodyKeyRoot) semitones. chord-stab skips this
  //     because its pitch is fully determined by the bank chord.
  let note = cell.note ?? slot.defaultNote;
  let chord = slot.chordType;
  let fromPitch = cell.__fromPitch ?? null;
  if (slot.sound === 'chord-stab' && bank?.chord) {
    note = chordRootMidi(rootSemitone(bank.chord.root) ?? 0);
    chord = bank.chord.type;
    fromPitch = null; // bank chord change doesn't glide
  } else if (slot.followChord && bank?.chord && slot.sound !== 'chord-stab') {
    const offset = chordTransposeOffset(slot, bank);
    if (offset !== 0) {
      note = note + offset;
      if (fromPitch != null) fromPitch = fromPitch + offset;
    }
  }

  fn(routing.ctx, time, velocity, dest, {
    note,
    fromPitch,
    filter: slot.filter,
    chord,
    tunable: slot.tunable,
    lengthSec: cell.__lengthSec ?? null,
    barSec,
  });
}

function maybeTriggerBed(routing, slotIdx, time, slot, samples, barSec) {
  if (slot.mute) return;
  if (!slot.pattern.some(c => c.on)) return;
  const dest = makeDest(routing, slotIdx, 1);
  const buf = samples[slotIdx];
  if (buf) {
    triggerSample(routing.ctx, time, dest, buf);
    return;
  }
  const fn = VOICES[slot.sound];
  if (!fn) return;
  fn(routing.ctx, time, 1, dest, { barSec });
}

// ----- Routing builder (shared by live + offline) -----
// Topology:
//   per slot (i): velTrim → slotVol[i] → slotDrive[i] → slotDucker[i]
//                  → fan: slotBus[i] (dry), slotRevSend[i] → reverbIn,
//                         slotDelSend[i] → delayIn
//   slotBuses[*], reverbWet, delayWet → master → [glue chain] → destination
// Glue chain: compressor → saturator → limiter → destination
function buildRouting(ctx, opts) {
  const {
    reverbAmount = 0.25,
    delayFeedback = 0.35,
    delayTimeSec = 0.5,
    glue = 0.35,
    slotVolumes = {},
    slotDrives = {},
    slotRevSends = {},
    slotDelSends = {},
  } = opts;

  // ---- master GLUE chain ----
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -0.3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;
  limiter.connect(ctx.destination);

  const saturator = ctx.createWaveShaper();
  saturator.oversample = '4x';
  saturator.connect(limiter);

  const compressor = ctx.createDynamicsCompressor();
  compressor.ratio.value = 2;
  compressor.knee.value = 6;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.1;
  compressor.threshold.value = -8;
  compressor.connect(saturator);

  // Master sum node — all sources merge here pre-glue
  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(compressor);

  // ---- persistent per-slot chain ----
  const slotVol = {}, slotDrive = {}, slotDucker = {};
  const slotBuses = {}, slotRevSend = {}, slotDelSend = {};
  for (const i of SLOT_INDICES) {
    slotVol[i] = ctx.createGain();
    slotVol[i].gain.value = slotVolumes[i] ?? 0.85;

    slotDrive[i] = ctx.createWaveShaper();
    slotDrive[i].oversample = '2x';
    // initial curve set by setSlotDrive(routing, i, ...)

    slotDucker[i] = ctx.createGain();
    slotDucker[i].gain.value = 1;

    slotBuses[i] = ctx.createGain();
    slotBuses[i].gain.value = 1;
    slotBuses[i].connect(master);

    slotRevSend[i] = ctx.createGain();
    slotRevSend[i].gain.value = slotRevSends[i] ?? 0;

    slotDelSend[i] = ctx.createGain();
    slotDelSend[i].gain.value = slotDelSends[i] ?? 0;

    slotVol[i].connect(slotDrive[i]);
    slotDrive[i].connect(slotDucker[i]);
    slotDucker[i].connect(slotBuses[i]);
    slotDucker[i].connect(slotRevSend[i]);
    slotDucker[i].connect(slotDelSend[i]);
  }

  // ---- send returns into master ----
  const reverbIn = ctx.createGain(); reverbIn.gain.value = 1;
  const convolver = ctx.createConvolver();
  convolver.buffer = makeIR(ctx, 2.4, 2.2);
  const reverbWet = ctx.createGain(); reverbWet.gain.value = reverbAmount;
  reverbIn.connect(convolver).connect(reverbWet).connect(master);

  const delayIn = ctx.createGain(); delayIn.gain.value = 1;
  const delayNode = ctx.createDelay(2.0);
  delayNode.delayTime.value = delayTimeSec;
  const feedback = ctx.createGain(); feedback.gain.value = delayFeedback;
  const fbFilter = ctx.createBiquadFilter();
  fbFilter.type = 'lowpass'; fbFilter.frequency.value = 4500;
  const delayWet = ctx.createGain(); delayWet.gain.value = 0.85;
  delayIn.connect(delayNode);
  delayNode.connect(fbFilter).connect(feedback).connect(delayNode);
  delayNode.connect(delayWet).connect(master);

  for (const i of SLOT_INDICES) {
    slotRevSend[i].connect(reverbIn);
    slotDelSend[i].connect(delayIn);
  }

  const routing = {
    ctx, master, compressor, saturator, limiter,
    slotVol, slotDrive, slotDucker, slotBuses, slotRevSend, slotDelSend,
    reverbIn, reverbWet, convolver,
    delayIn, delayNode, delayWet, feedback, fbFilter,
    glue,
  };
  // Initialize curves
  applyGlue(routing, glue);
  for (const i of SLOT_INDICES) setSlotDrive(routing, i, slotDrives[i] ?? 0);
  return routing;
}

// Iterate slots of a bank for scheduling. Yields { slotIdx, slot, glideSource? }.
function* iterSlots(bank) {
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = bank.slots[i];
    if (!slot || !slot.sound) continue;
    const glideSource = slot.glide ? computeGlideSource(slot) : null;
    yield { slotIdx: i, slot, glideSource };
  }
}

// ============================================================
// Live engine
// ============================================================
class DrumEngine {
  constructor() {
    this.ctx = null;
    this.routing = null;
    this.bpm = 92;
    this.delayFeedback = 0.35;
    this.delayTime = '3/8';
    this.banks = [];
    this.chain = [0];
    this.samples = {};
    // Mix is global: glue knob + sidechain depth + per-slot target list (idx 0..7)
    this.mix = { glue: 0.35, sidechain: { amount: 0.5, targets: [] } };
    this.isPlaying = false;
    this.currentStep = 0;
    this.chainIdx = 0;
    this.nextNoteTime = 0;
    this.lookahead = 25;
    this.scheduleAhead = 0.1;
    this.timerID = null;
    this.queue = [];
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const slotVolumes = {}, slotDrives = {}, slotRevSends = {}, slotDelSends = {};
    const bank0 = this.banks[0];
    if (bank0) for (let i = 0; i < SLOT_COUNT; i++) {
      const s = bank0.slots[i] || {};
      slotVolumes[i] = s.volume ?? 0.85;
      slotDrives[i] = s.drive ?? 0;
      slotRevSends[i] = s.reverbSend ?? 0;
      slotDelSends[i] = s.delaySend ?? 0;
    }
    this.routing = buildRouting(this.ctx, {
      reverbAmount: bank0?.reverbAmount ?? 0.25,
      delayFeedback: this.delayFeedback,
      delayTimeSec: delaySeconds(this.bpm, this.delayTime),
      glue: this.mix.glue,
      slotVolumes, slotDrives, slotRevSends, slotDelSends,
    });
  }

  setBanks(banks) { this.banks = banks; this._syncBankParams(); this._syncSlotParams(); }
  setChain(chain) { this.chain = (chain && chain.length) ? chain : [0]; }
  setMix(mix) {
    if (!mix) return;
    this.mix = { ...this.mix, ...mix };
    if (this.routing) applyGlue(this.routing, this.mix.glue ?? 0.35);
  }
  setBPM(b) {
    this.bpm = b;
    if (this.routing) this.routing.delayNode.delayTime.value = delaySeconds(b, this.delayTime);
  }
  setDelayFeedback(v) {
    this.delayFeedback = v;
    if (this.routing) this.routing.feedback.gain.value = v;
  }
  setDelayTime(frac) {
    this.delayTime = frac;
    if (this.routing) this.routing.delayNode.delayTime.value = delaySeconds(this.bpm, frac);
  }
  setSample(slotIdx, buffer) { this.samples[slotIdx] = buffer || null; }

  _syncBankParams() {
    if (!this.routing) return;
    const b = this.getPlayingBank();
    if (b) this.routing.reverbWet.gain.value = b.reverbAmount;
  }

  // Push per-slot params (volume, drive, sends) of the playing bank into the
  // persistent slot chain. Called whenever banks change or bank switches.
  _syncSlotParams() {
    if (!this.routing) return;
    const b = this.getPlayingBank();
    if (!b) return;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = b.slots[i] || {};
      setSlotVolume(this.routing, i, s.volume ?? 0.85);
      setSlotDrive(this.routing, i, s.drive ?? 0);
      setSlotRevSend(this.routing, i, s.reverbSend ?? 0);
      setSlotDelSend(this.routing, i, s.delaySend ?? 0);
    }
  }

  getPlayingBankIndex() {
    if (!this.chain?.length) return 0;
    return this.chain[this.chainIdx % this.chain.length];
  }
  getPlayingBank() { return this.banks[this.getPlayingBankIndex()]; }

  play() {
    if (!this.ctx) this.init();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.isPlaying = true;
    this.currentStep = 0;
    this.chainIdx = 0;
    this.queue = [];
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this._scheduler();
  }
  stop() {
    this.isPlaying = false;
    if (this.timerID) clearTimeout(this.timerID);
    this.timerID = null;
    this.currentStep = 0;
    this.chainIdx = 0;
    this.queue = [];
  }

  _scheduler() {
    while (this.nextNoteTime < this.ctx.currentTime + this.scheduleAhead) {
      const bank = this.banks[this.chain[this.chainIdx % this.chain.length]];
      const swingPct = bank?.swing ?? 0;
      const sixteenth = (60.0 / this.bpm) / 4;
      const isOff = (this.currentStep % 2) === 1;
      const swingDelay = isOff ? (swingPct / 100) * 0.5 * sixteenth : 0;
      this._scheduleStep(this.currentStep, this.chainIdx, this.nextNoteTime, this.nextNoteTime + swingDelay, bank);
      this._advance();
    }
    this.timerID = setTimeout(() => this._scheduler(), this.lookahead);
  }

  _scheduleStep(step, chainIdx, baseTime, triggerTime, bank) {
    if (!bank) return;
    if (step === 0 && this.routing) {
      this.routing.reverbWet.gain.setTargetAtTime(bank.reverbAmount, baseTime, 0.01);
      this._syncSlotParams();
    }
    const barSec = (60 / this.bpm) * 4;
    const sixteenth = (60 / this.bpm) / 4;

    // First pass: detect kick hits to fire sidechain ducks at the same time
    const kickFiresThisStep = this._kickFiresAtStep(bank, step);
    if (kickFiresThisStep) {
      const amt = this.mix.sidechain?.amount ?? 0;
      const targets = this.mix.sidechain?.targets ?? [];
      if (amt > 0 && targets.length) {
        for (const t of targets) triggerDuck(this.routing, t, triggerTime, amt, 150);
      }
    }

    for (const { slotIdx, slot, glideSource } of iterSlots(bank)) {
      if (isContinuous(slot.sound)) {
        if (step === 0) maybeTriggerBed(this.routing, slotIdx, baseTime, slot, this.samples, barSec);
        continue;
      }
      // Melody-mode notes for pitched slots — scheduled at step 0 of each bar
      // because individual notes can span multiple steps.
      if (slot.melody && Array.isArray(slot.melody) && step === 0) {
        for (const n of slot.melody) {
          const p = n.probability ?? 100;
          if (p < 100 && Math.random() * 100 >= p) continue;
          const noteStep = (n.step | 0) - 1;
          if (noteStep < 0 || noteStep > 15) continue;
          const noteTime = baseTime + noteStep * sixteenth;
          // Clamp note length so the gate-off never crosses the bar boundary.
          // Multi-step sustain across bars/banks is a separate, harder problem.
          const requested = Math.max(1, (n.length | 0));
          const maxSteps = 16 - noteStep;
          const lengthSec = Math.min(requested, maxSteps) * sixteenth;
          const cell = {
            on: true,
            velocity: n.velocity ?? 1,
            probability: n.probability ?? 100,
            note: n.pitch ?? slot.defaultNote,
            __lengthSec: lengthSec,
          };
          triggerSlot(this.routing, slotIdx, noteTime, cell, slot, this.samples, barSec, bank);
        }
        continue;
      }
      // Grid-mode (legacy) — per-step cell triggering
      const cell = slot.pattern[step];
      if (!cell?.on) continue;
      const p = cell.probability ?? 100;
      if (p < 100 && Math.random() * 100 >= p) continue;
      const augmented = glideSource && glideSource[step] != null
        ? { ...cell, __fromPitch: glideSource[step] }
        : cell;
      triggerSlot(this.routing, slotIdx, triggerTime, augmented, slot, this.samples, barSec, bank);
    }
    this.queue.push({ step, chainIdx, time: baseTime });
    if (this.queue.length > 64) this.queue.shift();
  }

  _kickFiresAtStep(bank, step) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = bank.slots[i];
      if (!s || s.sound !== 'kick' || s.mute) continue;
      const c = s.pattern[step];
      if (c?.on) return true;
    }
    return false;
  }

  _advance() {
    const secondsPerBeat = 60.0 / this.bpm;
    this.nextNoteTime += secondsPerBeat / 4;
    this.currentStep++;
    if (this.currentStep >= 16) {
      this.currentStep = 0;
      this.chainIdx = (this.chainIdx + 1) % this.chain.length;
    }
  }

  getPlayState() {
    if (!this.isPlaying || !this.ctx) return null;
    const now = this.ctx.currentTime;
    let last = null;
    for (const q of this.queue) {
      if (q.time <= now) last = q;
      else break;
    }
    return last;
  }
}

// ============================================================
// Offline render — chain → AudioBuffer
// ============================================================
async function renderOffline({ banks, chain, bpm, delayFeedback, delayTime, samples, mix, onProgress }) {
  const sixteenth = (60 / bpm) / 4;
  const bars = chain.length;
  const sampleRate = 48000;

  const lastBank = banks[chain[bars - 1]];
  const LAST_STEP = 15;
  const lastIsOff = LAST_STEP % 2 === 1;
  const lastSwingFrac = lastIsOff && lastBank ? (lastBank.swing / 100) * 0.5 : 0;
  const lastBarStart = (bars - 1) * 16 * sixteenth;
  const lastStepTime = lastBarStart + LAST_STEP * sixteenth + lastSwingFrac * sixteenth;
  const musicalDuration = lastStepTime + sixteenth;

  const IR_LEN = 2.4;
  const delayTimeSec = delaySeconds(bpm, delayTime);
  let delayDecay = 0;
  if (delayFeedback > 0.0001) {
    const cycles = Math.ceil(Math.log(0.001) / Math.log(delayFeedback));
    delayDecay = delayTimeSec * cycles;
  }
  // Bumped floor slightly for 808s and long pads.
  const tail = Math.min(10, Math.max(IR_LEN, delayDecay, 2.5));
  const totalDuration = musicalDuration + tail;
  const ctx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);

  const localSamples = {};
  for (const id of Object.keys(samples || {})) {
    const buf = samples[id];
    if (!buf) continue;
    if (buf.sampleRate === sampleRate) localSamples[id] = buf;
    else localSamples[id] = await resample(buf, sampleRate);
  }

  // Build the bank-0 slot params so the offline routing matches live playback
  const slotVolumes = {}, slotDrives = {}, slotRevSends = {}, slotDelSends = {};
  const bank0 = banks[chain[0]];
  if (bank0) for (let i = 0; i < SLOT_COUNT; i++) {
    const s = bank0.slots[i] || {};
    slotVolumes[i] = s.volume ?? 0.85;
    slotDrives[i] = s.drive ?? 0;
    slotRevSends[i] = s.reverbSend ?? 0;
    slotDelSends[i] = s.delaySend ?? 0;
  }

  const routing = buildRouting(ctx, {
    reverbAmount: bank0?.reverbAmount ?? 0.25,
    delayFeedback,
    delayTimeSec,
    glue: mix?.glue ?? 0.35,
    slotVolumes, slotDrives, slotRevSends, slotDelSends,
  });

  const sidechain = mix?.sidechain ?? { amount: 0, targets: [] };
  const barSec = (60 / bpm) * 4;
  let hitCount = 0;
  let activeBank = null;
  for (let bar = 0; bar < bars; bar++) {
    const bank = banks[chain[bar]];
    if (!bank) continue;
    const barStart = bar * 16 * sixteenth;
    routing.reverbWet.gain.setValueAtTime(bank.reverbAmount, barStart);

    // When the bank changes, re-apply per-slot params at the bar boundary so
    // bank-A and bank-B with different drives/volumes both sound right.
    if (bank !== activeBank) {
      activeBank = bank;
      for (let i = 0; i < SLOT_COUNT; i++) {
        const s = bank.slots[i] || {};
        try { routing.slotVol[i].gain.setValueAtTime(s.volume ?? 0.85, barStart); } catch {}
        setSlotDrive(routing, i, s.drive ?? 0);
        try { routing.slotRevSend[i].gain.setValueAtTime(s.reverbSend ?? 0, barStart); } catch {}
        try { routing.slotDelSend[i].gain.setValueAtTime(s.delaySend ?? 0, barStart); } catch {}
      }
    }

    const glideMap = {};
    for (const { slotIdx, slot, glideSource } of iterSlots(bank)) {
      if (glideSource) glideMap[slotIdx] = glideSource;
    }

    for (let slotIdx = 0; slotIdx < SLOT_COUNT; slotIdx++) {
      const slot = bank.slots[slotIdx];
      if (!slot?.sound || !isContinuous(slot.sound)) continue;
      maybeTriggerBed(routing, slotIdx, barStart, slot, localSamples, barSec);
    }

    // Pre-compute which steps the kick fires for sidechain scheduling
    const kickSteps = new Set();
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = bank.slots[i];
      if (!s || s.sound !== 'kick' || s.mute) continue;
      for (let step = 0; step < 16; step++) if (s.pattern[step]?.on) kickSteps.add(step);
    }

    for (let step = 0; step < 16; step++) {
      const baseTime = barStart + step * sixteenth;
      const isOff = (step % 2) === 1;
      const swingDelay = isOff ? (bank.swing / 100) * 0.5 * sixteenth : 0;
      const t = baseTime + swingDelay;

      // Sidechain duck at every kick step
      if (kickSteps.has(step) && sidechain.amount > 0) {
        for (const idx of (sidechain.targets || [])) triggerDuck(routing, idx, t, sidechain.amount, 150);
      }

      for (let slotIdx = 0; slotIdx < SLOT_COUNT; slotIdx++) {
        const slot = bank.slots[slotIdx];
        if (!slot?.sound) continue;
        if (isContinuous(slot.sound)) continue;

        // Melody-mode notes (scheduled at step 0 of bar)
        if (slot.melody && Array.isArray(slot.melody) && step === 0) {
          for (const n of slot.melody) {
            const p = n.probability ?? 100;
            if (p < 100 && Math.random() * 100 >= p) continue;
            const noteStep = (n.step | 0) - 1;
            if (noteStep < 0 || noteStep > 15) continue;
            const noteTime = barStart + noteStep * sixteenth;
            const requested = Math.max(1, (n.length | 0));
            const lengthSec = Math.min(requested, 16 - noteStep) * sixteenth;
            const cell = { on: true, velocity: n.velocity ?? 1, probability: n.probability ?? 100, note: n.pitch ?? slot.defaultNote, __lengthSec: lengthSec };
            triggerSlot(routing, slotIdx, noteTime, cell, slot, localSamples, barSec, bank);
            hitCount++;
          }
          continue;
        }

        const cell = slot.pattern[step];
        if (!cell?.on) continue;
        const p = cell.probability ?? 100;
        if (p < 100 && Math.random() * 100 >= p) continue;
        const augmented = glideMap[slotIdx] && glideMap[slotIdx][step] != null
          ? { ...cell, __fromPitch: glideMap[slotIdx][step] }
          : cell;
        triggerSlot(routing, slotIdx, t, augmented, slot, localSamples, barSec, bank);
        hitCount++;
      }
    }
  }
  console.log(`[Pattern-16 export] bars=${bars}  musical=${musicalDuration.toFixed(3)}s  tail=${tail.toFixed(3)}s  total=${totalDuration.toFixed(3)}s  hits=${hitCount}`);

  let cancelled = false;
  const startWall = performance.now();
  const estDurationMs = totalDuration * 1000 * 0.4;
  const progressTimer = setInterval(() => {
    if (cancelled) return;
    const elapsed = performance.now() - startWall;
    const p = Math.min(0.95, elapsed / estDurationMs);
    onProgress?.(p);
  }, 80);

  try {
    const buffer = await ctx.startRendering();
    clearInterval(progressTimer);
    cancelled = true;
    onProgress?.(1);
    return { buffer, musicalDuration, tail, totalDuration };
  } catch (e) {
    clearInterval(progressTimer);
    cancelled = true;
    throw e;
  }
}

async function resample(buf, targetRate) {
  const ratio = buf.sampleRate / targetRate;
  const newLen = Math.floor(buf.length / ratio);
  const out = new OfflineAudioContext(buf.numberOfChannels, newLen, targetRate);
  const src = out.createBufferSource();
  src.buffer = buf;
  src.connect(out.destination);
  src.start(0);
  return await out.startRendering();
}

// ============================================================
// Trim inaudible silent tail + smooth fade-out
// ============================================================
function trimSilentTail(audioBuffer, opts = {}) {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const totalSamples = audioBuffer.length;

  const windowMs = opts.windowMs ?? 30;
  const safetyMs = opts.safetyMs ?? 40;
  const fadeMs = opts.fadeMs ?? 80;
  const absoluteFloor = opts.absoluteFloor ?? 0.003;
  const relativeRatio = opts.relativeRatio ?? 0.0056;
  const minSamples = Math.max(0, Math.floor(opts.minSamples ?? 0));

  const windowSamples = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));
  const safetySamples = Math.floor((safetyMs / 1000) * sampleRate);
  const fadeSamples = Math.floor((fadeMs / 1000) * sampleRate);

  let peak = 0;
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < totalSamples; i++) {
      const v = data[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
  }
  const threshold = Math.max(absoluteFloor, relativeRatio * peak);

  let lastAudibleSample = -1;
  let end = totalSamples;
  while (end > 0) {
    const start = Math.max(0, end - windowSamples);
    let sumSq = 0, count = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = start; i < end; i++) { sumSq += data[i] * data[i]; count++; }
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    if (rms > threshold) { lastAudibleSample = end - 1; break; }
    end = start;
  }
  if (lastAudibleSample < minSamples - 1) lastAudibleSample = minSamples - 1;
  if (lastAudibleSample < 0) lastAudibleSample = Math.min(totalSamples - 1, Math.floor(0.25 * sampleRate));

  const trimmedLength = Math.min(totalSamples, lastAudibleSample + 1 + safetySamples);
  if (trimmedLength >= totalSamples) return audioBuffer;

  let out;
  try {
    out = new AudioBuffer({ length: trimmedLength, numberOfChannels: numChannels, sampleRate });
  } catch (_) {
    out = new OfflineAudioContext(numChannels, trimmedLength, sampleRate).createBuffer(numChannels, trimmedLength, sampleRate);
  }
  const fadeStart = Math.max(0, trimmedLength - fadeSamples);
  const fadeWindow = trimmedLength - fadeStart;
  for (let ch = 0; ch < numChannels; ch++) {
    const src = audioBuffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, trimmedLength));
    for (let i = fadeStart; i < trimmedLength; i++) {
      const gain = 1 - (i - fadeStart) / fadeWindow;
      dst[i] *= gain;
    }
  }
  const trimmedSec = (totalSamples - trimmedLength) / sampleRate;
  console.log(`[Pattern-16 export] trimmed ${trimmedSec.toFixed(2)}s · final ${(trimmedLength / sampleRate).toFixed(2)}s · threshold ${threshold.toFixed(5)} · peak ${peak.toFixed(3)}`);
  return out;
}

// ============================================================
// WAV encoder (PCM 16-bit)
// ============================================================
function encodeWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const bufferSize = 44 + dataSize;
  const ab = new ArrayBuffer(bufferSize);
  const view = new DataView(ab);
  let offset = 0;
  const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); };
  const u32 = (v) => { view.setUint32(offset, v, true); offset += 4; };
  const u16 = (v) => { view.setUint16(offset, v, true); offset += 2; };
  writeStr('RIFF'); u32(36 + dataSize); writeStr('WAVE');
  writeStr('fmt '); u32(16); u16(1); u16(numChannels); u32(sampleRate); u32(byteRate); u16(blockAlign); u16(16);
  writeStr('data'); u32(dataSize);
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

export { DrumEngine, renderOffline, trimSilentTail, encodeWav };
