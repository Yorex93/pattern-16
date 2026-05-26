import { Fragment, useEffect, useMemo, useState } from 'react';
import { SCALES, DEFAULT_MELODY_KEY } from './scales.js';

// Piano-roll editor for a single pitched slot. Replaces the normal 16-step grid
// in that row when MEL mode is active. 24 semitones tall × 16 steps wide.
//
// Click on empty cell        → place length-1 note (snap-to-scale unless alt).
// Click on existing note     → remove it.
// Shift-click empty          → place loud length-1 note.
// Shift-click existing       → cycle velocity (medium → loud → soft).
// Alt-click existing         → cycle probability (100 → 75 → 50 → 25).
// Alt-click empty            → place chromatic (no snap).
// Pointer-down + drag right  → place / extend note across the dragged span.
// Pointer-down on a TAIL     → no-op (only heads are interactive).
//
// Polyphony: chord-stab and pad allow up to 4 simultaneous notes per step.
// Mono voices replace any existing note whose span overlaps the new note.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const NOTES_SHOWN = 24;

function noteLabel(midi) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function isPolyphonic(soundKey) {
  return soundKey === 'chord-stab' || soundKey === 'pad';
}

// Range overlap helper used by mono/poly placement rules.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return !(aEnd < bStart || aStart > bEnd);
}

