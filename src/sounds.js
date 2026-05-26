// Sound palette for Pattern-16. Each entry is one voice; slots reference them
// by key. Categories drive the popover grouping; pitched/filter/chord/tunable
// flags drive per-slot UI and audio params.

export const CATEGORIES = [
  { id: 'drums', label: 'DRUMS' },
  { id: 'cymbals', label: 'CYMBALS' },
  { id: 'percussion', label: 'PERCUSSION' },
  { id: 'bass', label: 'BASS' },
  { id: 'tonal', label: 'TONAL' },
];

// MIDI note numbers: C2 = 36, C3 = 48
export const PALETTE = {
  // ---------- Drums ----------
  kick:       { name: 'KICK',    short: 'KICK',  category: 'drums' },
  snare:      { name: 'SNARE',   short: 'SNARE', category: 'drums' },
  rim:        { name: 'RIM',     short: 'RIM',   category: 'drums' },
  clap:       { name: 'CLAP',    short: 'CLAP',  category: 'drums' },
  tom:        { name: 'TOM',     short: 'TOM',   category: 'drums' },

  // ---------- Cymbals ----------
  chh:        { name: 'C-HAT',   short: 'C-HAT', category: 'cymbals' },
  ohh:        { name: 'O-HAT',   short: 'O-HAT', category: 'cymbals' },
  ride:       { name: 'RIDE',    short: 'RIDE',  category: 'cymbals' },
  shaker:     { name: 'SHAKER',  short: 'SHKR',  category: 'cymbals' },
  tambourine: { name: 'TAMB',    short: 'TAMB',  category: 'cymbals' },

  // ---------- Percussion (tunable per-slot for conga only per spec) ----------
  cowbell:    { name: 'CWBELL',  short: 'COW',   category: 'percussion' },
  conga:      { name: 'CONGA',   short: 'CONGA', category: 'percussion', tunable: ['low', 'mid', 'high'] },
  woodblock:  { name: 'WOOD',    short: 'WOOD',  category: 'percussion' },

  // ---------- Bass (pitched) ----------
  '808':         { name: '808',        short: '808',   category: 'bass',  pitched: true, defaultNote: 36 },
  'sub-bass':    { name: 'SUB',        short: 'SUB',   category: 'bass',  pitched: true, defaultNote: 36 },
  'synth-bass':  { name: 'SYN BASS',   short: 'SYNB',  category: 'bass',  pitched: true, defaultNote: 36, filter: { cutoff: 0.5, resonance: 0.2 } },

  // ---------- Tonal (chord-stab and pluck are pitched; the FX two are not) ----------
  'chord-stab':  { name: 'CHORD',      short: 'CHRD',  category: 'tonal', pitched: true, defaultNote: 48, filter: { cutoff: 0.5, resonance: 0.2 }, chord: 'minor' },
  pluck:         { name: 'PLUCK',      short: 'PLCK',  category: 'tonal', pitched: true, defaultNote: 48, filter: { cutoff: 0.55, resonance: 0.1 } },
  'vinyl-crackle': { name: 'CRACKLE',  short: 'CRKL',  category: 'tonal' },
  'noise-sweep':   { name: 'SWEEP',    short: 'SWPP',  category: 'tonal' },
};

export const SOUND_KEYS = Object.keys(PALETTE);
export const CHORD_TYPES = ['major', 'minor', 'sus4', 'm7', 'maj7'];

export function isPitched(soundKey) {
  return !!PALETTE[soundKey]?.pitched;
}
export function hasFilter(soundKey) {
  return !!PALETTE[soundKey]?.filter;
}
export function hasChord(soundKey) {
  return PALETTE[soundKey]?.chord != null;
}
export function tunableValues(soundKey) {
  return PALETTE[soundKey]?.tunable ?? null;
}
export function defaultNote(soundKey) {
  return PALETTE[soundKey]?.defaultNote ?? 48;
}
export function defaultFilter(soundKey) {
  const f = PALETTE[soundKey]?.filter;
  return f ? { ...f } : null;
}
export function defaultChord(soundKey) {
  return PALETTE[soundKey]?.chord ?? null;
}

// Slot 1–8 default loadout (so the new sounds are immediately discoverable).
export const DEFAULT_LOADOUT = ['kick', 'snare', 'chh', 'ohh', 'clap', 'tom', 'shaker', '808'];

// MIDI → "C#3" style label
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteLabel(midi) {
  const m = Math.round(midi);
  const n = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1; // MIDI 0 = C-1
  return `${n}${octave}`;
}
export function shortNoteLabel(midi) {
  // Two-char compact label for the step cell: "C", "C#", "F", etc.
  const m = Math.round(midi);
  return NOTE_NAMES[((m % 12) + 12) % 12];
}
