import { Fragment, useState, useEffect, useRef, useCallback } from 'react';
import { DrumEngine, renderOffline, trimSilentTail, encodeWav, SLOT_COUNT } from './audio-engine.js';
import { Splash, Knob, MiniSend, VolumeSlider, PlayButton, BPMControl, PitchedStep, PercStep } from './components.jsx';
import { ImportJsonModal, ExportJsonModal, ShareModal } from './json-modals.jsx';
import { MixModal } from './mix-modal.jsx';
import { MelodyEditor } from './melody.jsx';
import { AI_SYSTEM_PROMPT } from './json-io.js';
import { readShareFromHash, clearShareHash, decodeShare } from './share.js';
import {
  PALETTE, CATEGORIES, SOUND_KEYS, CHORD_TYPES,
  isPitched, hasFilter, hasChord, tunableValues, isContinuous, defaultNote, defaultFilter, defaultChord,
  DEFAULT_LOADOUT, noteLabel, shortNoteLabel,
} from './sounds.js';
import { DEFAULT_BANK_CHORD, chordLabel, ROOT_NAMES_SHARP, CHORD_TYPES_V5 } from './scales.js';
import { PalettePopover, NotePicker, SlotSettingsPopover, KitsPopover, BankChordPopover } from './slot-ui.jsx';
import { KITS, getKit } from './kits.js';

const BANK_LETTERS = ['A', 'B', 'C', 'D'];
const DELAY_OPTIONS = ['1/8', '1/4', '3/8', '1/2'];
const SLOT_IDX = Array.from({ length: SLOT_COUNT }, (_, i) => i);

// ----- Cell helpers -----
const emptyCell = () => ({ on: false, velocity: 1, probability: 100 });
const onCell = (velocity = 1, probability = 100) => ({ on: true, velocity, probability });
const EMPTY_ROW = () => Array.from({ length: 16 }, emptyCell);

// ----- Slot helpers -----
function emptySlot(sound = null) {
  const slot = {
    sound,
    pattern: EMPTY_ROW(),
    volume: 0.85,
    mute: false,
    reverbSend: 0,
    delaySend: 0,
    drive: 0,
  };
  if (sound) {
    if (isPitched(sound)) {
      slot.defaultNote = defaultNote(sound);
      slot.glide = false;
    }
    if (hasFilter(sound)) slot.filter = defaultFilter(sound);
    if (hasChord(sound)) slot.chordType = defaultChord(sound);
    const tv = tunableValues(sound);
    if (tv) slot.tunable = tv[Math.floor(tv.length / 2)] ?? tv[0];
  }
  return slot;
}

function emptyBank(loadout = DEFAULT_LOADOUT) {
  return {
    slots: loadout.slice(0, SLOT_COUNT).map(s => emptySlot(s)),
    swing: 0,
    reverbAmount: 0.25,
    // v5: bank-level chord that the chord-stab voice plays and follow-chord
    // pitched slots transpose against. New banks get A minor by default.
    chord: { ...DEFAULT_BANK_CHORD },
  };
}

// When the user changes a slot's sound, preserve pattern + mix but reset
// sound-specific config (glide/chord/filter/tunable/defaultNote). Also normalize
// note fields on active steps so they make sense for the new voice.
function reassignSlotSound(slot, newSound) {
  const next = {
    ...slot,
    sound: newSound,
  };
  // Strip sound-specific config; re-add as appropriate
  delete next.defaultNote;
  delete next.glide;
  delete next.filter;
  delete next.chordType;
  delete next.tunable;
  if (newSound) {
    if (isPitched(newSound)) {
      next.defaultNote = defaultNote(newSound);
      next.glide = slot.glide ?? false;
      // Initialize/normalize per-cell notes: keep existing notes if any, else default
      next.pattern = slot.pattern.map(c => {
        if (!c.on) return c;
        return { ...c, note: c.note ?? next.defaultNote };
      });
    } else {
      next.pattern = slot.pattern.map(c => {
        if (!c.on) return c;
        const { note, ...rest } = c;
        return rest;
      });
    }
    if (hasFilter(newSound)) next.filter = slot.filter ?? defaultFilter(newSound);
    if (hasChord(newSound)) next.chordType = slot.chordType ?? defaultChord(newSound);
    const tv = tunableValues(newSound);
    if (tv) next.tunable = (tv.includes(slot.tunable) ? slot.tunable : tv[Math.floor(tv.length / 2)] ?? tv[0]);
  }
  return next;
}

// ----- Preset row helper. Spec: '.' or 0=off; n=on(vel=n); [v,p]=on; [v,p,off]=on with note offset (pitched). -----
function row(spec, baseNote) {
  return spec.map(e => {
    if (e === '.' || e === 0) return emptyCell();
    if (typeof e === 'number') {
      const c = onCell(e, 100);
      if (baseNote != null) c.note = baseNote;
      return c;
    }
    if (Array.isArray(e)) {
      const c = onCell(e[0], e[1] ?? 100);
      if (baseNote != null) c.note = baseNote + (e[2] ?? 0);
      return c;
    }
    return emptyCell();
  });
}

// Build a slot from a sound + pattern + overrides
function makeSlot(sound, pattern, overrides = {}) {
  const base = emptySlot(sound);
  return {
    ...base,
    pattern,
    ...overrides,
  };
}

