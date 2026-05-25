// Pattern-16 audio engine — banks + chain + samples + sends + delay + offline render.

const ROW_IDS = ['kick', 'snare', 'chh', 'ohh', 'clap', 'tom'];
  const VEL_GAIN = [0.5, 0.85, 1.0]; // soft / med / loud
  const DELAY_FRACTIONS = { '1/8': 0.5, '1/4': 1, '3/8': 1.5, '1/2': 2 }; // × quarter note

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

  // ----- Voice triggers (pure, take a Routing object) -----
  // Each trigger draws envelopes / oscillators into `routing` which has:
  //   ctx, rowBuses[rowId] (-> dry to master), reverbIn, delayIn
  // Returns nothing; nodes self-destruct.

  function whiteNoise(ctx, time, dur) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  // Build a "trigger destination" — a gain that goes to dry + reverb-send + delay-send,
  // all scaled by row volume × velocity gain. Connect your voice into this.
  function makeDest(routing, rowId, rowVol, velGain, revSend, delSend) {
    const ctx = routing.ctx;
    const trim = ctx.createGain();
    trim.gain.value = rowVol * velGain;

    // dry
    trim.connect(routing.rowBuses[rowId]); // rowBuses[rowId] -> master
    // reverb send
    if (revSend > 0 && routing.reverbIn) {
      const rs = ctx.createGain();
      rs.gain.value = revSend;
      trim.connect(rs).connect(routing.reverbIn);
    }
    // delay send
    if (delSend > 0 && routing.delayIn) {
      const ds = ctx.createGain();
      ds.gain.value = delSend;
      trim.connect(ds).connect(routing.delayIn);
    }
    return trim;
  }

  function triggerKick(routing, rowId, time, velocity, dest) {
    const ctx = routing.ctx;
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

    const click = whiteNoise(ctx, time, 0.012);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(loud ? 0.55 : (soft ? 0.18 : 0.35), time);
    cg.gain.exponentialRampToValueAtTime(0.001, time + 0.012);
    const cf = ctx.createBiquadFilter();
    cf.type = 'highpass'; cf.frequency.value = 800;
    click.connect(cf).connect(cg).connect(dest);
    click.start(time); click.stop(time + 0.02);
  }

  function triggerSnare(routing, rowId, time, velocity, dest) {
    const ctx = routing.ctx;
    const n = whiteNoise(ctx, time, 0.25);
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

  function triggerCHH(routing, rowId, time, velocity, dest) {
    const ctx = routing.ctx;
    const n = whiteNoise(ctx, time, 0.06);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.45, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.045);
    n.connect(hp).connect(g).connect(dest);
    n.start(time); n.stop(time + 0.06);
  }

  function triggerOHH(routing, rowId, time, velocity, dest) {
    const ctx = routing.ctx;
    const n = whiteNoise(ctx, time, 0.35);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    n.connect(hp).connect(g).connect(dest);
    n.start(time); n.stop(time + 0.35);
  }

  function triggerClap(routing, rowId, time, velocity, dest) {
    const ctx = routing.ctx;
    const offsets = [0, 0.012, 0.024, 0.04];
    offsets.forEach((off, i) => {
      const n = whiteNoise(ctx, time + off, 0.05);
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

  function triggerTom(routing, rowId, time, velocity, dest) {
    const ctx = routing.ctx;
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

    const n = whiteNoise(ctx, time, 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 250; bp.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.2, time);
    ng.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    n.connect(bp).connect(ng).connect(dest);
    n.start(time); n.stop(time + 0.05);
  }

  function triggerSample(routing, rowId, time, velocity, dest, buffer) {
    const ctx = routing.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);
    src.start(time);
    src.stop(time + buffer.duration + 0.05);
  }

  const SYNTHS = {
    kick: triggerKick, snare: triggerSnare, chh: triggerCHH,
    ohh: triggerOHH, clap: triggerClap, tom: triggerTom,
  };

  // Trigger a row at `time` with the given bank's settings, in the given routing.
  // `samples` is the shared sample map.
  function triggerRow(routing, rowId, time, velocity, bank, samples) {
    if (bank.mutes[rowId]) return;
    const rowVol = bank.volumes[rowId];
    const velGain = VEL_GAIN[velocity] ?? 0.85;
    const dest = makeDest(routing, rowId, rowVol, velGain, bank.reverbSends[rowId], bank.delaySends[rowId]);
    const buf = samples[rowId];
    if (buf) {
      triggerSample(routing, rowId, time, velocity, dest, buf);
    } else {
      SYNTHS[rowId](routing, rowId, time, velocity, dest);
    }
  }

  // ----- Routing builder (shared by live + offline) -----
  // Builds master, row buses, reverb wet, delay line, returns a `routing` object.
  function buildRouting(ctx, opts) {
    const { reverbAmount = 0.25, delayFeedback = 0.35, delayTimeSec = 0.5 } = opts;

    const master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);

    // Row buses (dry)
    const rowBuses = {};
    for (const id of ROW_IDS) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(master);
      rowBuses[id] = g;
    }

    // Reverb wet path
    const reverbIn = ctx.createGain();
    reverbIn.gain.value = 1;
    const convolver = ctx.createConvolver();
    convolver.buffer = makeIR(ctx, 2.4, 2.2);
    const reverbWet = ctx.createGain();
    reverbWet.gain.value = reverbAmount;
    reverbIn.connect(convolver).connect(reverbWet).connect(master);

    // Delay wet path with feedback
    const delayIn = ctx.createGain();
    delayIn.gain.value = 1;
    const delayNode = ctx.createDelay(2.0);
    delayNode.delayTime.value = delayTimeSec;
    const feedback = ctx.createGain();
    feedback.gain.value = delayFeedback;
    // High-cut on feedback path for a smoother tail
    const fbFilter = ctx.createBiquadFilter();
    fbFilter.type = 'lowpass';
    fbFilter.frequency.value = 4500;
    const delayWet = ctx.createGain();
    delayWet.gain.value = 0.85;
    delayIn.connect(delayNode);
    delayNode.connect(fbFilter).connect(feedback).connect(delayNode); // feedback loop
    delayNode.connect(delayWet).connect(master);

    return {
      ctx, master, rowBuses,
      reverbIn, reverbWet, convolver,
      delayIn, delayNode, delayWet, feedback, fbFilter,
    };
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
      this.banks = [];           // [{pattern, volumes, mutes, swing, reverbAmount, reverbSends, delaySends}, ...]
      this.chain = [0];          // bank indices, e.g. [0,0,1,0]
      this.samples = {};         // {rowId: AudioBuffer | null}
      // Playback state
      this.isPlaying = false;
      this.currentStep = 0;      // 0..15 within current bar
      this.chainIdx = 0;
      this.nextNoteTime = 0;
      this.lookahead = 25;
      this.scheduleAhead = 0.1;
      this.timerID = null;
      this.queue = [];           // {step, chainIdx, time}
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
    setSample(rowId, buffer) { this.samples[rowId] = buffer || null; }

    // Push currently-playing bank's reverb amount into routing
    _syncBankParams() {
      if (!this.routing) return;
      const playingBank = this.getPlayingBank();
      if (playingBank) {
        this.routing.reverbWet.gain.value = playingBank.reverbAmount;
      }
    }

    getPlayingBankIndex() {
      if (!this.chain || !this.chain.length) return 0;
      const idx = this.chainIdx % this.chain.length;
      return this.chain[idx];
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
      // Update reverb wet for the currently-playing bank at the moment it starts
      if (step === 0 && this.routing) {
        this.routing.reverbWet.gain.setTargetAtTime(bank.reverbAmount, baseTime, 0.01);
      }
      for (const rowId of ROW_IDS) {
        const cell = bank.pattern[rowId]?.[step];
        if (!cell || !cell.on) continue;
        const p = cell.probability ?? 100;
        if (p < 100 && Math.random() * 100 >= p) continue;
        triggerRow(this.routing, rowId, triggerTime, cell.velocity ?? 1, bank, this.samples);
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

    // Returns {step, chainIdx} of the most-recently-played slot, or null
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

    // --- Compute musical duration from the actual last scheduled step time.
    // Pure formula (stepsTotal * sixteenth) would clip the final step's swing.
    const lastBank = banks[chain[bars - 1]];
    const LAST_STEP = 15;                       // 0-indexed final step
    const lastIsOff = LAST_STEP % 2 === 1;      // true — step 16 in 1-indexed is an off-beat
    const lastSwingFrac = lastIsOff && lastBank ? (lastBank.swing / 100) * 0.5 : 0;
    const lastBarStart = (bars - 1) * 16 * sixteenth;
    const lastStepTime = lastBarStart + LAST_STEP * sixteenth + lastSwingFrac * sixteenth;
    const musicalDuration = lastStepTime + sixteenth; // one full 16th of breathing room

    // --- Tail: enough time for the slowest effect to decay below -60 dB.
    const IR_LEN = 2.4;                         // matches makeIR(... 2.4 ...)
    const delayTimeSec = delaySeconds(bpm, delayTime);
    let delayDecay = 0;
    if (delayFeedback > 0.0001) {
      // feedback^N = 0.001  ⇒  N = log(0.001) / log(fb)
      const cycles = Math.ceil(Math.log(0.001) / Math.log(delayFeedback));
      delayDecay = delayTimeSec * cycles;
    }
    // Math.max with a 1.5s floor so even with zero FX we get a hair of headroom
    // for the longest synth envelope (kick ≈ 0.55s) to fully decay.
    const tail = Math.min(8, Math.max(IR_LEN, delayDecay, 1.5));

    const totalDuration = musicalDuration + tail;
    const ctx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);

    // Rebuild samples in this ctx if their original sampleRate differs.
    const localSamples = {};
    for (const id of Object.keys(samples || {})) {
      const buf = samples[id];
      if (!buf) continue;
      if (buf.sampleRate === sampleRate) {
        localSamples[id] = buf;
      } else {
        localSamples[id] = await resample(buf, sampleRate);
      }
    }

    const routing = buildRouting(ctx, {
      reverbAmount: banks[chain[0]]?.reverbAmount ?? 0.25,
      delayFeedback,
      delayTimeSec,
    });

    // Schedule every step. Count hits so we can sanity-check we're not dropping
    // the final step (a common bug when end-conditions use < instead of <=).
    let hitCount = 0;
    for (let bar = 0; bar < bars; bar++) {
      const bank = banks[chain[bar]];
      if (!bank) continue;
      const barStart = bar * 16 * sixteenth;
      routing.reverbWet.gain.setValueAtTime(bank.reverbAmount, barStart);

      for (let step = 0; step < 16; step++) {
        const baseTime = barStart + step * sixteenth;
        const isOff = (step % 2) === 1;
        const swingDelay = isOff ? (bank.swing / 100) * 0.5 * sixteenth : 0;
        const t = baseTime + swingDelay;

        for (const rowId of ROW_IDS) {
          const cell = bank.pattern[rowId]?.[step];
          if (!cell || !cell.on) continue;
          const p = cell.probability ?? 100;
          if (p < 100 && Math.random() * 100 >= p) continue;
          triggerRow(routing, rowId, t, cell.velocity ?? 1, bank, localSamples);
          hitCount++;
        }
      }
    }
    console.log(`[Pattern-16 export] bars=${bars}  musical=${musicalDuration.toFixed(3)}s  tail=${tail.toFixed(3)}s  total=${totalDuration.toFixed(3)}s  hits=${hitCount}`);

    // Progress estimate via wall-clock — OfflineAudioContext has no portable
    // mid-render progress event.
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

  // Naive linear resample
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
  // Uses windowed RMS (not per-sample peaks) so the random-noise content of
  // the reverb IR doesn't fool the detector into keeping a long, perceptually
  // silent tail. Threshold combines an absolute floor (~-50 dBFS) with a
  // peak-relative floor (~-45 dB below peak). `minSamples` preserves the
  // musical timeline so we never cut inside the composed pattern.
  function trimSilentTail(audioBuffer, opts = {}) {
    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const totalSamples = audioBuffer.length;

    const windowMs = opts.windowMs ?? 30;
    const safetyMs = opts.safetyMs ?? 40;
    const fadeMs = opts.fadeMs ?? 80;
    const absoluteFloor = opts.absoluteFloor ?? 0.003;  // ~ -50 dBFS
    const relativeRatio = opts.relativeRatio ?? 0.0056; // ~ -45 dB below peak
    const minSamples = Math.max(0, Math.floor(opts.minSamples ?? 0));

    const windowSamples = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));
    const safetySamples = Math.floor((safetyMs / 1000) * sampleRate);
    const fadeSamples = Math.floor((fadeMs / 1000) * sampleRate);

    // Peak (absolute) across all channels — used to scale the relative floor
    // so loud and quiet renders trim consistently.
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

    // Walk backwards window-by-window, computing summed RMS across channels.
    // Stop at the first window whose RMS exceeds the threshold — that's the
    // last perceptually-audible content.
    let lastAudibleSample = -1;
    let end = totalSamples;
    while (end > 0) {
      const start = Math.max(0, end - windowSamples);
      let sumSq = 0;
      let count = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = start; i < end; i++) {
          const v = data[i];
          sumSq += v * v;
          count++;
        }
      }
      const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
      if (rms > threshold) {
        lastAudibleSample = end - 1;
        break;
      }
      end = start;
    }

    // Floor: never cut earlier than the composed musical timeline. This keeps
    // intentional rests at the end of a bar intact.
    if (lastAudibleSample < minSamples - 1) lastAudibleSample = minSamples - 1;

    // Empty pattern fallback — keep a quarter second so the file isn't 0 bytes.
    if (lastAudibleSample < 0) {
      lastAudibleSample = Math.min(totalSamples - 1, Math.floor(0.25 * sampleRate));
    }

    const trimmedLength = Math.min(totalSamples, lastAudibleSample + 1 + safetySamples);
    if (trimmedLength >= totalSamples) {
      return audioBuffer; // Nothing to trim
    }

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

    writeStr('RIFF');
    u32(36 + dataSize);
    writeStr('WAVE');
    writeStr('fmt ');
    u32(16);
    u16(1);              // PCM
    u16(numChannels);
    u32(sampleRate);
    u32(byteRate);
    u16(blockAlign);
    u16(16);             // bits per sample
    writeStr('data');
    u32(dataSize);

    // Interleave + convert to 16-bit
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

export { DrumEngine, renderOffline, trimSilentTail, encodeWav, ROW_IDS as DRUM_ROW_IDS };
