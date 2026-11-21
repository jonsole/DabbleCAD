// "Slice to G-code" dialog: slices the design in the browser with CuraEngine and saves the G-code.
import { h, modal, button, toast, clear } from './dom.js';
import { platform } from '../platform.js';
import { exportModel } from '../core/io.js';
import { DEFAULT_BED } from '../core/printcheck.js';
import { SLICE_DEFAULTS, SLICE_LIMITS, sliceStl, gcodeSummary } from '../core/slicer.js';

const LAYER_HEIGHTS = [0.08, 0.12, 0.16, 0.2, 0.24, 0.28, 0.32];
const SUPPORTS = [['none', 'None'], ['touching', 'Touching the build plate'], ['everywhere', 'Everywhere']];
const ADHESION = [['skirt', 'Skirt'], ['brim', 'Brim'], ['raft', 'Raft'], ['none', 'None']];

function fmtTime(s) {
  if (s == null) return null;
  const hrs = Math.floor(s / 3600), min = Math.round((s % 3600) / 60);
  return hrs ? `${hrs} h ${min} min` : `${min} min`;
}

export function sliceDialog(app, { selectedOnly = false } = {}) {
  const ed = app.editor;
  let controller = null;
  const m = modal({ title: 'Slice to G-code', width: 560, onClose: () => { if (controller) controller.abort(); } });
  const values = { ...SLICE_DEFAULTS, ...(app.settings.slice || {}) };
  const bed = { ...DEFAULT_BED, ...(app.settings.bed || {}) };
  let result = null;

  const save = () => app.patchSettings({ slice: { ...values } });
  const stop = (e) => e.stopPropagation();

  const num = (key, label, step = 1) => {
    const [lo, hi] = SLICE_LIMITS[key] || [0, 1000];
    const input = h('input', { class: 'input', type: 'number', min: lo, max: hi, step, value: values[key], 'aria-label': label });
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      values[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : SLICE_DEFAULTS[key];
      input.value = values[key];
      save();
    });
    input.addEventListener('keydown', stop);
    return h('label', { class: 'field' }, h('span', {}, label), input);
  };
  const choice = (key, label, options) => {
    const sel = h('select', { class: 'select', 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, selected: String(values[key]) === String(v) }, t)));
    sel.addEventListener('change', () => { values[key] = typeof SLICE_DEFAULTS[key] === 'number' ? parseFloat(sel.value) : sel.value; save(); });
    return h('label', { class: 'field' }, h('span', {}, label), sel);
  };

  const bar = h('i');
  const progress = h('div', { class: 'laser-progress', style: { display: 'none' } }, bar);
  const status = h('div', { class: 'insp-note', role: 'status' });
  const summary = h('div', { class: 'insp-note' });
  const actions = h('div', { class: 'modal-actions' });

  function renderActions() {
    clear(actions);
    if (controller) {
      actions.append(button({ label: 'Cancel', cls: 'btn-outline', onClick: () => controller && controller.abort() }));
      return;
    }
    actions.append(button({ label: result ? 'Slice again' : 'Slice', cls: result ? 'btn-outline' : 'btn-primary', onClick: run }));
    if (result) actions.append(button({ label: 'Download G-code', icon: 'export', cls: 'btn-primary', onClick: download }));
  }

  async function download() {
    const path = await platform.saveDialog({
      title: 'Save G-code', defaultName: `${app._fileBase()}.gcode`,
      filters: [{ name: 'G-code', extensions: ['gcode'] }], data: result.gcode,
    });
    if (path) toast('Saved to ' + path);
  }

  async function run() {
    result = null;
    summary.textContent = '';
    controller = new AbortController();
    bar.style.width = '0';
    progress.style.display = '';
    status.textContent = 'Preparing the model…';
    renderActions();
    try {
      const out = await ed._busy(() => exportModel(ed, 'stl', { selectedOnly }));
      status.textContent = 'Slicing…';
      result = await sliceStl(out.data, values, bed, {
        signal: controller.signal,
        onProgress: (p) => { bar.style.width = Math.round(p * 100) + '%'; status.textContent = `Slicing… ${Math.round(p * 100)}%`; },
      });
      const s = gcodeSummary(result.gcode);
      status.textContent = 'Done.';
      summary.textContent = [
        s.layers ? `${s.layers} layers` : null,
        fmtTime(s.seconds) ? `about ${fmtTime(s.seconds)}` : null,
        s.filamentM ? `${s.filamentM.toFixed(2)} m of filament` : null,
        `${(result.gcode.length / 1024).toFixed(0)} KB of G-code`,
      ].filter(Boolean).join(' · ');
    } catch (err) {
      result = null;
      status.textContent = err && err.name === 'AbortError' ? 'Cancelled.' : (err.message || String(err));
      if (!(err && err.name === 'AbortError')) toast(status.textContent, 'warn', 6000);
    } finally {
      controller = null;
      progress.style.display = 'none';
      renderActions();
    }
  }

  m.body.append(
    h('div', { class: 'row' }, choice('layerHeight', 'Layer height (mm)', LAYER_HEIGHTS.map((v) => [v, String(v)])), num('infill', 'Infill (%)', 5), num('walls', 'Walls')),
    h('div', { class: 'row' }, choice('support', 'Supports', SUPPORTS), choice('adhesion', 'Bed adhesion', ADHESION)),
    h('div', { class: 'row' }, num('nozzleTemp', 'Nozzle (°C)'), num('bedTemp', 'Bed (°C)'), num('speed', 'Print speed (mm/s)', 5)),
    h('div', { class: 'row' }, num('nozzle', 'Nozzle size (mm)', 0.05), num('filament', 'Filament (mm)', 0.05), num('retraction', 'Retraction (mm)', 0.5)),
    h('div', { class: 'insp-note' }, `Printer bed ${bed.x} × ${bed.y} × ${bed.z} mm (change it in Print check). The model is centred on the bed and rests on the plate. G-code is Marlin-style with a simple start and end script, so check it suits your printer before printing.`),
    progress, status, summary, actions);
  renderActions();
  return { close: m.close };
}
