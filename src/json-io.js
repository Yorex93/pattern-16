// Pattern-16 JSON schema v2 — slot-based.
//   v2 keys banks by slot index "1".."8", each with a `sound` field.
//   v1 (six fixed row keys) is migrated on import.
//
// Step DSL is unchanged: . x X o (off / med / loud / soft).
// Optional per-slot `probability`: . 1 2 3 4 (100/25/50/75/100 — see PROB_FROM_CHAR).
// Pitched slots optionally carry a `notes` array of 16 ints (semitone offset
// from the sound's defaultNote; 0 if not retuned or step is off).

import {
  SOUND_KEYS,
  PALETTE,
  CHORD_TYPES,
  isPitched,
  hasFilter,
  hasChord,
  tunableValues,
  defaultNote,
  defaultFilter,
  defaultChord,
} from "./sounds.js";
import { MELODY_KEY_NAMES, DEFAULT_MELODY_KEY, VALID_ROOT_NAMES, CHORD_TYPES_V5, ROOT_NAMES_SHARP, NOTE_TO_SEMI } from "./scales.js";

const SLOT_COUNT = 8;
const BANK_LETTERS = ["A", "B", "C", "D"];
const DELAY_OPTIONS = ["1/8", "1/4", "3/8", "1/2"];

const STEP_CHARS = new Set([".", "x", "X", "o"]);
const ACCENT_CHARS = new Set([".", "L", "M", "S"]);
const PROB_CHARS = new Set([".", "1", "2", "3", "4"]);

const VEL_FROM_STEP = { x: 1, X: 2, o: 0 };
const VEL_FROM_ACCENT = { L: 2, M: 1, S: 0 };
const PROB_FROM_CHAR = { 1: 25, 2: 50, 3: 75, 4: 100 };
const PROB_TO_CHAR = { 100: "4", 75: "3", 50: "2", 25: "1" };

// v1 → v2 row key migration (six fixed → slots 1–6)
const V1_ROW_TO_SOUND = {
  kick: "kick",
  snare: "snare",
  chat: "chh",
  ohat: "ohh",
  clap: "clap",
  tom: "tom",
};
const V1_ROW_ORDER = ["kick", "snare", "chat", "ohat", "clap", "tom"]; // slot order for v1 import

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
  if (sound && isPitched(sound)) {
    s.defaultNote = defaultNote(sound);
    s.glide = false;
  }
  if (sound && hasFilter(sound)) s.filter = defaultFilter(sound);
  if (sound && hasChord(sound)) s.chordType = defaultChord(sound);
  const tv = sound ? tunableValues(sound) : null;
  if (tv) s.tunable = tv[Math.floor(tv.length / 2)] ?? tv[0];
  return s;
}
function emptyBankInternal() {
  return {
    slots: Array.from({ length: SLOT_COUNT }, () => emptySlotInternal(null)),
    swing: 0,
    reverbAmount: 0.25,
  };
}

function bankIsEmpty(b) {
  if (!b) return true;
  // Empty = no active steps in any slot, default mix everywhere, no sound override params
  for (const s of b.slots) {
    if (!s) continue;
    if (s.pattern.some((c) => c.on)) return false;
    if (s.volume !== 0.85) return false;
    if (s.mute) return false;
    if (s.reverbSend !== 0) return false;
    if (s.delaySend !== 0) return false;
    if (s.sound) return false; // bank with assigned sounds isn't "empty"
  }
  return true;
}

