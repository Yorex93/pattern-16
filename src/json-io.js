// Pattern-16 JSON schema v2 — slot-based.
//   v2 keys banks by slot index "1".."8", each with a `sound` field.
//   v1 (six fixed row keys) is migrated on import.
//
// Step DSL is unchanged: . x X o (off / med / loud / soft).
// Optional per-slot `probability`: . 1 2 3 4 (100/25/50/75/100 — see PROB_FROM_CHAR).
// Pitched slots optionally carry a `notes` array of 16 ints (semitone offset
// from the sound's defaultNote; 0 if not retuned or step is off).

import { SOUND_KEYS, PALETTE, CHORD_TYPES, isPitched, hasFilter, hasChord, tunableValues, defaultNote, defaultFilter, defaultChord } from './sounds.js';

const SLOT_COUNT = 8;
const BANK_LETTERS = ['A', 'B', 'C', 'D'];
const DELAY_OPTIONS = ['1/8', '1/4', '3/8', '1/2'];

const STEP_CHARS = new Set(['.', 'x', 'X', 'o']);
const ACCENT_CHARS = new Set(['.', 'L', 'M', 'S']);
const PROB_CHARS = new Set(['.', '1', '2', '3', '4']);

const VEL_FROM_STEP = { x: 1, X: 2, o: 0 };
const VEL_FROM_ACCENT = { L: 2, M: 1, S: 0 };
const PROB_FROM_CHAR = { '1': 25, '2': 50, '3': 75, '4': 100 };
const PROB_TO_CHAR = { 100: '4', 75: '3', 50: '2', 25: '1' };

// v1 → v2 row key migration (six fixed → slots 1–6)
const V1_ROW_TO_SOUND = { kick: 'kick', snare: 'snare', chat: 'chh', ohat: 'ohh', clap: 'clap', tom: 'tom' };
const V1_ROW_ORDER = ['kick', 'snare', 'chat', 'ohat', 'clap', 'tom']; // slot order for v1 import

// ---------- defaults ----------
const EMPTY_CELL = () => ({ on: false, velocity: 1, probability: 100 });
const EMPTY_ROW = () => Array.from({ length: 16 }, EMPTY_CELL);
function emptySlotInternal(sound = null) {
  const s = {
    sound,
    pattern: EMPTY_ROW(),
    volume: 0.85,
    mute: false,
    reverbSend: 0,
    delaySend: 0,
  };
  if (sound && isPitched(sound)) { s.defaultNote = defaultNote(sound); s.glide = false; }
  if (sound && hasFilter(sound)) s.filter = defaultFilter(sound);
  if (sound && hasChord(sound)) s.chordType = defaultChord(sound);
  const tv = sound ? tunableValues(sound) : null;
  if (tv) s.tunable = tv[Math.floor(tv.length / 2)] ?? tv[0];
  return s;
}
function emptyBankInternal() {
  return { slots: Array.from({ length: SLOT_COUNT }, () => emptySlotInternal(null)), swing: 0, reverbAmount: 0.25 };
}

function bankIsEmpty(b) {
  if (!b) return true;
  // Empty = no active steps in any slot, default mix everywhere, no sound override params
  for (const s of b.slots) {
    if (!s) continue;
    if (s.pattern.some(c => c.on)) return false;
    if (s.volume !== 0.85) return false;
    if (s.mute) return false;
    if (s.reverbSend !== 0) return false;
    if (s.delaySend !== 0) return false;
    if (s.sound) return false; // bank with assigned sounds isn't "empty"
  }
  return true;
}

// ---------- helpers ----------
function isFiniteNumber(x) { return typeof x === 'number' && Number.isFinite(x); }
function inRange(x, lo, hi) { return isFiniteNumber(x) && x >= lo && x <= hi; }
function round3(x) { return Math.round(x * 1000) / 1000; }

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
  return dp[m][n];
}
function suggest(key, valid) {
  let best = null, bestD = Infinity;
  for (const v of valid) {
    const d = levenshtein(String(key).toLowerCase(), v);
    if (d < bestD) { bestD = d; best = v; }
  }
  return bestD <= 3 ? best : null;
}

