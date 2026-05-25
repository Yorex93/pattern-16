/* global React, ReactDOM, DrumEngine, renderOffline, encodeWav, DRUM_ROW_IDS,
   Splash, Knob, MiniSend, VolumeSlider, PlayButton, BPMControl, Step */
const { useState, useEffect, useRef, useCallback } = React;

const ROWS = [
  { id: 'kick',  label: 'KICK' },
  { id: 'snare', label: 'SNARE' },
  { id: 'chh',   label: 'C-HAT' },
  { id: 'ohh',   label: 'O-HAT' },
  { id: 'clap',  label: 'CLAP' },
  { id: 'tom',   label: 'TOM' },
];
const ROW_IDS = ROWS.map(r => r.id);
const BANK_LETTERS = ['A', 'B', 'C', 'D'];
const DELAY_OPTIONS = ['1/8', '1/4', '3/8', '1/2'];

// ----- Cell + bank helpers -----
const emptyCell = () => ({ on: false, velocity: 1, probability: 100 });
const onCell = (velocity = 1, probability = 100) => ({ on: true, velocity, probability });
const EMPTY_ROW = () => Array.from({ length: 16 }, emptyCell);
const EMPTY_PATTERN = () => Object.fromEntries(ROWS.map(r => [r.id, EMPTY_ROW()]));

const ZERO_PER_ROW = () => Object.fromEntries(ROWS.map(r => [r.id, 0]));
const DEFAULT_VOLUMES = () => Object.fromEntries(ROWS.map(r => [r.id, 0.85]));
const DEFAULT_MUTES = () => Object.fromEntries(ROWS.map(r => [r.id, false]));

function emptyBank() {
  return {
    pattern: EMPTY_PATTERN(),
    volumes: DEFAULT_VOLUMES(),
    mutes: DEFAULT_MUTES(),
    reverbSends: ZERO_PER_ROW(),
    delaySends: ZERO_PER_ROW(),
    swing: 0,
    reverbAmount: 0.25,
  };
}

// Preset row helper: '.' or 0 = off, number = on with velocity, [v,p] = on with vel+prob
function row(spec) {
  return spec.map(e => {
    if (e === '.' || e === 0) return emptyCell();
    if (typeof e === 'number') return onCell(e, 100);
    if (Array.isArray(e)) return onCell(e[0], e[1] ?? 100);
    return emptyCell();
  });
}

const PRESETS = {
  'BOOM-BAP': {
    pattern: {
      kick:  row([2,'.','.','.', '.','.',1,'.', 1,'.','.','.', '.','.','.','.']),
      snare: row(['.','.','.','.', 2,'.','.','.', '.','.','.','.', 2,'.','.','.']),
      chh:   row([1,'.',1,'.', 1,'.',1,'.', 1,'.',1,'.', 1,'.',1,'.']),
      ohh:   row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.',1,'.']),
      clap:  EMPTY_ROW(),
      tom:   EMPTY_ROW(),
    },
    bpm: 88,
    swing: 56,
    reverbAmount: 0.32,
    reverbSends: { kick: 0,    snare: 0.45, chh: 0.1, ohh: 0.25, clap: 0, tom: 0.15 },
    delaySends: ZERO_PER_ROW(),
  },
  'TRAP': {
    pattern: {
      kick:  row([2,'.','.','.', '.','.',1,'.', '.','.',1,'.', '.','.','.','.']),
      snare: row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 1,'.','.','.']),
      chh:   row([1,[1,75],1,[1,50], 1,[1,75],1,[1,75], 1,[1,50],1,[1,75], 1,[1,75],[1,50],[1,75]]),
      ohh:   row(['.','.','.','.', '.','.','.','.', '.','.',1,'.', '.','.','.','.']),
      clap:  row(['.','.','.','.', 2,'.','.','.', '.','.','.','.', 2,'.','.','.']),
      tom:   row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.',1,'.']),
    },
    bpm: 140,
    swing: 0,
    reverbAmount: 0.22,
    reverbSends: { kick: 0, snare: 0.15, chh: 0, ohh: 0.2, clap: 0.2, tom: 0.25 },
    delaySends: { kick: 0, snare: 0, chh: 0, ohh: 0.55, clap: 0, tom: 0.2 },
  },
  'HOUSE': {
    pattern: {
      kick:  row([2,'.','.','.', 1,'.','.','.', 1,'.','.','.', 1,'.','.','.']),
      snare: EMPTY_ROW(),
      chh:   row(['.','.',1,'.', '.','.',1,'.', '.','.',1,'.', '.','.',1,'.']),
      ohh:   row(['.','.','.','.', '.','.',1,'.', '.','.','.','.', '.','.',1,'.']),
      clap:  row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 2,'.','.','.']),
      tom:   EMPTY_ROW(),
    },
    bpm: 124,
    swing: 0,
    reverbAmount: 0.20,
    reverbSends: { kick: 0, snare: 0, chh: 0.1, ohh: 0.2, clap: 0.4, tom: 0 },
    delaySends: { kick: 0, snare: 0, chh: 0, ohh: 0, clap: 0.3, tom: 0 },
  },
};

