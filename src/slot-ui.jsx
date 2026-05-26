import { useEffect, useRef, useState, useMemo } from 'react';
import {
  PALETTE, CATEGORIES, CHORD_TYPES,
  isPitched, hasFilter, hasChord, tunableValues, isContinuous, hasFilterEnv, noteLabel,
} from './sounds.js';
import { ROOT_NAMES_SHARP, CHORD_TYPES_V5, chordLabel } from './scales.js';
import { KITS } from './kits.js';

// Position a popover near an anchor element, clamped to the viewport.
function placeBelow(anchor, popoverEl) {
  if (!anchor || !popoverEl) return;
  const a = anchor.getBoundingClientRect();
  const p = popoverEl.getBoundingClientRect();
  const margin = 8;
  let left = a.left;
  let top = a.bottom + 6;
  if (left + p.width + margin > window.innerWidth) left = window.innerWidth - p.width - margin;
  if (left < margin) left = margin;
  if (top + p.height + margin > window.innerHeight) top = Math.max(margin, a.top - p.height - 6);
  popoverEl.style.left = `${left}px`;
  popoverEl.style.top = `${top}px`;
}

function useOutsideClose(ref, onClose) {
  useEffect(() => {
    const fn = (e) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) onClose();
    };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => window.addEventListener('mousedown', fn), 0);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', fn);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose, ref]);
}

