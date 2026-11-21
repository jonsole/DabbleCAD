// Slicer workspace: the plate on the left, the 3D view in the middle, settings on the right.
// Settings are split into Printer / Filament / Process, as in OrcaSlicer (see taxonomy.js).
import './slicer.css';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { h, clear, button, icon, toast } from '../ui/dom.js';
import { platform } from '../platform.js';
import { exportModel, importFiles } from '../core/io.js';
import { bakedWorldGeometry } from '../core/geometry.js';
import { loadDefinitions } from './defs.js';
import { SettingsStore } from './settings.js';
import { buildIndex } from './taxonomy.js';
import { Profiles } from './profiles.js';
import { SettingsPanel } from './settingspanel.js';
import { PlateModel, fitProblem, arrange } from './model.js';
import { SlicerScene } from './scene.js';
import { writeBinaryStl, buildArgs, runEngine, gcodeSummary, formatTime } from './engine.js';
import { parseGcode, TYPE_COLORS, TYPE_LABELS } from './gcodeview.js';

const MODEL_FILTERS = [{ name: '3D models', extensions: ['stl', 'obj', '3mf', 'ply'] }];

export class SlicerWorkspace {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.active = false;
    this.ready = null;
    this.models = [];
    this.selected = null;
    this.result = null;      // { gcode, parsed, summary }
    this.dirty = false;      // the plate or settings changed since the last slice
    this.controller = null;
    this.log = [];
    this.root.append(h('div', { class: 'sl-loading' }, 'Loading the slicer…'));
  }

  // ------------------------------------------------------------------ lifecycle
  setActive(on) {
    this.active = on;
    if (!on) return;
    if (!this.ready) this.ready = this._init().catch((err) => { console.error(err); clear(this.root); this.root.append(h('div', { class: 'sl-loading' }, 'The slicer could not start: ' + (err.message || err))); this.ready = null; });
    this.ready.then(() => { if (this.scene) { this.scene.resize(); this.scene.requestRender(); } });
  }

  async _init() {
    const base = new URL('curaengine/', document.baseURI);
    const defs = await loadDefinitions(base);
    this.defs = defs;
    this.store = new SettingsStore(defs);
    const { index, info } = buildIndex(defs);
    this.info = info;
    this._savePending = 0;
    this.profiles = new Profiles(this.store, info, this.app.settings.slicer, (state) => this._persist(state));
    this.panel = new SettingsPanel({ store: this.store, defs, index, info, profiles: this.profiles });
    this._build();
    this.store.onChange(() => this._settingsChanged());
    this._syncVolume(true);
    if (!this.models.length) await this.addFromDesign({ quiet: true });
  }

  _persist(state) {
    clearTimeout(this._savePending);
    this._savePending = setTimeout(() => this.app.patchSettings({ slicer: state }), 400);
  }

  // ------------------------------------------------------------------ layout
  _build() {
    clear(this.root);
    // left: the plate
    this.modelList = h('div', { class: 'sl-models' });
    this.transform = h('div', { class: 'sl-transform' });
    const left = h('div', { class: 'sl-left' },
      h('div', { class: 'sl-title' }, 'Plate'),
      h('div', { class: 'sl-buttons' },
        button({ label: 'Add design', icon: 'cube', cls: 'btn-outline', title: 'Put the whole 3D design on the plate (replaces the models from the design)', onClick: () => this.addFromDesign() }),
        button({ label: 'Selected', icon: 'select', cls: 'btn-outline', title: 'Put only the shapes selected in 3D Design on the plate', onClick: () => this.addFromDesign({ selectedOnly: true }) }),
        button({ label: 'Import…', icon: 'plus', cls: 'btn-outline', title: 'Add an STL, OBJ, 3MF or PLY file', onClick: () => this.importFiles() }),
        button({ label: 'Arrange', icon: 'align', cls: 'btn-outline', title: 'Space the models out on the bed', onClick: () => this.arrange() })),
      this.modelList, this.transform);

    // centre: 3D view and overlays
    this.viewEl = h('div', { class: 'sl-view' });
    this.modeSeg = h('div', { class: 'segmented sl-mode' },
      button({ label: 'Model', cls: 'active', onClick: () => this.setMode('model') }),
      button({ label: 'Preview', cls: 'disabled', onClick: () => this.setMode('preview') }));
    this.viewBtns = h('div', { class: 'sl-viewbtns' },
      button({ icon: 'home', title: 'Home view', cls: 'btn-ghost', onClick: () => this.scene.home() }),
      button({ icon: 'fit', title: 'Top view', cls: 'btn-ghost', onClick: () => this.scene.top() }),
      button({ icon: 'persp', title: 'Front view', cls: 'btn-ghost', onClick: () => this.scene.front() }));
    this.banner = h('div', { class: 'sl-banner', hidden: true });
    this.previewPanel = h('div', { class: 'sl-preview', hidden: true });
    this.status = h('div', { class: 'sl-status', role: 'status' });
    this.progress = h('i');
    this.progressWrap = h('div', { class: 'sl-progress', hidden: true }, this.progress);
    this.sliceBtn = button({ label: 'Slice', icon: 'export', cls: 'btn-primary sl-slice', onClick: () => this.slice() });
    this.cancelBtn = button({ label: 'Cancel', cls: 'btn-outline', onClick: () => this.controller && this.controller.abort() });
    this.cancelBtn.hidden = true;
    this.saveBtn = button({ label: 'Save G-code', icon: 'export', cls: 'btn-outline', onClick: () => this.saveGcode() });
    this.saveBtn.hidden = true;
    this.logEl = h('pre', { class: 'sl-log', hidden: true });
    const bottom = h('div', { class: 'sl-bottom' }, this.status, this.progressWrap, h('div', { class: 'sl-bottom-btns' }, this.cancelBtn, this.saveBtn, this.sliceBtn));
    const center = h('div', { class: 'sl-center' }, this.viewEl,
      h('div', { class: 'sl-overlay-tl' }, this.modeSeg, this.viewBtns), this.banner, this.previewPanel, h('div', { class: 'sl-hint' }, 'Left-drag a model to move it · right-drag to orbit · middle-drag to pan · scroll to zoom'), bottom);

    this.root.append(h('div', { class: 'sl-main' }, left, center, h('div', { class: 'sl-side' }, this.panel.el)));
    this.scene = new SlicerScene(this.viewEl);
    this.scene.onPick = (id) => this.select(id);
    this.scene.onMove = (m) => { this._markDirty(); this._renderTransformValues(m); };
    this.scene.onMoveEnd = () => { this._checkFit(); };
    document.addEventListener('keydown', (e) => this._key(e));
    this._renderModels();
  }

  _key(e) {
    if (!this.active || !this.scene) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); this.removeModel(this.selected); }
  }

  // ------------------------------------------------------------------ the plate
  get volume() {
    const s = this.store;
    return { width: s.get('machine_width'), depth: s.get('machine_depth'), height: s.get('machine_height'), shape: s.get('machine_shape') };
  }

  _syncVolume(first) {
    const v = this.volume;
    const o = this._vol;
    if (o && o.width === v.width && o.depth === v.depth && o.height === v.height && o.shape === v.shape) return;
    this._vol = v;
    this.scene.setVolume(v);
    if (first || !o) this.scene.home();
    this._checkFit();
  }

  _settingsChanged() {
    this._syncVolume(false);
    this._markDirty();
  }

  _markDirty() {
    if (!this.result || this.dirty) return;
    this.dirty = true;
    this._updateBar();
  }

  _checkFit() {
    const bad = this.models.filter((m) => fitProblem(m, this.volume));
    this.scene.setProblems(bad.map((m) => m.id));
    clear(this.banner);
    if (bad.length) {
      this.banner.hidden = false;
      const first = fitProblem(bad[0], this.volume);
      this.banner.append(h('span', {}, bad.length === 1 ? `${bad[0].name} is ${first}. ` : `${bad.length} models don't fit the printer. `),
        h('a', { href: '#', onClick: (e) => { e.preventDefault(); this.panel.focusKey('machine_width'); } }, 'Check the bed size'), ' or ',
        h('a', { href: '#', onClick: (e) => { e.preventDefault(); this.arrange(); } }, 'arrange the models'), '.');
    } else this.banner.hidden = true;
    this._renderModels();
  }

  async addFromDesign({ selectedOnly = false, quiet = false } = {}) {
    try {
      const ed = this.app.editor;
      const out = await ed._busy(() => exportModel(ed, 'stl', { selectedOnly, fuse: true }));
      const geo = new STLLoader().parse(out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength));
      // the models that came from the design are replaced; ones you imported stay
      for (const m of this.models.filter((x) => x.fromDesign)) this._remove(m);
      const m = new PlateModel(this.app._fileBase(), geo);
      m.fromDesign = true;
      this.models.push(m);
      this._place(m);
      this._afterModelsChanged();
      this.select(m.id);
    } catch (err) {
      console.error('slicer addFromDesign', err); if (!quiet) toast(err.message || String(err), 'warn', 5000);
    }
  }

  async importFiles() {
    const files = await platform.openDialog({ filters: MODEL_FILTERS, multi: true });
    if (!files || !files.length) return;
    await this.importData(files);
  }

  async importData(files) {
    await this.ready;
    const res = await importFiles(files, { fitTo: 1e6 });
    let last = null;
    for (const node of res.nodes) {
      const geo = bakedWorldGeometry(node, false);
      const m = new PlateModel(node.name || 'Model', geo);
      this.models.push(m); this._place(m); last = m;
    }
    for (const msg of res.messages) toast(msg, 'warn', 6000);
    this._afterModelsChanged();
    if (last) this.select(last.id);
  }

  /** Put a new model somewhere free: arrange everything if there are several. */
  _place(m) {
    if (this.models.length > 1) arrange(this.models, this.volume);
    else { m.x = 0; m.y = 0; }
  }

  arrange() {
    if (!this.models.length) return;
    const ok = arrange(this.models, this.volume);
    if (!ok) toast("They don't all fit on the bed", 'warn');
    this.scene.setModels(this.models);
    this._markDirty(); this._checkFit(); this._renderTransformValues();
  }

  _remove(m) {
    this.models = this.models.filter((x) => x !== m);
    if (this.selected === m.id) this.selected = null;
  }
  removeModel(id) {
    const m = this.models.find((x) => x.id === id);
    if (!m) return;
    this._remove(m);
    this._afterModelsChanged();
  }
  duplicate(id) {
    const src = this.models.find((x) => x.id === id);
    if (!src) return;
    const m = new PlateModel(src.name, src.geometry);
    Object.assign(m, { rx: src.rx, ry: src.ry, rz: src.rz, sx: src.sx, sy: src.sy, sz: src.sz });
    this.models.push(m);
    arrange(this.models, this.volume);
    this._afterModelsChanged();
    this.select(m.id);
  }

  _afterModelsChanged() {
    this.scene.setModels(this.models);
    this._markDirty();
    this._checkFit();
    this._renderTransform();
    this._updateBar();
  }

  select(id) {
    this.selected = id;
    this.scene.setSelection(id ? [id] : []);
    this._renderModels();
    this._renderTransform();
  }
  get selectedModel() { return this.models.find((m) => m.id === this.selected); }

  _renderModels() {
    if (!this.modelList) return;
    clear(this.modelList);
    if (!this.models.length) this.modelList.append(h('div', { class: 'sl-empty' }, 'Nothing on the plate yet. Add the design or import a model file.'));
    const bad = new Set(this.models.filter((m) => fitProblem(m, this.volume)).map((m) => m.id));
    for (const m of this.models) {
      const s = m.size;
      this.modelList.append(h('div', { class: 'sl-model' + (m.id === this.selected ? ' on' : ''), onClick: () => this.select(m.id), tabindex: 0, onKeydown: (e) => { if (e.key === 'Enter') this.select(m.id); } },
        h('div', { class: 'sl-model-name' }, bad.has(m.id) ? h('span', { class: 'sl-model-bad', title: fitProblem(m, this.volume) }, '⚠ ') : null, m.name),
        h('small', {}, `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm · ${Math.round(m.triangles).toLocaleString()} triangles`)));
    }
  }

  _renderTransform() {
    clear(this.transform);
    const m = this.selectedModel;
    this.fields = {};
    if (!m) return;
    const field = (key, label, unit, step = 1) => {
      const input = h('input', { class: 'input', type: 'number', step, 'aria-label': label });
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) { this._renderTransformValues(); return; }
        if (key === 'scale') { if (v > 0) m.setUniformScale(v); } else m[key] = v;
        this.scene.refreshModel(m); this._markDirty(); this._checkFit(); this._renderTransformValues();
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      this.fields[key] = input;
      return h('label', { class: 'sl-field' }, h('span', {}, label), input, h('em', {}, unit));
    };
    const turn = (axis) => () => { m[axis] = ((m[axis] + 90 + 180) % 360) - 180; this.scene.refreshModel(m); this._markDirty(); this._checkFit(); this._renderTransformValues(); };
    this.transform.append(
      h('div', { class: 'sl-title' }, 'Selected model'),
      h('div', { class: 'sl-fields' }, field('x', 'X', 'mm', 0.5), field('y', 'Y', 'mm', 0.5), field('rx', 'Rotate X', '°', 15), field('ry', 'Rotate Y', '°', 15), field('rz', 'Rotate Z', '°', 15), field('scale', 'Scale', '%', 5)),
      this.sizeNote = h('div', { class: 'sl-size' }),
      h('div', { class: 'sl-buttons' },
        button({ label: 'X 90°', cls: 'btn-outline', title: 'Tip the model over 90° around X', onClick: turn('rx') }),
        button({ label: 'Y 90°', cls: 'btn-outline', title: 'Tip the model over 90° around Y', onClick: turn('ry') }),
        button({ label: 'Reset', cls: 'btn-outline', title: 'Undo rotation and scaling', onClick: () => { Object.assign(m, { rx: 0, ry: 0, rz: 0, sx: 100, sy: 100, sz: 100 }); this.scene.refreshModel(m); this._markDirty(); this._checkFit(); this._renderTransformValues(); } }),
        button({ label: 'Copy', cls: 'btn-outline', onClick: () => this.duplicate(m.id) }),
        button({ label: 'Remove', cls: 'btn-outline', onClick: () => this.removeModel(m.id) })));
    this._renderTransformValues();
  }

  _renderTransformValues(m = this.selectedModel) {
    if (!m || !this.fields || !this.fields.x) return;
    const set = (k, v) => { if (this.fields[k] && document.activeElement !== this.fields[k]) this.fields[k].value = String(Number(v.toFixed(2))); };
    set('x', m.x); set('y', m.y); set('rx', m.rx); set('ry', m.ry); set('rz', m.rz); set('scale', m.sx);
    const s = m.size;
    if (this.sizeNote) this.sizeNote.textContent = `Size ${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm`;
  }

  // ------------------------------------------------------------------ modes and preview
  setMode(mode) {
    if (mode === 'preview' && !this.result) return;
    this.scene.setMode(mode);
    [...this.modeSeg.children].forEach((b, i) => b.classList.toggle('active', (i === 0) === (mode === 'model')));
    this.previewPanel.hidden = mode !== 'preview';
    this.viewEl.classList.toggle('sl-previewing', mode === 'preview');
  }

  _buildPreviewPanel() {
    const r = this.result, p = r.parsed;
    clear(this.previewPanel);
    const slider = h('input', { type: 'range', class: 'sl-layer', min: 0, max: p.layers - 1, value: p.layers - 1, orient: 'vertical', 'aria-label': 'Top layer' });
    const readout = h('div', { class: 'sl-layer-read' });
    let only = false;
    const apply = () => {
      const top = parseInt(slider.value, 10);
      this.scene.setLayerRange(only ? top : 0, top);
      readout.textContent = `Layer ${top + 1} / ${p.layers}\n${(p.layerZ[top] || 0).toFixed(2)} mm`;
    };
    slider.addEventListener('input', apply);
    const legend = h('div', { class: 'sl-legend' });
    for (const t of p.types.keys()) {
      const c = TYPE_COLORS[t] || TYPE_COLORS.DEFAULT;
      const cb = h('input', { type: 'checkbox', checked: true });
      cb.addEventListener('change', () => this.scene.setTypeVisible(t, cb.checked));
      legend.append(h('label', { class: 'sl-legend-row' }, cb, h('i', { style: { background: `rgb(${c.map((v) => Math.round(v * 255)).join(',')})` } }), TYPE_LABELS[t] || t));
    }
    const travel = h('input', { type: 'checkbox' });
    travel.addEventListener('change', () => this.scene.setTravelVisible(travel.checked));
    legend.append(h('label', { class: 'sl-legend-row' }, travel, h('i', { class: 'sl-travel' }), 'Travel moves'));
    const single = h('input', { type: 'checkbox' });
    single.addEventListener('change', () => { only = single.checked; apply(); });
    legend.append(h('label', { class: 'sl-legend-row' }, single, h('i', { class: 'sl-travel' }), 'Only this layer'));
    this.previewPanel.append(h('div', { class: 'sl-slider-box' }, readout, slider), legend);
    apply();
  }

  // ------------------------------------------------------------------ slicing
  _updateBar() {
    const busy = !!this.controller;
    this.sliceBtn.hidden = busy;
    this.cancelBtn.hidden = !busy;
    this.progressWrap.hidden = !busy;
    this.saveBtn.hidden = !this.result || busy;
    this.sliceBtn.querySelector('.btn-label').textContent = this.result && this.dirty ? 'Slice again' : 'Slice';
    this.sliceBtn.classList.toggle('disabled', !this.models.length);
    this.modeSeg.children[1].classList.toggle('disabled', !this.result);
    if (busy) return;
    if (this.result) {
      const s = this.result.summary;
      const parts = [s.layers ? `${s.layers} layers` : null, s.seconds ? `about ${formatTime(s.seconds)}` : null, s.filamentM ? `${s.filamentM.toFixed(2)} m of filament` : null].filter(Boolean);
      this.status.textContent = (this.dirty ? 'Out of date: you changed something since slicing. ' : '') + parts.join(' · ');
      this.status.classList.toggle('sl-stale', this.dirty);
    }
  }

  async slice() {
    if (this.controller || !this.models.length) return;
    const bad = this.models.find((m) => fitProblem(m, this.volume));
    if (bad) { toast(`${bad.name} is ${fitProblem(bad, this.volume)}`, 'warn', 5000); this._checkFit(); return; }
    const critical = this._blockingProblems();
    if (critical) { toast(critical, 'warn', 6000); return; }
    this.controller = new AbortController();
    this.log = []; this.logEl.hidden = true;
    this._updateBar();
    this.status.classList.remove('sl-stale');
    this.status.textContent = 'Slicing…';
    this.progress.style.width = '0';
    try {
      const files = this.models.map((m, i) => ({ name: `model${i}.stl`, data: writeBinaryStl([m.worldPositions()]) }));
      const settings = this.store.engineSettings();
      const args = buildArgs(settings, files.map((f) => f.name), { oneAtATime: this.store.get('print_sequence') === 'one_at_a_time' });
      const gcode = await runEngine(files, args, {
        signal: this.controller.signal,
        onProgress: (p) => { this.progress.style.width = Math.round(p * 100) + '%'; this.status.textContent = `Slicing… ${Math.round(p * 100)}%`; },
        onLog: (line) => { this.log.push(line); if (this.log.length > 400) this.log.shift(); },
      });
      this.status.textContent = 'Preparing the preview…';
      const parsed = await parseGcode(gcode, { signal: this.controller.signal, onProgress: (p) => { this.status.textContent = `Preparing the preview… ${Math.round(p * 100)}%`; } });
      this.result = { gcode, parsed, summary: gcodeSummary(gcode) };
      this.dirty = false;
      this.scene.showPreview(parsed, this.store.get('machine_center_is_zero'));
      this._buildPreviewPanel();
      this.controller = null;
      this._updateBar();
      this.setMode('preview');
    } catch (err) {
      this.controller = null;
      this._updateBar();
      const cancelled = err && err.name === 'AbortError';
      this.status.textContent = cancelled ? 'Cancelled.' : (err.message || String(err));
      if (!cancelled) { toast(this.status.textContent, 'warn', 6000); this.logEl.textContent = this.log.join('\n'); }
    }
  }

  /** Problems that would make the G-code useless, caught before the engine runs. */
  _blockingProblems() {
    const s = this.store;
    if (s.get('layer_height') > s.get('machine_nozzle_size')) return 'The layer height is larger than the nozzle. Lower it in Process › Quality.';
    if (!(s.get('machine_width') > 0 && s.get('machine_depth') > 0 && s.get('machine_height') > 0)) return 'The printer size is not set. See Printer › Basic information.';
    return '';
  }

  async saveGcode() {
    if (!this.result) return;
    const path = await platform.saveDialog({ title: 'Save G-code', defaultName: `${this.app._fileBase()}.gcode`, filters: [{ name: 'G-code', extensions: ['gcode'] }], data: this.result.gcode });
    if (path) toast('Saved to ' + path);
  }
}

void THREE; void icon;