// ---------- helpers ----------
// Scientific pitch notation: "C4", "F#3", "Eb2", "G#-1". A4 = MIDI 69.
const NOTE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function parseScientificPitch(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
  if (!m) return null;
  const base = NOTE_OFFSETS[m[1].toUpperCase()];
  if (base == null) return null;
  const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  const octave = parseInt(m[3], 10);
  return (octave + 1) * 12 + base + accidental;
}
function midiToScientific(midi) {
  const m = Math.round(midi);
  return `${NOTE_NAMES_SHARP[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}
function inRange(x, lo, hi) {
  return isFiniteNumber(x) && x >= lo && x <= hi;
}
function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
  return dp[m][n];
}
function suggest(key, valid) {
  let best = null,
    bestD = Infinity;
  for (const v of valid) {
    const d = levenshtein(String(key).toLowerCase(), v);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return bestD <= 3 ? best : null;
}

// ---------- parser ----------
export function parsePattern(json) {
  const errors = [];
  const warnings = [];

  let obj;
  if (typeof json === "string") {
    try {
      obj = JSON.parse(json);
    } catch (e) {
      return {
        ok: false,
        errors: [{ path: "", message: `JSON parse error: ${e.message}` }],
        warnings: [],
      };
    }
  } else {
    obj = json;
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      ok: false,
      errors: [
        { path: "", message: "Expected a JSON object at the top level." },
      ],
      warnings: [],
    };
  }

  // version — accept 1/2 (migrate), 3, or 4 (current)
  if (!("version" in obj)) {
    errors.push({
      path: "version",
      message:
        'Missing required "version" field. Expected 4 (or 1/2/3 to be migrated).',
    });
  } else if (obj.version === 1) {
    return parseV1ThenMigrate(obj);
  } else if (obj.version !== 2 && obj.version !== 3 && obj.version !== 4 && obj.version !== 5) {
    if (isFiniteNumber(obj.version) && obj.version > 5) {
      return {
        ok: false,
        errors: [
          {
            path: "version",
            message: `This file uses schema version ${obj.version}; this app supports version 5.`,
          },
        ],
        warnings: [],
      };
    }
    errors.push({
      path: "version",
      message: "version must equal 5 (or 1/2/3/4 for migration).",
    });
  }

  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : "untitled";

  if (!("bpm" in obj))
    errors.push({ path: "bpm", message: 'Missing required "bpm".' });
  else if (!inRange(obj.bpm, 60, 180))
    errors.push({
      path: "bpm",
      message: "bpm must be a number between 60 and 180.",
    });

  if (!("swing" in obj))
    errors.push({ path: "swing", message: 'Missing required "swing".' });
  else if (!inRange(obj.swing, 0, 0.66))
    errors.push({
      path: "swing",
      message: "swing must be a number between 0 and 0.66.",
    });

  if (!obj.sends || typeof obj.sends !== "object" || Array.isArray(obj.sends)) {
    errors.push({ path: "sends", message: 'Missing required "sends" object.' });
  } else {
    const r = obj.sends.reverb;
    if (!r || typeof r !== "object")
      errors.push({
        path: "sends.reverb",
        message: 'Missing "sends.reverb" object.',
      });
    else if (!inRange(r.amount, 0, 1))
      errors.push({
        path: "sends.reverb.amount",
        message: "sends.reverb.amount must be 0–1.",
      });

    const d = obj.sends.delay;
    if (!d || typeof d !== "object")
      errors.push({
        path: "sends.delay",
        message: 'Missing "sends.delay" object.',
      });
    else {
      if (!DELAY_OPTIONS.includes(d.time))
        errors.push({
          path: "sends.delay.time",
          message: `sends.delay.time must be one of ${DELAY_OPTIONS.map((v) => `"${v}"`).join(", ")}.`,
        });
      if (!inRange(d.feedback, 0, 1))
        errors.push({
          path: "sends.delay.feedback",
          message: "sends.delay.feedback must be 0–1.",
        });
    }
  }

  // banks
  const banks = [null, null, null, null];
  const bankExplicitlyNull = [false, false, false, false];
  if (!obj.banks || typeof obj.banks !== "object" || Array.isArray(obj.banks)) {
    errors.push({ path: "banks", message: 'Missing required "banks" object.' });
  } else {
    for (let i = 0; i < 4; i++) {
      const L = BANK_LETTERS[i];
      if (!(L in obj.banks)) {
        errors.push({
          path: `banks.${L}`,
          message: `Missing "banks.${L}". Use null for empty banks.`,
        });
        continue;
      }
      const bv = obj.banks[L];
      if (bv === null) {
        bankExplicitlyNull[i] = true;
        continue;
      }
      if (typeof bv !== "object" || Array.isArray(bv)) {
        errors.push({
          path: `banks.${L}`,
          message: `banks.${L} must be an object or null.`,
        });
        continue;
      }
      banks[i] = parseBank(bv, `banks.${L}`, errors, warnings, obj.version);
    }
    for (const k of Object.keys(obj.banks)) {
      if (!BANK_LETTERS.includes(k))
        warnings.push({
          path: `banks.${k}`,
          message: `Unknown bank "${k}" — ignored.`,
        });
    }
  }

  // chain
  const chainIdx = [];
  if (!Array.isArray(obj.chain)) {
    errors.push({ path: "chain", message: "chain must be an array." });
  } else if (obj.chain.length < 1 || obj.chain.length > 8) {
    errors.push({
      path: "chain",
      message: `chain must have 1–8 entries (got ${obj.chain.length}).`,
    });
  } else {
    obj.chain.forEach((c, i) => {
      const idx = BANK_LETTERS.indexOf(c);
      if (idx < 0) {
        errors.push({
          path: `chain[${i}]`,
          message: `chain[${i}] must be one of "A","B","C","D" (got ${JSON.stringify(c)}).`,
        });
        return;
      }
      if (bankExplicitlyNull[idx]) {
        errors.push({
          path: `chain[${i}]`,
          message: `chain[${i}] references bank "${c}", but banks.${c} is null.`,
        });
        return;
      }
      chainIdx.push(idx);
    });
  }

  // Optional top-level "kit" string (v3+); v2 files just don't have it.
  let kitId = null;
  if ("kit" in obj) {
    if (obj.kit === null) kitId = null;
    else if (typeof obj.kit !== "string")
      errors.push({
        path: "kit",
        message: 'kit must be a string id (e.g. "boom-bap") or null.',
      });
    else kitId = obj.kit;
  }

  // Optional top-level "mix" object (v4+). v3 files just don't have it.
  let mix = null;
  if ("mix" in obj && obj.mix != null) {
    const m = obj.mix;
    if (typeof m !== "object" || Array.isArray(m)) {
      errors.push({ path: "mix", message: "mix must be an object." });
    } else {
      mix = { glue: 0.35, sidechain: { amount: 0.5, targets: [] } };
      if ("glue" in m) {
        if (!inRange(m.glue, 0, 1)) errors.push({ path: "mix.glue", message: "mix.glue must be 0–1." });
        else mix.glue = m.glue;
      }
      if ("sidechain" in m && m.sidechain && typeof m.sidechain === "object") {
        if ("amount" in m.sidechain) {
          if (!inRange(m.sidechain.amount, 0, 1)) errors.push({ path: "mix.sidechain.amount", message: "mix.sidechain.amount must be 0–1." });
          else mix.sidechain.amount = m.sidechain.amount;
        }
        if (Array.isArray(m.sidechain.targets)) {
          const tIdx = [];
          for (const t of m.sidechain.targets) {
            const n = Number(t) - 1;
            if (!Number.isInteger(n) || n < 0 || n >= SLOT_COUNT) errors.push({ path: "mix.sidechain.targets", message: `target "${t}" must be a slot key "1".."8".` });
            else tIdx.push(n);
          }
          mix.sidechain.targets = Array.from(new Set(tIdx)).sort((a, b) => a - b);
        }
      }
    }
  }

  const KNOWN_TOP = new Set([
    "version",
    "name",
    "bpm",
    "swing",
    "sends",
    "banks",
    "chain",
    "kit",
    "mix",
  ]);
  for (const k of Object.keys(obj))
    if (!KNOWN_TOP.has(k))
      warnings.push({
        path: k,
        message: `Unknown top-level key "${k}" — ignored.`,
      });

  if (errors.length > 0) return { ok: false, errors, warnings };

  const sw = obj.swing;
  const rev = obj.sends.reverb.amount;
  const normalizedBanks = banks.map((b) => {
    if (b === null) return emptyBankInternal();
    return { ...b, swing: Math.round(sw * 100), reverbAmount: rev };
  });

  return {
    ok: true,
    errors: [],
    warnings,
    value: {
      name,
      bpm: obj.bpm,
      swing: sw,
      reverbAmount: rev,
      delayTime: obj.sends.delay.time,
      delayFeedback: obj.sends.delay.feedback,
      banks: normalizedBanks,
      bankPresent: bankExplicitlyNull.map((n, i) => !n && banks[i] !== null),
      chain: chainIdx,
      kit: kitId,
      mix,
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
    if (!bv.rows || typeof bv.rows !== "object" || Array.isArray(bv.rows)) {
      errors.push({
        path: `${base}.rows`,
        message: `${base}.rows must be an object.`,
      });
      return out;
    }
    // Place known v1 row keys into slots 1–6 (indices 0–5) in fixed order.
    for (let i = 0; i < V1_ROW_ORDER.length; i++) {
      const key = V1_ROW_ORDER[i];
      const v = bv.rows[key];
      if (!v) continue;
      if (typeof v !== "object" || Array.isArray(v)) {
        errors.push({
          path: `${base}.rows.${key}`,
          message: `must be an object.`,
        });
        continue;
      }
      const sound = V1_ROW_TO_SOUND[key];
      const slot = emptySlotInternal(sound);
      if (inRange(v.volume, 0, 1)) slot.volume = v.volume;
      else
        errors.push({
          path: `${base}.rows.${key}.volume`,
          message: `volume must be 0–1.`,
        });
      if (typeof v.mute === "boolean") slot.mute = v.mute;
      else
        errors.push({
          path: `${base}.rows.${key}.mute`,
          message: `mute must be boolean.`,
        });
      if (inRange(v.reverbSend, 0, 1)) slot.reverbSend = v.reverbSend;
      else
        errors.push({
          path: `${base}.rows.${key}.reverbSend`,
          message: `reverbSend must be 0–1.`,
        });
      if (inRange(v.delaySend, 0, 1)) slot.delaySend = v.delaySend;
      else
        errors.push({
          path: `${base}.rows.${key}.delaySend`,
          message: `delaySend must be 0–1.`,
        });

      if (typeof v.steps !== "string" || v.steps.length !== 16) {
        errors.push({
          path: `${base}.rows.${key}.steps`,
          message: `steps must be a 16-char string.`,
        });
      } else {
        slot.pattern = parseSteps(v.steps, `${base}.rows.${key}.steps`, errors);
      }
      out.slots[i] = slot;
    }
    // accents / probability for v1
    if ("accents" in bv && bv.accents && typeof bv.accents === "object") {
      for (const [k, v] of Object.entries(bv.accents)) {
        const idx = V1_ROW_ORDER.indexOf(k);
        if (idx < 0) continue;
        if (typeof v !== "string" || v.length !== 16) continue;
        applyAccents(out.slots[idx].pattern, v);
      }
    }
    if (
      "probability" in bv &&
      bv.probability &&
      typeof bv.probability === "object"
    ) {
      for (const [k, v] of Object.entries(bv.probability)) {
        const idx = V1_ROW_ORDER.indexOf(k);
        if (idx < 0) continue;
        if (typeof v !== "string" || v.length !== 16) continue;
        applyProb(out.slots[idx].pattern, v);
      }
    }
    warnings.push({
      path: base,
      message: `migrated from v1 (slots 1–6 from row keys; 7–8 empty).`,
    });
    return out;
  }

  // Walk v1 top-level (mirrors v2 parser but for v1's bank shape)
  if (!inRange(v1.bpm, 60, 180))
    errors.push({ path: "bpm", message: "bpm must be 60–180." });
  if (!inRange(v1.swing, 0, 0.66))
    errors.push({ path: "swing", message: "swing must be 0–0.66." });
  if (!v1.sends?.reverb || !inRange(v1.sends.reverb.amount, 0, 1))
    errors.push({
      path: "sends.reverb.amount",
      message: "sends.reverb.amount must be 0–1.",
    });
  if (!v1.sends?.delay || !DELAY_OPTIONS.includes(v1.sends.delay.time))
    errors.push({
      path: "sends.delay.time",
      message: `sends.delay.time invalid.`,
    });
  if (!v1.sends?.delay || !inRange(v1.sends.delay.feedback, 0, 1))
    errors.push({
      path: "sends.delay.feedback",
      message: "sends.delay.feedback must be 0–1.",
    });

  const banks = [null, null, null, null];
  const bankNull = [false, false, false, false];
  if (!v1.banks || typeof v1.banks !== "object")
    errors.push({ path: "banks", message: 'Missing "banks".' });
  else {
    for (let i = 0; i < 4; i++) {
      const L = BANK_LETTERS[i];
      const bv = v1.banks[L];
      if (bv == null) {
        bankNull[i] = bv === null;
        continue;
      }
      banks[i] = migrateV1Bank(bv, `banks.${L}`);
    }
  }
  const chainIdx = [];
  if (Array.isArray(v1.chain))
    v1.chain.forEach((c, i) => {
      const idx = BANK_LETTERS.indexOf(c);
      if (idx < 0)
        errors.push({ path: `chain[${i}]`, message: `must be A/B/C/D.` });
      else if (bankNull[idx])
        errors.push({
          path: `chain[${i}]`,
          message: `references null bank "${c}".`,
        });
      else chainIdx.push(idx);
    });

  if (errors.length > 0) return { ok: false, errors, warnings };

  const sw = v1.swing;
  const rev = v1.sends.reverb.amount;
  const normalizedBanks = banks.map((b) =>
    b == null
      ? emptyBankInternal()
      : { ...b, swing: Math.round(sw * 100), reverbAmount: rev },
  );

  return {
    ok: true,
    errors: [],
    warnings,
    value: {
      name:
        typeof v1.name === "string" && v1.name.trim()
          ? v1.name.trim()
          : "untitled",
      bpm: v1.bpm,
      swing: sw,
      reverbAmount: rev,
      delayTime: v1.sends.delay.time,
      delayFeedback: v1.sends.delay.feedback,
      banks: normalizedBanks,
      bankPresent: bankNull.map((n, i) => !n && banks[i] !== null),
      chain: chainIdx,
      kit: null,
      mix: null,
    },
  };
}

function parseSteps(str, path, errors) {
  const cells = [];
  for (let i = 0; i < 16; i++) {
    const ch = str[i];
    if (!STEP_CHARS.has(ch)) {
      errors.push({
        path,
        message: `Invalid character "${ch}" at position ${i + 1}. Allowed: . x X o`,
      });
      cells.push(EMPTY_CELL());
      continue;
    }
    if (ch === ".") cells.push(EMPTY_CELL());
    else
      cells.push({ on: true, velocity: VEL_FROM_STEP[ch], probability: 100 });
  }
  return cells;
}
function applyAccents(pattern, str) {
  for (let i = 0; i < 16; i++) {
    const ch = str[i];
    if (!ACCENT_CHARS.has(ch)) continue;
    if (ch === "." || !pattern[i].on) continue;
    pattern[i].velocity = VEL_FROM_ACCENT[ch];
  }
}
function applyProb(pattern, str) {
  for (let i = 0; i < 16; i++) {
    const ch = str[i];
    if (!PROB_CHARS.has(ch)) continue;
    if (ch === "." || !pattern[i].on) continue;
    pattern[i].probability = PROB_FROM_CHAR[ch];
  }
}

// ---------- v2 bank/slot parser ----------
function parseBank(bv, base, errors, warnings, version) {
  const out = emptyBankInternal();
  // v4 banks have no chord field; engine falls back to legacy slot.chordType.
  // Strip the default chord that emptyBankInternal stamps on, so the parser
  // never invents one for v4-or-earlier files.
  if (version < 5) delete out.chord;

  if (!bv.slots || typeof bv.slots !== "object" || Array.isArray(bv.slots)) {
    errors.push({
      path: `${base}.slots`,
      message: `${base}.slots must be an object keyed by "1".."8".`,
    });
    return out;
  }
  for (const [k, v] of Object.entries(bv.slots)) {
    const idx = Number(k) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= SLOT_COUNT) {
      errors.push({
        path: `${base}.slots.${k}`,
        message: `Slot key "${k}" must be "1".."8".`,
      });
      continue;
    }
    if (v === null) {
      out.slots[idx] = emptySlotInternal(null);
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      errors.push({
        path: `${base}.slots.${k}`,
        message: `Slot must be an object or null.`,
      });
      continue;
    }
    out.slots[idx] = parseSlot(v, `${base}.slots.${k}`, errors, warnings);
  }

  // v5: bank chord. Validate root + type independently; either default if missing.
  if ("chord" in bv && bv.chord != null) {
    const c = bv.chord;
    if (typeof c !== "object" || Array.isArray(c)) {
      errors.push({ path: `${base}.chord`, message: "chord must be an object { root, type }." });
    } else {
      const chord = { root: "A", type: "minor" };
      if ("root" in c) {
        if (typeof c.root === "string" && VALID_ROOT_NAMES.includes(c.root)) {
          // Canonicalize to sharp form so duplicate spellings round-trip cleanly.
          chord.root = ROOT_NAMES_SHARP[NOTE_TO_SEMI[c.root]];
        } else {
          errors.push({ path: `${base}.chord.root`, message: `chord.root must be a note name (C..B with optional # or b).` });
        }
      }
      if ("type" in c) {
        if (typeof c.type === "string" && CHORD_TYPES_V5.includes(c.type)) {
          chord.type = c.type;
        } else {
          errors.push({ path: `${base}.chord.type`, message: `chord.type must be one of: ${CHORD_TYPES_V5.join(", ")}.` });
        }
      }
      out.chord = chord;
    }
  } else if (version >= 5) {
    // v5 file with chord field missing — apply the default so the bank still
    // has a chord (v5 schema's "default for a new bank" rule).
    out.chord = { root: "A", type: "minor" };
  }

  const KNOWN_BANK = new Set(["slots", "chord"]);
  for (const k of Object.keys(bv))
    if (!KNOWN_BANK.has(k))
      warnings.push({
        path: `${base}.${k}`,
        message: `Unknown key "${k}" — ignored.`,
      });
  return out;
}