export function PalettePopover({ slotIdx, currentSound, anchor, onPick, onClose }) {
  const ref = useRef(null);
  const [query, setQuery] = useState('');
  useEffect(() => { placeBelow(anchor, ref.current); }, [anchor]);
  useOutsideClose(ref, onClose);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PALETTE;
    const out = {};
    for (const [key, m] of Object.entries(PALETTE)) {
      if (key.includes(q) || m.name.toLowerCase().includes(q) || m.category.includes(q)) {
        out[key] = m;
      }
    }
    return out;
  }, [query]);

  // Detect whether each category has any visible items under the filter
  const visibleByCategory = useMemo(() => {
    const map = {};
    for (const cat of CATEGORIES) {
      map[cat.id] = Object.entries(filtered).filter(([, m]) => m.category === cat.id);
    }
    return map;
  }, [filtered]);
  const totalVisible = Object.values(visibleByCategory).reduce((n, l) => n + l.length, 0);

  return (
    <div className="popover palette-popover" ref={ref}>
      <div className="popover-header">SLOT {slotIdx + 1} · CHOOSE SOUND</div>
      <input
        className="popover-search"
        placeholder="filter sounds…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
        spellCheck={false}
      />
      <div className="palette-grid">
        {CATEGORIES.map(cat => {
          const items = visibleByCategory[cat.id];
          if (!items.length) return null;
          return (
            <div key={cat.id} className="palette-group">
              <div className="palette-group-label">{cat.label}</div>
              <div className="palette-group-row">
                {items.map(([key, m]) => (
                  <button
                    key={key}
                    className={`palette-item ${currentSound === key ? 'active' : ''} ${m.pitched ? 'pitched' : ''} ${m.continuous ? 'continuous' : ''}`}
                    onClick={() => onPick(key)}
                    title={`${m.name}${m.pitched ? ' · pitched' : ''}${m.continuous ? ' · continuous (bar-long bed)' : ''}`}
                  >
                    <span className="palette-item-name">{m.name}</span>
                    {m.pitched && <span className="palette-item-tag">P</span>}
                    {m.continuous && <span className="palette-item-tag bed">BED</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {totalVisible === 0 && <div className="popover-empty">No sounds match "{query}".</div>}
      </div>
    </div>
  );
}

export function BankChordPopover({ anchor, bankLetter, chord, onChange, onClose }) {
  const ref = useRef(null);
  useEffect(() => { placeBelow(anchor, ref.current); }, [anchor]);
  useOutsideClose(ref, onClose);
  const root = chord?.root ?? 'A';
  const type = chord?.type ?? 'minor';
  return (
    <div className="popover bank-chord-popover" ref={ref}>
      <div className="popover-header">BANK {bankLetter} · CHORD {chordLabel({ root, type })}</div>
      <div className="bank-chord-section">
        <div className="bank-chord-label">ROOT</div>
        <div className="bank-chord-roots">
          {ROOT_NAMES_SHARP.map(r => (
            <button
              key={r}
              className={`bank-chord-root ${r === root ? 'on' : ''}`}
              onClick={() => onChange({ root: r, type })}
            >{r}</button>
          ))}
        </div>
      </div>
      <div className="bank-chord-section">
        <div className="bank-chord-label">TYPE</div>
        <div className="bank-chord-types">
          {CHORD_TYPES_V5.map(t => (
            <button
              key={t}
              className={`bank-chord-type ${t === type ? 'on' : ''}`}
              onClick={() => onChange({ root, type: t })}
            >{t}</button>
          ))}
        </div>
      </div>
      <div className="popover-footnote">chord-stab plays this; pitched slots with FOLLOW transpose to match</div>
    </div>
  );
}

export function KitsPopover({ anchor, currentKitId, onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => { placeBelow(anchor, ref.current); }, [anchor]);
  useOutsideClose(ref, onClose);
  return (
    <div className="popover kits-popover" ref={ref}>
      <div className="popover-header">LOAD KIT</div>
      <div className="kits-list">
        {KITS.map(kit => (
          <button
            key={kit.id}
            className={`kit-item ${currentKitId === kit.id ? 'active' : ''}`}
            onClick={() => onPick(kit)}
          >
            <div className="kit-item-name">{kit.name}</div>
            <div className="kit-item-desc">{kit.description}</div>
          </button>
        ))}
      </div>
      <div className="popover-footnote">loading a kit swaps sounds; your pattern stays put</div>
    </div>
  );
}

export function NotePicker({ slot, cell, anchor, onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => { placeBelow(anchor, ref.current); }, [anchor]);
  useOutsideClose(ref, onClose);

  const current = cell.note ?? slot.defaultNote ?? 48;
  // Two octaves around current, with current centered
  const minNote = Math.max(12, current - 12);
  const maxNote = Math.min(96, current + 12);
  const notes = [];
  for (let n = maxNote; n >= minNote; n--) notes.push(n);

  return (
    <div className="popover note-picker" ref={ref}>
      <div className="popover-header">PITCH · {noteLabel(current)}</div>
      <div className="note-picker-grid">
        {notes.map(n => (
          <button
            key={n}
            className={`note-item ${n === current ? 'active' : ''} ${n === slot.defaultNote ? 'default' : ''}`}
            onClick={() => onPick(n)}
          >{noteLabel(n)}</button>
        ))}
      </div>
      <div className="popover-footnote">drag step ↕ to pitch · esc closes</div>
    </div>
  );
}

export function SlotSettingsPopover({ slot, anchor, onGlide, onChord, onFilter, onTunable, onClose }) {
  const ref = useRef(null);
  useEffect(() => { placeBelow(anchor, ref.current); }, [anchor]);
  useOutsideClose(ref, onClose);

  const meta = PALETTE[slot.sound];
  const pitched = isPitched(slot.sound);
  const filtered = hasFilter(slot.sound);
  const chord = hasChord(slot.sound);
  const tv = tunableValues(slot.sound);

  return (
    <div className="popover slot-settings" ref={ref}>
      <div className="popover-header">{meta?.name ?? 'EMPTY'} · SETTINGS</div>
      <div className="slot-settings-body">
        {!pitched && !filtered && !chord && !tv && (
          <div className="popover-empty">No tunable parameters for this voice.</div>
        )}
        {pitched && (
          <div className="setting-row">
            <span className="setting-label">GLIDE</span>
            <button
              className={`toggle ${slot.glide ? 'on' : ''}`}
              onClick={() => onGlide(!slot.glide)}
              title="Slide pitch between consecutive active steps (TB-303 style)"
            >{slot.glide ? 'ON' : 'OFF'}</button>
          </div>
        )}
        {chord && (
          <div className="setting-row">
            <span className="setting-label">CHORD</span>
            <div className="setting-pills">
              {CHORD_TYPES.map(t => (
                <button
                  key={t}
                  className={`pill ${slot.chordType === t ? 'on' : ''}`}
                  onClick={() => onChord(t)}
                >{t}</button>
              ))}
            </div>
          </div>
        )}
        {filtered && (
          <>
            <div className="setting-row">
              <span className="setting-label">CUTOFF</span>
              <Slider value={slot.filter?.cutoff ?? 0.5} onChange={(v) => onFilter('cutoff', v)} />
              <span className="setting-readout">{Math.round((slot.filter?.cutoff ?? 0) * 100)}</span>
            </div>
            <div className="setting-row">
              <span className="setting-label">RESO</span>
              <Slider value={slot.filter?.resonance ?? 0.2} onChange={(v) => onFilter('resonance', v)} />
              <span className="setting-readout">{Math.round((slot.filter?.resonance ?? 0) * 100)}</span>
            </div>
            {hasFilterEnv(slot.sound) && (
              <div className="setting-row">
                <span className="setting-label">ENV</span>
                <Slider value={slot.filter?.envAmount ?? 0.75} onChange={(v) => onFilter('envAmount', v)} />
                <span className="setting-readout">{Math.round((slot.filter?.envAmount ?? 0) * 100)}</span>
              </div>
            )}
          </>
        )}
        {tv && (
          <div className="setting-row">
            <span className="setting-label">PITCH</span>
            <div className="setting-pills">
              {tv.map(v => (
                <button
                  key={v}
                  className={`pill ${slot.tunable === v ? 'on' : ''}`}
                  onClick={() => onTunable(v)}
                >{v.toUpperCase()}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Slider({ value, onChange }) {
  const trackRef = useRef(null);
  const drag = (e) => {
    const rect = trackRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onChange(pct);
  };
  const onPointerDown = (e) => {
    e.preventDefault();
    drag(e);
    const move = (ev) => drag(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="settings-slider" ref={trackRef} onPointerDown={onPointerDown}>
      <div className="settings-slider-track">
        <div className="settings-slider-fill" style={{ width: `${value * 100}%` }} />
      </div>
      <div className="settings-slider-thumb" style={{ left: `${value * 100}%` }} />
    </div>
  );
}
