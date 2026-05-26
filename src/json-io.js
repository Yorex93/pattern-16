// Pattern-16 JSON schema v1 — parser, serializer, AI prompt.
// Internal row IDs use chh/ohh; the JSON schema uses chat/ohat.

const ROW_KEY_TO_ID = { kick: 'kick', snare: 'snare', chat: 'chh', ohat: 'ohh', clap: 'clap', tom: 'tom' };
const ROW_ID_TO_KEY = Object.fromEntries(Object.entries(ROW_KEY_TO_ID).map(([k, v]) => [v, k]));
const ROW_KEYS = Object.keys(ROW_KEY_TO_ID);
const ROW_IDS = Object.values(ROW_KEY_TO_ID);
const BANK_LETTERS = ['A', 'B', 'C', 'D'];
const DELAY_OPTIONS = ['1/8', '1/4', '3/8', '1/2'];

const STEP_CHARS = new Set(['.', 'x', 'X', 'o']);
const ACCENT_CHARS = new Set(['.', 'L', 'M', 'S']);
const PROB_CHARS = new Set(['.', '1', '2', '3', '4']);

const VEL_FROM_STEP = { x: 1, X: 2, o: 0 };
const VEL_FROM_ACCENT = { L: 2, M: 1, S: 0 };
const PROB_FROM_CHAR = { '1': 25, '2': 50, '3': 75, '4': 100 };
const PROB_TO_CHAR = { 100: '4', 75: '3', 50: '2', 25: '1' };

// ---------- defaults ----------
const EMPTY_CELL = () => ({ on: false, velocity: 1, probability: 100 });
const EMPTY_ROW = () => Array.from({ length: 16 }, EMPTY_CELL);
const EMPTY_PATTERN = () => Object.fromEntries(ROW_IDS.map(id => [id, EMPTY_ROW()]));
const ZERO_PER_ROW = () => Object.fromEntries(ROW_IDS.map(id => [id, 0]));
const DEFAULT_VOLUMES = () => Object.fromEntries(ROW_IDS.map(id => [id, 0.85]));
const DEFAULT_MUTES = () => Object.fromEntries(ROW_IDS.map(id => [id, false]));

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