// ---------- parser ----------
export function parsePattern(json) {
  const errors = [];
  const warnings = [];

  let obj;
  if (typeof json === 'string') {
    try { obj = JSON.parse(json); }
    catch (e) { return { ok: false, errors: [{ path: '', message: `JSON parse error: ${e.message}` }], warnings: [] }; }
  } else { obj = json; }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [{ path: '', message: 'Expected a JSON object at the top level.' }], warnings: [] };
  }

  // version — accept 1 (migrate) or 2 (current)
  if (!('version' in obj)) {
    errors.push({ path: 'version', message: 'Missing required "version" field. Expected 2 (or 1 to be migrated).' });
  } else if (obj.version === 1) {
    return parseV1ThenMigrate(obj);
  } else if (obj.version !== 2) {
    if (isFiniteNumber(obj.version) && obj.version > 2) {
      return { ok: false, errors: [{ path: 'version', message: `This file uses schema version ${obj.version}; this app supports version 2.` }], warnings: [] };
    }
    errors.push({ path: 'version', message: 'version must equal 2 (or 1 for migration).' });
  }

  const name = (typeof obj.name === 'string' && obj.name.trim()) ? obj.name.trim() : 'untitled';

  if (!('bpm' in obj)) errors.push({ path: 'bpm', message: 'Missing required "bpm".' });
  else if (!inRange(obj.bpm, 60, 180)) errors.push({ path: 'bpm', message: 'bpm must be a number between 60 and 180.' });

  if (!('swing' in obj)) errors.push({ path: 'swing', message: 'Missing required "swing".' });
  else if (!inRange(obj.swing, 0, 0.66)) errors.push({ path: 'swing', message: 'swing must be a number between 0 and 0.66.' });

  if (!obj.sends || typeof obj.sends !== 'object' || Array.isArray(obj.sends)) {
    errors.push({ path: 'sends', message: 'Missing required "sends" object.' });
  } else {
    const r = obj.sends.reverb;
    if (!r || typeof r !== 'object') errors.push({ path: 'sends.reverb', message: 'Missing "sends.reverb" object.' });
    else if (!inRange(r.amount, 0, 1)) errors.push({ path: 'sends.reverb.amount', message: 'sends.reverb.amount must be 0–1.' });

    const d = obj.sends.delay;
    if (!d || typeof d !== 'object') errors.push({ path: 'sends.delay', message: 'Missing "sends.delay" object.' });
    else {
      if (!DELAY_OPTIONS.includes(d.time)) errors.push({ path: 'sends.delay.time', message: `sends.delay.time must be one of ${DELAY_OPTIONS.map(v => `"${v}"`).join(', ')}.` });
      if (!inRange(d.feedback, 0, 1)) errors.push({ path: 'sends.delay.feedback', message: 'sends.delay.feedback must be 0–1.' });
    }
  }

  // banks
  const banks = [null, null, null, null];
  const bankExplicitlyNull = [false, false, false, false];
  if (!obj.banks || typeof obj.banks !== 'object' || Array.isArray(obj.banks)) {
    errors.push({ path: 'banks', message: 'Missing required "banks" object.' });
  } else {
    for (let i = 0; i < 4; i++) {
      const L = BANK_LETTERS[i];
      if (!(L in obj.banks)) {
        errors.push({ path: `banks.${L}`, message: `Missing "banks.${L}". Use null for empty banks.` });
        continue;
      }
      const bv = obj.banks[L];
      if (bv === null) { bankExplicitlyNull[i] = true; continue; }
      if (typeof bv !== 'object' || Array.isArray(bv)) {
        errors.push({ path: `banks.${L}`, message: `banks.${L} must be an object or null.` });
        continue;
      }
      banks[i] = parseBank(bv, `banks.${L}`, errors, warnings);
    }
    for (const k of Object.keys(obj.banks)) {
      if (!BANK_LETTERS.includes(k)) warnings.push({ path: `banks.${k}`, message: `Unknown bank "${k}" — ignored.` });
    }
  }

  // chain
  const chainIdx = [];
  if (!Array.isArray(obj.chain)) {
    errors.push({ path: 'chain', message: 'chain must be an array.' });
  } else if (obj.chain.length < 1 || obj.chain.length > 8) {
    errors.push({ path: 'chain', message: `chain must have 1–8 entries (got ${obj.chain.length}).` });
  } else {
    obj.chain.forEach((c, i) => {
      const idx = BANK_LETTERS.indexOf(c);
      if (idx < 0) {
        errors.push({ path: `chain[${i}]`, message: `chain[${i}] must be one of "A","B","C","D" (got ${JSON.stringify(c)}).` });
        return;
      }
      if (bankExplicitlyNull[idx]) {
        errors.push({ path: `chain[${i}]`, message: `chain[${i}] references bank "${c}", but banks.${c} is null.` });
        return;
      }
      chainIdx.push(idx);
    });
  }

  const KNOWN_TOP = new Set(['version', 'name', 'bpm', 'swing', 'sends', 'banks', 'chain']);
  for (const k of Object.keys(obj)) if (!KNOWN_TOP.has(k)) warnings.push({ path: k, message: `Unknown top-level key "${k}" — ignored.` });

  if (errors.length > 0) return { ok: false, errors, warnings };

  const sw = obj.swing;
  const rev = obj.sends.reverb.amount;
  const normalizedBanks = banks.map(b => {
    if (b === null) return emptyBankInternal();
    return { ...b, swing: Math.round(sw * 100), reverbAmount: rev };
  });

  return {
    ok: true, errors: [], warnings,
    value: {
      name, bpm: obj.bpm,
      swing: sw, reverbAmount: rev,
      delayTime: obj.sends.delay.time,
      delayFeedback: obj.sends.delay.feedback,
      banks: normalizedBanks,
      bankPresent: bankExplicitlyNull.map((n, i) => !n && banks[i] !== null),
      chain: chainIdx,
    },
  };
}

