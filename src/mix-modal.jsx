import { useEffect, useRef } from 'react';
import { Knob } from './components.jsx';
import { PALETTE } from './sounds.js';

// Sidechain target toggle row: a checkbox per slot, labeled by the slot's sound.
function SidechainTargets({ slots, targets, onToggle }) {
  return (
    <div className="sc-targets">
      {slots.map((s, i) => {
        const checked = targets.includes(i);
        const label = s?.sound ? (PALETTE[s.sound]?.short ?? s.sound) : '—';
        const isKick = s?.sound === 'kick';
        return (
          <label key={i} className={`sc-target ${checked ? 'on' : ''} ${isKick ? 'kick' : ''}`}>
            <input
              type="checkbox"
              checked={checked}
              disabled={isKick}
              onChange={() => onToggle(i)}
            />
            <span className="sc-target-num">{i + 1}</span>
            <span className="sc-target-name">{label}</span>
          </label>
        );
      })}
    </div>
  );
}

export function MixModal({ mix, slots, onChange, onAutoMix, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const setGlue = (v) => onChange({ ...mix, glue: v });
  const setAmount = (v) => onChange({ ...mix, sidechain: { ...mix.sidechain, amount: v } });
  const toggleTarget = (i) => {
    const set = new Set(mix.sidechain.targets ?? []);
    if (set.has(i)) set.delete(i); else set.add(i);
    onChange({ ...mix, sidechain: { ...mix.sidechain, targets: Array.from(set).sort((a, b) => a - b) } });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide mix-modal" onClick={(e) => e.stopPropagation()} ref={ref}>
        <div className="modal-header">
          <span>MIX</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="mix-section">
            <div className="mix-section-title">MASTER · COMP → SAT → LIMIT</div>
            <div className="mix-glue-row">
              <Knob value={mix.glue} onChange={setGlue} label="GLUE" size={64} displayValue={Math.round(mix.glue * 100)} />
              <div className="mix-glue-meaning">
                <div>0–30%: subtle tightening</div>
                <div>30–60%: mix snap, drum punch</div>
                <div>60–100%: harmonic warmth + bus pump</div>
                <div className="mix-glue-foot">Limiter is always engaged — output safe regardless of GLUE.</div>
              </div>
            </div>
          </div>

          <div className="mix-section">
            <div className="mix-section-title">SIDECHAIN · kick ducks targets</div>
            <div className="sc-controls">
              <Knob value={mix.sidechain.amount} onChange={setAmount} label="AMOUNT" size={52} displayValue={Math.round(mix.sidechain.amount * 100)} />
              <SidechainTargets slots={slots} targets={mix.sidechain.targets ?? []} onToggle={toggleTarget} />
            </div>
            <div className="mix-section-foot">Kick slot triggers a 150 ms duck on each checked target. Pumping bass = check the 808/bass slots.</div>
          </div>

          <div className="mix-section">
            <div className="modal-actions">
              <button className="json-btn primary auto-mix" onClick={onAutoMix} title="Apply sensible mix to the current pattern">⚡ AUTO MIX</button>
            </div>
            <div className="mix-section-foot">Sets GLUE based on density, enables sidechain on bass/tonal slots, adds drive to synth kick/snare.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
