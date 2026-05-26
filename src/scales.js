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