// ---------- v1 → v2 migration ----------
function parseV1ThenMigrate(v1) {
  const errors = [];
  const warnings = [];

  // Reuse v1 row-shape validation but emit a v2 internal bank.
  function migrateV1Bank(bv, base) {
    const out = emptyBankInternal();
    if (!bv.rows || typeof bv.rows !== 'object' || Array.isArray(bv.rows)) {
      errors.push({ path: `${base}.rows`, message: `${base}.rows must be an object.` });
      return out;
    }
    // Place known v1 row keys into slots 1–6 (indices 0–5) in fixed order.
    for (let i = 0; i < V1_ROW_ORDER.length; i++) {
      const key = V1_ROW_ORDER[i];
      const v = bv.rows[key];
      if (!v) continue;
      if (typeof v !== 'object' || Array.isArray(v)) {
        errors.push({ path: `${base}.rows.${key}`, message: `must be an object.` });
        continue;
      }
      const sound = V1_ROW_TO_SOUND[key];
      const slot = emptySlotInternal(sound);
      if (inRange(v.volume, 0, 1)) slot.volume = v.volume; else errors.push({ path: `${base}.rows.${key}.volume`, message: `volume must be 0–1.` });
      if (typeof v.mute === 'boolean') slot.mute = v.mute; else errors.push({ path: `${base}.rows.${key}.mute`, message: `mute must be boolean.` });
      if (inRange(v.reverbSend, 0, 1)) slot.reverbSend = v.reverbSend; else errors.push({ path: `${base}.rows.${key}.reverbSend`, message: `reverbSend must be 0–1.` });
      if (inRange(v.delaySend, 0, 1)) slot.delaySend = v.delaySend; else errors.push({ path: `${base}.rows.${key}.delaySend`, message: `delaySend must be 0–1.` });

      if (typeof v.steps !== 'string' || v.steps.length !== 16) {
        errors.push({ path: `${base}.rows.${key}.steps`, message: `steps must be a 16-char string.` });
      } else {
        slot.pattern = parseSteps(v.steps, `${base}.rows.${key}.steps`, errors);
      }
      out.slots[i] = slot;
    }
    // accents / probability for v1
    if ('accents' in bv && bv.accents && typeof bv.accents === 'object') {
      for (const [k, v] of Object.entries(bv.accents)) {
        const idx = V1_ROW_ORDER.indexOf(k);
        if (idx < 0) continue;
        if (typeof v !== 'string' || v.length !== 16) continue;
        applyAccents(out.slots[idx].pattern, v);
      }
    }
    if ('probability' in bv && bv.probability && typeof bv.probability === 'object') {
      for (const [k, v] of Object.entries(bv.probability)) {
        const idx = V1_ROW_ORDER.indexOf(k);
        if (idx < 0) continue;
        if (typeof v !== 'string' || v.length !== 16) continue;
        applyProb(out.slots[idx].pattern, v);
      }
    }
    warnings.push({ path: base, message: `migrated from v1 (slots 1–6 from row keys; 7–8 empty).` });
    return out;
  }

  // Walk v1 top-level (mirrors v2 parser but for v1's bank shape)
  if (!inRange(v1.bpm, 60, 180)) errors.push({ path: 'bpm', message: 'bpm must be 60–180.' });
  if (!inRange(v1.swing, 0, 0.66)) errors.push({ path: 'swing', message: 'swing must be 0–0.66.' });
  if (!v1.sends?.reverb || !inRange(v1.sends.reverb.amount, 0, 1)) errors.push({ path: 'sends.reverb.amount', message: 'sends.reverb.amount must be 0–1.' });
  if (!v1.sends?.delay || !DELAY_OPTIONS.includes(v1.sends.delay.time)) errors.push({ path: 'sends.delay.time', message: `sends.delay.time invalid.` });
  if (!v1.sends?.delay || !inRange(v1.sends.delay.feedback, 0, 1)) errors.push({ path: 'sends.delay.feedback', message: 'sends.delay.feedback must be 0–1.' });

  const banks = [null, null, null, null];
  const bankNull = [false, false, false, false];
  if (!v1.banks || typeof v1.banks !== 'object') errors.push({ path: 'banks', message: 'Missing "banks".' });
  else {
    for (let i = 0; i < 4; i++) {
      const L = BANK_LETTERS[i];
      const bv = v1.banks[L];
      if (bv == null) { bankNull[i] = bv === null; continue; }
      banks[i] = migrateV1Bank(bv, `banks.${L}`);
    }
  }
  const chainIdx = [];
  if (Array.isArray(v1.chain)) v1.chain.forEach((c, i) => {
    const idx = BANK_LETTERS.indexOf(c);
    if (idx < 0) errors.push({ path: `chain[${i}]`, message: `must be A/B/C/D.` });
    else if (bankNull[idx]) errors.push({ path: `chain[${i}]`, message: `references null bank "${c}".` });
    else chainIdx.push(idx);
  });

  if (errors.length > 0) return { ok: false, errors, warnings };

  const sw = v1.swing;
  const rev = v1.sends.reverb.amount;
  const normalizedBanks = banks.map(b => b == null ? emptyBankInternal() : { ...b, swing: Math.round(sw * 100), reverbAmount: rev });

  return {
    ok: true, errors: [], warnings,
    value: {
      name: (typeof v1.name === 'string' && v1.name.trim()) ? v1.name.trim() : 'untitled',
      bpm: v1.bpm, swing: sw, reverbAmount: rev,
      delayTime: v1.sends.delay.time,
      delayFeedback: v1.sends.delay.feedback,
      banks: normalizedBanks,
      bankPresent: bankNull.map((n, i) => !n && banks[i] !== null),
      chain: chainIdx,
    },
  };
}

