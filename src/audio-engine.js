// Pattern-16 audio engine — slot-indexed (0..7) routing, swing/velocity/probability
// scheduling, sample override per slot, reverb + delay sends, offline render.

import { VOICES, triggerSample } from './voices.js';

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

// Build a "trigger destination" — a gain that fans to dry + reverb-send + delay-send,
// scaled by slot volume × velocity gain.
function makeDest(routing, slotIdx, slotVol, velGain, revSend, delSend) {
  const ctx = routing.ctx;
  const trim = ctx.createGain();
  trim.gain.value = slotVol * velGain;
  trim.connect(routing.slotBuses[slotIdx]);
  if (revSend > 0 && routing.reverbIn) {
    const rs = ctx.createGain(); rs.gain.value = revSend;
    trim.connect(rs).connect(routing.reverbIn);
  }
  if (delSend > 0 && routing.delayIn) {
    const ds = ctx.createGain(); ds.gain.value = delSend;
    trim.connect(ds).connect(routing.delayIn);
  }
  return trim;
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

function triggerSlot(routing, slotIdx, time, cell, slot, samples) {
  if (slot.mute) return;
  const velocity = cell.velocity ?? 1;
  const velGain = VEL_GAIN[velocity] ?? 0.85;
  const dest = makeDest(routing, slotIdx, slot.volume, velGain, slot.reverbSend, slot.delaySend);

  const buf = samples[slotIdx];
  if (buf) {
    triggerSample(routing.ctx, time, dest, buf);
    return;
  }
  const fn = VOICES[slot.sound];
  if (!fn) return;
  fn(routing.ctx, time, velocity, dest, {
    note: cell.note ?? slot.defaultNote,
    fromPitch: cell.__fromPitch ?? null,
    filter: slot.filter,
    chord: slot.chordType,
    tunable: slot.tunable,
  });
}

// ----- Routing builder (shared by live + offline) -----
function buildRouting(ctx, opts) {
  const { reverbAmount = 0.25, delayFeedback = 0.35, delayTimeSec = 0.5 } = opts;

  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);

  const slotBuses = {};
  for (const i of SLOT_INDICES) {
    const g = ctx.createGain(); g.gain.value = 1;
    g.connect(master);
    slotBuses[i] = g;
  }

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

  return {
    ctx, master, slotBuses,
    reverbIn, reverbWet, convolver,
    delayIn, delayNode, delayWet, feedback, fbFilter,
  };
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
    this.samples = {}; // {slotIdx: AudioBuffer | null}
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
    this.routing = buildRouting(this.ctx, {
      reverbAmount: this.banks[0]?.reverbAmount ?? 0.25,
      delayFeedback: this.delayFeedback,
      delayTimeSec: delaySeconds(this.bpm, this.delayTime),
    });
  }

  setBanks(banks) { this.banks = banks; this._syncBankParams(); }
  setChain(chain) { this.chain = (chain && chain.length) ? chain : [0]; }
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
    }
    for (const { slotIdx, slot, glideSource } of iterSlots(bank)) {
      const cell = slot.pattern[step];
      if (!cell?.on) continue;
      const p = cell.probability ?? 100;
      if (p < 100 && Math.random() * 100 >= p) continue;
      const augmented = glideSource && glideSource[step] != null
        ? { ...cell, __fromPitch: glideSource[step] }
        : cell;
      triggerSlot(this.routing, slotIdx, triggerTime, augmented, slot, this.samples);
    }
    this.queue.push({ step, chainIdx, time: baseTime });
    if (this.queue.length > 64) this.queue.shift();
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
async function renderOffline({ banks, chain, bpm, delayFeedback, delayTime, samples, onProgress }) {
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

  const routing = buildRouting(ctx, {
    reverbAmount: banks[chain[0]]?.reverbAmount ?? 0.25,
    delayFeedback,
    delayTimeSec,
  });

  let hitCount = 0;
  for (let bar = 0; bar < bars; bar++) {
    const bank = banks[chain[bar]];
    if (!bank) continue;
    const barStart = bar * 16 * sixteenth;
    routing.reverbWet.gain.setValueAtTime(bank.reverbAmount, barStart);

    // Pre-compute glide sources for pitched slots in this bank
    const glideMap = {};
    for (const { slotIdx, slot, glideSource } of iterSlots(bank)) {
      if (glideSource) glideMap[slotIdx] = glideSource;
    }

    for (let step = 0; step < 16; step++) {
      const baseTime = barStart + step * sixteenth;
      const isOff = (step % 2) === 1;
      const swingDelay = isOff ? (bank.swing / 100) * 0.5 * sixteenth : 0;
      const t = baseTime + swingDelay;

      for (let slotIdx = 0; slotIdx < SLOT_COUNT; slotIdx++) {
        const slot = bank.slots[slotIdx];
        if (!slot?.sound) continue;
        const cell = slot.pattern[step];
        if (!cell?.on) continue;
        const p = cell.probability ?? 100;
        if (p < 100 && Math.random() * 100 >= p) continue;
        const augmented = glideMap[slotIdx] && glideMap[slotIdx][step] != null
          ? { ...cell, __fromPitch: glideMap[slotIdx][step] }
          : cell;
        triggerSlot(routing, slotIdx, t, augmented, slot, localSamples);
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
