// Pattern-16 launch kits. A kit is a curated 8-slot sound assignment with
// sensible default mix and per-slot config. Loading a kit swaps sounds (and
// the chosen mix/config) without touching the user's pattern.
//
// Schema:
//   { id, name, description, slots:[8 sound keys], mix?:{idx:{volume,reverbSend,delaySend}},
//     config?:{idx:{glide?,chordType?,filter?,tunable?}} }

export const KITS = [
  {
    id: 'boom-bap',
    name: 'Boom-Bap',
    description: 'Classic 90s hip-hop palette — swung hats, ride, rim, 808 weight',
    slots: ['kick', 'snare', 'chh', 'ohh', 'rim', 'ride', 'shaker', '808'],
    mix: {
      1: { reverbSend: 0.45 },
      3: { reverbSend: 0.25 },
      5: { reverbSend: 0.2 },
    },
  },
  {
    id: 'trap',
    name: 'Trap',
    description: 'Tight kick, snap-tight clap, hat rolls, sliding 808',
    slots: ['kick', 'snare', 'chh', 'ohh', 'clap', 'snap', '808', 'riser'],
    mix: {
      1: { reverbSend: 0.15 },
      3: { reverbSend: 0.2, delaySend: 0.35 },
      4: { reverbSend: 0.2 },
    },
    config: { 6: { glide: true } },
  },
  {
    id: 'house',
    name: 'House',
    description: 'Four-on-the-floor, off-beat hats, minor chord stab, sub',
    slots: ['kick', 'clap', 'chh', 'ohh', 'shaker', 'tambourine', 'chord-stab', 'sub-bass'],
    mix: {
      1: { reverbSend: 0.4 },
      3: { reverbSend: 0.2 },
      5: { reverbSend: 0.3 },
      6: { reverbSend: 0.3 },
    },
    config: { 6: { chordType: 'minor' } },
  },
  {
    id: 'drill',
    name: 'Drill',
    description: 'UK drill — slid 808, sharp snare, crash hits, glide on',
    slots: ['kick', 'snare', 'chh', 'ohh', 'clap', 'rim', '808', 'crash'],
    mix: {
      1: { reverbSend: 0.18 },
      4: { reverbSend: 0.18 },
      7: { reverbSend: 0.35 },
    },
    config: { 6: { glide: true } },
  },
  {
    id: 'lo-fi',
    name: 'Lo-Fi',
    description: 'Soft kick, dusty snare, ride wash, vinyl bed, mellow pad',
    slots: ['kick', 'snare', 'chh', 'ride', 'shaker', 'vinyl-bed', 'chord-stab', 'pad'],
    mix: {
      0: { volume: 0.7 },
      1: { volume: 0.7, reverbSend: 0.35 },
      3: { reverbSend: 0.3 },
      5: { volume: 0.45 },
      6: { reverbSend: 0.4 },
      7: { reverbSend: 0.5 },
    },
    config: { 6: { chordType: 'maj7' }, 7: { chordType: 'maj7' } },
  },
  {
    id: 'acid-house',
    name: 'Acid House',
    description: 'Squelchy 303 bass driving cowbell + chord stab — Chicago feel',
    slots: ['kick', 'clap', 'chh', 'ohh', 'shaker', 'cowbell', 'acid-bass', 'chord-stab'],
    mix: {
      3: { reverbSend: 0.2 },
      7: { reverbSend: 0.25 },
    },
    config: { 6: { glide: true }, 7: { chordType: 'minor' } },
  },
  {
    id: 'jungle-dnb',
    name: 'Jungle / DnB',
    description: 'Chopped break feel, ride wash, reese growl + sub fundament',
    slots: ['kick', 'snare', 'chh', 'ohh', 'ride', 'reese-bass', 'sub-bass', 'riser'],
    mix: {
      1: { reverbSend: 0.3 },
      4: { reverbSend: 0.35 },
    },
    config: { 5: { glide: true } },
  },
  {
    id: 'afrobeats',
    name: 'Afrobeats',
    description: 'Djembe-led, snappy hats, shaker continuous, warm chord',
    slots: ['kick', 'snare', 'snap', 'shaker', 'conga', 'djembe', 'tom', 'chord-stab'],
    mix: {
      1: { reverbSend: 0.2 },
      4: { reverbSend: 0.25 },
      5: { reverbSend: 0.25 },
      7: { reverbSend: 0.4 },
    },
    config: {
      4: { tunable: 'high' },
      5: { tunable: 'mid' },
      7: { chordType: 'major' },
    },
  },
  {
    id: 'ambient',
    name: 'Ambient / Downtempo',
    description: 'Sparse percussion, soft kick, vinyl bed, evolving pad + pluck',
    slots: ['kick', 'rim', 'shaker', 'ride', 'vinyl-bed', 'pad', 'sub-bass', 'pluck'],
    mix: {
      0: { volume: 0.65, reverbSend: 0.3 },
      1: { reverbSend: 0.45 },
      3: { reverbSend: 0.5 },
      4: { volume: 0.35 },
      5: { reverbSend: 0.55 },
      7: { reverbSend: 0.45, delaySend: 0.3 },
    },
    config: { 5: { chordType: 'maj7' } },
  },
];

export const KITS_BY_ID = Object.fromEntries(KITS.map(k => [k.id, k]));

export function getKit(id) { return KITS_BY_ID[id] ?? null; }