function parseSteps(str, path, errors) {
  const cells = [];
  for (let i = 0; i < 16; i++) {
    const ch = str[i];
    if (!STEP_CHARS.has(ch)) { errors.push({ path, message: `Invalid character "${ch}" at position ${i + 1}. Allowed: . x X o` }); cells.push(EMPTY_CELL()); continue; }
    if (ch === '.') cells.push(EMPTY_CELL());
    else cells.push({ on: true, velocity: VEL_FROM_STEP[ch], probability: 100 });
  }
  return cells;
}
function applyAccents(pattern, str) {
  for (let i = 0; i < 16; i++) {
    const ch = str[i];
    if (!ACCENT_CHARS.has(ch)) continue;
    if (ch === '.' || !pattern[i].on) continue;
    pattern[i].velocity = VEL_FROM_ACCENT[ch];
  }
}
function applyProb(pattern, str) {
  for (let i = 0; i < 16; i++) {
    const ch = str[i];
    if (!PROB_CHARS.has(ch)) continue;
    if (ch === '.' || !pattern[i].on) continue;
    pattern[i].probability = PROB_FROM_CHAR[ch];
  }
}

// ---------- v2 bank/slot parser ----------
function parseBank(bv, base, errors, warnings) {
  const out = emptyBankInternal();
  if (!bv.slots || typeof bv.slots !== 'object' || Array.isArray(bv.slots)) {
    errors.push({ path: `${base}.slots`, message: `${base}.slots must be an object keyed by "1".."8".` });
    return out;
  }
  for (const [k, v] of Object.entries(bv.slots)) {
    const idx = Number(k) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= SLOT_COUNT) {
      errors.push({ path: `${base}.slots.${k}`, message: `Slot key "${k}" must be "1".."8".` });
      continue;
    }
    if (v === null) { out.slots[idx] = emptySlotInternal(null); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      errors.push({ path: `${base}.slots.${k}`, message: `Slot must be an object or null.` });
      continue;
    }
    out.slots[idx] = parseSlot(v, `${base}.slots.${k}`, errors, warnings);
  }
  const KNOWN_BANK = new Set(['slots']);
  for (const k of Object.keys(bv)) if (!KNOWN_BANK.has(k)) warnings.push({ path: `${base}.${k}`, message: `Unknown key "${k}" — ignored.` });
  return out;
}