function parseSlot(v, base, errors, warnings) {
  // sound
  if (!("sound" in v)) {
    errors.push({
      path: `${base}.sound`,
      message: `Missing "sound" (use null for unassigned).`,
    });
    return emptySlotInternal(null);
  }
  if (v.sound !== null && !SOUND_KEYS.includes(v.sound)) {
    const hint = suggest(v.sound, SOUND_KEYS);
    errors.push({
      path: `${base}.sound`,
      message: `Unknown sound "${v.sound}".${hint ? ` Did you mean "${hint}"?` : ""}`,
    });
    return emptySlotInternal(null);
  }
  const slot = emptySlotInternal(v.sound);
  const path = (k) => `${base}.${k}`;

  if (inRange(v.volume, 0, 1)) slot.volume = v.volume;
  else errors.push({ path: path("volume"), message: "volume must be 0–1." });
  if (typeof v.mute === "boolean") slot.mute = v.mute;
  else errors.push({ path: path("mute"), message: "mute must be a boolean." });
  if (inRange(v.reverbSend, 0, 1)) slot.reverbSend = v.reverbSend;
  else
    errors.push({
      path: path("reverbSend"),
      message: "reverbSend must be 0–1.",
    });
  if (inRange(v.delaySend, 0, 1)) slot.delaySend = v.delaySend;
  else
    errors.push({ path: path("delaySend"), message: "delaySend must be 0–1." });

  // v4: per-slot drive (optional, defaults 0)
  if ("drive" in v && v.drive != null) {
    if (inRange(v.drive, 0, 1)) slot.drive = v.drive;
    else errors.push({ path: path("drive"), message: "drive must be 0–1." });
  } else {
    slot.drive = 0;
  }
  // v5: per-pitched-slot followChord (optional, default false)
  if ("followChord" in v && v.followChord != null) {
    if (typeof v.followChord === "boolean") slot.followChord = v.followChord;
    else errors.push({ path: path("followChord"), message: "followChord must be a boolean." });
  } else {
    slot.followChord = false;
  }

  if (typeof v.steps !== "string" || v.steps.length !== 16) {
    errors.push({
      path: path("steps"),
      message: "steps must be a 16-char string.",
    });
  } else {
    slot.pattern = parseSteps(v.steps, path("steps"), errors);
  }

  // optional probability + accents
  if (typeof v.accents === "string" && v.accents.length === 16)
    applyAccents(slot.pattern, v.accents);
  if (typeof v.probability === "string" && v.probability.length === 16)
    applyProb(slot.pattern, v.probability);

  // pitched-only fields
  if (v.sound !== null && isPitched(v.sound)) {
    if (typeof v.glide === "boolean") slot.glide = v.glide;
    if ("notes" in v) {
      if (!Array.isArray(v.notes) || v.notes.length !== 16) {
        errors.push({
          path: path("notes"),
          message:
            "notes must be a 16-element array of integers (semitone offsets from defaultNote).",
        });
      } else {
        for (let i = 0; i < 16; i++) {
          const off = v.notes[i];
          if (off == null) continue;
          if (!Number.isInteger(off) || off < -48 || off > 48) {
            errors.push({
              path: `${path("notes")}[${i}]`,
              message: `notes[${i}] must be an integer between -48 and 48.`,
            });
            continue;
          }
          if (slot.pattern[i].on) slot.pattern[i].note = slot.defaultNote + off;
        }
      }
    }
    // Ensure all active cells have a note (default if missing)
    for (let i = 0; i < 16; i++)
      if (slot.pattern[i].on && slot.pattern[i].note == null)
        slot.pattern[i].note = slot.defaultNote;

    // v4: melody array — supersedes the grid pattern for this slot when present.
    if ("melody" in v && Array.isArray(v.melody)) {
      const melody = [];
      for (let mi = 0; mi < v.melody.length; mi++) {
        const n = v.melody[mi];
        if (!n || typeof n !== "object") {
          errors.push({ path: `${path("melody")}[${mi}]`, message: "melody item must be an object." });
          continue;
        }
        if (!Number.isInteger(n.step) || n.step < 1 || n.step > 16) {
          errors.push({ path: `${path("melody")}[${mi}].step`, message: "step must be an integer 1–16." });
          continue;
        }
        const pitchMidi = parseScientificPitch(n.pitch);
        if (pitchMidi == null) {
          errors.push({ path: `${path("melody")}[${mi}].pitch`, message: `pitch "${n.pitch}" must be scientific notation (e.g. "A3", "F#2", "Eb4").` });
          continue;
        }
        let length = 1;
        if ("length" in n) {
          if (!Number.isInteger(n.length) || n.length < 1 || n.length > 16) errors.push({ path: `${path("melody")}[${mi}].length`, message: "length must be 1–16." });
          else length = n.length;
        }
        let velocity = 1;
        if ("velocity" in n) {
          const map = { soft: 0, medium: 1, loud: 2 };
          if (!(n.velocity in map)) errors.push({ path: `${path("melody")}[${mi}].velocity`, message: 'velocity must be "soft", "medium", or "loud".' });
          else velocity = map[n.velocity];
        }
        let probability = 100;
        if ("probability" in n) {
          if (![100, 75, 50, 25].includes(n.probability)) errors.push({ path: `${path("melody")}[${mi}].probability`, message: "probability must be 100, 75, 50, or 25." });
          else probability = n.probability;
        }
        melody.push({ step: n.step, pitch: pitchMidi, length, velocity, probability });
      }
      slot.melody = melody;
    }

    // melodyKey: used by the melody editor for snap-to-scale AND by the v5
    // follow-chord transposition. Parse on any pitched slot, not just melody-
    // mode ones. Missing field is fine; the engine and editor both fall back
    // to DEFAULT_MELODY_KEY when undefined.
    if ("melodyKey" in v) {
      if (typeof v.melodyKey === "string" && MELODY_KEY_NAMES.includes(v.melodyKey)) {
        slot.melodyKey = v.melodyKey;
      } else {
        errors.push({ path: path("melodyKey"), message: `melodyKey must be one of: ${MELODY_KEY_NAMES.join(", ")}.` });
      }
    }
  }

  // filter
  if (v.sound !== null && hasFilter(v.sound) && v.filter) {
    if (inRange(v.filter.cutoff, 0, 1)) slot.filter.cutoff = v.filter.cutoff;
    else
      errors.push({
        path: path("filter.cutoff"),
        message: "filter.cutoff must be 0–1.",
      });
    if (inRange(v.filter.resonance, 0, 1))
      slot.filter.resonance = v.filter.resonance;
    else
      errors.push({
        path: path("filter.resonance"),
        message: "filter.resonance must be 0–1.",
      });
  }

  // chord
  if (v.sound !== null && hasChord(v.sound) && v.chordType) {
    if (CHORD_TYPES.includes(v.chordType)) slot.chordType = v.chordType;
    else
      errors.push({
        path: path("chordType"),
        message: `chordType must be one of ${CHORD_TYPES.join(", ")}.`,
      });
  }

  // tunable (e.g. conga low/mid/high)
  if (v.sound !== null && tunableValues(v.sound) && v.tunable) {
    const tv = tunableValues(v.sound);
    if (tv.includes(v.tunable)) slot.tunable = v.tunable;
    else
      errors.push({
        path: path("tunable"),
        message: `tunable must be one of ${tv.join(", ")}.`,
      });
  }

  // unknown slot keys
  const KNOWN_SLOT = new Set([
    "sound",
    "pitched",
    "volume",
    "mute",
    "reverbSend",
    "delaySend",
    "drive",
    "steps",
    "accents",
    "probability",
    "glide",
    "notes",
    "melody",
    "melodyKey",
    "filter",
    "chordType",
    "tunable",
    "followChord",
    "defaultNote",
  ]);
  for (const k of Object.keys(v))
    if (!KNOWN_SLOT.has(k))
      warnings.push({
        path: path(k),
        message: `Unknown key "${k}" — ignored.`,
      });

  return slot;
}

