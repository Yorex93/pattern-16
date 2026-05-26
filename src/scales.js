// Musical scale definitions used by the melody editor's piano-roll snap logic
// and the JSON schema's melodyKey validator. Kept in a .js file (not the
// editor's .jsx) so it can be imported from json-io.js without dragging in
// React. Semitone classes are 0..11 from C.

export const SCALES = {
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
export const MELODY_KEY_NAMES = Object.keys(SCALES);
export const DEFAULT_MELODY_KEY = 'A minor';

// ---------- Chord progression helpers (v5) ----------
// Note name → semitone class (0..11). Accepts sharp or flat spellings on input;
// serializer always uses the sharp form via SEMI_TO_NOTE_SHARP below.
export const NOTE_TO_SEMI = {
  C: 0, 'C#': 1, Db: 1,
  D: 2, 'D#': 3, Eb: 3,
  E: 4,
  F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8,
  A: 9, 'A#': 10, Bb: 10,
  B: 11,
};
export const ROOT_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const VALID_ROOT_NAMES = Object.keys(NOTE_TO_SEMI);

export function rootSemitone(name) {
  if (typeof name !== 'string') return null;
  return NOTE_TO_SEMI[name] ?? null;
}

// Canonical MIDI for a chord root in the C4 octave (60..71). Chord-stab voices
// stack intervals above this; the highest interval (maj7 = +11) reaches B5 max
// when the chord root is B.
export function chordRootMidi(rootSemi) {
  return 60 + (((rootSemi % 12) + 12) % 12);
}

// Chord types and their semitone intervals from the root. Order matters for
// display and for the popover's type list.
export const CHORD_TYPES_V5 = ['major', 'minor', 'maj7', 'm7', '7', 'sus4', 'dim', 'aug'];
export const CHORD_INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  maj7:  [0, 4, 7, 11],
  m7:    [0, 3, 7, 10],
  '7':   [0, 4, 7, 10],
  sus4:  [0, 5, 7],
  dim:   [0, 3, 6],
  aug:   [0, 4, 8],
};
const TYPE_SUFFIX = {
  major: '', minor: 'm', maj7: 'maj7', m7: 'm7', '7': '7',
  sus4: 'sus4', dim: 'dim', aug: 'aug',
};
// Compact chord label for UI: "Am", "F#m7", "Csus4", etc.
export function chordLabel(chord) {
  if (!chord || !chord.root) return '';
  return `${chord.root}${TYPE_SUFFIX[chord.type] ?? chord.type ?? ''}`;
}

export const DEFAULT_BANK_CHORD = { root: 'A', type: 'minor' };