function parseSlot(v, base, errors, warnings) {
  // sound
  if (!('sound' in v)) {
    errors.push({ path: `${base}.sound`, message: `Missing "sound" (use null for unassigned).` });
    return emptySlotInternal(null);
  }
  if (v.sound !== null && !SOUND_KEYS.includes(v.sound)) {
    const hint = suggest(v.sound, SOUND_KEYS);
    errors.push({ path: `${base}.sound`, message: `Unknown sound "${v.sound}".${hint ? ` Did you mean "${hint}"?` : ''}` });
    return emptySlotInternal(null);
  }
  const slot = emptySlotInternal(v.sound);
  const path = (k) => `${base}.${k}`;

  if (inRange(v.volume, 0, 1)) slot.volume = v.volume; else errors.push({ path: path('volume'), message: 'volume must be 0–1.' });
  if (typeof v.mute === 'boolean') slot.mute = v.mute; else errors.push({ path: path('mute'), message: 'mute must be a boolean.' });
  if (inRange(v.reverbSend, 0, 1)) slot.reverbSend = v.reverbSend; else errors.push({ path: path('reverbSend'), message: 'reverbSend must be 0–1.' });
  if (inRange(v.delaySend, 0, 1)) slot.delaySend = v.delaySend; else errors.push({ path: path('delaySend'), message: 'delaySend must be 0–1.' });

  if (typeof v.steps !== 'string' || v.steps.length !== 16) {
    errors.push({ path: path('steps'), message: 'steps must be a 16-char string.' });
  } else {
    slot.pattern = parseSteps(v.steps, path('steps'), errors);
  }

  // optional probability + accents
  if (typeof v.accents === 'string' && v.accents.length === 16) applyAccents(slot.pattern, v.accents);
  if (typeof v.probability === 'string' && v.probability.length === 16) applyProb(slot.pattern, v.probability);

  // pitched-only fields
  if (v.sound !== null && isPitched(v.sound)) {
    if (typeof v.glide === 'boolean') slot.glide = v.glide;
    if ('notes' in v) {
      if (!Array.isArray(v.notes) || v.notes.length !== 16) {
        errors.push({ path: path('notes'), message: 'notes must be a 16-element array of integers (semitone offsets from defaultNote).' });
      } else {
        for (let i = 0; i < 16; i++) {
          const off = v.notes[i];
          if (off == null) continue;
          if (!Number.isInteger(off) || off < -48 || off > 48) {
            errors.push({ path: `${path('notes')}[${i}]`, message: `notes[${i}] must be an integer between -48 and 48.` });
            continue;
          }
          if (slot.pattern[i].on) slot.pattern[i].note = slot.defaultNote + off;
        }
      }
    }
    // Ensure all active cells have a note (default if missing)
    for (let i = 0; i < 16; i++) if (slot.pattern[i].on && slot.pattern[i].note == null) slot.pattern[i].note = slot.defaultNote;
  }

  // filter
  if (v.sound !== null && hasFilter(v.sound) && v.filter) {
    if (inRange(v.filter.cutoff, 0, 1)) slot.filter.cutoff = v.filter.cutoff; else errors.push({ path: path('filter.cutoff'), message: 'filter.cutoff must be 0–1.' });
    if (inRange(v.filter.resonance, 0, 1)) slot.filter.resonance = v.filter.resonance; else errors.push({ path: path('filter.resonance'), message: 'filter.resonance must be 0–1.' });
  }

  // chord
  if (v.sound !== null && hasChord(v.sound) && v.chordType) {
    if (CHORD_TYPES.includes(v.chordType)) slot.chordType = v.chordType;
    else errors.push({ path: path('chordType'), message: `chordType must be one of ${CHORD_TYPES.join(', ')}.` });
  }

  // tunable (e.g. conga low/mid/high)
  if (v.sound !== null && tunableValues(v.sound) && v.tunable) {
    const tv = tunableValues(v.sound);
    if (tv.includes(v.tunable)) slot.tunable = v.tunable;
    else errors.push({ path: path('tunable'), message: `tunable must be one of ${tv.join(', ')}.` });
  }

  // unknown slot keys
  const KNOWN_SLOT = new Set(['sound', 'pitched', 'volume', 'mute', 'reverbSend', 'delaySend', 'steps', 'accents', 'probability', 'glide', 'notes', 'filter', 'chordType', 'tunable', 'defaultNote']);
  for (const k of Object.keys(v)) if (!KNOWN_SLOT.has(k)) warnings.push({ path: path(k), message: `Unknown key "${k}" — ignored.` });

  return slot;
}