// Presets pair a kit (which sets slot sound assignments + mix/config) with a
// step pattern per slot. Pattern entries follow the row() DSL — pitched slots
// don't need explicit notes here; the loader fills in the kit's defaultNote.
// Presets now ship 2-bank chord progressions so harmonic movement is audible
// on first play. Each bank entry holds a chord + per-slot patterns. The
// `chain` walks through bank indices (0 = A, 1 = B). `followChord` lists the
// slot indices where chord-follow should be enabled (typically the bass).
// `melodyKey` per slot sets the reference key used by follow-chord transposition.
const PRESETS = {
  'BOOM-BAP': {
    kitId: 'boom-bap',
    bpm: 88,
    swing: 56,
    reverbAmount: 0.32,
    chain: [0, 0, 1, 0],
    // 808 pattern is intentionally empty (the A2 default was too boomy) but
    // the slot is still wired for follow-chord — if a user adds hits, they'll
    // transpose down a fifth on bank B (Dm7) automatically.
    followChord: [false, false, false, false, false, false, false, true],
    melodyKey: { 7: 'A minor' },
    banks: [
      {
        chord: { root: 'A', type: 'm7' },
        patterns: [
          row([2,'.','.','.', '.','.',1,'.', 1,'.','.','.', '.','.','.','.']),
          row(['.','.','.','.', 2,'.','.','.', '.','.','.','.', 2,'.','.','.']),
          row([1,'.',1,'.', 1,'.',1,'.', 1,'.',1,'.', 1,'.',1,'.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.',1,'.']),
          row(['.','.',[1,75],'.', '.','.','.','.', '.','.',[1,75],'.', '.','.','.','.']),
          row([1,'.','.','.', 1,'.','.','.', 1,'.','.','.', 1,'.','.','.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.','.','.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.','.','.']), // 808 empty
        ],
      },
      {
        chord: { root: 'D', type: 'm7' },
        patterns: [
          row([2,'.','.','.', '.','.',1,'.', 1,'.','.','.', '.','.','.','.']),
          row(['.','.','.','.', 2,'.','.','.', '.','.','.','.', 2,'.','.','.']),
          row([1,'.',1,'.', 1,'.',1,'.', 1,'.',1,'.', 1,'.',1,'.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.',1,'.']),
          row(['.','.',[1,75],'.', '.','.','.','.', '.','.',[1,75],'.', '.','.','.','.']),
          row([1,'.','.','.', 1,'.','.','.', 1,'.','.','.', 1,'.','.','.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.','.','.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.','.','.']), // 808 empty
        ],
      },
    ],
  },

  'TRAP': {
    kitId: 'trap',
    bpm: 140,
    swing: 0,
    reverbAmount: 0.22,
    chain: [0, 0, 1, 1],
    // 808 pattern intentionally empty; follow-chord stays wired so hits the
    // user adds on slot 7 will transpose from F to C on bank B (Cm).
    followChord: [false, false, false, false, false, false, true, false],
    melodyKey: { 6: 'F minor' },
    banks: [
      {
        chord: { root: 'F', type: 'minor' },
        patterns: [
          row([2,'.','.','.', '.','.',1,'.', '.','.',1,'.', '.','.','.','.']),
          row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 1,'.','.','.']),
          row([1,[1,75],1,[1,50], 1,[1,75],1,[1,75], 1,[1,50],1,[1,75], 1,[1,75],[1,50],[1,75]]),
          row(['.','.','.','.', '.','.','.','.', '.','.',1,'.', '.','.','.','.']),
          row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 1,'.','.','.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.',1,'.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.','.','.']), // 808 empty
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.','.','.']),
        ],
      },
      {
        chord: { root: 'C', type: 'minor' },
        patterns: [
          row([2,'.','.','.', '.','.',1,'.', '.','.',1,'.', '.','.','.','.']),
          row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 1,'.','.','.']),
          row([1,[1,75],1,[1,50], 1,[1,75],1,[1,75], 1,[1,50],1,[1,75], 1,[1,75],[1,50],[1,75]]),
          row(['.','.','.','.', '.','.','.','.', '.','.',1,'.', '.','.','.','.']),
          row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 1,'.','.','.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.',1,'.']),
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.','.','.']), // 808 empty
          row(['.','.','.','.', '.','.','.','.', '.','.','.','.', '.','.','.','.']),
        ],
      },
    ],
  },

  'HOUSE': {
    kitId: 'house',
    bpm: 124,
    swing: 0,
    reverbAmount: 0.20,
    chain: [0, 1, 0, 1],
    followChord: [false, false, false, false, false, false, false, true],
    melodyKey: { 7: 'A minor' },
    banks: [
      {
        chord: { root: 'A', type: 'm7' },
        patterns: [
          row([2,'.','.','.', 1,'.','.','.', 1,'.','.','.', 1,'.','.','.']),
          row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 2,'.','.','.']),
          row(['.','.',1,'.', '.','.',1,'.', '.','.',1,'.', '.','.',1,'.']),
          row(['.','.','.','.', '.','.',1,'.', '.','.','.','.', '.','.',1,'.']),
          row([1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1]),
          row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 1,'.','.','.']),
          // Chord stab fires off-beats — the chord it plays comes from the
          // bank, not the slot. The note here is just a placeholder pitch.
          row(['.','.',1,'.', '.','.',1,'.', '.','.',1,'.', '.','.',1,'.'], 48),
          // Sub-bass root A2 (45); bank B (Fmaj7) transposes to F2 via follow-chord.
          row([1,'.','.','.', '.','.','.','.', 1,'.','.','.', '.','.','.','.'], 45),
        ],
      },
      {
        chord: { root: 'F', type: 'maj7' },
        patterns: [
          row([2,'.','.','.', 1,'.','.','.', 1,'.','.','.', 1,'.','.','.']),
          row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 2,'.','.','.']),
          row(['.','.',1,'.', '.','.',1,'.', '.','.',1,'.', '.','.',1,'.']),
          row(['.','.','.','.', '.','.',1,'.', '.','.','.','.', '.','.',1,'.']),
          row([1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1]),
          row(['.','.','.','.', 1,'.','.','.', '.','.','.','.', 1,'.','.','.']),
          row(['.','.',1,'.', '.','.',1,'.', '.','.',1,'.', '.','.',1,'.'], 48),
          row([1,'.','.','.', '.','.','.','.', 1,'.','.','.', '.','.','.','.'], 45),
        ],
      },
    ],
  },
};

// ----- Kit + preset application helpers -----

// Apply a kit to a fresh blank slot array (preservePattern=false) or to existing
// slots (preservePattern=true, used by the user-facing "load kit" action which
// must keep the user's pattern intact).
function slotsFromKit(kit, basePatternSlots, preservePattern) {
  return Array.from({ length: SLOT_COUNT }, (_, i) => {
    const newSound = kit.slots[i] ?? null;
    const slot = emptySlot(newSound);
    if (preservePattern && basePatternSlots) {
      const prev = basePatternSlots[i];
      slot.pattern = prev.pattern.map(c => ({ ...c }));
      if (isPitched(newSound)) {
        for (let j = 0; j < 16; j++) {
          if (slot.pattern[j].on && slot.pattern[j].note == null) slot.pattern[j].note = slot.defaultNote;
        }
      } else {
        for (let j = 0; j < 16; j++) { const c = slot.pattern[j]; if (c.note != null) delete c.note; }
      }
    }
    if (kit.mix?.[i]) Object.assign(slot, kit.mix[i]);
    if (kit.config?.[i]) {
      const cfg = kit.config[i];
      if (cfg.glide != null) slot.glide = cfg.glide;
      if (cfg.chordType != null) slot.chordType = cfg.chordType;
      if (cfg.tunable != null) slot.tunable = cfg.tunable;
      if (cfg.filter) slot.filter = { ...slot.filter, ...cfg.filter };
    }
    return slot;
  });
}

