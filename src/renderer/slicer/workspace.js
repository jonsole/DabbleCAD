// Slicer workspace: the plate on the left, the 3D view in the middle, settings on the right.
// Settings are split into Printer / Filament / Process, as in OrcaSlicer (see taxonomy.js).
import './slicer.css';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { h, clear, button, icon, toast } from '../ui/dom.js';
import { ViewCube } from '../view/viewcube.js';
import { addResizer } from '../ui/resizer.js';
import { makeDraggable } from '../ui/draggable.js';
import { platform } from '../platform.js';
import { CURAENGINE_URL } from '../config.js';
import { exportModel, importFiles } from '../core/io.js';
import { bakedWorldGeometry } from '../core/geometry.js';
import { loadDefinitions } from './defs.js';
import { SettingsStore } from './settings.js';
import { buildIndex } from './taxonomy.js';
import { Profiles, FILAMENT_DENSITY } from './profiles.js';
import { SettingsPanel } from './settingspanel.js';
import { PlateModel, fitProblem, arrange } from './model.js';
import { SlicerScene } from './scene.js';
import { ModelGizmo } from './modelgizmo.js';
import { writeBinaryStl, buildArgs, runEngine, gcodeSummary, formatTime } from './engine.js';
import { parseGcode, TYPE_COLORS, TYPE_LABELS } from './gcodeview.js';

const MODEL_FILTERS = [{ name: '3D models', extensions: ['stl', 'obj', '3mf', 'ply'] }];