function bankFromPreset(name) {
  const p = PRESETS[name];
  if (!p) return emptyBank();
  return {
    pattern: Object.fromEntries(Object.entries(p.pattern).map(([k, v]) => [k, v.map(c => ({ ...c }))])),
    volumes: DEFAULT_VOLUMES(),
    mutes: DEFAULT_MUTES(),
    reverbSends: { ...ZERO_PER_ROW(), ...(p.reverbSends || {}) },
    delaySends: { ...ZERO_PER_ROW(), ...(p.delaySends || {}) },
    swing: p.swing ?? 0,
    reverbAmount: p.reverbAmount ?? 0.25,
  };
}

// ============================================================
// Sub-components specific to this app
// ============================================================

function BankBar({ banks, editBank, playingBank, isPlaying, onSelect }) {
  return (
    <div className="bankbar">
      <div className="band-label">BANKS</div>
      <div className="bankbar-row">
        {BANK_LETTERS.map((letter, i) => {
          const isEditing = i === editBank;
          const isPlayingHere = isPlaying && i === playingBank;
          const populated = Object.values(banks[i].pattern).some(r => r.some(c => c.on));
          return (
            <button
              key={letter}
              className={`bank ${isEditing ? 'editing' : ''} ${isPlayingHere ? 'playing' : ''} ${populated ? 'populated' : ''}`}
              onClick={() => onSelect(i)}
              title={`Bank ${letter}${isEditing ? ' (editing)' : ''}${isPlayingHere ? ' · playing' : ''}`}
            >
              <span className="bank-letter">{letter}</span>
              <span className="bank-play-led" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChainEditor({ chain, setChain, playingChainIdx, isPlaying }) {
  const cycleCell = (idx) => {
    if (idx > chain.length) return; // can't reach past the next-empty slot
    if (idx === chain.length) {
      // The "+" add slot — append a default A
      if (chain.length >= 8) return;
      setChain([...chain, 0]);
      return;
    }
    const cur = chain[idx];
    const isLast = idx === chain.length - 1;
    if (cur >= 3) {
      // Past D: last slot removes, middle slot wraps to A (no holes allowed)
      if (isLast && idx > 0) { setChain(chain.slice(0, idx)); return; }
      const nc = [...chain]; nc[idx] = 0; setChain(nc); return;
    }
    const nc = [...chain]; nc[idx] = cur + 1; setChain(nc);
  };

  return (
    <div className="chain">
      <div className="band-label">CHAIN <span className="band-sub">{chain.length} {chain.length === 1 ? 'BAR' : 'BARS'}</span></div>
      <div className="chain-cells">
        {Array.from({ length: 8 }).map((_, i) => {
          const inChain = i < chain.length;
          const isAddSlot = i === chain.length;
          const isPad = i > chain.length;
          const v = inChain ? chain[i] : null;
          const active = isPlaying && inChain && (playingChainIdx % chain.length) === i;
          return (
            <button
              key={i}
              className={`chain-cell ${!inChain ? 'empty' : ''} ${active ? 'active' : ''} ${isPad ? 'pad' : ''} ${isAddSlot ? 'add' : ''}`}
              onClick={() => cycleCell(i)}
              disabled={isPad}
              title={
                inChain
                  ? `Slot ${i + 1}: bank ${BANK_LETTERS[v]} — click to cycle${i === chain.length - 1 ? ' (D → remove)' : ''}`
                  : isAddSlot
                    ? `Slot ${i + 1}: empty — click to add`
                    : 'Locked — extend the chain first'
              }
            >
              {inChain && <span className="chain-letter">{BANK_LETTERS[v]}</span>}
              {isAddSlot && <span className="chain-add">+</span>}
              {isPad && <span className="chain-dash">—</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SendsPanel({ swing, setSwing, reverbAmount, setReverbAmount, delayFeedback, setDelayFeedback, delayTime, setDelayTime }) {
  return (
    <div className="sends-panel">
      <div className="sends-header">
        <span className="sends-title">MODULATION</span>
        <div className="delay-time">
          {DELAY_OPTIONS.map(opt => (
            <button
              key={opt}
              className={`dt-opt ${delayTime === opt ? 'on' : ''}`}
              onClick={() => setDelayTime(opt)}
              title={`Delay time ${opt} note`}
            >{opt}</button>
          ))}
        </div>
      </div>
      <div className="sends-knobs">
        <Knob
          value={swing}
          onChange={setSwing}
          min={0}
          max={66}
          label="SWING"
          size={52}
          displayValue={`${Math.round(swing)}`}
        />
        <Knob value={reverbAmount} onChange={setReverbAmount} label="REVERB" size={52} />
        <Knob
          value={delayFeedback}
          onChange={setDelayFeedback}
          min={0}
          max={0.8}
          label="DELAY FB"
          size={52}
          displayValue={Math.round(delayFeedback * 100)}
        />
      </div>
    </div>
  );
}

function SampleSlot({ rowId, label, sample, onLoad, onClear, dragOver, setDragOver }) {
  const fileRef = useRef(null);
  const handleFile = async (file) => {
    if (!file) return;
    await onLoad(file);
  };
  return (
    <div
      className={`row-name ${dragOver ? 'drag' : ''} ${sample ? 'has-sample' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(rowId); }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(null);
        const f = e.dataTransfer.files?.[0];
        handleFile(f);
      }}
      onClick={() => fileRef.current?.click()}
      title={sample ? `${sample.name} — click to replace, × to revert to synth` : `${label} — drop a .wav/.mp3 or click to upload`}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".wav,.mp3,audio/wav,audio/mpeg,audio/*"
        hidden
        onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      <span className="row-label">
        {sample ? (
          <>
            <span className="sample-icon" aria-hidden="true">
              <svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 6 L4 6 L5 3 L7 9 L8 6 L10 6" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" strokeLinecap="round"/></svg>
            </span>
            <span className="sample-name" title={sample.name}>{sample.name.replace(/\.[^.]+$/, '').slice(0, 10)}</span>
          </>
        ) : (
          <span className="instr-name">{label}</span>
        )}
      </span>
      {sample && (
        <button
          className="sample-clear"
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          title="Revert to synth voice"
        >×</button>
      )}
    </div>
  );
}

function ExportModal({ progress, onCancel }) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">RENDERING WAV</div>
        <div className="modal-body">
          <div className="modal-progress">
            <div className="modal-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="modal-progress-text">{Math.round(progress * 100)}% · bouncing offline</div>
          <div className="modal-hint">Captures the full chain with swing, velocity, probability, samples, and sends.</div>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, onClose }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, 4200);
    return () => clearTimeout(t);
  }, [message, onClose]);
  if (!message) return null;
  return <div className="toast">{message}</div>;
}

// ============================================================
// App
// ============================================================
function App() {
  // State
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [bpm, setBpmState] = useState(92);
  const [banks, setBanks] = useState(() => {
    const b = [emptyBank(), emptyBank(), emptyBank(), emptyBank()];
    b[0] = bankFromPreset('BOOM-BAP');
    return b;
  });
  const [editBank, setEditBank] = useState(0);
  const [chain, setChain] = useState([0]);
  const [activePreset, setActivePreset] = useState('BOOM-BAP');

  const [delayFeedback, setDelayFeedback] = useState(0.35);
  const [delayTime, setDelayTime] = useState('3/8');

  const [samples, setSamples] = useState({}); // {rowId: {name, buffer}}
  const [dragOver, setDragOver] = useState(null);
  const [toast, setToast] = useState(null);
  const sampleNoticeShown = useRef(false);

  const [playState, setPlayStateInternal] = useState({ step: -1, chainIdx: 0 });
  const [flash, setFlash] = useState({});

  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const engineRef = useRef(null);
  const rafRef = useRef(null);

  // Derived
  const bank = banks[editBank];

  // Start up the engine on user gesture
  const start = useCallback(() => {
    if (!engineRef.current) {
      const eng = new DrumEngine();
      eng.init();
      eng.setBanks(banks);
      eng.setChain(chain);
      eng.setBPM(bpm);
      eng.setDelayFeedback(delayFeedback);
      eng.setDelayTime(delayTime);
      engineRef.current = eng;
    }
    setStarted(true);
  }, []);

  // Sync state → engine
  useEffect(() => { engineRef.current?.setBanks(banks); }, [banks]);
  useEffect(() => { engineRef.current?.setChain(chain); }, [chain]);
  useEffect(() => { engineRef.current?.setBPM(bpm); }, [bpm]);
  useEffect(() => { engineRef.current?.setDelayFeedback(delayFeedback); }, [delayFeedback]);
  useEffect(() => { engineRef.current?.setDelayTime(delayTime); }, [delayTime]);

  // Playback indicator + row flashes
  useEffect(() => {
    if (!playing) { setPlayStateInternal({ step: -1, chainIdx: 0 }); return; }
    const tick = () => {
      const ps = engineRef.current?.getPlayState();
      if (ps) {
        setPlayStateInternal(prev => {
          const changed = ps.step !== prev.step || ps.chainIdx !== prev.chainIdx;
          if (changed && ps.step >= 0) {
            const bankIdx = chain[ps.chainIdx % chain.length];
            const b = banks[bankIdx];
            if (b) {
              ROW_IDS.forEach(rid => {
                const cell = b.pattern[rid]?.[ps.step];
                if (cell?.on && !b.mutes[rid]) {
                  setFlash(f => ({ ...f, [rid]: (f[rid] ?? 0) + 1 }));
                }
              });
            }
            return ps;
          }
          return changed ? ps : prev;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, banks, chain]);

  // ----- Helpers -----
  const updateEditBank = (fn) => {
    setBanks(prev => prev.map((b, i) => (i === editBank ? fn(b) : b)));
  };

  const togglePlay = () => {
    if (!engineRef.current) return;
    if (playing) { engineRef.current.stop(); setPlaying(false); }
    else { engineRef.current.play(); setPlaying(true); }
  };

  // ----- Step interactions (apply to edit bank) -----
  const onStepClick = (rowId, idx, e) => {
    updateEditBank(b => {
      const r = b.pattern[rowId];
      const cell = r[idx];
      let nextCell;
      if (cell.on && e.shiftKey) {
        const order = [1, 2, 0];
        const cur = order.indexOf(cell.velocity);
        nextCell = { ...cell, velocity: order[(cur + 1) % order.length] };
      } else if (cell.on && e.altKey) {
        const order = [100, 75, 50, 25];
        const cur = order.indexOf(cell.probability);
        nextCell = { ...cell, probability: order[(cur + 1) % order.length] };
      } else {
        nextCell = cell.on ? emptyCell() : onCell(1, 100);
      }
      const nr = [...r]; nr[idx] = nextCell;
      return { ...b, pattern: { ...b.pattern, [rowId]: nr } };
    });
    setActivePreset(null);
  };

  const onStepContext = (rowId, idx, e) => {
    e.preventDefault();
    updateEditBank(b => {
      const r = b.pattern[rowId];
      const cell = r[idx];
      if (!cell.on) return b;
      const order = [1, 2, 0];
      const cur = order.indexOf(cell.velocity);
      const nr = [...r];
      nr[idx] = { ...cell, velocity: order[(cur + 1) % order.length] };
      return { ...b, pattern: { ...b.pattern, [rowId]: nr } };
    });
    setActivePreset(null);
  };

  const setRowVolume = (rowId, v) => {
    updateEditBank(b => ({ ...b, volumes: { ...b.volumes, [rowId]: v } }));
  };
  const toggleRowMute = (rowId) => {
    updateEditBank(b => ({ ...b, mutes: { ...b.mutes, [rowId]: !b.mutes[rowId] } }));
  };
  const setRowRevSend = (rowId, v) => {
    updateEditBank(b => ({ ...b, reverbSends: { ...b.reverbSends, [rowId]: v } }));
  };
  const setRowDelSend = (rowId, v) => {
    updateEditBank(b => ({ ...b, delaySends: { ...b.delaySends, [rowId]: v } }));
  };
  const setBankReverbAmount = (v) => {
    updateEditBank(b => ({ ...b, reverbAmount: v }));
  };
  const setBankSwing = (v) => {
    updateEditBank(b => ({ ...b, swing: Math.round(Math.max(0, Math.min(66, v))) }));
  };

  // ----- Bank handlers -----
  const selectBank = (idx) => { setEditBank(idx); setActivePreset(null); };

  // ----- Presets -----
  const applyPreset = (name) => {
    const nb = bankFromPreset(name);
    setBanks(prev => prev.map((b, i) => (i === editBank ? nb : b)));
    setBpmState(PRESETS[name].bpm ?? 92);
    setActivePreset(name);
  };
  const clearEditBank = () => {
    setBanks(prev => prev.map((b, i) => (i === editBank ? emptyBank() : b)));
    setActivePreset(null);
  };

  // ----- Samples -----
  const loadSample = async (rowId, file) => {
    if (!engineRef.current?.ctx) return;
    try {
      const ab = await file.arrayBuffer();
      const buf = await engineRef.current.ctx.decodeAudioData(ab.slice(0));
      if (buf.duration > 10) {
        setToast(`"${file.name}" is ${buf.duration.toFixed(1)}s — over the 10s cap. Trim and try again.`);
        return;
      }
      engineRef.current.setSample(rowId, buf);
      setSamples(prev => ({ ...prev, [rowId]: { name: file.name, buffer: buf } }));
      if (!sampleNoticeShown.current) {
        sampleNoticeShown.current = true;
        setToast('Samples live in memory only — reload reverts rows to the synth voices.');
      }
    } catch (err) {
      setToast(`Couldn't decode "${file.name}". Try a different .wav or .mp3.`);
    }
  };
  const clearSample = (rowId) => {
    engineRef.current?.setSample(rowId, null);
    setSamples(prev => {
      const n = { ...prev }; delete n[rowId]; return n;
    });
  };

  // ----- Export -----
  const exportWav = async () => {
    if (exporting) return;
    if (playing) { engineRef.current.stop(); setPlaying(false); }
    setExporting(true); setExportProgress(0);
    try {
      const audioBuffer = await renderOffline({
        banks, chain, bpm, delayFeedback, delayTime,
        samples: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.buffer])),
        onProgress: setExportProgress,
      });
      const trimmed = trimSilentTail(audioBuffer);
      const blob = encodeWav(trimmed);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url; a.download = `pattern-16-${ts}.wav`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      setToast(`Export failed: ${err.message || err}`);
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  };

  // Keyboard
  useEffect(() => {
    if (!started) return;
    const onKey = (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [started, playing]);

  if (!started) return <Splash onStart={start} />;

  const playingBankIdx = chain[(playState.chainIdx) % chain.length] ?? 0;

  return (
    <div className="machine">
      <div className="chrome">
        <div className="chrome-left">
          <div className="brand">
            <div className="brand-mark"><span/><span/><span/><span/></div>
            <div className="brand-text">
              <div className="brand-name">PATTERN-16</div>
              <div className="brand-sub">DRUM COMPUTER · MK III</div>
            </div>
          </div>
        </div>
        <div className="chrome-right">
          <div className="screws"><span/><span/></div>
        </div>
      </div>

      <div className="transport">
        <div className="transport-left">
          <PlayButton playing={playing} onClick={togglePlay} />
          <button
            className={`export-btn ${exporting ? 'busy' : ''}`}
            onClick={exportWav}
            disabled={exporting}
            title="Bounce the current chain to WAV"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M12 3 L12 14 M7 10 L12 15 L17 10 M4 18 L20 18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>EXPORT</span>
          </button>
          <BPMControl bpm={bpm} setBpm={setBpmState} />
          <div className="meter">
            <div className="meter-label">STEP</div>
            <div className="meter-val">
              {String((playState.step < 0 ? 0 : playState.step) + 1).padStart(2, '0')}/16
            </div>
          </div>
        </div>

        <div className="transport-center">
          <div className="ctl-band">
            <BankBar
              banks={banks}
              editBank={editBank}
              playingBank={playingBankIdx}
              isPlaying={playing}
              onSelect={selectBank}
            />
            <ChainEditor
              chain={chain}
              setChain={setChain}
              playingChainIdx={playState.chainIdx}
              isPlaying={playing}
            />
            <div className="presets-panel">
              <div className="band-label">PATTERNS <span className="band-sub">→ BANK {BANK_LETTERS[editBank]}</span></div>
              <div className="presets-row">
                {Object.keys(PRESETS).map(name => (
                  <button
                    key={name}
                    className={`preset ${activePreset === name ? 'active' : ''}`}
                    onClick={() => applyPreset(name)}
                  >
                    <span className="preset-led"/>
                    {name}
                  </button>
                ))}
                <button className="preset clear" onClick={clearEditBank}>
                  <span className="preset-led"/>
                  CLEAR
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="transport-right">
          <SendsPanel
            swing={bank.swing}
            setSwing={setBankSwing}
            reverbAmount={bank.reverbAmount}
            setReverbAmount={setBankReverbAmount}
            delayFeedback={delayFeedback}
            setDelayFeedback={setDelayFeedback}
            delayTime={delayTime}
            setDelayTime={setDelayTime}
          />
        </div>
      </div>

      <div className="body">
        <div className="rows">
          {ROWS.map((r, ri) => {
            const isMuted = bank.mutes[r.id];
            const sample = samples[r.id];
            return (
              <div key={r.id} className={`row ${isMuted ? 'muted' : ''}`}>
                <div className="row-ctrls">
                  <div className="row-name-wrap">
                    <span className="row-num">{String(ri + 1).padStart(2, '0')}</span>
                    <SampleSlot
                      rowId={r.id}
                      label={r.label}
                      sample={sample}
                      onLoad={(file) => loadSample(r.id, file)}
                      onClear={() => clearSample(r.id)}
                      dragOver={dragOver === r.id}
                      setDragOver={setDragOver}
                    />
                    <span className="row-pulse" key={flash[r.id] || 0} />
                  </div>
                  <VolumeSlider value={bank.volumes[r.id]} onChange={(v) => setRowVolume(r.id, v)} />
                  <div className="row-sends">
                    <MiniSend
                      value={bank.reverbSends[r.id]}
                      onChange={(v) => setRowRevSend(r.id, v)}
                      letter="R"
                      color="rev"
                    />
                    <MiniSend
                      value={bank.delaySends[r.id]}
                      onChange={(v) => setRowDelSend(r.id, v)}
                      letter="D"
                      color="del"
                    />
                  </div>
                  <button
                    className={`mute ${isMuted ? 'on' : ''}`}
                    onClick={() => toggleRowMute(r.id)}
                    aria-label="Mute"
                  >M</button>
                </div>
                <div className="steps">
                  {bank.pattern[r.id].map((cell, si) => (
                    <React.Fragment key={si}>
                      <Step
                        cell={cell}
                        current={playState.step === si}
                        downbeat={si % 4 === 0}
                        rowIndex={ri}
                        stepIndex={si}
                        onClick={(e) => onStepClick(r.id, si, e)}
                        onContextMenu={(e) => onStepContext(r.id, si, e)}
                      />
                      {si % 4 === 3 && si < 15 && <span className="step-gap" />}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="col-strip">
          <div className="col-strip-left">
            <span className="hint">SHIFT/RIGHT-CLICK: VELOCITY · ALT-CLICK: PROBABILITY · DROP AUDIO ON A ROW LABEL</span>
          </div>
          <div className="col-strip-steps">
            {Array.from({ length: 16 }).map((_, i) => (
              <React.Fragment key={i}>
                <div className={`col-num ${playState.step === i ? 'active' : ''} ${i % 4 === 0 ? 'down' : ''}`}>
                  {i + 1}
                </div>
                {i % 4 === 3 && i < 15 && <span className="step-gap" />}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      <div className="footer">
        <div className="footer-text">
          <span className={`dot ${playing ? 'live' : ''}`} /> {playing ? 'RUNNING' : 'STANDBY'}
          <span className="sep">·</span>
          BANK {BANK_LETTERS[playing ? playingBankIdx : editBank]}{!playing && <span className="sub-tag"> (EDIT)</span>}
          <span className="sep">·</span>
          CHAIN {Math.min(playState.chainIdx % chain.length, chain.length - 1) + 1}/{chain.length}
          <span className="sep">·</span>
          BPM {bpm}
          <span className="sep">·</span>
          SWING {Math.round(bank.swing)}%
          <span className="sep">·</span>
          DELAY {delayTime}
        </div>
      </div>

      {exporting && <ExportModal progress={exportProgress} onCancel={() => {}} />}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