// ---------- serializer ----------
export function serializePattern(state) {
  const { name, bpm, banks, chain, delayTime, delayFeedback, editBank, kit, mix } =
    state;
  const refBank =
    banks[editBank] ?? banks.find((b) => !bankIsEmpty(b)) ?? banks[0];
  const swInt = refBank?.swing ?? 0;
  const rev = refBank?.reverbAmount ?? 0.25;

  const banksObj = {};
  BANK_LETTERS.forEach((L, i) => {
    const b = banks[i];
    banksObj[L] = bankIsEmpty(b) ? null : bankToJson(b);
  });

  const out = {
    version: 5,
    name: (name && name.trim()) || "untitled",
    bpm,
    swing: Math.round(swInt) / 100,
    sends: {
      reverb: { amount: round3(rev) },
      delay: { time: delayTime, feedback: round3(delayFeedback) },
    },
    banks: banksObj,
    chain: chain.map((i) => BANK_LETTERS[i]),
  };
  if (kit) out.kit = kit;
  if (mix) {
    out.mix = {
      glue: round3(mix.glue ?? 0.35),
      sidechain: {
        amount: round3(mix.sidechain?.amount ?? 0.5),
        targets: (mix.sidechain?.targets ?? []).map((i) => String(i + 1)),
      },
    };
  }
  return out;
}