function bankIsEmpty(b) {
  if (!b) return true;
  if (Object.values(b.pattern).some(r => r.some(c => c.on))) return false;
  if (Object.values(b.volumes).some(v => v !== 0.85)) return false;
  if (Object.values(b.mutes).some(m => m)) return false;
  if (Object.values(b.reverbSends).some(v => v !== 0)) return false;
  if (Object.values(b.delaySends).some(v => v !== 0)) return false;
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
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
      : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
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
    catch (e) {
      return { ok: false, errors: [{ path: '', message: `JSON parse error: ${e.message}` }], warnings: [] };
    }
  } else { obj = json; }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [{ path: '', message: 'Expected a JSON object at the top level.' }], warnings: [] };
  }

  // version — fail-fast: if version is wrong, stop here (other validations may not apply)
  if (!('version' in obj)) {
    errors.push({ path: 'version', message: 'Missing required "version" field. Expected 1.' });
  } else if (obj.version !== 1) {
    if (isFiniteNumber(obj.version) && obj.version > 1) {
      return { ok: false, errors: [{ path: 'version', message: `This file uses schema version ${obj.version}; this app supports version 1.` }], warnings: [] };
    }
    errors.push({ path: 'version', message: 'version must equal 1.' });
  }

  // name
  const name = (typeof obj.name === 'string' && obj.name.trim()) ? obj.name.trim() : 'untitled';

  // bpm
  if (!('bpm' in obj)) errors.push({ path: 'bpm', message: 'Missing required "bpm".' });
  else if (!inRange(obj.bpm, 60, 180)) errors.push({ path: 'bpm', message: 'bpm must be a number between 60 and 180.' });

  // swing (0–0.66 fraction)
  if (!('swing' in obj)) errors.push({ path: 'swing', message: 'Missing required "swing".' });
  else if (!inRange(obj.swing, 0, 0.66)) errors.push({ path: 'swing', message: 'swing must be a number between 0 and 0.66.' });

  // sends
  if (!obj.sends || typeof obj.sends !== 'object' || Array.isArray(obj.sends)) {
    errors.push({ path: 'sends', message: 'Missing required "sends" object.' });
  } else {
    const r = obj.sends.reverb;
    if (!r || typeof r !== 'object') errors.push({ path: 'sends.reverb', message: 'Missing "sends.reverb" object.' });
    else if (!inRange(r.amount, 0, 1)) errors.push({ path: 'sends.reverb.amount', message: 'sends.reverb.amount must be a number between 0 and 1.' });

    const d = obj.sends.delay;
    if (!d || typeof d !== 'object') errors.push({ path: 'sends.delay', message: 'Missing "sends.delay" object.' });
    else {
      if (!DELAY_OPTIONS.includes(d.time)) errors.push({ path: 'sends.delay.time', message: `sends.delay.time must be one of ${DELAY_OPTIONS.map(v => `"${v}"`).join(', ')}.` });
      if (!inRange(d.feedback, 0, 1)) errors.push({ path: 'sends.delay.feedback', message: 'sends.delay.feedback must be a number between 0 and 1.' });
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
    // unknown bank keys → warning
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

  // unknown top-level keys → warning
  const KNOWN_TOP = new Set(['version', 'name', 'bpm', 'swing', 'sends', 'banks', 'chain']);
  for (const k of Object.keys(obj)) {
    if (!KNOWN_TOP.has(k)) warnings.push({ path: k, message: `Unknown top-level key "${k}" — ignored.` });
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  // assemble normalized state
  const sw = obj.swing;
  const rev = obj.sends.reverb.amount;
  const normalizedBanks = banks.map(b => {
    if (b === null) return emptyBank();
    return { ...b, swing: Math.round(sw * 100), reverbAmount: rev };
  });

  return {
    ok: true, errors: [], warnings,
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
    },
  };
}

function parseBank(bv, base, errors, warnings) {
  const pattern = EMPTY_PATTERN();
  const volumes = DEFAULT_VOLUMES();
  const mutes = DEFAULT_MUTES();
  const reverbSends = ZERO_PER_ROW();
  const delaySends = ZERO_PER_ROW();
  const accents = {};
  const probability = {};

  if (!bv.rows || typeof bv.rows !== 'object' || Array.isArray(bv.rows)) {
    errors.push({ path: `${base}.rows`, message: `${base}.rows must be an object.` });
  } else {
    for (const [k, v] of Object.entries(bv.rows)) {
      if (!ROW_KEYS.includes(k)) {
        const hint = suggest(k, ROW_KEYS);
        errors.push({ path: `${base}.rows.${k}`, message: `Unknown row "${k}".${hint ? ` Did you mean "${hint}"?` : ''} Valid: ${ROW_KEYS.join(', ')}.` });
        continue;
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        errors.push({ path: `${base}.rows.${k}`, message: `must be an object.` });
        continue;
      }
      const id = ROW_KEY_TO_ID[k];
      if (!inRange(v.volume, 0, 1)) errors.push({ path: `${base}.rows.${k}.volume`, message: `volume must be a number between 0 and 1.` });
      else volumes[id] = v.volume;
      if (typeof v.mute !== 'boolean') errors.push({ path: `${base}.rows.${k}.mute`, message: `mute must be a boolean.` });
      else mutes[id] = v.mute;
      if (!inRange(v.reverbSend, 0, 1)) errors.push({ path: `${base}.rows.${k}.reverbSend`, message: `reverbSend must be a number between 0 and 1.` });
      else reverbSends[id] = v.reverbSend;
      if (!inRange(v.delaySend, 0, 1)) errors.push({ path: `${base}.rows.${k}.delaySend`, message: `delaySend must be a number between 0 and 1.` });
      else delaySends[id] = v.delaySend;

      if (typeof v.steps !== 'string' || v.steps.length !== 16) {
        errors.push({ path: `${base}.rows.${k}.steps`, message: `steps must be a string of exactly 16 characters (got ${typeof v.steps === 'string' ? v.steps.length : typeof v.steps}).` });
      } else {
        const cells = [];
        let bad = null;
        for (let i = 0; i < 16; i++) {
          const ch = v.steps[i];
          if (!STEP_CHARS.has(ch)) { bad = { i, ch }; break; }
          if (ch === '.') cells.push(EMPTY_CELL());
          else cells.push({ on: true, velocity: VEL_FROM_STEP[ch], probability: 100 });
        }
        if (bad) errors.push({ path: `${base}.rows.${k}.steps`, message: `Invalid character "${bad.ch}" at position ${bad.i + 1}. Allowed: . x X o` });
        else pattern[id] = cells;
      }

      // unknown row keys
      const KNOWN_ROW = new Set(['volume', 'mute', 'reverbSend', 'delaySend', 'steps']);
      for (const rk of Object.keys(v)) {
        if (!KNOWN_ROW.has(rk)) warnings.push({ path: `${base}.rows.${k}.${rk}`, message: `Unknown key "${rk}" — ignored.` });
      }
    }
  }

  if ('accents' in bv) {
    if (!bv.accents || typeof bv.accents !== 'object' || Array.isArray(bv.accents)) {
      errors.push({ path: `${base}.accents`, message: `accents must be an object.` });
    } else {
      for (const [k, v] of Object.entries(bv.accents)) {
        if (!ROW_KEYS.includes(k)) {
          const hint = suggest(k, ROW_KEYS);
          errors.push({ path: `${base}.accents.${k}`, message: `Unknown row "${k}".${hint ? ` Did you mean "${hint}"?` : ''}` });
          continue;
        }
        if (typeof v !== 'string' || v.length !== 16) {
          errors.push({ path: `${base}.accents.${k}`, message: `must be a string of exactly 16 characters.` });
          continue;
        }
        let bad = null;
        for (let i = 0; i < 16; i++) if (!ACCENT_CHARS.has(v[i])) { bad = { i, ch: v[i] }; break; }
        if (bad) { errors.push({ path: `${base}.accents.${k}`, message: `Invalid character "${bad.ch}" at position ${bad.i + 1}. Allowed: . L M S` }); continue; }
        accents[ROW_KEY_TO_ID[k]] = v;
      }
    }
  }

  if ('probability' in bv) {
    if (!bv.probability || typeof bv.probability !== 'object' || Array.isArray(bv.probability)) {
      errors.push({ path: `${base}.probability`, message: `probability must be an object.` });
    } else {
      for (const [k, v] of Object.entries(bv.probability)) {
        if (!ROW_KEYS.includes(k)) {
          const hint = suggest(k, ROW_KEYS);
          errors.push({ path: `${base}.probability.${k}`, message: `Unknown row "${k}".${hint ? ` Did you mean "${hint}"?` : ''}` });
          continue;
        }
        if (typeof v !== 'string' || v.length !== 16) {
          errors.push({ path: `${base}.probability.${k}`, message: `must be a string of exactly 16 characters.` });
          continue;
        }
        let bad = null;
        for (let i = 0; i < 16; i++) if (!PROB_CHARS.has(v[i])) { bad = { i, ch: v[i] }; break; }
        if (bad) { errors.push({ path: `${base}.probability.${k}`, message: `Invalid character "${bad.ch}" at position ${bad.i + 1}. Allowed: . 1 2 3 4` }); continue; }
        probability[ROW_KEY_TO_ID[k]] = v;
      }
    }
  }

  // apply accent/probability overrides on top of the parsed step velocities
  for (const id of ROW_IDS) {
    const acc = accents[id];
    const prob = probability[id];
    if (!acc && !prob) continue;
    pattern[id] = pattern[id].map((cell, i) => {
      const nc = { ...cell };
      if (cell.on && acc && acc[i] !== '.') nc.velocity = VEL_FROM_ACCENT[acc[i]];
      if (cell.on && prob && prob[i] !== '.') nc.probability = PROB_FROM_CHAR[prob[i]];
      return nc;
    });
  }

  const KNOWN_BANK = new Set(['rows', 'accents', 'probability']);
  for (const k of Object.keys(bv)) {
    if (!KNOWN_BANK.has(k)) warnings.push({ path: `${base}.${k}`, message: `Unknown key "${k}" — ignored.` });
  }

  return { pattern, volumes, mutes, reverbSends, delaySends, swing: 0, reverbAmount: 0.25 };
}

// ---------- serializer ----------
export function serializePattern(state) {
  const { name, bpm, banks, chain, delayTime, delayFeedback, editBank } = state;
  // Top-level swing/reverb mirror the edit bank (the bank the user has been tweaking).
  const refBank = banks[editBank] ?? banks.find(b => !bankIsEmpty(b)) ?? banks[0];
  const swInt = refBank?.swing ?? 0;
  const rev = refBank?.reverbAmount ?? 0.25;

  const banksObj = {};
  BANK_LETTERS.forEach((L, i) => {
    const b = banks[i];
    banksObj[L] = bankIsEmpty(b) ? null : bankToJson(b);
  });

  return {
    version: 1,
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
  const rows = {};
  const accents = {};
  const probability = {};
  for (const [key, id] of Object.entries(ROW_KEY_TO_ID)) {
    const cells = b.pattern[id];
    let steps = '', probStr = '', hasProb = false;
    for (let i = 0; i < 16; i++) {
      const c = cells[i];
      if (!c.on) { steps += '.'; probStr += '.'; continue; }
      steps += c.velocity === 2 ? 'X' : c.velocity === 0 ? 'o' : 'x';
      if (c.probability !== 100) { probStr += PROB_TO_CHAR[c.probability]; hasProb = true; }
      else probStr += '.';
    }
    rows[key] = {
      volume: round3(b.volumes[id]),
      mute: !!b.mutes[id],
      reverbSend: round3(b.reverbSends[id]),
      delaySend: round3(b.delaySends[id]),
      steps,
    };
    if (hasProb) probability[key] = probStr;
  }
  const out = { rows };
  if (Object.keys(probability).length) out.probability = probability;
  return out;
}

// ---------- AI prompt ----------
export const AI_SYSTEM_PROMPT = `You are helping a user design a drum pattern for Pattern-16, a 16-step drum machine. Output a single JSON object matching the schema below. Output JSON only — no commentary, no markdown fences.

SCHEMA
{
  "version": 1,
  "name": "<short name>",
  "bpm": <60-180>,
  "swing": <0-0.66, use 0 for straight, ~0.56 for boom-bap, ~0.2 for subtle shuffle>,
  "sends": {
    "reverb": { "amount": <0-1> },
    "delay":  { "time": "1/8"|"1/4"|"3/8"|"1/2", "feedback": <0-1> }
  },
  "banks": {
    "A": { "rows": { <row>: { "volume": <0-1>, "mute": false, "reverbSend": <0-1>, "delaySend": <0-1>, "steps": "<16 chars>" }, ... },
           "accents": { <row>: "<16 chars, optional>" },
           "probability": { <row>: "<16 chars, optional>" } },
    "B": <same shape or null>,
    "C": <same shape or null>,
    "D": <same shape or null>
  },
  "chain": [<1-8 bank letters from {A,B,C,D}>]
}

ROWS (use exactly these keys): kick, snare, chat (closed hat), ohat (open hat), clap, tom

STEP DSL (each "steps" string is exactly 16 chars):
  .  off
  x  on, medium velocity
  X  on, loud (accent)
  o  on, soft (ghost note)

ACCENTS (optional, overrides velocity): L=loud, M=medium, S=soft, .=no override
PROBABILITY (optional, per active step): 4=100%, 3=75%, 2=50%, 1=25%, .=default 100%

GROOVE GUIDANCE
- Boom-bap: kick on 1 and the "and of 2", snare on 2 and 4, swung hats with ghost notes (mix x and o), swing ~0.56, BPM 80-95.
- Trap: kick sparse and syncopated, snare/clap on 3, rolling hats with probability and accents on offbeats, swing 0, BPM 130-160.
- House: kick four-on-the-floor, clap on 2 and 4, open hat on offbeats, swing 0-0.1, BPM 120-128.
- Use multiple banks (A→B variation) when the user asks for something with movement. Otherwise a single bank A with chain ["A"] is fine.
- Ghost notes (o) on snares and hats are what make patterns feel human. Use them.

Now produce a pattern for this request:
`;