export function MelodyEditor({ slot, slotIdx, currentStep, onChange, onMelKey }) {
  const defaultNote = slot.defaultNote ?? 48;
  const baseNote = defaultNote - 4; // 4 semitones below the slot's default; 19 above
  const melody = slot.melody || [];

  const keyName = slot.melodyKey || DEFAULT_MELODY_KEY;
  const { root: keyRoot, scale: keyScale } = SCALES[keyName] || SCALES[DEFAULT_MELODY_KEY];
  const inScale = useMemo(() => new Set(keyScale), [keyScale]);

  // Snap an out-of-scale MIDI pitch to the nearest in-scale pitch.
  const snapToScale = (midiPitch) => {
    const semi = ((midiPitch % 12) + 12) % 12;
    if (inScale.has(semi)) return midiPitch;
    for (let d = 1; d <= 6; d++) {
      if (inScale.has(((semi - d) % 12 + 12) % 12)) return midiPitch - d;
      if (inScale.has((semi + d) % 12)) return midiPitch + d;
    }
    return midiPitch;
  };

  const poly = isPolyphonic(slot.sound);

  // ---------- Drag state ----------
  // drag = { rowPitch, startStep, endStep, isNewNote, modifiedNoteIdx, shift, alt, dragged }
  const [drag, setDrag] = useState(null);

  // Compute the "effective" melody = real melody + drag preview. Drives the
  // grid rendering so users see the note materialize as they drag.
  const effectiveMelody = useMemo(() => {
    if (!drag) return melody;
    const length = drag.endStep - drag.startStep + 1;
    if (drag.isNewNote) {
      const previewPitch = drag.alt ? drag.rowPitch : snapToScale(drag.rowPitch);
      return [
        ...melody,
        { step: drag.startStep, pitch: previewPitch, length, velocity: drag.shift ? 2 : 1, probability: 100, __preview: true },
      ];
    }
    return melody.map((n, i) => i === drag.modifiedNoteIdx ? { ...n, length } : n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [melody, drag]);

  // Span lookup keyed by `step|pitch`. Includes the drag preview so rendering
  // and hit-testing during the drag both reflect the in-progress note.
  const noteSpansAt = useMemo(() => {
    const map = {};
    for (let i = 0; i < effectiveMelody.length; i++) {
      const n = effectiveMelody[i];
      for (let s = n.step; s < n.step + (n.length || 1) && s <= 16; s++) {
        const key = `${s}|${n.pitch}`;
        (map[key] ||= []).push({ idx: i, isHead: s === n.step });
      }
    }
    return map;
  }, [effectiveMelody]);

  // ---------- Click logic (no-drag path) ----------
  const handleCellClick = (step, pitch, shift, alt) => {
    const span = noteSpansAt[`${step}|${pitch}`];
    if (span && span.length) {
      const head = span.find(x => x.isHead);
      if (!head) return; // tail-only — no-op
      const i = head.idx;
      const n = melody[i];
      if (!n) return;
      if (shift) {
        const cyc = [1, 2, 0];
        const cur = cyc.indexOf(n.velocity);
        const nv = cyc[(cur + 1) % cyc.length];
        const out = [...melody]; out[i] = { ...n, velocity: nv };
        onChange(out);
        return;
      }
      if (alt) {
        const cyc = [100, 75, 50, 25];
        const cur = cyc.indexOf(n.probability ?? 100);
        const np = cyc[(cur + 1) % cyc.length];
        const out = [...melody]; out[i] = { ...n, probability: np };
        onChange(out);
        return;
      }
      // Remove
      onChange(melody.filter((_, j) => j !== i));
    } else {
      // Place a length-1 note. Snap unless alt-held.
      const placedPitch = alt ? pitch : snapToScale(pitch);
      const filtered = poly
        ? melody.filter(n => !(n.step === step && n.pitch === placedPitch))
        : melody.filter(n => !(n.step <= step && step < n.step + (n.length || 1)));
      if (poly) {
        const sameStep = filtered.filter(n => n.step === step);
        if (sameStep.length >= 4) return;
      }
      onChange([...filtered, { step, pitch: placedPitch, length: 1, velocity: shift ? 2 : 1, probability: 100 }]);
    }
  };

  // ---------- Pointer handlers ----------
  const handlePointerDown = (step, pitch, e) => {
    e.preventDefault();
    const spans = noteSpansAt[`${step}|${pitch}`];
    const head = spans?.find(x => x.isHead);
    const isHead = !!head;
    const isTail = !!(spans && spans.length && !isHead);
    if (isTail) return; // tail clicks/drags do nothing
    setDrag({
      rowPitch: pitch,
      startStep: step,
      endStep: step,
      isNewNote: !isHead,
      modifiedNoteIdx: isHead ? head.idx : -1,
      shift: e.shiftKey,
      alt: e.altKey,
      dragged: false,
    });
  };

  const handlePointerEnter = (step, pitch) => {
    if (!drag) return;
    if (pitch !== drag.rowPitch) return;
    if (step < drag.startStep) return;
    if (step === drag.endStep) return;
    setDrag(d => ({ ...d, endStep: step, dragged: true }));
  };

  // Finalize on global pointerup so releases outside cells still resolve.
  useEffect(() => {
    if (!drag) return;
    const onUp = () => {
      const d = drag;
      const length = d.endStep - d.startStep + 1;
      if (!d.dragged || length === 1) {
        // Treat as a click (no measurable drag)
        handleCellClick(d.startStep, d.rowPitch, d.shift, d.alt);
        setDrag(null);
        return;
      }
      // Drag finalized — place or extend the note.
      const newStart = d.startStep;
      const newEnd = d.endStep;

      if (d.isNewNote) {
        const placedPitch = d.alt ? d.rowPitch : snapToScale(d.rowPitch);
        // Mono: remove any note overlapping the new span. Poly: only remove
        // notes at the same pitch that overlap the new span.
        const next = melody.filter(n => {
          if (poly && n.pitch !== placedPitch) return true;
          const ns = n.step;
          const ne = n.step + (n.length || 1) - 1;
          return !rangesOverlap(newStart, newEnd, ns, ne);
        });
        if (poly) {
          const sameStepCount = next.filter(n => n.step === newStart).length;
          if (sameStepCount >= 4) { setDrag(null); return; }
        }
        onChange([...next, {
          step: newStart, pitch: placedPitch, length,
          velocity: d.shift ? 2 : 1, probability: 100,
        }]);
      } else {
        const original = melody[d.modifiedNoteIdx];
        if (!original) { setDrag(null); return; }
        const next = melody
          .map((n, i) => i === d.modifiedNoteIdx ? { ...n, length } : n)
          .filter((n, i) => {
            if (i === d.modifiedNoteIdx) return true;
            if (poly && n.pitch !== original.pitch) return true;
            const ns = n.step;
            const ne = n.step + (n.length || 1) - 1;
            return !rangesOverlap(newStart, newEnd, ns, ne);
          });
        onChange(next);
      }
      setDrag(null);
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  // ---------- Row data ----------
  const rows = [];
  for (let r = NOTES_SHOWN - 1; r >= 0; r--) {
    const pitch = baseNote + r;
    const semi = ((pitch % 12) + 12) % 12;
    rows.push({
      pitch, semi,
      isBlack: BLACK_KEYS.has(semi),
      isRoot: semi === keyRoot,
      isInScale: inScale.has(semi),
    });
  }

  // Length label that follows the cursor during drag
  const dragLength = drag ? drag.endStep - drag.startStep + 1 : 0;

  return (
    <div className="melody-editor">
      <div className="melody-header">
        <span className="melody-title">MELODY · {slot.sound?.toUpperCase()} {poly && <span className="melody-poly">(poly)</span>}</span>
        <label className="melody-key">
          <span>KEY</span>
          <select value={keyName} onChange={(e) => onMelKey(e.target.value)}>
            {Object.keys(SCALES).map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>
      <div className="melody-grid">
        {rows.map(({ pitch, semi, isBlack, isRoot, isInScale }) => {
          const isC = semi === 0;
          return (
            <div key={pitch} className={`melody-row ${isBlack ? 'black' : ''} ${isRoot ? 'root' : ''} ${!isInScale ? 'oos' : ''} ${isC ? 'octave' : ''}`}>
              {Array.from({ length: 16 }, (_, s) => {
                const step = s + 1;
                const spans = noteSpansAt[`${step}|${pitch}`];
                const has = spans && spans.length > 0;
                const isHead = has && spans.some(x => x.isHead);
                const headIdx = has ? (spans.find(x => x.isHead)?.idx ?? spans[0].idx) : -1;
                const note = headIdx >= 0 ? effectiveMelody[headIdx] : null;
                const vel = note?.velocity ?? 1;
                const prob = note?.probability ?? 100;
                const isPreview = !!note?.__preview;
                const cur = currentStep === s;
                const isTail = has && !isHead;
                return (
                  <Fragment key={s}>
                    <button
                      className={
                        `step melody-cell ${has ? 'on' : ''} ${has ? `v${vel}` : ''} ` +
                        `${isHead ? 'head' : ''} ${isTail ? 'tail' : ''} ` +
                        `${cur ? 'current' : ''} ${s % 4 === 0 ? 'downbeat' : ''} ` +
                        `${prob < 100 ? 'prob' : ''} ${isPreview ? 'preview' : ''}`
                      }
                      onPointerDown={(e) => handlePointerDown(step, pitch, e)}
                      onPointerEnter={() => handlePointerEnter(step, pitch)}
                      onContextMenu={(e) => { e.preventDefault(); handleCellClick(step, pitch, true, false); }}
                      title={
                        has
                          ? `${noteLabel(pitch)} · ${['SOFT','MED','LOUD'][vel]} · ${prob}%${isTail ? ' (sustain)' : ''}`
                          : `${noteLabel(pitch)} · step ${step}`
                      }
                    >
                      {s === 0 && <span className="melody-cell-label">{noteLabel(pitch)}</span>}
                      {isHead && dragLength > 1 && drag && drag.modifiedNoteIdx === headIdx && (
                        <span className="melody-drag-length">{dragLength}</span>
                      )}
                      {isHead && drag && drag.isNewNote && drag.startStep === step && drag.rowPitch === pitch && dragLength > 1 && (
                        <span className="melody-drag-length">{dragLength}</span>
                      )}
                    </button>
                    {s % 4 === 3 && s < 15 && <span className="step-gap" />}
                  </Fragment>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="melody-hint">CLICK: PLACE (SNAP TO {keyName.toUpperCase()}) · DRAG RIGHT: SET LENGTH · ALT-CLICK: CHROMATIC · SHIFT/ALT-CLICK NOTE: VEL/PROB</div>
    </div>
  );
}