// ---------- serializer ----------
export function serializePattern(state) {
  const { name, bpm, banks, chain, delayTime, delayFeedback, editBank } = state;
  const refBank = banks[editBank] ?? banks.find(b => !bankIsEmpty(b)) ?? banks[0];
  const swInt = refBank?.swing ?? 0;
  const rev = refBank?.reverbAmount ?? 0.25;

  const banksObj = {};
  BANK_LETTERS.forEach((L, i) => {
    const b = banks[i];
    banksObj[L] = bankIsEmpty(b) ? null : bankToJson(b);
  });

  return {
    version: 2,
    name: (name && name.trim()) || 'untitled',
    bpm,
    swing: Math.round(swInt) / 100,
    sends: {
      reverb: { amount: round3(rev) },
      delay: { time: delayTime, feedback: round3(delayFeedback) },
    },
    banks: banksObj,
    chain: chain.map(i => BANK_LETTERS[i]),
  };
}

function bankToJson(b) {
  const slots = {};
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = b.slots[i];
    if (!s || !s.sound) continue;
    slots[String(i + 1)] = slotToJson(s);
  }
  return { slots };
}

function slotToJson(s) {
  const out = {
    sound: s.sound,
    pitched: !!isPitched(s.sound),
    volume: round3(s.volume),
    mute: !!s.mute,
    reverbSend: round3(s.reverbSend),
    delaySend: round3(s.delaySend),
  };
  // steps + probability strings
  let steps = '', prob = '', hasProb = false;
  for (let i = 0; i < 16; i++) {
    const c = s.pattern[i];
    if (!c.on) { steps += '.'; prob += '.'; continue; }
    steps += c.velocity === 2 ? 'X' : c.velocity === 0 ? 'o' : 'x';
    if (c.probability !== 100) { prob += PROB_TO_CHAR[c.probability]; hasProb = true; }
    else prob += '.';
  }
  out.steps = steps;
  if (hasProb) out.probability = prob;

  // pitched extras
  if (isPitched(s.sound)) {
    if (s.glide) out.glide = true;
    const base = s.defaultNote ?? defaultNote(s.sound);
    const notes = new Array(16).fill(0);
    let anyNonZero = false;
    for (let i = 0; i < 16; i++) {
      if (!s.pattern[i].on) continue;
      const off = (s.pattern[i].note ?? base) - base;
      notes[i] = off;
      if (off !== 0) anyNonZero = true;
    }
    if (anyNonZero) out.notes = notes;
  }
  if (hasFilter(s.sound) && s.filter) out.filter = { cutoff: round3(s.filter.cutoff), resonance: round3(s.filter.resonance) };
  if (hasChord(s.sound) && s.chordType) out.chordType = s.chordType;
  if (tunableValues(s.sound) && s.tunable) out.tunable = s.tunable;
  return out;
}

