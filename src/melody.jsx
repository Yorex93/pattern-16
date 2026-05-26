import { useMemo } from 'react';

// Piano-roll editor for a single pitched slot. Replaces the normal 16-step grid
// in that row when MEL mode is active. 24 semitones tall × 16 steps wide.
//
// Interactions:
//   click empty cell: place note (medium velocity, length 1)
//   click existing note: remove it
//   shift-click existing note: cycle velocity (medium → loud → soft → medium)
//   alt-click existing note: cycle probability (100 → 75 → 50 → 25)
//   shift-click empty (with selected length): place loud note
//
// Polyphony: chord-stab and pad allow up to 4 simultaneous notes per step.
// Mono voices replace any existing note at the same step.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

function noteLabel(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

// Scale definitions — semitone classes (0..11)
const SCALES = {
  'A minor':  { root: 9,  scale: [0, 2, 3, 5, 7, 8, 10] },
  'A major':  { root: 9,  scale: [0, 2, 4, 5, 7, 9, 11] },
  'C major':  { root: 0,  scale: [0, 2, 4, 5, 7, 9, 11] },
  'C minor':  { root: 0,  scale: [0, 2, 3, 5, 7, 8, 10] },
  'D minor':  { root: 2,  scale: [0, 2, 3, 5, 7, 8, 10] },
  'E minor':  { root: 4,  scale: [0, 2, 3, 5, 7, 8, 10] },
  'F minor':  { root: 5,  scale: [0, 2, 3, 5, 7, 8, 10] },
  'F# minor': { root: 6,  scale: [0, 2, 3, 5, 7, 8, 10] },
  'G minor':  { root: 7,  scale: [0, 2, 3, 5, 7, 8, 10] },
};

function isPolyphonic(soundKey) {
  return soundKey === 'chord-stab' || soundKey === 'pad';
}

export function MelodyEditor({ slot, slotIdx, currentStep, onChange, onMelKey }) {
  const defaultNote = slot.defaultNote ?? 48;
  // Show 2 octaves centered around defaultNote (root anchored at row 0 from bottom)
  const baseNote = defaultNote - 4; // 4 semis below root, 19 above
  const NOTES_SHOWN = 24;
  const melody = slot.melody || [];

  const keyName = slot.melodyKey || 'A minor';
  const { root: keyRoot, scale: keyScale } = SCALES[keyName] || SCALES['A minor'];
  const inScale = useMemo(() => {
    const out = new Set();
    for (const semi of keyScale) out.add(semi);
    return out;
  }, [keyScale]);

  // Build a (pitch, step) → note lookup for hit-testing
  const noteAt = useMemo(() => {
    const map = {};
    for (let i = 0; i < melody.length; i++) {
      const n = melody[i];
      map[`${n.step}|${n.pitch}`] = i;
    }
    return map;
  }, [melody]);

  // Multi-step span lookup: which steps does each note occupy
  const noteSpansAt = useMemo(() => {
    // map[step][pitch] → array of indices whose span covers this cell
    const map = {};
    for (let i = 0; i < melody.length; i++) {
      const n = melody[i];
      for (let s = n.step; s < n.step + (n.length || 1) && s <= 16; s++) {
        const key = `${s}|${n.pitch}`;
        (map[key] ||= []).push({ idx: i, isHead: s === n.step });
      }
    }
    return map;
  }, [melody]);

  const poly = isPolyphonic(slot.sound);

  const handleCellClick = (step, pitch, e) => {
    e.preventDefault();
    const span = noteSpansAt[`${step}|${pitch}`];
    if (span && span.length) {
      // Existing note (or its tail). Find the head and modify the head.
      const head = span.find(x => x.isHead) || span[0];
      const i = head.idx;
      const n = melody[i];
      if (e.shiftKey) {
        // cycle velocity 1 → 2 → 0 → 1
        const next = [1, 2, 0];
        const cur = next.indexOf(n.velocity);
        const nv = next[(cur + 1) % next.length];
        const out = [...melody];
        out[i] = { ...n, velocity: nv };
        onChange(out);
        return;
      }
      if (e.altKey) {
        const next = [100, 75, 50, 25];
        const cur = next.indexOf(n.probability ?? 100);
        const np = next[(cur + 1) % next.length];
        const out = [...melody];
        out[i] = { ...n, probability: np };
        onChange(out);
        return;
      }
      // Remove
      onChange(melody.filter((_, j) => j !== i));
    } else {
      // Place a new note. For mono slots, remove any existing note at the same step.
      const filtered = poly ? melody : melody.filter(n => {
        // Drop notes whose span covers this step
        return !(n.step <= step && step < n.step + (n.length || 1));
      });
      const next = [...filtered, { step, pitch, length: 1, velocity: e.shiftKey ? 2 : 1, probability: 100 }];
      // Limit polyphony to 4 simultaneous notes on this step
      if (poly) {
        const sameStep = next.filter(n => n.step === step);
        if (sameStep.length > 4) return;
      }
      onChange(next);
    }
  };

  // Note rows: top of editor is highest pitch
  const rows = [];
  for (let r = NOTES_SHOWN - 1; r >= 0; r--) {
    const pitch = baseNote + r;
    const semi = ((pitch % 12) + 12) % 12;
    const isBlack = BLACK_KEYS.has(semi);
    const isRoot = semi === keyRoot;
    const isInScale = inScale.has(semi);
    rows.push({ pitch, semi, isBlack, isRoot, isInScale });
  }

  return (
    <div className="melody-editor">
      <div className="melody-header">
        <span className="melody-title">MELODY · {slot.sound?.toUpperCase()} {poly && <span className="melody-poly">(poly)</span>}</span>
        <label className="melody-key">
          <span>KEY</span>
          <select
            value={keyName}
            onChange={(e) => onMelKey(e.target.value)}
          >
            {Object.keys(SCALES).map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>
      <div className="melody-grid">
        {rows.map(({ pitch, isBlack, isRoot, isInScale }) => (
          <div key={pitch} className={`melody-row ${isBlack ? 'black' : ''} ${isRoot ? 'root' : ''} ${!isInScale ? 'oos' : ''}`}>
            <div className="melody-label" title={noteLabel(pitch)}>{noteLabel(pitch)}</div>
            <div className="melody-cells">
              {Array.from({ length: 16 }, (_, s) => {
                const step = s + 1;
                const spans = noteSpansAt[`${step}|${pitch}`];
                const has = spans && spans.length > 0;
                const isHead = has && spans.some(x => x.isHead);
                const headIdx = has ? (spans.find(x => x.isHead)?.idx ?? spans[0].idx) : -1;
                const note = headIdx >= 0 ? melody[headIdx] : null;
                const vel = note?.velocity ?? 1;
                const prob = note?.probability ?? 100;
                const cur = currentStep === s;
                return (
                  <button
                    key={s}
                    className={`melody-cell ${has ? 'on' : ''} ${has ? `v${vel}` : ''} ${isHead ? 'head' : ''} ${cur ? 'current' : ''} ${s % 4 === 0 ? 'downbeat' : ''} ${prob < 100 ? 'prob' : ''}`}
                    onClick={(e) => handleCellClick(step, pitch, e)}
                    onContextMenu={(e) => { e.preventDefault(); handleCellClick(step, pitch, { ...e, shiftKey: true }); }}
                    title={has ? `${noteLabel(pitch)} · ${['SOFT','MED','LOUD'][vel]} · ${prob}%` : `${noteLabel(pitch)} · step ${step}`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="melody-hint">CLICK: PLACE/REMOVE · SHIFT-CLICK: VELOCITY · ALT-CLICK: PROBABILITY</div>
    </div>
  );
}
