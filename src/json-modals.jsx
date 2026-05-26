import { useState, useRef } from 'react';
import { parsePattern, serializePattern } from './json-io.js';

function ImportJsonModal({ onClose, onLoad }) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [fileName, setFileName] = useState('');
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    const t = await file.text();
    setText(t);
    setErrors([]);
    setWarnings([]);
  };

  const handleLoad = () => {
    const src = text.trim();
    if (!src) {
      setErrors([{ path: '', message: 'Paste JSON or pick a file first.' }]);
      return;
    }
    const result = parsePattern(src);
    if (!result.ok) {
      setErrors(result.errors);
      setWarnings(result.warnings);
      return;
    }
    onLoad(result.value, result.warnings);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>IMPORT PATTERN</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="json-import-actions">
            <label className="json-btn">
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
              />
              CHOOSE FILE
            </label>
            <span className="json-file-name">{fileName || 'or paste JSON below'}</span>
          </div>
          <textarea
            className="json-textarea"
            placeholder='{"version": 1, "name": "...", ...}'
            value={text}
            onChange={(e) => { setText(e.target.value); setFileName(''); }}
            spellCheck={false}
          />
          {errors.length > 0 && (
            <div className="json-errors">
              <div className="json-errors-title">{errors.length} ERROR{errors.length > 1 ? 'S' : ''}</div>
              <ul>
                {errors.map((e, i) => (
                  <li key={i}>
                    {e.path && <code className="json-err-path">{e.path}</code>}
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && errors.length === 0 && (
            <div className="json-warnings">
              <div className="json-warnings-title">{warnings.length} WARNING{warnings.length > 1 ? 'S' : ''}</div>
              <ul>
                {warnings.map((w, i) => (
                  <li key={i}>
                    {w.path && <code className="json-err-path">{w.path}</code>}
                    <span>{w.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="modal-actions">
            <button className="json-btn ghost" onClick={onClose}>CANCEL</button>
            <button className="json-btn primary" onClick={handleLoad}>LOAD</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportJsonModal({ state, onClose, onToast }) {
  const initialName = state.name || 'untitled';
  const [name, setName] = useState(initialName);
  const json = serializePattern({ ...state, name });
  const pretty = JSON.stringify(json, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pretty);
      onToast('JSON copied to clipboard');
    } catch {
      onToast('Copy failed — select the text manually.');
    }
  };

  const download = () => {
    const blob = new Blob([pretty], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = (name || 'untitled').replace(/[^a-z0-9\-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'untitled';
    a.href = url;
    a.download = `${safeName}-${ts}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>EXPORT PATTERN (JSON)</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="json-name-row">
            <label className="json-name-label">NAME</label>
            <input
              className="json-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
          </div>
          <pre className="json-pre">{pretty}</pre>
          <div className="modal-actions">
            <button className="json-btn ghost" onClick={onClose}>CLOSE</button>
            <button className="json-btn" onClick={download}>DOWNLOAD .JSON</button>
            <button className="json-btn primary" onClick={copy}>COPY TO CLIPBOARD</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { ImportJsonModal, ExportJsonModal };