// ---------- AI prompt ----------
export const AI_SYSTEM_PROMPT = `You are helping a user design a drum + bass + chord pattern for Pattern-16, a 16-step machine with 8 assignable slots per bank. Output a single JSON object matching the schema below. Output JSON only — no commentary, no markdown fences.

SCHEMA (version 2)
{
  "version": 2,
  "name": "<short name>",
  "bpm": <60-180>,
  "swing": <0-0.66, use 0 for straight, ~0.56 for boom-bap, ~0.2 for subtle shuffle>,
  "sends": {
    "reverb": { "amount": <0-1> },
    "delay":  { "time": "1/8"|"1/4"|"3/8"|"1/2", "feedback": <0-1> }
  },
  "banks": {
    "A": {
      "slots": {
        "1": { "sound": <palette key>, "pitched": <true|false>,
               "volume": <0-1>, "mute": false, "reverbSend": <0-1>, "delaySend": <0-1>,
               "steps": "<16 chars>",
               // optional:
               "probability": "<16 chars>",
               "glide": <true|false>,                      // pitched slots only
               "notes": [<16 ints, semitone offsets from the sound's default pitch>],  // pitched slots only; omit if every step is at default
               "filter": { "cutoff": <0-1>, "resonance": <0-1> },                     // synth-bass / chord-stab / pluck only
               "chordType": "major"|"minor"|"sus4"|"m7"|"maj7",                       // chord-stab only
               "tunable": "low"|"mid"|"high"                                           // conga only
        },
        "2": <same shape>, ..., "8": <same shape>
      }
    },
    "B": <same shape or null>,
    "C": <same shape or null>,
    "D": <same shape or null>
  },
  "chain": [<1-8 bank letters from {A,B,C,D}>]
}

SOUND PALETTE (use exactly these keys for "sound")
  Drums:       kick, snare, rim, clap, tom
  Cymbals:     chh (closed hat), ohh (open hat), ride, shaker, tambourine
  Percussion:  cowbell, conga (tunable low/mid/high), woodblock
  Bass:        808, sub-bass, synth-bass            ← pitched, default note C2 (MIDI 36)
  Tonal:       chord-stab, pluck                    ← pitched, default note C3 (MIDI 48)
               vinyl-crackle, noise-sweep           ← FX, not pitched

STEP DSL (each "steps" string is exactly 16 chars):
  .  off    x  on, medium    X  on, loud (accent)    o  on, soft (ghost)

PROBABILITY (optional, per active step): 4=100%, 3=75%, 2=50%, 1=25%, .=default 100%

NOTES ENCODING (pitched slots)
  "notes" is an array of 16 integers, each a SEMITONE OFFSET from the sound's default pitch.
  - 0  = play the default note (C2 for bass voices, C3 for chord/pluck)
  - 7  = a perfect fifth up;  -5 = a fourth down
  - Off steps: 0 is fine (ignored).
  - Omit "notes" entirely if every active step is at the default pitch.

GLIDE
  - Pitched slots only. When "glide": true, two ACTIVE STEPS THAT ARE IMMEDIATELY ADJACENT
    slide pitch between them (TB-303 style). Used heavily for trap 808 lines and acid bass.

GENRE GUIDANCE
- Boom-bap: kick on 1 and "and of 2", snare on 2 and 4, swing ~0.56, BPM 80-95. Ride swung 8ths
  feels great. Shaker on continuous 16ths adds movement.
- Trap: kick sparse and syncopated, snare/clap on 3, hi-hat rolls with probability + soft "o"
  ghost notes, swing 0, BPM 130-160. 808s on 1 and around the snare with glide between
  syncopated pitches (e.g. notes like [0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 7, 0, ...]).
- House: kick four-on-the-floor (1,5,9,13), clap on 5 and 13, closed hat on offbeats
  (3,7,11,15), open hat on 7 and 15. Chord stab on offbeats with a minor-7 voicing.
  Sub-bass on 1 and 9. Shaker continuous, tambourine on backbeats. BPM 120-128.
- Garage: shuffled kicks, snare/clap on 5 and 13, sub-bass with glide, swing ~0.3, BPM 130.

- Ghost notes (o) on snares and hats are what make patterns feel human.
- Use multiple banks (A→B variation) when the user asks for movement.

Now produce a pattern for this request:
`;