// Build a complete bank from a preset (kit + patterns).
// Sounds that should be ducked when the kick fires. Bass voices + pitched
// tonal voices (chord-stab, pad, pluck). FX (riser, vinyl-bed, vinyl-crackle,
// noise-sweep) are NOT included even though they live in the Tonal category.
const SIDECHAIN_TARGET_SOUNDS = new Set([
  '808', 'sub-bass', 'synth-bass', 'acid-bass', 'reese-bass',
  'chord-stab', 'pad', 'pluck',
]);
function isSidechainTarget(sound) {
  return !!sound && SIDECHAIN_TARGET_SOUNDS.has(sound);
}
// Derive the full target list from a slots array (used on JSON import + init).
function deriveSidechainTargets(slots) {
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    if (isSidechainTarget(slots[i]?.sound)) out.push(i);
  }
  return out;
}
// Delta update: when a single slot's sound changes, add or remove just that
// slot from the targets list. Preserves user manual unchecks on OTHER slots.
function updateTargetsForSlotChange(targets, slotIdx, oldSound, newSound) {
  const was = isSidechainTarget(oldSound);
  const isT = isSidechainTarget(newSound);
  if (was === isT) return targets;
  const set = new Set(targets);
  if (isT) set.add(slotIdx); else set.delete(slotIdx);
  return Array.from(set).sort((a, b) => a - b);
}
// Apply the delta across all 8 slots (used by kit/preset load).
function recomputeTargetsForSlots(prevTargets, prevSlots, newSlots) {
  let t = prevTargets;
  for (let i = 0; i < SLOT_COUNT; i++) {
    t = updateTargetsForSlotChange(t, i, prevSlots[i]?.sound, newSlots[i]?.sound);
  }
  return t;
}

// Build a single bank from a preset's bank entry. Each entry has a chord +
// per-slot patterns. Slot loadout/mix/config come from the preset's kit; the
// preset's followChord and melodyKey lists flag specific slots as chord-followers.
function buildPresetBank(preset, bankEntry) {
  const kit = getKit(preset.kitId) ?? { slots: DEFAULT_LOADOUT.slice() };
  const followChord = preset.followChord || [];
  const melodyKey = preset.melodyKey || {};
  const slots = slotsFromKit(kit, null, false).map((s, i) => {
    const pat = bankEntry.patterns[i] || EMPTY_ROW();
    const next = { ...s, pattern: pat.map(c => ({ ...c })) };
    if (isPitched(s.sound)) {
      for (let j = 0; j < 16; j++) {
        if (next.pattern[j].on && next.pattern[j].note == null) next.pattern[j].note = s.defaultNote;
      }
    }
    if (followChord[i]) next.followChord = true;
    if (melodyKey[i]) next.melodyKey = melodyKey[i];
    return next;
  });
  return {
    slots,
    swing: preset.swing,
    reverbAmount: preset.reverbAmount,
    chord: bankEntry.chord ? { ...bankEntry.chord } : { ...DEFAULT_BANK_CHORD },
  };
}

// Build the full {banks[4], chain, swing, reverbAmount, kitId} state for a
// preset. The chain references the preset's bank indices (0/1); we map those
// into banks slots A/B leaving C/D empty.
function bankFromPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return emptyBank();
  // Legacy single-bank fallback for any preset that hasn't been updated
  if (!preset.banks && preset.patterns) {
    return buildPresetBank(preset, { patterns: preset.patterns });
  }
  return buildPresetBank(preset, preset.banks[0]);
}

// ============================================================
// Sub-components
// ============================================================