function bankToJson(b) {
  const slots = {};
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = b.slots[i];
    if (!s || !s.sound) continue;
    slots[String(i + 1)] = slotToJson(s);
  }
  const out = { slots };
  // v5: emit chord only when defined. v4-vintage banks have no chord.
  if (b.chord && b.chord.root && b.chord.type) {
    out.chord = { root: b.chord.root, type: b.chord.type };
  }
  return out;
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
  if (s.drive && s.drive > 0) out.drive = round3(s.drive);
  if (isPitched(s.sound) && s.followChord) out.followChord = true;
  // steps + probability strings
  let steps = "",
    prob = "",
    hasProb = false;
  for (let i = 0; i < 16; i++) {
    const c = s.pattern[i];
    if (!c.on) {
      steps += ".";
      prob += ".";
      continue;
    }
    steps += c.velocity === 2 ? "X" : c.velocity === 0 ? "o" : "x";
    if (c.probability !== 100) {
      prob += PROB_TO_CHAR[c.probability];
      hasProb = true;
    } else prob += ".";
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
  if (hasFilter(s.sound) && s.filter)
    out.filter = {
      cutoff: round3(s.filter.cutoff),
      resonance: round3(s.filter.resonance),
    };
  if (hasChord(s.sound) && s.chordType) out.chordType = s.chordType;
  if (tunableValues(s.sound) && s.tunable) out.tunable = s.tunable;

  // v4 melody (pitched only) — supersedes the notes string when present.
  // Also serialize melodyKey alongside the array (it's UI-tied and meaningless
  // without melody mode; emit even when the array is empty so an empty-melody
  // slot still round-trips the key choice).
  if (isPitched(s.sound) && Array.isArray(s.melody)) {
    const VEL_NAME = ["soft", "medium", "loud"];
    out.melody = s.melody.map((n) => {
      const item = {
        step: n.step,
        pitch: midiToScientific(n.pitch),
      };
      if (n.length && n.length !== 1) item.length = n.length;
      if (n.velocity !== 1) item.velocity = VEL_NAME[n.velocity ?? 1];
      if (n.probability !== 100) item.probability = n.probability;
      return item;
    });
  }
  // v5: melodyKey is meaningful for both melody-mode (snap-to-scale) AND
  // follow-chord grid-mode slots (transposition reference). Emit when non-default.
  if (isPitched(s.sound) && s.melodyKey && s.melodyKey !== DEFAULT_MELODY_KEY) {
    out.melodyKey = s.melodyKey;
  }
  return out;
}

// ---------- AI prompt ----------
export const AI_SYSTEM_PROMPT_V0 = `You are helping a user design a drum + bass + chord pattern for Pattern-16, a 16-step machine with 8 assignable slots per bank. Output a single JSON object matching the schema below. Output JSON only — no commentary, no markdown fences.

SCHEMA (version 3)
{
  "version": 3,
  "name": "<short name>",
  "bpm": <60-180>,
  "swing": <0-0.66, use 0 for straight, ~0.56 for boom-bap, ~0.2 for subtle shuffle>,
  "kit": <optional kit id, see KITS below; display only>,
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
               "glide": <true|false>,                       // pitched slots only
               "notes": [<16 ints, semitone offsets from the sound's default pitch>],   // pitched slots only; omit if every step is at default
               "filter": { "cutoff": <0-1>, "resonance": <0-1>, "envAmount": <0-1> },   // synth-bass / acid-bass / reese-bass / chord-stab / pad / pluck (envAmount: acid-bass only)
               "chordType": "major"|"minor"|"sus4"|"m7"|"maj7",                         // chord-stab / pad only
               "tunable": "low"|"mid"|"high"                                            // conga / djembe only
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
  Drums:       kick, snare, rim, clap, snap, tom
  Cymbals:     chh (closed hat), ohh (open hat), ride, crash, shaker, tambourine
  Percussion:  cowbell, conga, djembe (both tunable low/mid/high), woodblock
  Bass:        808, sub-bass, synth-bass, acid-bass, reese-bass    ← pitched, default note C2 (MIDI 36)
  Tonal:       chord-stab, pad, pluck                              ← pitched, default note C3 (MIDI 48)
               riser, vinyl-bed, vinyl-crackle, noise-sweep        ← FX/texture, not pitched

SPECIAL VOICE BEHAVIORS
  • vinyl-bed is CONTINUOUS — its active steps just gate the bed on/off for the whole bar.
    Placing one active step is enough to make the bed play through the bar; you don't need to
    fill 16 steps. Use it for lo-fi or ambient atmosphere underneath everything.
  • riser plays its full ~1-bar sweep when triggered and overlaps subsequent steps naturally.
    Trigger it once near the end of a bar to transition into a section change. Don't try
    to fit it inside the 16-step grid.

KITS (optional curated 8-slot palettes — the user can also load these by name in the UI)
  boom-bap     classic 90s hip-hop palette
  trap         tight kick, snap-tight clap, hat rolls, sliding 808
  house        4/4, off-beat hats, minor chord stab, sub
  drill        UK drill — slid 808, sharp snare, crash hits, glide on
  lo-fi        soft kick, dusty snare, vinyl bed, mellow pad
  acid-house   squelchy 303 bass driving cowbell + chord stab
  jungle-dnb   chopped breaks, ride wash, reese growl + sub
  afrobeats    djembe-led, snappy hats, warm chord
  ambient      sparse percussion, vinyl bed, evolving pad
  Setting "kit" at the top level is a display-only hint — the per-slot "sound" values are
  authoritative. Pick one only if your slot assignments actually match a kit.

STEP DSL (each "steps" string is exactly 16 chars):
  .  off    x  on, medium    X  on, loud (accent)    o  on, soft (ghost)

PROBABILITY (optional, per active step): 4=100%, 3=75%, 2=50%, 1=25%, .=default 100%

NOTES ENCODING (pitched slots)
  "notes" is an array of 16 integers, each a SEMITONE OFFSET from the sound's default pitch.
  - 0  = play the default note (C2 for bass voices, C3 for chord/pluck/pad)
  - 7  = a perfect fifth up;  -5 = a fourth down
  - Off steps: 0 is fine (ignored).
  - Omit "notes" entirely if every active step is at the default pitch.

GLIDE
  - Pitched slots only. When "glide": true, two ACTIVE STEPS THAT ARE IMMEDIATELY ADJACENT
    slide pitch between them (TB-303 style). Used heavily for trap 808 lines and acid bass.

GENRE GUIDANCE
- Boom-bap: kick on 1 and "and of 2", snare on 2 and 4, swing ~0.56, BPM 80-95. Ride swung
  8ths feels great. Shaker on continuous 16ths adds movement. Rim on odd off-beats.
- Trap: kick sparse and syncopated, snare/clap on 3, hi-hat rolls with probability + soft "o"
  ghost notes, swing 0, BPM 130-160. 808s on 1 and around the snare with glide between
  syncopated pitches (e.g. notes like [0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 7, 0, ...]).
  A snap on backbeat layered with clap is the modern sound.
- Drill: kick patterns with slid 808s (heavy glide), sharper snares, occasional crash on
  bar one. BPM 140-150.
- House: kick four-on-the-floor (1,5,9,13), clap on 5 and 13, closed hat on offbeats
  (3,7,11,15), open hat on 7 and 15. Chord stab on offbeats with a minor-7 voicing.
  Sub-bass on 1 and 9. Shaker continuous, tambourine on backbeats. BPM 120-128.
- Acid house: same kick/clap as house but the star is acid-bass with high resonance and
  filter env — write a sequence with glide between adjacent notes and let the filter sweep.
  BPM 120-130.
- Jungle / DnB: chopped break feel, snappy snare on 5/13, reese-bass holding long notes
  underneath (long decay so notes blur), sub-bass on root. BPM 160-180. Reese works well
  with notes a fifth apart.
- Lo-fi: BPM 70-90, swing ~0.2, soft kick, dusty snare, vinyl-bed always on, mellow chord
  pad (maj7), sparse ride.
- Afrobeats: BPM 100-115, djembe and conga as the rhythmic backbone, snap on accents,
  warm major chord stab.
- Ambient / Downtempo: BPM 60-80, sparse hits, long pad with reverb, vinyl-bed underneath,
  pluck for occasional melodic accent.

VOICE-SPECIFIC TIPS
- acid-bass: keep resonance high (>0.6) and envAmount around 0.7 for the signature squelch.
- reese-bass: longer note placements work best — its slow filter LFO needs time to breathe.
- pad: typically on a single step at the start of a bar; its 1.5s+ decay does the work.
- riser: one trigger near step 13-15 of a bar to transition into the next section.
- vinyl-bed: a single active step in the bar is all that's needed.
- crash: bar one, or final bar of the chain. Don't sprinkle it.

- Ghost notes (o) on snares and hats are what make patterns feel human.
- Use multiple banks (A→B variation) when the user asks for movement.

Now produce a pattern for this request:
`;

