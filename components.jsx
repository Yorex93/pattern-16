/* global React */
// Shared UI primitives for Pattern-16. Exposed on window for app.jsx.
const { useState, useEffect, useRef } = React;

function Splash({ onStart }) {
  return (
    <div className="splash">
      <div className="splash-card">
        <div className="splash-grid" aria-hidden="true">
          {Array.from({ length: 64 }).map((_, i) => (
            <span key={i} style={{ animationDelay: `${(i % 16) * 60}ms` }} />
          ))}
        </div>
        <div className="splash-text">
          <div className="splash-eyebrow">PATTERN-16 · DRUM MACHINE</div>
          <h1>Click anywhere to power on</h1>
          <p>Audio output requires a tap. Headphones recommended.</p>
        </div>
        <button className="splash-btn" onClick={onStart}>
          <span className="dot" /> POWER ON
        </button>
      </div>
    </div>
  );
}

function Knob({ value, onChange, min = 0, max = 1, label, size = 64, displayValue }) {
  const ref = useRef(null);
  const dragRef = useRef(null);
  const angle = ((value - min) / (max - min)) * 270 - 135;

  const onPointerDown = (e) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startVal: value };
    const move = (ev) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - ev.clientY;
      const range = max - min;
      const next = Math.max(min, Math.min(max, dragRef.current.startVal + (dy / 140) * range));
      onChange(next);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * 270 - 135;
    ticks.push(
      <div key={i} className="knob-tick" style={{ transform: `rotate(${a}deg) translateY(-${size/2 + 4}px)` }} />
    );
  }
  const display = displayValue ?? Math.round(((value - min) / (max - min)) * 100);

  return (
    <div className="knob-wrap" style={{ width: size + 24 }}>
      <div className="knob" ref={ref} style={{ width: size, height: size }} onPointerDown={onPointerDown}>
        <div className="knob-ticks">{ticks}</div>
        <div className="knob-body" style={{ transform: `rotate(${angle}deg)` }}>
          <div className="knob-indicator" />
        </div>
        <div className="knob-cap"><span>{display}</span></div>
      </div>
      <div className="knob-label">{label}</div>
    </div>
  );
}

// Compact send knob for per-row use (smaller, single-letter label inside)
function MiniSend({ value, onChange, letter, color = 'rev' }) {
  const dragRef = useRef(null);
  const angle = value * 270 - 135;
  const onPointerDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startY: e.clientY, startVal: value };
    const move = (ev) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - ev.clientY;
      const next = Math.max(0, Math.min(1, dragRef.current.startVal + dy / 100));
      onChange(next);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onDblClick = () => onChange(0);
  return (
    <div
      className={`mini-send ${color} ${value > 0 ? 'active' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDblClick}
      title={`${letter === 'R' ? 'Reverb' : 'Delay'} send: ${Math.round(value * 100)}% · drag, double-click to reset`}
    >
      <div className="mini-send-body" style={{ transform: `rotate(${angle}deg)` }}>
        <div className="mini-send-ind" />
      </div>
      <div className="mini-send-letter">{letter}</div>
    </div>
  );
}

function VolumeSlider({ value, onChange }) {
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
    <div className="vol" ref={trackRef} onPointerDown={onPointerDown}>
      <div className="vol-track">
        <div className="vol-fill" style={{ width: `${value * 100}%` }} />
      </div>
      <div className="vol-thumb" style={{ left: `${value * 100}%` }} />
    </div>
  );
}

function PlayButton({ playing, onClick }) {
  return (
    <button className={`play ${playing ? 'on' : ''}`} onClick={onClick} aria-label={playing ? 'Stop' : 'Play'}>
      <span className="play-glow" />
      {playing ? (
        <svg viewBox="0 0 24 24" width="22" height="22"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 5 L19 12 L7 19 Z" fill="currentColor"/></svg>
      )}
      <span className="play-label">{playing ? 'STOP' : 'PLAY'}</span>
    </button>
  );
}

function BPMControl({ bpm, setBpm }) {
  const drag = useRef(null);
  const onPointerDown = (e) => {
    e.preventDefault();
    drag.current = { y: e.clientY, v: bpm };
    const move = (ev) => {
      const dy = drag.current.y - ev.clientY;
      const next = Math.max(60, Math.min(180, Math.round(drag.current.v + dy * 0.5)));
      setBpm(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="bpm" onPointerDown={onPointerDown} title="Drag vertically">
      <div className="bpm-label">BPM</div>
      <div className="bpm-val">
        <button className="bpm-step" onPointerDown={(e) => { e.stopPropagation(); setBpm(Math.max(60, bpm - 1)); }}>−</button>
        <span className="bpm-num">{bpm}</span>
        <button className="bpm-step" onPointerDown={(e) => { e.stopPropagation(); setBpm(Math.min(180, bpm + 1)); }}>+</button>
      </div>
    </div>
  );
}

const VEL_LABEL = ['SOFT', 'MED', 'LOUD'];

function Step({ cell, current, downbeat, onClick, onContextMenu, rowIndex, stepIndex }) {
  const { on, velocity, probability } = cell;
  const cls = [
    'step',
    on && 'on',
    on && `v${velocity}`,
    on && probability < 100 && 'prob',
    current && 'current',
    downbeat && 'downbeat',
  ].filter(Boolean).join(' ');
  const title = on
    ? `Step ${stepIndex + 1} · ${VEL_LABEL[velocity]} · ${probability}%\nShift/right-click: velocity · Alt-click: probability`
    : `Step ${stepIndex + 1} · empty`;

  return (
    <button
      className={cls}
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-row={rowIndex}
      title={title}
    >
      <span className="step-face">
        <span className="step-led" />
        {on && probability < 100 && (
          <span className="step-prob" aria-hidden="true">
            <span className="step-prob-dot" data-p={probability} />
          </span>
        )}
      </span>
    </button>
  );
}

Object.assign(window, {
  Splash, Knob, MiniSend, VolumeSlider, PlayButton, BPMControl, Step,
});