function BankBar({ banks, editBank, playingBank, isPlaying, onSelect, onChordClick }) {
  return (
    <div className="bankbar">
      <div className="band-label">BANKS</div>
      <div className="bankbar-row">
        {BANK_LETTERS.map((letter, i) => {
          const isEditing = i === editBank;
          const isPlayingHere = isPlaying && i === playingBank;
          const populated = banks[i].slots.some(s => s.pattern.some(c => c.on));
          const chord = banks[i].chord;
          const label = chord ? chordLabel(chord) : '';
          return (
            <div key={letter} className="bank-cell">
              <button
                className={`bank ${isEditing ? 'editing' : ''} ${isPlayingHere ? 'playing' : ''} ${populated ? 'populated' : ''}`}
                onClick={() => onSelect(i)}
                title={`Bank ${letter}${chord ? ` · ${label}` : ''}${isEditing ? ' (editing)' : ''}${isPlayingHere ? ' · playing' : ''}`}
              >
                <span className="bank-letter">{letter}</span>
                <span className="bank-play-led" />
              </button>
              <button
                className={`bank-chord-badge ${chord ? '' : 'unset'}`}
                onClick={(e) => onChordClick(i, e.currentTarget)}
                title={chord ? `Bank ${letter} chord: ${label} — click to change` : 'No chord set — click to add'}
              >{label || '—'}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChainEditor({ chain, setChain, playingChainIdx, isPlaying }) {
  const cycleCell = (idx) => {
    if (idx > chain.length) return;
    if (idx === chain.length) {
      if (chain.length >= 8) return;
      setChain([...chain, 0]);
      return;
    }
    const cur = chain[idx];
    const isLast = idx === chain.length - 1;
    if (cur >= 3) {
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
            <button key={opt} className={`dt-opt ${delayTime === opt ? 'on' : ''}`} onClick={() => setDelayTime(opt)}>{opt}</button>
          ))}
        </div>
      </div>
      <div className="sends-knobs">
        <Knob value={swing} onChange={setSwing} min={0} max={66} label="SWING" size={52} displayValue={`${Math.round(swing)}`} />
        <Knob value={reverbAmount} onChange={setReverbAmount} label="REVERB" size={52} />
        <Knob value={delayFeedback} onChange={setDelayFeedback} min={0} max={0.8} label="DELAY FB" size={52} displayValue={Math.round(delayFeedback * 100)} />
      </div>
    </div>
  );
}

// Slot label is now a clickable button that opens the palette popover, plus
// retains the sample-upload drop target behavior.
function SlotLabel({ slotIdx, slot, sample, onLoad, onClear, onOpenPalette, dragOver, setDragOver }) {
  const fileRef = useRef(null);
  const handleFile = async (file) => {
    if (!file) return;
    await onLoad(file);
  };
  const meta = slot.sound ? PALETTE[slot.sound] : null;
  const continuous = !!meta?.continuous;
  const label = sample ? sample.name.replace(/\.[^.]+$/, '').slice(0, 10) : (meta?.short ?? '—');

  return (
    <div
      className={`row-name ${dragOver ? 'drag' : ''} ${sample ? 'has-sample' : ''} ${continuous ? 'continuous' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(slotIdx); }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(null);
        handleFile(e.dataTransfer.files?.[0]);
      }}
      onClick={(e) => {
        // Cmd/Ctrl-click → upload sample. Plain click → open palette popover.
        if (e.metaKey || e.ctrlKey) { fileRef.current?.click(); return; }
        onOpenPalette(slotIdx, e.currentTarget);
      }}
      title={sample
        ? `${sample.name} — Cmd/Ctrl-click to replace, × to revert`
        : `${meta?.name ?? 'EMPTY'} — click to change sound · Cmd/Ctrl-click to upload sample · or drop audio`}
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
            <span className="sample-name" title={sample.name}>{label}</span>
          </>
        ) : (
          <>
            <span className="instr-name">{label}</span>
            {continuous && <span className="slot-bed-tag">BED</span>}
          </>
        )}
      </span>
      {sample && (
        <button className="sample-clear" onClick={(e) => { e.stopPropagation(); onClear(); }} title="Revert to assigned voice">×</button>
      )}
    </div>
  );
}

function ExportModal({ progress, onCancel }) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header"><span>RENDERING WAV</span></div>
        <div className="modal-body">
          <div className="modal-progress">
            <div className="modal-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div className="modal-progress-text">{Math.round(progress * 100)}% · bouncing offline</div>
          <div className="modal-hint">Captures the full chain with swing, velocity, probability, samples, pitched notes, and sends.</div>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, onClose }) {
  // Hold onClose in a ref so the auto-dismiss timer only resets when `message`
  // actually changes — not on every parent re-render (the App re-renders many
  // times per second during playback, which previously cancelled the timer
  // before it could fire and the toast stuck around forever).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => onCloseRef.current?.(), 4200);
    return () => clearTimeout(t);
  }, [message]);
  if (!message) return null;
  const isObj = typeof message === 'object';
  const text = isObj ? message.text : message;
  const kind = isObj ? message.kind : null;
  return <div className={`toast ${kind === 'ok' ? 'ok' : ''}`}>{text}</div>;
}

// ============================================================
// App
// ============================================================
function App() {
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
  // Kit tracking: id of the kit last loaded into the edit bank, and whether the
  // user has changed slot sounds since (display only).
  const [currentKit, setCurrentKit] = useState('boom-bap');
  const [kitModified, setKitModified] = useState(false);

  const [delayFeedback, setDelayFeedback] = useState(0.35);
  const [delayTime, setDelayTime] = useState('3/8');

  const [samples, setSamples] = useState({}); // {slotIdx: {name, buffer}}
  const [dragOver, setDragOver] = useState(null);
  const [toast, setToast] = useState(null);
  const sampleNoticeShown = useRef(false);

  const [playState, setPlayStateInternal] = useState({ step: -1, chainIdx: 0 });
  const [flash, setFlash] = useState({});

  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const [patternName, setPatternName] = useState('untitled');
  const [importOpen, setImportOpen] = useState(false);
  const [exportJsonOpen, setExportJsonOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // null | {kind:'loading'} | {kind:'ready', name} | {kind:'failed'} — surfaced on the splash
  const [shareStatus, setShareStatus] = useState(null);
  // Global mix state: master GLUE + sidechain config. Per-slot drive lives on slot.drive.
  // Initial targets are derived from the initial bank's bass/tonal slots so the
  // feature is discoverable on first run (BOOM-BAP starts with 808 in slot 8).
  const [mix, setMix] = useState(() => ({
    glue: 0,
    sidechain: { amount: 0.5, targets: deriveSidechainTargets(bankFromPreset('BOOM-BAP').slots) },
  }));
  const [mixOpen, setMixOpen] = useState(false);

  // Popover/picker state: {slotIdx, anchor}
  const [palettePopover, setPalettePopover] = useState(null);
  const [notePicker, setNotePicker] = useState(null);
  const [slotSettings, setSlotSettings] = useState(null);
  const [kitsPopover, setKitsPopover] = useState(null);
  const [bankChordPopover, setBankChordPopover] = useState(null);

  const engineRef = useRef(null);
  const rafRef = useRef(null);

  const bank = banks[editBank];

  // Refs let start() read the latest state at click-time. Otherwise a pattern
  // loaded async from a share URL would be replaced by the stale closure value
  // when the splash gate boots the engine.
  const stateRef = useRef();
  stateRef.current = { banks, chain, bpm, delayFeedback, delayTime, mix };

  const start = useCallback(() => {
    if (!engineRef.current) {
      const s = stateRef.current;
      const eng = new DrumEngine();
      eng.setBanks(s.banks);
      eng.setMix(s.mix);
      eng.init();
      eng.setBanks(s.banks);
      eng.setChain(s.chain);
      eng.setBPM(s.bpm);
      eng.setDelayFeedback(s.delayFeedback);
      eng.setDelayTime(s.delayTime);
      eng.setMix(s.mix);
      engineRef.current = eng;
    }
    setStarted(true);
  }, []);

  useEffect(() => { engineRef.current?.setBanks(banks); }, [banks]);
  useEffect(() => { engineRef.current?.setChain(chain); }, [chain]);
  useEffect(() => { engineRef.current?.setBPM(bpm); }, [bpm]);
  useEffect(() => { engineRef.current?.setDelayFeedback(delayFeedback); }, [delayFeedback]);
  useEffect(() => { engineRef.current?.setDelayTime(delayTime); }, [delayTime]);
  useEffect(() => { engineRef.current?.setMix(mix); }, [mix]);

  // Apply a successfully-decoded shared pattern to the live state. Pulled out
  // so we can call it both on initial mount and on `hashchange` events (when a
  // user pastes a share URL into a tab that already has the app loaded).
  const applySharedPattern = useCallback((value) => {
    setBanks(value.banks);
    setChain(value.chain);
    setBpmState(value.bpm);
    setDelayFeedback(value.delayFeedback);
    setDelayTime(value.delayTime);
    setPatternName(value.name);
    setCurrentKit(value.kit ?? null);
    setKitModified(false);
    const firstPresent = value.bankPresent.findIndex(Boolean);
    const editIdx = firstPresent >= 0 ? firstPresent : 0;
    const editSlots = value.banks[editIdx]?.slots ?? [];
    setMix(prev => {
      const base = value.mix ?? prev;
      const existing = base.sidechain?.targets ?? [];
      // Auto-migrate v4 patterns saved with the old empty default. Respect any
      // non-empty explicit target list the user saved.
      const targets = existing.length ? existing : deriveSidechainTargets(editSlots);
      return { ...base, sidechain: { ...(base.sidechain ?? prev.sidechain), targets } };
    });
    setEditBank(editIdx);
    setActivePreset(null);
    setToast({ kind: 'ok', text: `Loaded shared pattern: ${value.name}` });
  }, []);

  // Load a pattern from a #p=… share link. Runs on mount AND on hashchange so
  // pasting a link into an already-loaded tab also works. Behind the splash
  // gate the recipient's first audible sound is the sender's beat.
  useEffect(() => {
    let cancelled = false;
    const tryLoad = (enc) => {
      if (!enc) return;
      clearShareHash();
      setShareStatus({ kind: 'loading' });
      decodeShare(enc).then(result => {
        if (cancelled) return;
        if (!result.ok) {
          console.warn('[Pattern-16] share decode failed:', result.errors);
          setShareStatus({ kind: 'failed' });
          setToast('Couldn’t load shared pattern — the link may be corrupt or from a newer version. Starting with default pattern.');
          return;
        }
        applySharedPattern(result.value);
        setShareStatus({ kind: 'ready', name: result.value.name });
      });
    };
    // Initial mount
    tryLoad(readShareFromHash());
    // Subsequent hash changes (pasting URL into same tab)
    const onHash = () => tryLoad(readShareFromHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHash);
    };
  }, [applySharedPattern]);

  // Playback indicator + slot flashes
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
              for (let i = 0; i < SLOT_COUNT; i++) {
                const slot = b.slots[i];
                const cell = slot.pattern[ps.step];
                if (cell?.on && !slot.mute) {
                  setFlash(f => ({ ...f, [i]: (f[i] ?? 0) + 1 }));
                }
              }
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
  const updateSlot = (slotIdx, fn) => {
    updateEditBank(b => {
      const slots = b.slots.map((s, i) => (i === slotIdx ? fn(s) : s));
      return { ...b, slots };
    });
  };

  const togglePlay = () => {
    if (!engineRef.current) return;
    if (playing) { engineRef.current.stop(); setPlaying(false); }
    else { engineRef.current.play(); setPlaying(true); }
  };

  // ----- Step interactions -----
  const onStepClick = (slotIdx, idx, e) => {
    const slot = bank.slots[slotIdx];
    const pitched = isPitched(slot.sound);
    updateSlot(slotIdx, s => {
      const r = s.pattern;
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
      } else if (cell.on && pitched && (e.metaKey || e.ctrlKey)) {
        // Open note picker — handled by Step component via separate handler; bail.
        return s;
      } else {
        if (cell.on) nextCell = emptyCell();
        else {
          nextCell = onCell(1, 100);
          if (pitched) nextCell.note = s.defaultNote ?? 48;
        }
      }
      const nr = [...r]; nr[idx] = nextCell;
      return { ...s, pattern: nr };
    });
    setActivePreset(null);
  };

  const onStepContext = (slotIdx, idx, e) => {
    e.preventDefault();
    updateSlot(slotIdx, s => {
      const r = s.pattern;
      const cell = r[idx];
      if (!cell.on) return s;
      const order = [1, 2, 0];
      const cur = order.indexOf(cell.velocity);
      const nr = [...r];
      nr[idx] = { ...cell, velocity: order[(cur + 1) % order.length] };
      return { ...s, pattern: nr };
    });
    setActivePreset(null);
  };

  const onStepPitchDrag = (slotIdx, idx, deltaSemis) => {
    updateSlot(slotIdx, s => {
      const r = s.pattern;
      const cell = r[idx];
      if (!cell.on) return s;
      const base = cell.note ?? s.defaultNote ?? 48;
      const next = Math.max(12, Math.min(96, base + deltaSemis));
      if (next === base) return s;
      const nr = [...r];
      nr[idx] = { ...cell, note: next };
      return { ...s, pattern: nr };
    });
    setActivePreset(null);
  };

  const onStepNotePickerOpen = (slotIdx, idx, anchorEl) => {
    setNotePicker({ slotIdx, stepIdx: idx, anchor: anchorEl });
  };

  const setStepNote = (slotIdx, idx, note) => {
    updateSlot(slotIdx, s => {
      const r = s.pattern;
      const cell = r[idx];
      if (!cell.on) return s;
      const nr = [...r];
      nr[idx] = { ...cell, note };
      return { ...s, pattern: nr };
    });
    setActivePreset(null);
  };

  // ----- Slot-level controls -----
  const setSlotVolume = (slotIdx, v) => updateSlot(slotIdx, s => ({ ...s, volume: v }));
  const toggleSlotMute = (slotIdx) => updateSlot(slotIdx, s => ({ ...s, mute: !s.mute }));
  const setSlotRevSend = (slotIdx, v) => updateSlot(slotIdx, s => ({ ...s, reverbSend: v }));
  const setSlotDelSend = (slotIdx, v) => updateSlot(slotIdx, s => ({ ...s, delaySend: v }));
  const setSlotDrive = (slotIdx, v) => updateSlot(slotIdx, s => ({ ...s, drive: v }));
  // Toggle the slot between grid mode (cell-per-step) and melody mode (piano roll).
  // On the first switch into melody, seed an empty array so the engine knows
  // to use melody scheduling.
  const toggleSlotMelody = (slotIdx) => {
    updateSlot(slotIdx, s => {
      if (s.melody) {
        const { melody, ...rest } = s;
        return rest;
      }
      return { ...s, melody: [] };
    });
  };
  const setSlotMelody = (slotIdx, melody) => updateSlot(slotIdx, s => ({ ...s, melody }));
  const setSlotMelKey = (slotIdx, key) => updateSlot(slotIdx, s => ({ ...s, melodyKey: key }));
  const toggleSlotFollowChord = (slotIdx) => updateSlot(slotIdx, s => ({ ...s, followChord: !s.followChord }));
  const setBankReverbAmount = (v) => updateEditBank(b => ({ ...b, reverbAmount: v }));
  // Per-bank chord setter. `idx` is the bank index (0-3), not necessarily the
  // edit bank — the popover can target any bank.
  const setBankChord = (idx, chord) => {
    setBanks(prev => prev.map((b, i) => (i === idx ? { ...b, chord } : b)));
  };
  const setBankSwing = (v) => updateEditBank(b => ({ ...b, swing: Math.round(Math.max(0, Math.min(66, v))) }));

  const assignSlotSound = (slotIdx, soundKey) => {
    const prevSound = bank.slots[slotIdx]?.sound;
    updateSlot(slotIdx, s => reassignSlotSound(s, soundKey));
    // Sidechain target list reflects the slot's new sound: bass/tonal sounds
    // are auto-added; non-target sounds are auto-removed. Other slots' manual
    // unchecks are preserved by the delta update.
    setMix(prev => ({
      ...prev,
      sidechain: {
        ...prev.sidechain,
        targets: updateTargetsForSlotChange(prev.sidechain.targets, slotIdx, prevSound, soundKey),
      },
    }));
    setPalettePopover(null);
    setActivePreset(null);
    if (currentKit) setKitModified(true);
  };

  const setSlotGlide = (slotIdx, on) => updateSlot(slotIdx, s => ({ ...s, glide: !!on }));
  const setSlotChord = (slotIdx, t) => updateSlot(slotIdx, s => ({ ...s, chordType: t }));
  const setSlotFilter = (slotIdx, key, v) => updateSlot(slotIdx, s => ({ ...s, filter: { ...s.filter, [key]: v } }));
  const setSlotTunable = (slotIdx, v) => updateSlot(slotIdx, s => ({ ...s, tunable: v }));

  // ----- Bank handlers -----
  const selectBank = (idx) => { setEditBank(idx); setActivePreset(null); };

  // ----- Presets -----
  const applyPreset = (name) => {
    const preset = PRESETS[name];
    if (!preset) return;
    const prevSlots = bank.slots;
    // Multi-bank presets: build each bank from its entry, fill remaining slots
    // with empty banks. Edit bank moves to A and chain comes from the preset.
    const presetBanks = (preset.banks || [{ patterns: preset.patterns }]);
    const newBanks = [emptyBank(), emptyBank(), emptyBank(), emptyBank()];
    for (let i = 0; i < Math.min(presetBanks.length, 4); i++) {
      newBanks[i] = buildPresetBank(preset, presetBanks[i]);
    }
    setBanks(newBanks);
    setEditBank(0);
    setChain(preset.chain ?? [0]);
    setBpmState(preset.bpm);
    setActivePreset(name);
    setCurrentKit(preset.kitId);
    setKitModified(false);
    // Recompute sidechain targets — preset loads new sounds in every slot.
    setMix(prev => ({
      ...prev,
      sidechain: {
        ...prev.sidechain,
        targets: recomputeTargetsForSlots(prev.sidechain.targets, prevSlots, newBanks[0].slots),
      },
    }));
  };
  const clearEditBank = () => {
    // Clears patterns only — kit, slot assignments, mix and config are preserved
    // so the user can keep noodling in the current palette.
    updateEditBank(b => ({
      ...b,
      slots: b.slots.map(s => ({ ...s, pattern: EMPTY_ROW() })),
    }));
    setActivePreset(null);
  };

  // ----- Kits -----
  const loadKit = (kit) => {
    const prevSlots = bank.slots;
    const newSlots = slotsFromKit(kit, prevSlots, true);
    updateEditBank(b => ({ ...b, slots: newSlots }));
    setCurrentKit(kit.id);
    setKitModified(false);
    setActivePreset(null);
    setKitsPopover(null);
    // Master mix preset + recompute sidechain targets across all 8 slot changes.
    setMix(prev => ({
      ...prev,
      ...(kit.masterMix || {}),
      sidechain: {
        ...prev.sidechain,
        targets: recomputeTargetsForSlots(prev.sidechain.targets, prevSlots, newSlots),
      },
    }));
    setToast({ kind: 'ok', text: `Loaded kit: ${kit.name}` });
  };

  // ----- Samples (now keyed by slot index) -----
  const loadSample = async (slotIdx, file) => {
    if (!engineRef.current?.ctx) return;
    try {
      const ab = await file.arrayBuffer();
      const buf = await engineRef.current.ctx.decodeAudioData(ab.slice(0));
      if (buf.duration > 10) {
        setToast(`"${file.name}" is ${buf.duration.toFixed(1)}s — over the 10s cap. Trim and try again.`);
        return;
      }
      engineRef.current.setSample(slotIdx, buf);
      setSamples(prev => ({ ...prev, [slotIdx]: { name: file.name, buffer: buf } }));
      if (!sampleNoticeShown.current) {
        sampleNoticeShown.current = true;
        setToast('Samples live in memory only — reload reverts slots to assigned voices.');
      }
    } catch (err) {
      setToast(`Couldn't decode "${file.name}". Try a different .wav or .mp3.`);
    }
  };
  const clearSample = (slotIdx) => {
    engineRef.current?.setSample(slotIdx, null);
    setSamples(prev => { const n = { ...prev }; delete n[slotIdx]; return n; });
  };

  // ----- WAV Export -----
  const exportWav = async () => {
    if (exporting) return;
    if (playing) { engineRef.current.stop(); setPlaying(false); }
    setExporting(true); setExportProgress(0);
    try {
      const { buffer: audioBuffer, musicalDuration } = await renderOffline({
        banks, chain, bpm, delayFeedback, delayTime, mix,
        samples: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.buffer])),
        onProgress: setExportProgress,
      });
      const trimmed = trimSilentTail(audioBuffer, { minSamples: Math.floor(musicalDuration * audioBuffer.sampleRate) });
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

  // ----- JSON Import -----
  const handleJsonImport = (value, warnings) => {
    setBanks(value.banks);
    setChain(value.chain);
    setBpmState(value.bpm);
    setDelayFeedback(value.delayFeedback);
    setDelayTime(value.delayTime);
    setPatternName(value.name);
    const firstPresent = value.bankPresent.findIndex(Boolean);
    const editIdx = firstPresent >= 0 ? firstPresent : 0;
    setEditBank(editIdx);
    setActivePreset(null);
    setCurrentKit(value.kit ?? null);
    setKitModified(false);
    const editSlots = value.banks[editIdx]?.slots ?? [];
    setMix(prev => {
      const base = value.mix ?? prev;
      const existing = base.sidechain?.targets ?? [];
      const targets = existing.length ? existing : deriveSidechainTargets(editSlots);
      return { ...base, sidechain: { ...(base.sidechain ?? prev.sidechain), targets } };
    });
    setImportOpen(false);
    const w = warnings?.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : '';
    setToast({ kind: 'ok', text: `Loaded: ${value.name}${w}` });
  };

  // ----- AUTO MIX -----
  const autoMix = () => {
    // Density: count active steps across edit bank's slots / 128 → 0..1
    const b = banks[editBank];
    let active = 0;
    for (const s of b.slots) for (const c of s.pattern) if (c.on) active++;
    const density = Math.min(1, active / 128);
    const newGlue = 0.35 + density * 0.1; // 0.35–0.45

    // Sidechain targets: every slot whose sound is bass or tonal-pitched, if a kick exists
    const hasKick = b.slots.some(s => s.sound === 'kick');
    const targets = [];
    if (hasKick) {
      for (let i = 0; i < SLOT_COUNT; i++) {
        const s = b.slots[i];
        if (!s?.sound) continue;
        const m = PALETTE[s.sound];
        if (!m) continue;
        if (m.category === 'bass' || (m.category === 'tonal' && m.pitched)) targets.push(i);
      }
    }
    setMix({ glue: Math.min(0.5, newGlue), sidechain: { amount: 0.5, targets } });

    // Add drive to synth kick + snare (skip if user has a sample uploaded)
    updateEditBank(bb => ({
      ...bb,
      slots: bb.slots.map((s, i) => {
        if (samples[i]) return s; // sample slot — leave alone
        if (s.sound === 'kick' || s.sound === 'snare') return { ...s, drive: Math.max(s.drive ?? 0, 0.2) };
        return s;
      }),
    }));
    setToast({ kind: 'ok', text: 'Auto-mix applied.' });
    setMixOpen(false);
  };

  const copyAiPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AI_SYSTEM_PROMPT);
      setToast({ kind: 'ok', text: 'AI prompt copied — paste into Claude or ChatGPT, then bring the JSON back via IMPORT.' });
    } catch {
      setToast('Clipboard blocked — open Export instead and copy manually.');
    }
  };

  // Keyboard
  useEffect(() => {
    if (!started) return;
    const onKey = (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [started, playing]);

  if (!started) return <Splash onStart={start} shareStatus={shareStatus} />;

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
       <div className="transport-top">
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
          <div className="json-cluster" title="JSON pattern interchange">
            <div className="json-cluster-label">JSON</div>
            <div className="json-cluster-btns">
              <button className="json-cluster-btn" onClick={() => setImportOpen(true)} title="Import pattern from JSON">IMPORT</button>
              <button className="json-cluster-btn" onClick={() => setExportJsonOpen(true)} title="Export current pattern as JSON">EXPORT</button>
              <button className="json-cluster-btn share" onClick={() => setShareOpen(true)} title="Create a shareable URL of this pattern">SHARE</button>
              <button className="json-cluster-btn ai" onClick={copyAiPrompt} title="Copy AI system prompt to clipboard">AI</button>
            </div>
          </div>
          <button className="mix-btn" onClick={() => setMixOpen(true)} title="Master mix: GLUE, sidechain, AUTO MIX">
            <span className="mix-btn-dot" />
            <span>MIX</span>
          </button>
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

       <div className="transport-bottom">
        <BankBar
          banks={banks}
          editBank={editBank}
          playingBank={playingBankIdx}
          isPlaying={playing}
          onSelect={selectBank}
          onChordClick={(bankIdx, anchor) => setBankChordPopover({ bankIdx, anchor })}
        />
        <ChainEditor
          chain={chain}
          setChain={setChain}
          playingChainIdx={playState.chainIdx}
          isPlaying={playing}
        />
        <div className="kits-panel">
          <div className="band-label">KIT</div>
          <button
            className={`kit-button ${currentKit && !kitModified ? 'on' : ''}`}
            onClick={(e) => setKitsPopover({ anchor: e.currentTarget })}
            title="Load a kit (8 curated sounds; preserves your pattern)"
          >
            <span className="preset-led" />
            <span className="kit-button-label">{currentKit ? `${getKit(currentKit)?.name ?? 'CUSTOM'}${kitModified ? ' *' : ''}` : 'CHOOSE…'}</span>
            <span className="kit-chevron">▾</span>
          </button>
        </div>
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

      <div className="body">
        <div className="rows">
          {SLOT_IDX.map((ri) => {
            const slot = bank.slots[ri];
            const pitched = isPitched(slot.sound);
            const sample = samples[ri];
            return (
              <div key={ri} className={`row ${slot.mute ? 'muted' : ''} ${pitched ? 'pitched' : ''}`}>
                <div className="row-ctrls">
                  <div className="row-name-wrap">
                    <span className="row-num">{String(ri + 1).padStart(2, '0')}</span>
                    <SlotLabel
                      slotIdx={ri}
                      slot={slot}
                      sample={sample}
                      onLoad={(file) => loadSample(ri, file)}
                      onClear={() => clearSample(ri)}
                      onOpenPalette={(idx, anchor) => setPalettePopover({ slotIdx: idx, anchor })}
                      dragOver={dragOver === ri}
                      setDragOver={setDragOver}
                    />
                    <span className="row-pulse" key={flash[ri] || 0} />
                  </div>
                  <VolumeSlider value={slot.volume} onChange={(v) => setSlotVolume(ri, v)} />
                  <div className="row-cluster">
                    <MiniSend value={slot.reverbSend} onChange={(v) => setSlotRevSend(ri, v)} letter="R" color="rev" />
                    <MiniSend value={slot.delaySend} onChange={(v) => setSlotDelSend(ri, v)} letter="D" color="del" />
                    <MiniSend value={slot.drive ?? 0} onChange={(v) => setSlotDrive(ri, v)} letter="X" color="drv" />
                    <button
                      className={`slot-gear ${(slot.glide || hasChord(slot.sound) || hasFilter(slot.sound) || tunableValues(slot.sound)) ? 'has' : ''}`}
                      onClick={(e) => setSlotSettings({ slotIdx: ri, anchor: e.currentTarget })}
                      title="Slot settings"
                      aria-label="Slot settings"
                    >·</button>
                    <button
                      className={`mute ${slot.mute ? 'on' : ''}`}
                      onClick={() => toggleSlotMute(ri)}
                      aria-label="Mute"
                    >M</button>
                    {pitched && slot.sound !== 'chord-stab' && (
                      <button
                        className={`follow-btn ${slot.followChord ? 'on' : ''}`}
                        onClick={() => toggleSlotFollowChord(ri)}
                        title={slot.followChord
                          ? 'FOLLOW on — notes transpose with the bank\'s chord root'
                          : 'FOLLOW off — notes play their literal pitches'}
                      >♪→C</button>
                    )}
                    {pitched && (
                      <button
                        className={`mel-btn ${slot.melody ? 'on' : ''}`}
                        onClick={() => toggleSlotMelody(ri)}
                        title={slot.melody ? 'Switch back to grid mode' : 'Switch to melody (piano-roll) mode'}
                      >MEL</button>
                    )}
                  </div>
                </div>
                {pitched && slot.melody ? (
                  <MelodyEditor
                    slot={slot}
                    slotIdx={ri}
                    currentStep={playState.step}
                    onChange={(melody) => setSlotMelody(ri, melody)}
                    onMelKey={(k) => setSlotMelKey(ri, k)}
                  />
                ) : (
                <div className="steps">
                  {slot.pattern.map((cell, si) => (
                    <Fragment key={si}>
                      {pitched ? (
                        <PitchedStep
                          cell={cell}
                          current={playState.step === si}
                          downbeat={si % 4 === 0}
                          rowIndex={ri}
                          stepIndex={si}
                          defaultNote={slot.defaultNote ?? 48}
                          onClick={(e) => {
                            if (cell.on && (e.metaKey || e.ctrlKey)) {
                              onStepNotePickerOpen(ri, si, e.currentTarget);
                            } else {
                              onStepClick(ri, si, e);
                            }
                          }}
                          onContextMenu={(e) => onStepContext(ri, si, e)}
                          onPitchDrag={(delta) => onStepPitchDrag(ri, si, delta)}
                        />
                      ) : (
                        <PercStep
                          cell={cell}
                          current={playState.step === si}
                          downbeat={si % 4 === 0}
                          rowIndex={ri}
                          stepIndex={si}
                          onClick={(e) => onStepClick(ri, si, e)}
                          onContextMenu={(e) => onStepContext(ri, si, e)}
                        />
                      )}
                      {si % 4 === 3 && si < 15 && <span className="step-gap" />}
                    </Fragment>
                  ))}
                </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="col-strip">
          <div className="col-strip-left">
            <span className="hint">CLICK LABEL: SOUND · SHIFT/RIGHT-CLICK: VEL · ALT: PROB · ON PITCHED: DRAG ↕ FOR PITCH · CMD-CLICK: NOTE PICKER</span>
          </div>
          <div className="col-strip-steps">
            {Array.from({ length: 16 }).map((_, i) => (
              <Fragment key={i}>
                <div className={`col-num ${playState.step === i ? 'active' : ''} ${i % 4 === 0 ? 'down' : ''}`}>
                  {i + 1}
                </div>
                {i % 4 === 3 && i < 15 && <span className="step-gap" />}
              </Fragment>
            ))}
          </div>
        </div>
      </div>

      <div className="footer">
        <div className="footer-text">
          <span className={`dot ${playing ? 'live' : ''}`} /> {playing ? 'RUNNING' : 'STANDBY'}
          <span className="sep">·</span>
          BANK {BANK_LETTERS[playing ? playingBankIdx : editBank]}{!playing && <span className="sub-tag"> (EDIT)</span>}
          {(() => {
            // Show the currently-playing bank's chord when it has one. v4-imported
            // banks without a chord field skip this segment entirely.
            const currentBank = banks[playing ? playingBankIdx : editBank];
            const ch = currentBank?.chord;
            if (!ch || !ch.root || !ch.type) return null;
            return (
              <>
                <span className="sep">·</span>
                CHORD {chordLabel(ch)}
              </>
            );
          })()}
          <span className="sep">·</span>
          CHAIN {Math.min(playState.chainIdx % chain.length, chain.length - 1) + 1}/{chain.length}
          <span className="sep">·</span>
          BPM {bpm}
          <span className="sep">·</span>
          SWING {Math.round(bank.swing)}%
          <span className="sep">·</span>
          DELAY {delayTime}
          {currentKit && (
            <>
              <span className="sep">·</span>
              KIT {(getKit(currentKit)?.name ?? currentKit).toUpperCase()}{kitModified && <span className="sub-tag"> (MODIFIED)</span>}
            </>
          )}
        </div>
      </div>

      {exporting && <ExportModal progress={exportProgress} onCancel={() => {}} />}
      {palettePopover && (
        <PalettePopover
          slotIdx={palettePopover.slotIdx}
          currentSound={bank.slots[palettePopover.slotIdx].sound}
          anchor={palettePopover.anchor}
          onPick={(soundKey) => assignSlotSound(palettePopover.slotIdx, soundKey)}
          onClose={() => setPalettePopover(null)}
        />
      )}
      {notePicker && (
        <NotePicker
          slot={bank.slots[notePicker.slotIdx]}
          cell={bank.slots[notePicker.slotIdx].pattern[notePicker.stepIdx]}
          anchor={notePicker.anchor}
          onPick={(note) => { setStepNote(notePicker.slotIdx, notePicker.stepIdx, note); setNotePicker(null); }}
          onClose={() => setNotePicker(null)}
        />
      )}
      {slotSettings && (
        <SlotSettingsPopover
          slot={bank.slots[slotSettings.slotIdx]}
          anchor={slotSettings.anchor}
          onGlide={(v) => setSlotGlide(slotSettings.slotIdx, v)}
          onChord={(t) => setSlotChord(slotSettings.slotIdx, t)}
          onFilter={(k, v) => setSlotFilter(slotSettings.slotIdx, k, v)}
          onTunable={(v) => setSlotTunable(slotSettings.slotIdx, v)}
          onClose={() => setSlotSettings(null)}
        />
      )}
      {kitsPopover && (
        <KitsPopover
          anchor={kitsPopover.anchor}
          currentKitId={kitModified ? null : currentKit}
          onPick={loadKit}
          onClose={() => setKitsPopover(null)}
        />
      )}
      {bankChordPopover && (
        <BankChordPopover
          anchor={bankChordPopover.anchor}
          bankLetter={BANK_LETTERS[bankChordPopover.bankIdx]}
          chord={banks[bankChordPopover.bankIdx].chord ?? { ...DEFAULT_BANK_CHORD }}
          onChange={(c) => setBankChord(bankChordPopover.bankIdx, c)}
          onClose={() => setBankChordPopover(null)}
        />
      )}
      {importOpen && (
        <ImportJsonModal
          onClose={() => setImportOpen(false)}
          onLoad={handleJsonImport}
        />
      )}
      {exportJsonOpen && (
        <ExportJsonModal
          state={{ name: patternName, bpm, banks, chain, delayTime, delayFeedback, editBank, kit: currentKit, mix }}
          onClose={() => setExportJsonOpen(false)}
          onToast={(text) => setToast({ kind: 'ok', text })}
        />
      )}
      {shareOpen && (
        <ShareModal
          state={{ name: patternName, bpm, banks, chain, delayTime, delayFeedback, editBank, kit: currentKit, mix }}
          onClose={() => setShareOpen(false)}
          onToast={(text) => setToast({ kind: 'ok', text })}
          onNameChange={(n) => setPatternName(n)}
        />
      )}
      {mixOpen && (
        <MixModal
          mix={mix}
          slots={bank.slots}
          onChange={setMix}
          onAutoMix={autoMix}
          onClose={() => setMixOpen(false)}
        />
      )}
      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}

export default App;