export const AI_SYSTEM_PROMPT = `You are an expert beat producer helping a user design a drum pattern for Pattern-16, a 16-step groovebox. Output a single JSON object matching the schema below. Output JSON only — no commentary, no markdown fences, no explanation before or after.

# v5 ADDITIONS — CHORD PROGRESSIONS (READ THIS FIRST)
Each non-null bank has a "chord": { "root": <note name>, "type": <chord type> } that drives two things:
1. Any chord-stab slot in the bank plays this chord automatically. Do NOT write a chord-stab's pitches in melody mode for harmony — just place the slot's hits (steps grid is fine) and the bank chord supplies the voicing.
2. Pitched slots with "followChord": true transpose every note they play by (bankRoot - slotMelodyKeyRoot) semitones. This turns a single bassline into a progression that moves with the chord changes.

bank chord shape: { "root": "A"|"A#"|"B"|... |"Bb"|"Eb"|... , "type": "major"|"minor"|"maj7"|"m7"|"7"|"sus4"|"dim"|"aug" }
Root accepts sharp or flat spellings; the canonical output uses sharps (so "Eb" round-trips to "D#").

When to use followChord:
- Bass slots (808, sub-bass, synth-bass, acid-bass, reese-bass) in chains that span multiple bank chords → YES, set followChord true and write the bassline in bank A's key.
- Chord-stab / pad / pluck → leave followChord OFF (chord-stab follows automatically; pad/pluck are written in concrete pitches for melodic content).
- Single-chord patterns (chain is just ["A"]) → leave followChord off; there's nothing to follow.

For follow-chord slots, also set "melodyKey" to the slot's reference key (e.g. "A minor"). The slot's notes are interpreted relative to this key's root, so make sure bank A's chord root MATCHES the melodyKey's root for the bassline to play its written pitches in bank A.

GENRE PROGRESSIONS
- Boom-bap / lo-fi: i-iv or ii-V-i with maj7/m7 colors. Example: Am7 → Dm7 → G7 → Cmaj7. Slow harmonic rhythm — chain like [A, A, B, A]. Bass follows.
- House: i-VI or i-iv-V. Example: Am7 → Fmaj7. Chain [A, B, A, B]. Sub-bass follows. Chord-stab IS the lead — make sure both banks have a chord-stab slot.
- Trap / drill: simple, dark, often i-VII or i-VI. Example: Fm → Cm (i-V), Cm → Ab (i-VI). Chain [A, A, A, B] for a turnaround. 808 follows with glide on.
- Ambient: slow chord movement, modal or extended. Use all four banks if you want full-bar chord changes — chain [A, B, C, D]. Pad and sub-bass both follow.

RULE: if you write a multi-bank chain, set followChord true on the bass slot. Otherwise the bass plays the same literal notes under every chord (which sounds wrong against changing harmony).

# v4 ADDITIONS (READ THIS BEFORE THE REST)
- Top-level "mix" object: { "glue": <0-1>, "sidechain": { "amount": <0-1>, "targets": ["1","3",...] } }. Glue is the master bus compressor+saturator+limiter knob. Sidechain ducks the listed slots whenever the kick fires.
- Per-slot "drive": <0-1>, an optional saturator on each slot. 0 if omitted.
- Per-pitched-slot "melody": optional array of note objects. When present, it supersedes the slot's "notes" string for that slot. Use melody arrays for melodic content (pluck, pad, lead lines, multi-step bass sustains). Use "notes" string for grid-aligned basslines that just play once per active step.

melody[] item shape: { "step": <1-16>, "pitch": "<scientific notation, e.g. A3, F#2, Eb4>", "length": <1-16>, "velocity": "soft"|"medium"|"loud", "probability": 100|75|50|25 }
  length, velocity, probability are optional — omit when defaulted (length 1, velocity medium, probability 100).
  Mono pitched voices (808, sub-bass, synth-bass, acid-bass, reese-bass, pluck) allow ONE note per step.
  Polyphonic voices (chord-stab, pad) allow UP TO 4 notes at the same step — voice chords by stacking multiple melody items at the same step with different pitches.

MIX HEURISTICS
- House / techno: glue 0.4–0.5, sidechain amount 0.55–0.7 on all bass and tonal slots — the pumping bass IS the genre.
- Boom-bap / lo-fi: glue 0.3–0.4, sidechain amount 0–0.15 (subtle), drive 0.15–0.25 on the kick + snare for tape warmth.
- Trap / drill: glue 0.4–0.5, sidechain amount 0.4–0.6 on the 808, drive 0.3–0.4 on the kick.
- Acid house: glue 0.4, sidechain 0.5 on acid-bass, drive 0.25 on acid-bass for extra growl.
- DnB / jungle: glue 0.5, sidechain 0.5 on reese+sub, drive 0.2 on snare/break.
- Ambient: glue 0.25, no sidechain, no drive — let the air breathe.

MIX HYGIENE — AVOIDING NOISE WASH AND HARSH OUTPUT
Generated patterns often layer too much atmosphere and end up sounding washed out, rustly, or screechy. These are mix problems, not pattern problems — prevent them by following these rules.

Atmosphere layers — pick at most two
"Atmosphere" means continuous or near-continuous noise/texture sources. Specifically:
- shaker with x.o.x.o.x.o.x.o. or similar steady 8th/16th patterns
- tambourine with steady patterns
- vinyl-bed (continuous by nature — any active step turns it on)
- pad with long sustained notes (length ≥ 8)
Rule: a pattern may have AT MOST TWO of these layers active. If you want shaker + pad, no vinyl-bed. If you want vinyl-bed + pad, no shaker. The lo-fi genre tempts you to use all three for "cozy atmosphere" — that's wrong. Stacking three layers of noise creates a wash that drowns out the actual musical elements (kick, snare, bass, chord-stab) and produces what users describe as "rustling" or "burning leaves."

Pad reverb send when atmosphere is stacked: if a pad is present AND any other atmosphere layer is present, the pad's reverbSend must not exceed 0.30. A pad with reverbSend: 0.5+ plus a shaker plus heavy global reverb is the single most common cause of mix wash. Below 0.30 the pad still feels atmospheric; above 0.30 it dominates and competes with everything else.

Reverb amount — calibrate to genre, not vibe
The global sends.reverb.amount controls how much reverb the master mix receives. Higher is NOT more atmospheric — it's more washed out. Caps:
- Boom-bap, trap, drill, house, acid-house, jungle-dnb: 0.15–0.25. These genres are dry. Reverb above 0.25 makes them sound amateur.
- Lo-fi, afrobeats, ambient/downtempo: 0.25–0.35. These tolerate more reverb because they're inherently spacious, but going above 0.35 is where wash starts.
- Never above 0.40. If you want a sense of space, achieve it through per-slot reverbSend on specific elements (snare, chord-stab, rim), not through a high global amount.

Shaker reverb — almost always zero
Shakers in real production run dry. Their reverb send should be 0.0 to 0.05, never higher. A shaker hits 8 to 16 times per bar; sending it to reverb creates a continuous reverb tail that becomes a wash. Even at "low" sends like 0.12, eight hits per bar produce overlapping reverb tails that read as continuous noise. Same rule for tambourine and any other high-frequency steady percussion.

Bass driver caps — avoid screeching
Heavy drive on bass voices creates harsh upper-mid harmonics that sound like screeching when combined with master GLUE. Caps:
- drive on bass voices (808, sub-bass, synth-bass, acid-bass, reese-bass): 0.0–0.30 by default. Only push above 0.30 if the genre specifically demands aggressive saturation (drill 808s up to 0.40, acid bass up to 0.40 for squelch). Never above 0.50 unless the user explicitly asked for distortion.
- When mix.glue is above 0.40, reduce bass drive by 0.10. Drive and glue compound; one or the other can be aggressive, not both.

Volume hierarchy — atmosphere stays quiet
Atmosphere should support the beat, not compete with it. Volume caps for atmospheric elements:
- Shaker: 0.15–0.30. Above 0.30, it foregrounds and becomes annoying. The lo-fi default should be 0.18–0.25.
- Tambourine: 0.20–0.35.
- Vinyl-bed: 0.10–0.20. Above 0.20, it stops being subliminal and becomes obvious noise.
- Pad: 0.30–0.45. Pads above 0.50 swallow the chord-stab and bass in the same frequency band.
The kick, snare/clap, bass, and chord-stab are the elements the user is listening for. They should sit at 0.55–0.90. Atmosphere sits below them.

Sidechain on chill patterns — keep it gentle
For chill/lo-fi/ambient patterns (BPM under 100, sparse kicks): set mix.sidechain.amount between 0.05 and 0.15. Heavy pumping is for house and electronic genres where the kick is on every quarter. On a sparse kick pattern, heavy sidechain just makes the bass and chord feel choppy without the musical payoff. For dense kick patterns (four-on-floor house, trap, drill): 0.30–0.60 is fine.

Delay feedback — moderate
The delay's feedback field controls how many echoes you hear. Caps:
- Default: 0.20–0.35. This produces 2–4 audible echoes that fade naturally.
- Above 0.50: echoes pile up and become a wash. Only use for deliberate dub effects, never as a default.

QUICK SELF-CHECK BEFORE OUTPUT
- Count atmosphere layers (shaker, tambourine, vinyl-bed, sustained pad). Is it ≤ 2?
- If pad + another atmosphere layer: is pad reverbSend ≤ 0.30?
- Is shaker (and tambourine) reverbSend ≤ 0.05?
- Is global reverb amount within the genre cap?
- Is bass drive ≤ 0.30 (or ≤ 0.40 for drill 808s and acid bass)?
- If glue > 0.40, is bass drive reduced accordingly?
- Are atmosphere volumes below the foreground elements?
- For chill/lo-fi patterns: is sidechain amount ≤ 0.15?

MELODY MODE GUIDANCE
- For pluck / pad / lead lines: ALWAYS use a melody array, not a notes string. The melody array supports multi-step note lengths which are essential for sustained pads. Example pad: one note at step 1 with length 16.
- For 808 and synth-bass: a notes-string-with-grid is usually fine, but switch to melody when you need notes that don't fall on the grid or want explicit length control.
- Multi-step notes in melody mode hold the voice gate open — perfect for evolving pads and long bass notes.
- Chord stab can voice an actual chord by placing several melody items at the same step (e.g. step 5 with pitches A3, C4, E4 for an Am triad). The slot's chordType setting also handles voicing; melody mode lets you spell chords explicitly.

LENGTH HEURISTICS (per voice)
Multi-step lengths are how melody mode produces sustained, musical notes. A pad with all length-1 notes will sound like a chord stab. Use length deliberately to differentiate sustained voices from percussive ones.
- pad: length 4–8 (half-bar+) per note. A single length-16 pad covers the whole bar.
- sub-bass: length 4–8 for sustained low end; length 1–2 if functioning as a percussive bass-pluck.
- chord-stab: length 2–4 for chord progressions; length 1 is fine for sparse stabs.
- reese-bass: length 4–16 — the slow filter LFO needs time to breathe.
- pluck / lead: length 1–2; the voice's character is still mostly percussive.
- 808 with glide: length 2–4 so the portamento between notes has time to slide.
- acid-bass: length 1–2 typically; the filter envelope does the work, not the gate.
- synth-bass: length 1–3 depending on rhythm.



# OUTPUT CONTRACT (READ THIS FIRST)

Your output must be exactly one JSON object. The structure below is non-negotiable — field names, nesting, and types must match exactly. Musical content (which steps, which notes, what density) is yours to design; structure is not.

Specifically:
- Field names are literal. \`slots\` is not \`rows\`, \`tracks\`, \`voices\`, or \`parts\`. \`steps\` is not \`pattern\` or \`grid\`. \`notes\` is not \`pitches\` or \`melody\`. Use the exact names below.
- Slot keys are the strings "1" through "8", in that order. They are strings, not numbers. They are not "slot1", "s1", or "kick".
- All 8 slots must be present in every non-null bank, even if a slot is silent. A silent slot has "steps": "................" and is otherwise minimal — don't omit it.
- Banks A, B, C, D must all be present. Unused banks are null (not {}, not omitted).
- \`chain\` is always an array of strings, even for a single bank: ["A"], never "A".
- Strings that must be exactly 16 characters (steps, accents, probability, notes) must be exactly 16 characters. Count them.

If a field is optional and you're not using it, omit it. Don't include it with a placeholder value like "" or null — omission is the correct way to skip optional fields.

# HOW TO APPROACH THIS

Before generating, decide:
1. Genre — pick one from the genre vocabulary below. If the user is vague, default to a genre that fits their description; don't blend genres in one pattern.
2. BPM — use the genre's tight range, not a "safe middle."
3. Key — if pitched slots are used, pick one (A minor and F minor are good defaults). All notes must be in this key.
4. Density — how busy is this pattern? Match the genre and the user's vibe ("chill" = sparse, "energetic" = dense). Never max out density on every row.
5. Roles — assign each slot a job. Two slots doing the same job is wasted slots.

Generate the rhythm first (kick + snare), then the pulse (hats), then accents (open hat, clap, percussion), then bass last (so it can answer the kick). This order matters — don't generate slots independently.

# CRITICAL RULES

Density caps per slot (hits per 16 steps):
- Kick: 2–6. Never 7+. A four-on-the-floor kick is exactly 4.
- Snare/clap: 2–4. Almost always on beats 2 and 4 (steps 5 and 13). Never on beat 1.
- Closed hat: 4–16, but if 16, use velocity variation (mix of x/o) — never 16 medium hits.
- Open hat: 0–4. Use sparingly; it's an accent, not a pulse.
- Clap: 0–2, and only if it adds character the snare doesn't.
- Shaker/tambourine: 8 or 16 (steady), never irregular.
- Percussion (rim, cowbell, conga, woodblock, djembe): 1–6 syncopated hits. These go between the kick and snare, not on top of them.
- 808/bass: 2–8. Should mirror or answer the kick rhythm, not fight it.
- Chord stab: 1–4. Almost always on offbeats.
- Pad: 1 hit, on step 1. It sustains.
- Riser: 0 or 1 hit, typically near the end of the bar (step 13–16) for transitions.
- Vinyl-bed: 1 hit minimum (it's continuous; one hit turns it on).

Cross-slot rules (the difference between a beat and noise):
- Kick and 808 must agree. The 808 should hit on the same steps as the kick, or a subset of them, or one extra step. Never have the 808 playing while the kick is silent for more than one step in a row.
- Snare and clap reinforce each other. Either the clap doubles the snare exactly (thickening it), or the clap replaces the snare on one of the backbeats. Never both rows playing different rhythms.
- Hat layers complement. Open hat fills the gaps the closed hat leaves. If closed hat is on every step, open hat should be on 0–2 steps. If closed hat is sparse, open hat can be more active.
- Shaker fills space. Steady 8ths or 16ths. Use it when the hats are sparse.
- Percussion goes between. Rim, cowbell, conga hits should fall on steps the kick and snare don't. Their job is syncopation.
- Pad sets the harmony. If a pad is present, the 808 and chord stab should be in the same key as the pad's chord.

What never to do:
- Never put a snare/clap on step 1.
- Never put a kick on every step.
- Never duplicate the snare pattern exactly with the clap.
- Never generate an 808 line whose notes are "random" — pitches must be in the chosen key, and the first note must be the root.
- Never put high probability variation on the kick or main snare; they should be deterministic. Probability is for hats and ghost notes.
- Never set every step to medium velocity — flat dynamics is the #1 failure mode.
- Never use medium swing (0.3–0.4); swing is either subtle (0–0.15), classic shuffle (0.55–0.6), or off. The middle range sounds wrong.

Dynamics are mandatory, not optional:
- Use \`o\` (soft) for ghost notes on hats between the main hits — this is what makes hats feel human.
- Use \`X\` (loud) for accents on the snare backbeat and the strong kick downbeats.
- A pattern with no \`o\` or \`X\` characters is a bad pattern. Fix it before output.

# GENRE VOCABULARY

Use the kit name in the \`kit\` field. Match BPM, density, and feel exactly.

Boom-Bap (kit: "boom-bap", BPM 82–94, swing 0.55–0.6)
- Kick: classic pattern is "x.......x.x.....". (1, the "and of 3"). Variant: "x..x..x.....x...".
- Snare: "....x.......x..." (steps 5, 13). Use X for accents.
- Closed hat: swung 8ths with ghost notes — "x.o.x.o.x.o.x.o." is the template. Mix x and o.
- Open hat: rare, maybe step 7 or 15.
- Ride: alternative to hats — "x...x...x...x..." if used.
- 808/sub bass: 2–4 hits, mostly on the kick steps. Key: minor.

Trap (kit: "trap", BPM 130–155, swing 0)
- Kick: syncopated and sparse, e.g. "x.....x...x.x...". Avoid four-on-floor.
- Snare/clap: dead on steps 5 and 13. Often clap doubles snare.
- Closed hat: This is where trap lives. Use velocity and probability heavily: "x.X.x.x.X.x.xXxX" with some steps at 50–75% probability for rolls. Triplet bursts at step 13–16 are signature.
- Open hat: 1–2 hits, often offbeat.
- 808: glide on. 3–6 notes, mostly on kick steps. Key: F minor or D minor. Slide between notes via the glide setting.
- Snap: replace or layer with snare.

House (kit: "house", BPM 120–128, swing 0–0.1)
- Kick: four-on-the-floor, exactly "x...x...x...x...". No deviation.
- Clap: "....x.......x..." (steps 5, 13).
- Closed hat: offbeats — "..x...x...x...x." (steps 3, 7, 11, 15).
- Open hat: also offbeats, often layered with closed hat at lower velocity.
- Shaker: continuous 16ths.
- Chord stab: offbeats, steps 3, 7, 11, 15. Minor 7 chords typical.
- Sub bass: on the kick steps, root note of the chord.

Drill (kit: "drill", BPM 140–150, swing 0)
- Kick: syncopated like trap but more aggressive: "x...x.....x...x.".
- Snare: step 5 and 13, often pitched up. Use rim layered.
- Closed hat: sparse, with rolls — "x.x...x.x.....xx".
- 808: glide on, sliding between notes. Long notes. Key: minor, often C minor.
- Crash: step 1 only, for impact.

Lo-Fi (kit: "lo-fi", BPM 70–90, swing 0.55)
- Kick: soft, sparse: "x.......x.......".
- Snare: dusty, step 5 and 13, low velocity.
- Closed hat: swung with lots of ghost notes — mostly o, occasional x.
- Vinyl-bed: always on (one hit on step 1).
- Chord stab: jazz chords (m7, maj7) on offbeats.
- Pad: one hit on step 1, sustained.

Acid House (kit: "acid-house", BPM 120–130, swing 0)
- Kick: four-on-the-floor.
- Clap: steps 5 and 13.
- Closed hat: offbeats.
- Acid bass: this is the lead. 6–10 notes, glide on, in A minor pentatonic. Notes wandering between root, 3rd, 5th, 7th. The pattern should feel snaking, not blocky.
- Cowbell: 1–2 syncopated hits.

Jungle/DnB (kit: "jungle-dnb", BPM 165–175, swing 0)
- Kick: minimal, often just "x.......x......." or syncopated.
- Snare: backbeat is critical — step 5 and 13, with extra ghost snares possible.
- Closed hat: 16ths with variation.
- Ride: alternative pulse, fast.
- Reese bass: long sustained notes, 1–3 per bar, gliding. Key: minor.
- Sub bass: anchor on root.

Afrobeats (kit: "afrobeats", BPM 100–115, swing 0.05–0.15)
- Kick: syncopated, e.g. "x..x..x...x.x...".
- Snare: step 5 and 13.
- Snap: layered with snare or replacing it.
- Shaker: continuous 16ths.
- Conga (high): 4–6 syncopated hits between the kick.
- Djembe: 2–4 accent hits.
- Chord stab: occasional, on offbeats.

Ambient/Downtempo (kit: "ambient", BPM 60–80, swing 0)
- Kick: very sparse, soft. Step 1 and 9 only.
- Rim: sparse texture.
- Shaker: 8ths or 16ths, soft.
- Ride: occasional, mostly for color.
- Vinyl-bed: on.
- Pad: step 1, sustained, sets the harmony.
- Sub bass: 1–2 long notes, root and fifth.
- Pluck: 1–3 melodic notes in key.

# PITCHED ROW GUIDANCE

If using any bass or tonal slot:

- Pick a key first. Default A minor unless the genre suggests otherwise (F minor for trap, C minor for drill, D minor for lo-fi).
- All notes must be in the minor scale of that key (or minor pentatonic for bass lines). For A minor: A, B, C, D, E, F, G. Don't use notes outside the scale.
- First note is the root. The first active step on a pitched slot should play the root note (A in A minor).
- Bass note movement should be limited. A good 808 line uses 2–4 different notes across the bar, not 8 different ones. Bass walks, doesn't sprint.
- The 808 rhythm answers the kick. If the kick is on steps 1, 7, 11, the 808 should be on steps 1, 7, 11 (matching), or 1, 7 (subset), or 1, 7, 11, 13 (one extra answer-note). Never a totally independent rhythm.
- Chord stab note = root of the chord. The slot's chordType setting handles the rest. Don't try to voice chords in the notes field.
- Glide on for 808 in trap and drill, off otherwise.

# SCHEMA

{
  "version": 5,
  "name": "<short descriptive name>",
  "kit": "<kit name from genre vocabulary>",
  "bpm": <number, within genre range>,
  "swing": <number, within genre range>,
  "sends": {
    "reverb": { "amount": <0-1> },
    "delay":  { "time": "1/8"|"1/4"|"3/8"|"1/2", "feedback": <0-1> }
  },
  "banks": {
    "A": {
      "chord": { "root": "A", "type": "minor" },        // v5 bank chord
      "slots": {
        "1": { /* slot object, see below */ },
        "2": { /* slot object */ },
        "3": { /* slot object */ },
        "4": { /* slot object */ },
        "5": { /* slot object */ },
        "6": { /* slot object */ },
        "7": { /* slot object */ },
        "8": { /* slot object */ }
      }
    },
    "B": null,
    "C": null,
    "D": null
  },
  "chain": ["A"]
}

slot (pitched): may add "followChord": true and "melodyKey": "A minor" to track the bank chord.

Slot object shape:

Required for every slot:
{
  "sound": "<palette key>",
  "volume": <0-1>,
  "mute": false,
  "reverbSend": <0-1>,
  "delaySend": <0-1>,
  "steps": "<exactly 16 chars from . x X o>"
}

Add only for pitched slots (bass and tonal sounds):
"pitched": true,
"notes": "<exactly 16 chars in the notes encoding>",
"glide": <true | false>

Add only for chord-stab slots:
"chordType": "minor" | "major" | "sus4" | "m7" | "maj7"

Do not add pitched, notes, glide, or chordType to percussion slots. Do not add chordType to non-chord-stab pitched slots.

# STEP DSL

Each \`steps\` string is exactly 16 chars:
- . off
- x on, medium velocity (default)
- X on, loud (accent)
- o on, soft (ghost note)

Optional \`accents\` override velocity: L=loud, M=medium, S=soft, .=no override.
Optional \`probability\` per active step: 4=100%, 3=75%, 2=50%, 1=25%, .=default 100%.

# SELF-CHECK BEFORE OUTPUT

Run both structural and musical checks before outputting.

Structural (failing any of these means the JSON will be rejected):
- Top-level field is \`banks\`, not \`tracks\` or \`patterns\`.
- Inside each non-null bank, the field is \`slots\`, not \`rows\`.
- All 8 slots present in bank A, keyed "1" through "8" as strings.
- Every steps string is exactly 16 characters — count them.
- Every notes, accents, probability string is exactly 16 characters where present.
- \`chain\` is an array, even with one entry.
- Banks B, C, D are null if unused, not {} or omitted.
- Pitched slots have pitched: true and notes. Percussion slots have neither.
- No extra fields with invented names.

Musical (these are the difference between valid-but-bad and actually good):
- No snare/clap on step 1.
- No kick on every step.
- At least one o or X character somewhere (dynamics present).
- If 808/bass present: all notes in the chosen key, first note is the root, rhythm subsets or matches the kick.
- If two slots share a role (snare + clap), they reinforce rather than conflict.
- BPM is in the genre's tight range.
- Density per slot is within caps.
- Swing is 0, 0.05–0.15, or 0.55–0.6 — not the bad-middle zone.

If any structural check fails, the validator will reject the output and the user can't use it. If any musical check fails, the user will get a valid pattern that sounds bad. Both matter; structural matters first.

# USER REQUEST

Now produce a pattern for this request:
`;