export class SlicerWorkspace {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.active = false;
    this.mode = 'model';
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
    if (!this.ready) this.ready = this._init().catch((err) => { console.error(err); this._showGate(err); return false; });
    this.ready.then(() => { if (this.scene) { this.scene.resize(); this.scene.requestRender(); } });
  }

  /** Folder URL of the CuraEngine package (a separate AGPL-3.0 download, see config.js). */
  get engineBase() {
    let u = (this.app.settings.slicerEngine || CURAENGINE_URL || 'curaengine/').trim();
    if (!u.endsWith('/')) u += '/';
    return new URL(u, document.baseURI).href;
  }

  async _init() {
    const defs = await loadDefinitions(this.engineBase);
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
    if (this.pendingAdd) { const add = this.pendingAdd; this.pendingAdd = null; await this.addFromDesign(add); }
    else if (!this.models.length) await this.addFromDesign({ quiet: true });
    return true;
  }

  /** The engine package could not be loaded: say what it is and let the person point at it. */
  _showGate(err) {
    clear(this.root);
    const input = h('input', { class: 'input', type: 'url', value: this.engineBase, spellcheck: false, 'aria-label': 'Engine address' });
    const retry = () => {
      this.app.patchSettings({ slicerEngine: input.value.trim() });
      this.ready = null;
      clear(this.root);
      this.root.append(h('div', { class: 'sl-loading' }, 'Loading the slicer…'));
      this.setActive(true);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') retry(); });
    this.root.append(h('div', { class: 'sl-gate' },
      h('h2', {}, 'The slicing engine is not available'),
      h('p', {}, 'The Slicer uses CuraEngine, which is licensed under the AGPL-3.0, so it is a separate download and is not part of DabbleCAD itself. DabbleCAD loads it from the address below when you open this tab.'),
      h('label', { class: 'sl-gate-field' }, h('span', {}, 'Engine address'), input),
      h('div', { class: 'sl-buttons' }, button({ label: 'Try again', cls: 'btn-primary', onClick: retry }),
        button({ label: 'Use the default', cls: 'btn-outline', onClick: () => { input.value = new URL(CURAENGINE_URL, document.baseURI).href; retry(); } })),
      h('p', { class: 'sl-gate-err' }, `Could not load it: ${(err && err.message) || err}`),
      h('p', {}, 'To host it yourself, publish the files from ', h('code', {}, 'github.com/jonsole/DabbleCAD-curaengine'), ' on any static web server that allows cross-origin requests. If that server is not localhost, its address also has to be allowed in the Content-Security-Policy in index.html.')));
  }

  _persist(state) {
    clearTimeout(this._savePending);
    this._savePending = setTimeout(() => this.app.patchSettings({ slicer: state }), 400);
  }

  // ------------------------------------------------------------------ layout
  _build() {
    clear(this.root);
    this.modelList = h('div', { class: 'outliner-list' });
    this.outliner = h('div', { class: 'outliner open' });
    // top toolbar, built like the 3D Design one
    this.modeSeg = h('div', { class: 'mode-group', role: 'group', 'aria-label': 'View' },
      button({ label: 'Model', title: 'Show the models on the bed', cls: 'active', onClick: () => this.setMode('model') }),
      button({ label: 'Preview', title: 'Show the sliced G-code layer by layer', cls: 'disabled', onClick: () => this.setMode('preview') }));
    this.progress = h('i');
    this.progressWrap = h('div', { class: 'sl-progress', hidden: true }, this.progress);
    this.sliceBtn = button({ label: 'Slice', icon: 'export', cls: 'btn-primary sl-slice', title: 'Slice the plate to G-code', onClick: () => this.slice() });
    this.cancelBtn = button({ label: 'Cancel', cls: 'btn-outline', onClick: () => this.controller && this.controller.abort() });
    this.cancelBtn.hidden = true;
    this.saveBtn = button({ label: 'Save G-code', icon: 'export', cls: 'btn-outline', title: 'Save the G-code file', onClick: () => this.saveGcode() });
    this.saveBtn.hidden = true;
    this.toolbar = h('div', { class: 'toolbar sl-toolbar', role: 'toolbar', 'aria-label': 'Slicer tools' },
      this.listBtn = button({ icon: 'list', title: 'Plate list', cls: 'active', onClick: () => this.toggleOutliner() }), h('span', { class: 'sep' }),
      button({ icon: 'cube', label: 'Add design', title: 'Add the whole 3D design to the plate', onClick: () => this.addFromDesign() }),
      button({ icon: 'select', label: 'Selected', title: 'Add the shapes selected in 3D Design to the plate', onClick: () => this.addFromDesign({ selectedOnly: true }) }),
      button({ icon: 'plus', label: 'Import', title: 'Add an STL, OBJ, 3MF or PLY file', onClick: () => this.importFiles() }), h('span', { class: 'sep' }),
      button({ icon: 'duplicate', title: 'Copy the selected model', onClick: () => this.selected && this.duplicate(this.selected) }),
      button({ icon: 'trash', title: 'Remove the selected model (Del)', onClick: () => this.selected && this.removeModel(this.selected) }), h('span', { class: 'sep' }),
      button({ icon: 'align', title: 'Arrange: space the models out on the bed', onClick: () => this.arrange() }),
      button({ icon: 'drop', title: 'Reset the selected model: undo rotation and scaling', onClick: () => this.resetSelected() }),
      h('span', { class: 'spacer' }), this.modeSeg);

    // the 3D view, with the same floating pieces as 3D Design
    this.viewEl = h('div', { class: 'viewport sl-view' });
    this.status = h('span', { class: 'sl-status', role: 'status' });
    this.statusSub = h('div', { class: 'sl-sum-sub' });
    this.footer = h('div', { class: 'sl-footer' },
      h('div', { class: 'sl-sum-title' }, h('svg', { viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', class: 'icon' }, h('path', { d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2' })), this.status), this.statusSub, this.progressWrap,
      h('div', { class: 'sl-footer-btns' }, this.cancelBtn, this.saveBtn, this.sliceBtn));
    this.banner = h('div', { class: 'mode-banner', hidden: true });
    this.inspectorEl = h('div', { class: 'inspector sl-inspector' });
    makeDraggable(this.inspectorEl, { key: 'slicer-inspector' });
    this.previewPanel = h('div', { class: 'sl-preview', hidden: true });
    this.logEl = h('pre', { class: 'sl-log', hidden: true });
    this.root.append(this.toolbar, h('div', { class: 'sl-main' }, this.outliner, this.viewEl, h('div', { class: 'side sl-side' }, this.panel.el, this.footer)));
    addResizer(this.outliner, { side: 'left', key: 'slicer-outliner', min: 170, max: 460 });
    addResizer(this.root.querySelector('.sl-side'), { side: 'right', key: 'slicer-side', min: 300, max: 760 });
    this.scene = new SlicerScene(this.viewEl);
    this.viewcube = new ViewCube(this.scene);
    this.projBtn = button({ icon: 'persp', title: 'Switch between perspective and orthographic view', onClick: () => { this.scene.setProjection(this.scene.isOrtho ? 'perspective' : 'orthographic'); this.app.patchSettings({ projection: this.scene.isOrtho ? 'orthographic' : 'perspective' }); } });
    this.viewEl.append(
      h('div', { class: 'viewnav' }, this.viewcube.el, h('div', { class: 'navcol' },
        button({ icon: 'home', title: 'Home view', onClick: () => this.scene.home() }),
        button({ icon: 'fit', title: 'Fit the plate in view', onClick: () => this.fit() }),
        button({ icon: 'plus', title: 'Zoom in', onClick: () => this.scene.zoomBy(0.75) }),
        button({ icon: 'minus', title: 'Zoom out', onClick: () => this.scene.zoomBy(1 / 0.75) }),
        this.projBtn)),
      this.inspectorEl, this.previewPanel, this.banner);
    this.gizmo = new ModelGizmo(this.scene, {
      getModel: () => this.selectedModel,
      active: () => this.mode !== 'preview',
      onChange: (m, final) => { this.scene.refreshModel(m); this._markDirty(); this._renderTransformValues(m); if (final) this._checkFit(); },
    });
    this.scene.onPick = (id) => this.select(id);
    this.scene.onMove = (m) => { this._markDirty(); this._renderTransformValues(m); };
    this.scene.onMoveEnd = () => { this._checkFit(); };
    document.addEventListener('keydown', (e) => this._key(e));
    this._renderModels();
    this._renderTransform();
    this._updateBar();
  }

  fit() { this.scene.home(); }

  resetSelected() {
    const m = this.selectedModel;
    if (!m || m.locked) return;
    Object.assign(m, { rx: 0, ry: 0, rz: 0, sx: 100, sy: 100, sz: 100 });
    this.scene.refreshModel(m); this._markDirty(); this._checkFit(); this._renderTransformValues();
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

  _active() { return this.models.filter((m) => !m.hidden); }
  _movable() { return this.models.filter((m) => !m.hidden && !m.locked); }

  toggleOutliner() {
    this.outliner.classList.toggle('open');
    this.listBtn.classList.toggle('active', this.outliner.classList.contains('open'));
    this._renderModels();
    this.scene.resize();
  }

  _checkFit() {
    const bad = this._active().filter((m) => fitProblem(m, this.volume));
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

  async addFromDesign({ selectedOnly = false, quiet = false, name } = {}) {
    if (!this.scene) return;
    try {
      const ed = this.app.editor;
      const out = await ed._busy(() => exportModel(ed, 'stl', { selectedOnly, fuse: true }));
      const geo = new STLLoader().parse(out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength));
      const m = new PlateModel(name || this.app._fileBase(), geo);
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
    if (!(await this.ready)) return;
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
    if (this.models.length > 1) arrange(this._movable(), this.volume);
    else { m.x = 0; m.y = 0; }
  }

  arrange() {
    if (!this.models.length) return;
    const ok = arrange(this._movable(), this.volume);
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
    if (m.locked) { toast('Unlock it first', 'warn'); return; }
    this._remove(m);
    this._afterModelsChanged();
  }
  duplicate(id) {
    const src = this.models.find((x) => x.id === id);
    if (!src) return;
    const m = new PlateModel(src.name, src.geometry);
    Object.assign(m, { rx: src.rx, ry: src.ry, rz: src.rz, sx: src.sx, sy: src.sy, sz: src.sz });
    this.models.push(m);
    arrange(this._movable(), this.volume);
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
    const m = this.models.find((x) => x.id === id);
    if (m && m.hidden) id = null;
    this.selected = id;
    this.scene.setSelection(id ? [id] : []);
    this._renderModels();
    this._renderTransform();
  }
  get selectedModel() { return this.models.find((m) => m.id === this.selected); }

  _renderModels() {
    if (!this.outliner || !this.outliner.classList.contains('open')) return;
    clear(this.outliner);
    const list = h('div', { class: 'outliner-list' });
    const bad = new Set(this._active().filter((m) => fitProblem(m, this.volume)).map((m) => m.id));
    for (const m of this.models) {
      const s = m.size;
      const eye = h('button', { class: 'mini' + (m.hidden ? ' on' : ''), type: 'button', title: m.hidden ? 'Show' : 'Hide (left out of the slice)' }, icon(m.hidden ? 'eyeOff' : 'eye', 15));
      eye.addEventListener('click', (e) => { e.stopPropagation(); m.hidden = !m.hidden; if (m.hidden && this.selected === m.id) this.selected = null; this._modelsChanged(); });
      const lock = h('button', { class: 'mini' + (m.locked ? ' on' : ''), type: 'button', title: m.locked ? 'Unlock' : 'Lock (stops it being moved, changed or removed)' }, icon(m.locked ? 'lock' : 'unlock', 15));
      lock.addEventListener('click', (e) => { e.stopPropagation(); m.locked = !m.locked; this._renderModels(); this._renderTransform(); this.scene.requestRender(); });
      const row = h('div', { class: 'outliner-row' + (m.id === this.selected ? ' selected' : '') + (m.hidden ? ' hidden-node' : ''), tabindex: 0,
        title: `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)} mm · ${Math.round(m.triangles).toLocaleString()} triangles` + (bad.has(m.id) ? '\n' + fitProblem(m, this.volume) : '') },
        h('span', { class: 'dot', style: { background: bad.has(m.id) ? '#ffb74d' : 'var(--accent)' } }),
        h('span', { class: 'name' }, m.name), lock, eye);
      row.addEventListener('click', () => { if (!m.hidden) this.select(m.id); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !m.hidden) this.select(m.id); });
      list.append(row);
    }
    if (!this.models.length) list.append(h('div', { class: 'side-empty' }, 'Nothing on the plate yet. Use Add design or Import.'));
    this.outliner.append(h('div', { class: 'outliner-head' }, h('span', { style: { flex: 1 } }, `Plate (${this.models.length})`), button({ icon: 'close', cls: 'btn-ghost', title: 'Close', onClick: () => this.toggleOutliner() })), list);
  }

  /** Something about which models count (hidden) changed: refresh the view, the checks and the lists. */
  _modelsChanged() {
    this.scene.setModels(this.models);
    this.scene.setSelection(this.selected ? [this.selected] : []);
    this._markDirty(); this._checkFit(); this._renderTransform(); this._updateBar();
  }

  _renderTransform() {
    clear(this.inspectorEl);
    const m = this.selectedModel;
    this.fields = {};
    this.inspectorEl.hidden = !m || this.mode === 'preview';
    if (!m) return;
    const input = (key, step, axis) => {
      const el = h('input', { class: 'input' + (axis ? ' ax-' + axis : ''), type: 'number', step, 'aria-label': key });
      el.addEventListener('change', () => {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) { this._renderTransformValues(); return; }
        if (key === 'scale') { if (v > 0) m.setUniformScale(v); } else m[key] = v;
        this.scene.refreshModel(m); this._markDirty(); this._checkFit(); this._renderTransformValues();
      });
      el.addEventListener('keydown', (e) => e.stopPropagation());
      el.disabled = !!m.locked;
      this.fields[key] = el;
      return el;
    };
    const turn = (axis) => () => { m[axis] = ((m[axis] + 90 + 180) % 360) - 180; this.scene.refreshModel(m); this._markDirty(); this._checkFit(); this._renderTransformValues(); };
    this.inspectorEl.append(
      h('div', { class: 'insp-head' }, h('div', { class: 'insp-title', title: m.name }, m.name),
        button({ icon: m.locked ? 'lock' : 'unlock', title: m.locked ? 'Unlock' : 'Lock', cls: m.locked ? 'active' : '', onClick: () => { m.locked = !m.locked; this._renderModels(); this._renderTransform(); this.scene.requestRender(); } }),
        button({ icon: 'bulb', title: 'Hide (left out of the slice)', onClick: () => { m.hidden = true; if (this.selected === m.id) this.selected = null; this._modelsChanged(); } }),
        button({ icon: 'duplicate', title: 'Duplicate', onClick: () => this.duplicate(m.id) }),
        button({ icon: 'trash', title: 'Delete (Del)', onClick: () => this.removeModel(m.id) })),
      h('details', { class: 'insp-section', open: true },
        h('summary', {}, 'Position & size'),
        h('div', { class: 'xyz' }, h('span', {}, 'Move'), input('x', 0.5, 'x'), input('y', 0.5, 'y'), h('span', {}, 'mm')),
        h('div', { class: 'xyz' }, h('span', {}, 'Scale'), input('scale', 5), h('span', {}, '%'), h('span', {})),
        this.sizeNote = h('div', { class: 'insp-note' }), m.locked ? h('div', { class: 'insp-note' }, 'Locked: unlock it in the plate list to change it.') : null),
      h('details', { class: 'insp-section', open: true },
        h('summary', {}, 'Rotation'),
        h('div', { class: 'xyz' }, h('span', {}, 'Rotate'), input('rx', 15, 'x'), input('ry', 15, 'y'), input('rz', 15, 'z')),
        h('div', { class: 'sl-insp-btns' },
          button({ label: 'X 90°', cls: 'btn-outline' + (m.locked ? ' disabled' : ''), title: 'Tip the model over 90° around X', onClick: turn('rx') }),
          button({ label: 'Y 90°', cls: 'btn-outline' + (m.locked ? ' disabled' : ''), title: 'Tip the model over 90° around Y', onClick: turn('ry') }),
          button({ label: 'Reset', cls: 'btn-outline' + (m.locked ? ' disabled' : ''), title: 'Undo rotation and scaling', onClick: () => this.resetSelected() }))));
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
    this.mode = mode;
    [...this.modeSeg.children].forEach((b, i) => b.classList.toggle('active', (i === 0) === (mode === 'model')));
    this.previewPanel.hidden = mode !== 'preview';
    this._renderTransform();
    this.viewEl.classList.toggle('sl-previewing', mode === 'preview');
  }

  _buildPreviewPanel() {
    const r = this.result, p = r.parsed;
    clear(this.previewPanel);
    // Cura-style layer slider: a thin overlay on the right whose length follows the print height
    const n = p.layers, last = Math.max(0, n - 1);
    const topZ = p.layerZ[last] || 0;
    const frac = Math.max(0.3, Math.min(1, topZ / Math.max(1, this.volume.height))) * 0.82;
    const track = h('div', { class: 'sl-vs-track' }), fill = h('div', { class: 'sl-vs-fill' });
    const mkHandle = (name) => h('div', { class: 'sl-vs-handle', tabindex: 0, role: 'slider', 'aria-label': name }, h('span', { class: 'sl-vs-tip' }));
    const hTop = mkHandle('Top layer'), hLow = mkHandle('Bottom layer');
    const slider = h('div', { class: 'sl-vs', style: { height: frac * 100 + '%' } }, track, fill, hLow, hTop);
    const state = { lo: 0, hi: last };
    let only = false;
    const apply = () => {
      const { lo, hi } = state;
      const pct = (v) => (last ? v / last : 1) * 100;
      hTop.style.bottom = `calc(${pct(hi)}% - 7px)`; hLow.style.bottom = `calc(${pct(lo)}% - 7px)`;
      fill.style.bottom = pct(lo) + '%'; fill.style.height = (pct(hi) - pct(lo)) + '%';
      hTop.firstChild.textContent = `${hi + 1}`; hLow.firstChild.textContent = `${lo + 1}`;
      hTop.setAttribute('aria-valuenow', hi + 1); hLow.setAttribute('aria-valuenow', lo + 1);
      hTop.title = `Layer ${hi + 1} of ${n} · ${(p.layerZ[hi] || 0).toFixed(2)} mm`;
      hLow.title = `Layer ${lo + 1} of ${n} · ${(p.layerZ[lo] || 0).toFixed(2)} mm`;
      hLow.style.display = only ? 'none' : '';
      this.scene.setLayerRange(only ? hi : lo, hi);
    };
    const move = (which, v) => {
      v = Math.max(0, Math.min(last, Math.round(v)));
      if (which === 'hi') { state.hi = Math.max(v, state.lo); } else { state.lo = Math.min(v, state.hi); }
      apply();
    };
    const wire = (el, which) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); el.setPointerCapture(e.pointerId); el.focus();
        const onMove = (ev) => { const r = track.getBoundingClientRect(); move(which, last * (1 - (ev.clientY - r.top) / r.height)); };
        const onUp = () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); };
        el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
      });
      el.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : e.key === 'PageUp' ? 10 : e.key === 'PageDown' ? -10 : 0;
        if (!d) return;
        e.preventDefault(); e.stopPropagation(); move(which, state[which] + d);
      });
    };
    wire(hTop, 'hi'); wire(hLow, 'lo');
    slider.addEventListener('pointerdown', (e) => {   // click the track: move the nearer handle
      if (e.target !== slider && e.target !== track && e.target !== fill) return;
      const r = track.getBoundingClientRect(), v = last * (1 - (e.clientY - r.top) / r.height);
      move(!only && Math.abs(v - state.lo) < Math.abs(v - state.hi) ? 'lo' : 'hi', v);
    });
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
    this.previewPanel.append(slider, legend);
    apply();
  }

  // ------------------------------------------------------------------ slicing
  _updateBar() {
    const busy = !!this.controller;
    this.sliceBtn.hidden = busy;
    this.cancelBtn.hidden = !busy;
    this.progressWrap.hidden = !busy;
    this.saveBtn.hidden = !this.result || busy;
    const lbl = this.sliceBtn.querySelector('.btn-label'); if (lbl) lbl.textContent = this.result && this.dirty ? 'Slice again' : 'Slice';
    this.sliceBtn.classList.toggle('disabled', !this._active().length);
    this.modeSeg.children[1].classList.toggle('disabled', !this.result);
    if (busy) return;
    const st = this.store;
    if (this.result) {
      const r = this.result.summary;
      const g = r.filamentM ? Math.PI * Math.pow(st.get('material_diameter') / 2, 2) * r.filamentM * (FILAMENT_DENSITY[this.profiles.current('filament').id] ?? 1.24) : null;   // mm² x m = cm³
      this.status.textContent = this.dirty ? 'Out of date' : (r.seconds ? formatTime(r.seconds) : 'Sliced');
      this.status.classList.toggle('sl-stale', this.dirty);
      this.statusSub.textContent = this.dirty ? 'You changed something since slicing. Slice again to update.'
        : [g ? `about ${Math.round(g)} g` : null, r.filamentM ? `${r.filamentM.toFixed(2)} m` : null, r.layers ? `${r.layers} layers` : null].filter(Boolean).join(' · ');
      this.statusSub.classList.toggle('sl-stale', this.dirty);
    } else {
      const n = this._active().length;
      this.status.textContent = 'Not sliced yet';
      this.status.classList.remove('sl-stale');
      this.statusSub.classList.remove('sl-stale');
      this.statusSub.textContent = n ? `${n} model${n === 1 ? '' : 's'} on the plate` : 'Add a model to the plate first';
    }
  }

  async slice() {
    if (this.controller || !this._active().length) return;
    const bad = this._active().find((m) => fitProblem(m, this.volume));
    if (bad) { toast(`${bad.name} is ${fitProblem(bad, this.volume)}`, 'warn', 5000); this._checkFit(); return; }
    const critical = this._blockingProblems();
    if (critical) { toast(critical, 'warn', 6000); return; }
    this.controller = new AbortController();
    this.log = []; this.logEl.hidden = true;
    this._updateBar();
    this.status.classList.remove('sl-stale'); this.statusSub.textContent = '';
    this.status.textContent = 'Slicing…';
    this.progress.style.width = '0';
    try {
      const files = this._active().map((m, i) => ({ name: `model${i}.stl`, data: writeBinaryStl([m.worldPositions()]) }));
      const settings = this.store.engineSettings();
      const args = buildArgs(settings, files.map((f) => f.name), { oneAtATime: this.store.get('print_sequence') === 'one_at_a_time' });
      const gcode = await runEngine(files, args, {
        base: this.engineBase,
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
      this.status.textContent = cancelled ? 'Cancelled' : 'Could not slice'; this.statusSub.textContent = cancelled ? '' : (err.message || String(err));
      if (!cancelled) { toast(this.statusSub.textContent, 'warn', 6000); this.logEl.textContent = this.log.join('\n'); }
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
