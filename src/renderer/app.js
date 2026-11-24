// Application shell: layout, toolbars, keyboard shortcuts, auto-save and file handling.
import { APP_NAME } from './brand.js';

/** The commit this build was made from (set in vite.config.mjs). */
const BUILD = typeof __APP_BUILD__ === 'object' ? __APP_BUILD__ : { sha: 'unknown', short: 'dev', branch: '', date: '' };
const BUILD_TITLE = `Commit ${BUILD.sha}${BUILD.branch ? `\nBranch ${BUILD.branch}` : ''}${BUILD.date ? `\nBuilt ${new Date(BUILD.date).toLocaleString()}` : ''}`;
import * as THREE from 'three';
import { initSolid } from './core/solid.js';
import { h, clear, button, icon, toast, popupMenu, promptDialog, confirmDialog } from './ui/dom.js';
import { platform } from './platform.js';
import { Viewport, HOME_VIEW } from './view/viewport.js';
import { ViewCube } from './view/viewcube.js';
import { addResizer } from './ui/resizer.js';
import { makeDraggable } from './ui/draggable.js';
import { Gizmo, formatLength, parseLength } from './view/gizmo.js';
import { buildVoxels, disposeVoxels } from './view/voxels.js';
import { Editor } from './editor.js';
import { Inspector } from './ui/inspector.js';
import { ShapesPanel } from './ui/shapespanel.js';
import { Dashboard } from './ui/dashboard.js';
import { scribbleDialog } from './ui/scribble.js';
import { sketchDialog } from './ui/sketch.js';
import { settingsDialog, gridDialog, exportDialog, shortcutsDialog, welcomeDialog, updateDialog, statsDialog, patternDialog, noteDialog, aboutDialog, saveChangesDialog } from './ui/dialogs.js';
import { newDoc, serializeDoc, deserializeDoc, uid, walk, countShapes } from './core/doc.js';
import { initFonts, ensureFont } from './core/fonts.js';
import { kindName } from './core/shapes.js';
import { importFiles, exportModel, IMPORT_FILTERS, extrusionNode, dataUrlToBytes } from './core/io.js';
import { LaserWorkspace } from './laser/workspace.js';
import { SlicerWorkspace } from './slicer/workspace.js';
import { AiWindow } from './ai/window.js';

const SNAPS = [0, 0.1, 0.25, 0.5, 1, 2, 5];
// DabbleCAD's own mark: a "D" with a splash dot.
const LOGO_SVG = '<svg viewBox="0 0 32 32" width="30" height="30"><rect x="1.500" y="1.500" width="29" height="29" rx="7.500" fill="#4f5bd5"/><path d="M9.500 8h5.500a8 8 0 0 1 0 16H9.500z M13.500 12v8H15a4 4 0 0 0 0-8z" fill="#fff" fill-rule="evenodd"/><circle cx="24" cy="23" r="2.600" fill="#ff9f43"/></svg>';

export class App {
  async init() {
    this.settings = await platform.getSettings();
    document.documentElement.dataset.theme = this.settings.theme === 'light' ? 'light' : 'dark';
    await initFonts();
    await initSolid();
    this.designId = null;
    this.dirty = false;
    this.saveTimer = null;
    this.viewMode = 'design';
    this._build();
    this._wire();
    await this._openInitial();
    const boot = document.getElementById('boot');
    if (boot) boot.remove();
    setTimeout(() => this._checkForUpdate(), 4000);
    if (this.settings.welcomeSeen !== true && !this.settings.smoke) welcomeDialog(this);
    if (this.settings.gpuAutoDisabled) toast('GPU acceleration was turned off after a graphics crash. You can re-enable it in Settings.', 'warn', 7000);
  }

  toast(msg, kind, ms) { toast(msg, kind, ms); }
  prompt(title, label, value) { return promptDialog(title, label, value); }

  logoMark() {
    return h('span', { class: 'logo-mark', html: LOGO_SVG });
  }

  // ---------------------------------------------------------------- layout
  _build() {
    const root = document.getElementById('app');
    const tb = (id, ic, title, onClick, label) => { const b = button({ icon: ic, title, onClick, label }); this.btn[id] = b; return b; };
    this.btn = {};

    this.nameInput = h('input', { class: 'design-name', type: 'text', spellcheck: false, title: 'Design name' });
    this.nameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') this.nameInput.blur(); });
    this.nameInput.addEventListener('change', () => {
      const name = this.nameInput.value.trim() || 'Untitled design';
      this.editor.doc.name = name;
      this.nameInput.value = name;
      this._markDirty();
      this._title();
    });
    this.saveState = h('span', { class: 'save-state' });
    this.modeSeg = h('div', { class: 'segmented', title: 'View mode' });
    for (const [id, label, ic, tip] of [['design', '3D Design', 'cube', 'Edit your design'], ['blocks', 'Blocks', 'blocks', 'See the design as blocks'], ['bricks', 'Bricks', 'bricks', 'See the design as building bricks']]) {
      const b = button({ label, icon: ic, title: tip, size: 16, onClick: () => this.setViewMode(id) });
      b.dataset.mode = id;
      if (id === 'design') b.classList.add('active');
      this.modeSeg.append(b);
    }
    this.themeBtn = button({ icon: 'sun', title: 'Switch between dark and light mode', onClick: () => this.setTheme(this.settings.theme === 'light' ? 'dark' : 'light') });
    const logo = h('button', { class: 'logo', type: 'button', title: 'Your designs' }, this.logoMark(), h('span', { class: 'logo-name' }, 'DabbleCAD', h('span', { class: 'logo-plus' }, 'Plus')), h('span', { class: 'logo-commit', title: BUILD_TITLE }, BUILD.short));
    logo.addEventListener('click', () => this.dashboard.show());
    const topbar = h('div', { class: 'topbar', role: 'toolbar', 'aria-label': 'Design and file tools' }, logo, h('span', { class: 'sep' }), this.nameInput, this.saveState, h('span', { class: 'spacer' }),
      this.modeSeg, h('span', { class: 'sep' }),
      button({ label: 'Import', icon: 'import', title: 'Import STL, OBJ, GLB, 3MF, SVG, images (Ctrl+O opens a design file)', onClick: () => this.importDialog() }),
      button({ label: 'Export', icon: 'export', title: 'Download for 3D printing or sharing (Ctrl+E)', onClick: () => exportDialog(this) }),
      h('span', { class: 'sep' }), this.aiBtn = button({ icon: 'sparkle', label: 'AI', title: 'AI assistant: ask about your design or have it build things', cls: 'ai-btn', onClick: () => this.ai.toggle() }), this.themeBtn,
      button({ icon: 'help', title: 'Help: shortcuts and getting started (?)', onClick: () => shortcutsDialog(this) }),
      button({ icon: 'info', title: `About ${APP_NAME}`, onClick: () => aboutDialog(this) }),
      button({ icon: 'settings', title: 'Settings', onClick: () => settingsDialog(this) }));

    // top-level workspaces sit directly beneath the DabbleCAD brand
    this.wsTabs = {};
    const wsTab = (id, label, ic, tip) => { const b = button({ label, icon: ic, title: tip, size: 17, cls: 'ws-tab', onClick: () => this.setViewMode(id === 'laser' || id === 'slicer' ? id : this.last3d || 'design') }); b.dataset.mode = id === '3d' ? 'workspace-3d' : id; this.wsTabs[id] = b; return b; };
    const workspaceBar = this.workspaceBar = h('div', { class: 'workspace-bar', role: 'tablist', 'aria-label': 'Workspace' }, wsTab('3d', '3D Design', 'cube', '3D design workspace'), wsTab('slicer', 'Slicer', 'cube', 'Slicer workspace: slice your design to G-code for a 3D printer'), wsTab('laser', 'Laser', 'laser', 'Laser workspace: draw, set up cuts and engraves, and run your laser'));
    this.wsTabs['3d'].classList.add('active');
    this.applyWorkspaces();
    const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Editing tools' },
      tb('outliner', 'list', 'Objects list', () => this.toggleOutliner()),
      tb('parts', 'parts', 'Parts (P): the shape library: drag a shape onto the workplane', () => this.toggleParts(), 'Parts'), h('span', { class: 'sep' }),
      tb('copy', 'copy', 'Copy (Ctrl+C)', () => this.editor.copy()),
      tb('paste', 'paste', 'Paste (Ctrl+V)', () => this.editor.paste()),
      tb('duplicate', 'duplicate', 'Duplicate and repeat (Ctrl+D)', () => this.editor.duplicate()),
      tb('delete', 'trash', 'Delete (Del)', () => this.editor.deleteSelection()),
      h('span', { class: 'sep' }),
      tb('undo', 'undo', 'Undo (Ctrl+Z)', () => this.editor.undo()),
      tb('redo', 'redo', 'Redo (Ctrl+Y)', () => this.editor.redo()),
      h('span', { class: 'sep' }),
      h('div', { class: 'mode-group', role: 'group', 'aria-label': 'Editing mode' },
        tb('modeObject', 'modeObject', 'Object mode (1): move, resize and rotate whole shapes', () => this.editor.setTool('select')),
        tb('modeFace', 'modeFace', 'Face mode (2): pick flat faces and move them in or out', () => this.editor.setTool(this.editor.tool === 'face' ? 'select' : 'face')),
        tb('modeEdge', 'modeEdge', 'Edge mode (3): pick edges to round, chamfer or move them', () => this.editor.setTool(this.editor.tool === 'edges' ? 'select' : 'edges')),
        tb('modeCorner', 'modeCorner', 'Corner mode (4): pick corners and move them', () => this.editor.setTool(this.editor.tool === 'corner' ? 'select' : 'corner'))),
      h('span', { class: 'sep' }),
      tb('workplane', 'workplane', 'Workplane (W): click a face to build on it, click empty space to reset', () => this.editor.setTool(this.editor.tool === 'workplane' ? 'select' : 'workplane')),
      tb('ruler', 'ruler', 'Ruler (R): click the workplane to place a ruler', () => this.editor.setTool(this.editor.tool === 'ruler' ? 'select' : 'ruler')),
      tb('note', 'note', 'Notes (N): click to pin a note', () => this.editor.setTool(this.editor.tool === 'note' ? 'select' : 'note')),
      h('span', { class: 'spacer' }),
      tb('stats', 'stats', 'Size, volume and weight', () => statsDialog(this)),
      tb('pattern', 'pattern', 'Pattern: repeat the selection in rows or a circle', () => patternDialog(this)),
      tb('drop', 'drop', 'Drop to workplane (D)', () => this.editor.dropToWorkplane()),
      h('span', { class: 'sep' }),
      tb('showall', 'bulb', 'Show all hidden shapes (Ctrl+Shift+H)', () => this.editor.showAll()),
      h('span', { class: 'sep' }),
      tb('group', 'group', 'Group: union the selection, holes cut (Ctrl+G)', () => this.editor.group('union'), 'Group'),
      tb('intersect', 'intersect', 'Intersect: keep only the overlap (Ctrl+I)', () => this.editor.group('intersect'), 'Intersect'),
      tb('bundle', 'bundle', 'Bundle: move together but stay separate (Ctrl+B)', () => this.editor.group('bundle'), 'Bundle'),
      tb('ungroup', 'ungroup', 'Ungroup: split the selected group back into its shapes (Ctrl+Shift+G)', () => this.editor.ungroup(), 'Ungroup'),
      h('span', { class: 'sep' }),
      tb('align', 'align', 'Align (L)', () => this.editor.setTool('align'), 'Align'),
      tb('mirror', 'mirror', 'Mirror (M)', () => this.editor.setTool('mirror'), 'Mirror'),
      tb('split', 'split', 'Split: cut the selection in two with a plane (K)', () => this.editor.setTool('split'), 'Split'),
      tb('cruise', 'cruise', 'Cruise: drag shapes onto other shapes (C)', () => this.editor.toggleCruise(), 'Cruise'));

    this.outliner = h('div', { class: 'outliner' });
    this.viewEl = h('div', { class: 'viewport' });
    this.side = h('div', { class: 'side parts-panel' });
    this.laserRoot = h('div', { class: 'laser-root' });
    this.slicerRoot = h('div', { class: 'slicer-root' });
    root.append(topbar, workspaceBar, toolbar, h('div', { class: 'main' }, this.outliner, this.viewEl), this.laserRoot, this.slicerRoot);
    addResizer(this.outliner, { side: 'left', key: '3d-outliner', min: 170, max: 460 });

    this.viewport = new Viewport(this.viewEl, this.settings);
    this.editor = new Editor(this.viewport, this.settings);
    this.gizmo = new Gizmo(this.editor, this.viewport);
    this.viewcube = new ViewCube(this.viewport);

    // view navigation column
    this.projBtn = button({ icon: 'persp', title: 'Switch between perspective and orthographic view (O)', onClick: () => this.toggleProjection() });
    this.viewEl.append(h('div', { class: 'viewnav' }, this.viewcube.el, h('div', { class: 'navcol' },
      button({ icon: 'home', title: 'Home view (Home)', onClick: () => this.viewport.home() }),
      button({ icon: 'fit', title: 'Fit all in view (F)', onClick: () => this.fit() }),
      button({ icon: 'plus', title: 'Zoom in (+)', onClick: () => this.viewport.zoomBy(0.75) }),
      button({ icon: 'minus', title: 'Zoom out (−)', onClick: () => this.viewport.zoomBy(1 / 0.75) }),
      this.projBtn,
      this.axesBtn = button({ icon: 'axes', title: 'Move arrows (A): X / Y / Z arrows to move objects, edges and corners along one axis', onClick: () => this.toggleMoveArrows() }))));

    if (this.settings.moveArrows) { this.axesBtn.classList.add('active'); this.axesBtn.setAttribute('aria-pressed', 'true'); }
    this.inspectorEl = h('div', { class: 'inspector' });
    makeDraggable(this.inspectorEl, { key: '3d-inspector' });
    this.banner = h('div', { class: 'mode-banner' });
    this.status = h('div', { class: 'statusbar' });
    this.snapSel = h('select', { class: 'select', title: 'Snap Grid' });
    this.snapSel.addEventListener('change', () => { this.editor.doc.workplane.snap = parseFloat(this.snapSel.value); this._markDirty(); this.snapSel.blur(); });
    this.gridbar = h('div', { class: 'gridbar' },
      button({ label: 'Edit Grid', cls: 'btn-outline', title: 'Workplane size and units', onClick: () => gridDialog(this) }),
      h('label', {}, 'Snap Grid'), this.snapSel);
    this.voxelDetail = h('input', { type: 'range', min: 12, max: 128, step: 1, value: 56, title: 'Detail' });
    this.voxelDetail.addEventListener('change', () => this._rebuildVoxels());
    this.voxelInfo = h('span', {});
    this.voxelBar = h('div', { class: 'voxel-bar' }, h('span', {}, 'Detail'), this.voxelDetail, this.voxelInfo,
      button({ label: 'Back to 3D design', cls: 'btn-primary', onClick: () => this.setViewMode('design') }));
    // the Parts panel's size (resized from its corner) is remembered like its position
    try { const sz = JSON.parse(localStorage.getItem('dabblecad.card.3d-parts.size') || 'null'); if (sz) Object.assign(this.side.style, { width: sz.w + 'px', height: sz.h + 'px' }); } catch { /* ignore */ }
    if (window.ResizeObserver) {
      let t = 0;
      new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (this.side.offsetWidth && this.side.style.width) try { localStorage.setItem('dabblecad.card.3d-parts.size', JSON.stringify({ w: this.side.offsetWidth, h: this.side.offsetHeight })); } catch { /* ignore */ } }, 300); }).observe(this.side);
    }
    makeDraggable(this.side, { key: '3d-parts', handle: '.parts-head' });
    this.viewEl.append(this.side, this.inspectorEl, this.banner, this.status, this.gridbar, this.voxelBar, h('div', { class: 'busy-pill' }, 'Working…'));

    this.inspector = new Inspector(this.editor, this.inspectorEl, this);
    this.shapes = new ShapesPanel(this.editor, this.side, this);
    this.btn.parts.classList.add('keep-label');
    this.toggleParts(this.settings.partsOpen !== false);   // open until the user closes it
    this.editor.on('tool', () => { for (const id of ['workplane', 'ruler', 'note']) this.btn[id].classList.toggle('active', this.editor.tool === id); });
    this.dashboard = new Dashboard(this);
    this.laser = new LaserWorkspace(this, this.laserRoot);
    this.slicer = new SlicerWorkspace(this, this.slicerRoot);
    this.modeSeg.before(this.slicer.modeSeg);
    this.ai = new AiWindow(this);
    this.ai.sync();
    this._syncThemeButton();
    this._syncProjection();
  }

  // ---------------------------------------------------------------- wiring
  _wire() {
    const ed = this.editor;
    ed.on('doc', (info) => {
      if (!info || !info.loaded) this._markDirty();
      this._renderOutliner();
      this._updateButtons();
      if (this._isVoxel()) this._rebuildVoxels();
    });
    ed.on('selection', () => { this._updateButtons(); this._renderOutliner(); this._updateStatus(); });
    ed.on('transform', () => this._updateStatus());
    ed.on('history', () => this._updateButtons());
    ed.on('tool', () => { this._updateButtons(); this._updateBanner(); });
    ed.on('split', () => this._syncSplitBanner());
    ed.on('selection', () => { if (ed.tool === 'split') this._syncSplitBanner(); });
    ed.on('editing', () => { this._updateBanner(); this._updateButtons(); });
    ed.on('busy', (on) => this.viewEl.classList.toggle('busy', on));
    ed.on('contextmenu', (e) => this._contextMenu(e));
    ed.on('note-new', async (pos) => { const text = await noteDialog('', true); if (text) ed.addNote(pos, text); });
    ed.on('note-edit', async (note) => {
      const text = await noteDialog(note.text, false);
      if (text === '') ed.removeNote(note.id); else if (text) ed.updateNote(note.id, text);
    });
    ed.on('dblclick', (node) => {
      if (node.type === 'shape' && node.kind === 'text') { this.inspector.open.params = true; this.inspector.render(); this.inspector.focusText(); }
      else if (node.type === 'shape' && node.kind === 'extrusion' && node.params.sketch) this.openSketch(node);
      else if (node.type === 'shape' && node.kind === 'extrusion' && node.params.image) this.openScribble(node);
      else if (node.type === 'group' && !ed.editing) ed.enterGroup(node);
    });
    document.addEventListener('keydown', (e) => this._key(e));
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = [];
      for (const f of e.dataTransfer.files) files.push({ name: f.name, data: await f.arrayBuffer() });
      if (!files.length) return;
      // in the laser workspace the drop belongs to the laser canvas, not the hidden 3D design
      if (this.viewMode === 'laser') this.laser.importData(files);
      else if (this.viewMode === 'slicer') this.slicer.importData(files);
      else this.importData(files);
    });
    window.addEventListener('blur', () => this.flushSave());
    platform.onBeforeClose(async (unloadEvent) => {
      if (unloadEvent) {
        // browser tab: only synchronous work is possible, so let the browser ask instead of our dialog
        if (this.dirty && this.settings.autosave === false) { unloadEvent.preventDefault(); unloadEvent.returnValue = ''; }
        else this.flushSave();
        return;
      }
      let ok = false;
      try { ok = await this.confirmLeave(() => platform.closeHold()); } catch (err) { console.error(err); }
      if (ok) platform.closeReady(); else platform.closeCancel();
    });
    platform.onOpenFile((file) => this._openExternal(file));
    // the open design was changed on another computer (Google Drive): show the new version
    window.addEventListener('dabble-designs-changed', async (e) => {
      const id = this.designId;
      if (!id || this.dirty || !e.detail || !e.detail.ids.includes(id)) return;
      const text = await platform.loadDesign(id);
      if (!text || this.dirty || this.designId !== id) return;
      try { await this._loadDoc(deserializeDoc(text), id); toast('Updated with changes from Google Drive'); } catch (err) { console.warn(err); }
    });
  }

  async _openInitial() {
    const pending = await platform.pendingFile();
    if (pending && (await this._openExternal(pending))) return;
    const list = await platform.listDesigns();
    if (list.length && (await this.openDesign(list[0].id))) return;
    await this.newDesign();
  }

  // ---------------------------------------------------------------- designs
  async _loadDoc(doc, id) {
    const fonts = new Set();
    walk(doc.nodes, (n) => { if (n.kind === 'text' && n.params.font) fonts.add(n.params.font); });
    const laserFonts = (list) => { for (const x of list || []) { if (x.type === 'text' && x.font) fonts.add(x.font); if (x.children) laserFonts(x.children); } };
    if (doc.laser) laserFonts(doc.laser.shapes);
    for (const f of fonts) await ensureFont(f);
    if (this.viewMode !== 'laser') this.setViewMode('design', true);
    this.laser.load(doc.laser);
    doc.laser = this.laser.getDoc();
    this.designId = id;
    this.editor.load(doc);
    this.nameInput.value = doc.name;
    this.refreshGridBar();
    this.dirty = false;
    this._setSaveState('');
    this._title();
    const d = Math.max(doc.workplane.width, doc.workplane.length);
    this.viewport.target.set(0, 0, 0);
    this.viewport.radius = d * 1.65;
    this.viewport.theta = HOME_VIEW.theta;
    this.viewport.phi = HOME_VIEW.phi;
    this.viewport.requestRender();
  }

  /**
   * Called before leaving, replacing or deleting the open design, or closing the app.
   * With auto-save off it asks Save / Don't save / Cancel; a failed save also prevents leaving.
   */
  async confirmLeave(onPrompt) {
    if (this.settings.autosave !== false || !this.dirty || !this.designId) return this.flushSave();
    if (onPrompt) onPrompt();
    const choice = await saveChangesDialog(this.editor.doc.name);
    if (choice === 'save') return this.flushSave(true);
    return choice === 'discard';
  }

  async newDesign() {
    if (!(await this.confirmLeave())) return false;
    const doc = newDoc();
    doc.workplane.snap = this.settings.snap ?? 1;
    doc.workplane.units = this.settings.units || 'mm';
    await this._loadDoc(doc, uid('d'));
    return true;
  }

  async openDesign(id) {
    if (id === this.designId) return true;
    if (!(await this.confirmLeave())) return false;
    let doc;
    try {
      const text = await platform.loadDesign(id);
      if (!text) throw new Error('the design file is missing');
      doc = deserializeDoc(text);
    } catch (err) {
      console.warn('Could not open design', id, err);
      toast('That design could not be opened: ' + (err.message || err), 'error', 5000);
      return false;
    }
    await this._loadDoc(doc, id);
    return true;
  }

  async _openExternal(file) {
    try {
      const doc = deserializeDoc(file.text);
      if (file.name) doc.name = doc.name || file.name.replace(/\.dabble$/i, '');
      if (!(await this.confirmLeave())) return false;
      await this._loadDoc(doc, uid('d'));
      this._markDirty();
      return true;
    } catch (err) {
      toast('That file could not be opened: ' + (err.message || err), 'error', 5000);
      return false;
    }
  }

  async openFile() {
    const files = await platform.openDialog({ title: 'Open design', filters: [{ name: 'DabbleCAD designs', extensions: ['dabble'] }] });
    if (!files.length) return;
    const ok = await this._openExternal({ name: files[0].name, text: new TextDecoder().decode(files[0].data) });
    if (ok) this.dashboard.hide();
  }

  async duplicateDesign(id) {
    const text = await platform.loadDesign(id);
    const doc = deserializeDoc(text);
    const list = await platform.listDesigns();
    const meta = list.find((m) => m.id === id) || {};
    doc.name = 'Copy of ' + doc.name;
    await platform.saveDesign(uid('d'), serializeDoc(doc), { name: doc.name, modified: Date.now(), thumb: meta.thumb || '', shapes: meta.shapes });
  }

  async renameDesign(id, name) {
    if (id === this.designId) {
      this.editor.doc.name = name;
      this.nameInput.value = name;
      this._title();
      this.dirty = true;
      if (this.settings.autosave !== false) { await this.flushSave(); return; }
      // auto-save off: the open design's other edits stay unsaved, only its saved copy is renamed
      this._setSaveState('Unsaved changes (Ctrl+S)');
    }
    const text = await platform.loadDesign(id);
    if (!text) return;
    const doc = deserializeDoc(text);
    doc.name = name;
    const meta = (await platform.listDesigns()).find((m) => m.id === id) || {};
    await platform.saveDesign(id, serializeDoc(doc), { ...meta, name });
  }

  async deleteDesign(id) {
    if (id === this.designId && !(await this.confirmLeave())) return false;
    await platform.deleteDesign(id);
    if (id === this.designId) {
      this.dirty = false;
      clearTimeout(this.saveTimer);
      await this.newDesign();
    }
    return true;
  }

  _title() { document.title = `${this.editor.doc.name} – ${APP_NAME}`; }
  _setSaveState(text) { this.saveState.textContent = text; }

  _markDirty() {
    this.dirty = true;
    if (this.settings.autosave === false) { this._setSaveState('Unsaved changes (Ctrl+S)'); return; }
    this._setSaveState('Saving…');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 1400);
  }

  /** Save now. Resolves true when everything is saved (or there was nothing to save). */
  async flushSave(force = false) {
    clearTimeout(this.saveTimer);
    if (!this.dirty || !this.designId) return true;
    if (this.settings.autosave === false && !force) return false;
    this.editor.doc.laser = this.laser.getDoc();
    if (this.gizmo.dragging) { this.saveTimer = setTimeout(() => this.flushSave(force), 800); return false; }
    this.dirty = false;
    try {
      const doc = this.editor.doc;
      const thumb = this.viewport.snapshot(480, 360);
      const ok = await platform.saveDesign(this.designId, serializeDoc(doc), { name: doc.name, modified: Date.now(), thumb, shapes: countShapes(doc.nodes) });
      if (ok === false) throw new Error('Not enough storage space');
      if (!this.dirty) this._setSaveState('All changes saved');
      return true;
    } catch (err) {
      console.error(err);
      this.dirty = true;
      this._setSaveState('Could not save');
      return false;
    }
  }

  /** Ctrl+S: save even with auto-save off, and say whether it worked. */
  async saveNow() {
    this.dirty = true;
    if (await this.flushSave(true)) toast('Saved');
    else if (!this.gizmo.dragging) toast('Could not save the design', 'error', 4000);
  }

  // ---------------------------------------------------------------- import / export
  async importDialog() {
    const files = await platform.openDialog({ title: 'Import', filters: IMPORT_FILTERS, multi: true });
    if (files.length) await this.importData(files);
  }

  async importData(files) {
    const ed = this.editor;
    const res = await ed._busy(() => importFiles(files, { fitTo: Math.max(ed.doc.workplane.width, ed.doc.workplane.length) }));
    const fonts = new Set();
    walk(res.nodes, (n) => { if (n.kind === 'text' && n.params.font) fonts.add(n.params.font); });
    for (const f of fonts) await ensureFont(f);
    if (res.nodes.length) {
      const c = ed.viewCenterPoint();
      const fromDesign = files.length === 1 && /\.dabble$/i.test(files[0].name);
      for (const n of res.nodes) { if (!fromDesign) ed.placeAt(n, c.x, c.y); ed.addNode(n, { select: false, commit: false }); }
      ed.selection = new Set(res.nodes.map((n) => n.id));
      ed.sync();
      ed.commit();
      ed.emit('selection');
      toast(res.nodes.length === 1 ? 'Imported 1 object' : `Imported ${res.nodes.length} objects`);
    }
    for (const msg of res.messages) toast(msg, 'warn', 6000);
  }

  /** Open the Slicer workspace and add the design (or just the selection) to its build plate. */
  async openSlicer({ selectedOnly = false } = {}) {
    if (!this.workspaceOn('slicer')) return;
    let name;
    if (selectedOnly) {
      const nodes = this.editor.selectedNodes();
      name = nodes.length === 1 ? (nodes[0].name || kindName(nodes[0])) : `${nodes.length} objects`;
    }
    this.slicer.pendingAdd = { selectedOnly, name };   // so the first open does not also add the whole design
    this.setViewMode('slicer');
    if (await this.slicer.ready) {
      const add = this.slicer.pendingAdd;
      this.slicer.pendingAdd = null;
      if (add) await this.slicer.addFromDesign(add);
    }
  }

  async exportAs(format, selectedOnly, { fuse = true } = {}) {
    try {
      const out = await this.editor._busy(() => exportModel(this.editor, format, { selectedOnly, fuse }));
      const path = await platform.saveDialog({
        title: 'Export ' + out.extension.toUpperCase(), defaultName: `${this._fileBase()}.${out.extension}`,
        filters: [{ name: out.filterName, extensions: [out.extension] }], data: out.data,
      });
      if (path) toast('Exported to ' + path);
      return path || null;
    } catch (err) {
      toast(err.message || String(err), 'warn', 5000);
      return null;
    }
  }

  /** Export to a temporary file and hand it to the user's slicer (or the default app for the file type). */
  async openInSlicer(selectedOnly = false) {
    try {
      const format = this.settings.slicerFormat === 'stl' ? 'stl' : '3mf';
      const out = await this.editor._busy(() => exportModel(this.editor, format, { selectedOnly }));
      const res = await platform.openInSlicer({ name: `${this._fileBase()}.${out.extension}`, data: out.data });
      if (res && res.ok) toast(res.app ? `Opened in ${res.app}` : `Opened ${out.extension.toUpperCase()} with your default app`);
      else toast('Could not open a slicer' + (res && res.error ? ': ' + res.error : '') + '. Choose your slicer in Settings.', 'warn', 6000);
    } catch (err) {
      toast(err.message || String(err), 'warn', 5000);
    }
  }

  async _checkForUpdate() {
    if (this.settings.checkUpdates === false) return;
    const u = await platform.checkUpdate().catch(() => null);
    if (!u) return;
    const link = h('a', { href: '#', onClick: (e) => { e.preventDefault(); updateDialog(this, u); } }, 'Update now');
    toast(h('span', {}, `${APP_NAME} ${u.latest} is available (you have ${u.current}). `, link), 'info', 15000);
  }

  async exportScreenshot() {
    const path = await platform.saveDialog({ title: 'Save picture', defaultName: `${this._fileBase()}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }], data: dataUrlToBytes(this.viewport.screenshot()) });
    if (path) toast('Saved picture to ' + path);
  }

  async saveCopy() {
    const path = await platform.saveDialog({ title: 'Save a copy', defaultName: `${this._fileBase()}.dabble`, filters: [{ name: 'DabbleCAD design', extensions: ['dabble'] }], data: serializeDoc(this.editor.doc) });
    if (path) toast('Saved a copy to ' + path);
  }

  _fileBase() { return (this.editor.doc.name || 'design').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'design'; }

  // ---------------------------------------------------------------- scribble
  async openSketch(node) {
    const res = await sketchDialog(node ? node.params.sketch : null);
    if (!res) return;
    const ed = this.editor;
    if (node && ed.node(node.id)) {
      node.params = { ...node.params, polys: res.polys, sketch: res.sketch, depth: res.depth, pid: uid('p') };
      ed.sync();
      ed.commit();
      ed.emit('selection');
    } else {
      const n = extrusionNode(res.polys, 'Sketch', res.depth, { sketch: res.sketch });
      n.color = '#3fa7a3';
      ed.addAtViewCenter(n);
    }
  }

  async openScribble(node) {
    const res = await scribbleDialog(node ? node.params.image : null);
    if (!res) return;
    const ed = this.editor;
    if (node && ed.node(node.id)) {
      node.params = { ...node.params, polys: res.polys, image: res.image, pid: uid('p') };
      ed.sync();
      ed.commit();
      ed.emit('selection');
    } else {
      const n = extrusionNode(res.polys, 'Scribble', 10, { image: res.image });
      n.color = '#00acc1';
      ed.addAtViewCenter(n);
    }
  }

  async renameNode(node) {
    if (!node) return;
    const name = await promptDialog('Rename', 'Name', node.name || kindName(node));
    if (name != null) { this.editor.rename(node.id, name.trim()); this.editor.emit('selection'); }
  }

  /** Settings, scrolled to the AI section. */
  async openAiSettings() {
    await settingsDialog(this);
    const sec = document.querySelector('.set-group[data-sec="ai"]');
    if (sec) sec.scrollIntoView({ block: 'start' });
  }

  // ---------------------------------------------------------------- settings / theme / view
  patchSettings(patch) {
    Object.assign(this.settings, patch);
    platform.setSettings(patch);
    if ('shadows' in patch) this.viewport.setShadows(patch.shadows);
    if ('edges' in patch) this.editor.refreshOutlines();
    if ('showDims' in patch) this.gizmo.refresh();
    this.viewport.requestRender();
  }

  /** The coloured X / Y / Z move arrows, in every mode (off: drag for X / Y, the black arrow for height). */
  toggleMoveArrows(on = !this.settings.moveArrows) {
    this.patchSettings({ moveArrows: on });
    this.axesBtn.classList.toggle('active', on);
    this.axesBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    this.editor.parts.refresh();
    this.gizmo.refresh();
    toast(on ? 'Move arrows on' : 'Move arrows off', 'info', 1500);
  }

  setTheme(theme) {
    this.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    this.viewport.setTheme(theme);
    platform.setSettings({ theme });
    this._syncThemeButton();
  }

  _syncThemeButton() {
    clear(this.themeBtn).append(icon(this.settings.theme === 'light' ? 'moon' : 'sun'));
    this.themeBtn.title = this.settings.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  }

  toggleProjection() {
    const next = this.viewport.isOrtho ? 'perspective' : 'orthographic';
    this.viewport.setProjection(next);
    this.patchSettings({ projection: next });
    this._syncProjection();
  }

  _syncProjection() {
    clear(this.projBtn).append(icon(this.viewport.isOrtho ? 'ortho' : 'persp'));
    this.projBtn.title = this.viewport.isOrtho ? 'Orthographic view. Click for perspective (O)' : 'Perspective view. Click for orthographic (O)';
  }

  fit() {
    if (this._isVoxel() && this.voxels) {
      const box = new THREE.Box3().setFromObject(this.voxels);
      if (!box.isEmpty()) return this.viewport.fit(box);
    }
    this.editor.fitView();
  }

  refreshGridBar() {
    const wp = this.editor.doc.workplane;
    clear(this.snapSel);
    const unit = wp.units === 'in' ? 'in' : 'mm';
    const fmt = (v) => (v === 0 ? 'Off' : wp.units === 'in' ? `${+(v / 25.4).toFixed(4)} in (${v} mm)` : `${v.toFixed(v < 1 ? 2 : 1).replace(/0$/, '').replace(/\.$/, '.0')} mm`);
    const list = SNAPS.includes(wp.snap) ? SNAPS : [...SNAPS, wp.snap].sort((a, b) => a - b);
    for (const s of list) this.snapSel.append(h('option', { value: s }, fmt(s)));
    this.snapSel.value = String(wp.snap);
    void unit;
  }

  /** Is a workspace switched on? (Settings › Workspaces; 3D Design always is.) */
  workspaceOn(id) { return id === '3d' || (this.settings.workspaces || {})[id] !== false; }

  /** Show only the workspaces that are switched on; leave one that has just been switched off. */
  applyWorkspaces() {
    let shown = 0;
    for (const [id, b] of Object.entries(this.wsTabs)) { const on = this.workspaceOn(id); b.style.display = on ? '' : 'none'; if (on) shown++; }
    this.workspaceBar.style.display = shown < 2 ? 'none' : '';   // just 3D Design: no tabs needed
    if ((this.viewMode === 'laser' || this.viewMode === 'slicer') && !this.workspaceOn(this.viewMode)) this.setViewMode(this.last3d || 'design');
  }

  setWorkspace(id, on) {
    this.patchSettings({ workspaces: { ...(this.settings.workspaces || {}), [id]: on } });
    this.applyWorkspaces();
  }

  setViewMode(mode, silent = false) {
    if ((mode === 'laser' || mode === 'slicer') && !this.workspaceOn(mode)) return;
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    for (const b of this.modeSeg.children) b.classList.toggle('active', b.dataset.mode === mode);
    const slicer = mode === 'slicer', laser = mode === 'laser' || slicer, voxel = this._isVoxel();
    if (!laser) this.last3d = mode;
    this.wsTabs['3d'].classList.toggle('active', !laser);
    this.wsTabs.laser.classList.toggle('active', mode === 'laser');
    this.wsTabs.slicer.classList.toggle('active', slicer);
    this.modeSeg.style.display = laser ? 'none' : '';
    this.slicer.modeSeg.style.display = slicer ? '' : 'none';
    this.editor.disabled = voxel || laser;
    document.getElementById('app').classList.toggle('laser-mode', mode === 'laser');
    document.getElementById('app').classList.toggle('slicer-mode', slicer);
    this.laser.setActive(mode === 'laser');
    this.slicer.setActive(slicer);
    if (this.ai) this.ai.sync();
    if (!laser) this.viewport.resize();
    if (voxel || laser) { this.editor.setTool('select'); if (!slicer) this.editor.clearSelection(); }  // the Slicer's "Selected" button needs the selection
    this.viewEl.classList.toggle('voxel-mode', voxel);
    this.voxelBar.classList.toggle('open', voxel);
    this.viewport.objects.visible = !voxel;
    if (voxel) this._rebuildVoxels(); else this._clearVoxels();
    if (!silent) this.viewport.requestRender();
  }

  _isVoxel() { return this.viewMode === 'blocks' || this.viewMode === 'bricks'; }

  _clearVoxels() {
    if (!this.voxels) return;
    this.viewport.scene.remove(this.voxels);
    disposeVoxels(this.voxels);
    this.voxels = null;
    this.viewport.requestRender();
  }

  async _rebuildVoxels() {
    if (!this._isVoxel()) return;
    const res = await this.editor._busy(() => buildVoxels(this.editor, { mode: this.viewMode, detail: +this.voxelDetail.value }));
    this._clearVoxels();
    if (!this._isVoxel()) { disposeVoxels(res.group); return; }
    this.voxels = res.group;
    this.viewport.scene.add(res.group);
    this.voxelInfo.textContent = res.count
      ? `${res.count.toLocaleString()} ${this.viewMode === 'bricks' ? 'bricks' : 'blocks'} · ${res.dims.join(' × ')}`
      : 'Add some shapes first';
    this.viewport.requestRender();
  }

  // ---------------------------------------------------------------- outliner
  /** Show or hide the floating Parts panel (remembered). */
  toggleParts(on = !this.side.classList.contains('open')) {
    this.side.classList.toggle('open', on);
    this.viewEl.classList.toggle('parts-open', on);
    this.btn.parts.classList.toggle('active', on);
    this.btn.parts.setAttribute('aria-pressed', String(on));
    if (this.settings.partsOpen !== on) this.patchSettings({ partsOpen: on });
  }

  toggleOutliner() {
    this.outliner.classList.toggle('open');
    this.btn.outliner.classList.toggle('active', this.outliner.classList.contains('open'));
    this._renderOutliner();
    this.viewport.resize();
  }

  _renderOutliner() {
    if (!this.outliner.classList.contains('open')) return;
    const ed = this.editor;
    clear(this.outliner);
    const list = h('div', { class: 'outliner-list' });
    const counts = {};
    const rows = ed.doc.nodes.map((n) => {
      const base = kindName(n);
      counts[base] = (counts[base] || 0) + 1;
      return { n, label: n.name || `${base} ${counts[base]}` };
    });
    for (const { n, label } of rows.reverse()) {
      const eye = h('button', { class: 'mini' + (n.hidden ? ' on' : ''), type: 'button', title: n.hidden ? 'Show' : 'Hide' }, icon(n.hidden ? 'eyeOff' : 'eye', 15));
      eye.addEventListener('click', (e) => { e.stopPropagation(); n.hidden = !n.hidden; if (n.hidden) ed.selection.delete(n.id); ed.sync(); ed.commit(); ed.emit('selection'); });
      const lock = h('button', { class: 'mini' + (n.locked ? ' on' : ''), type: 'button', title: n.locked ? 'Unlock' : 'Lock' }, icon(n.locked ? 'lock' : 'unlock', 15));
      lock.addEventListener('click', (e) => { e.stopPropagation(); n.locked = !n.locked; ed.commit(); ed.emit('selection'); });
      const row = h('div', { class: 'outliner-row' + (ed.selection.has(n.id) ? ' selected' : '') + (n.hidden ? ' hidden-node' : '') },
        h('span', { class: 'dot', style: { background: n.hole ? 'radial-gradient(#7f8894 1.3px, transparent 1.5px) 0 0 / 5px 5px, #cfd5dc' : n.color } }),
        h('span', { class: 'name' }, label), lock, eye);
      row.addEventListener('click', (e) => { if (!n.hidden) ed.select([n.id], { toggle: e.shiftKey || e.ctrlKey }); });
      row.addEventListener('dblclick', () => this.renameNode(n));
      list.append(row);
    }
    if (!rows.length) list.append(h('div', { class: 'side-empty' }, 'No objects yet. Drag a shape onto the workplane.'));
    this.outliner.append(h('div', { class: 'outliner-head' }, h('span', { style: { flex: 1 } }, `Objects (${rows.length})`), button({ icon: 'close', cls: 'btn-ghost', title: 'Close', onClick: () => this.toggleOutliner() })), list);
  }

  // ---------------------------------------------------------------- state reflection
  _updateButtons() {
    const ed = this.editor;
    const n = ed.selection.size, movable = ed.movableNodes().length;
    const set = (id, enabled) => this.btn[id].classList.toggle('disabled', !enabled);
    set('copy', n > 0); set('paste', !!ed.clipboard); set('duplicate', n > 0); set('delete', movable > 0);
    set('undo', ed.history.canUndo); set('redo', ed.history.canRedo);
    // say what Undo / Redo would take back when the step has a name (the AI's steps do)
    const ul = ed.history.undoLabel, rl = ed.history.redoLabel;
    this.btn.undo.title = ul ? `Undo ${ul} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    this.btn.redo.title = rl ? `Redo ${rl} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    set('group', movable > 1); set('intersect', movable > 1); set('bundle', movable > 1);
    set('ungroup', ed.movableNodes().some((x) => x.type === 'group'));
    set('align', movable > 0); set('mirror', movable > 0); set('split', movable > 0 || ed.tool === 'split'); set('drop', movable > 0); set('pattern', n > 0);
    set('showall', ed.doc.nodes.some((x) => x.hidden));
    this.btn.align.classList.toggle('active', ed.tool === 'align');
    const mode = ed.tool === 'face' ? 'Face' : ed.tool === 'edges' ? 'Edge' : ed.tool === 'corner' ? 'Corner' : 'Object';
    for (const m of ['Object', 'Face', 'Edge', 'Corner']) { this.btn['mode' + m].classList.toggle('active', m === mode); this.btn['mode' + m].setAttribute('aria-pressed', m === mode ? 'true' : 'false'); }
    this.btn.mirror.classList.toggle('active', ed.tool === 'mirror');
    this.btn.split.classList.toggle('active', ed.tool === 'split');
    this.btn.cruise.classList.toggle('active', ed.cruise);
  }

  _updateBanner() {
    const ed = this.editor;
    const text = {
      workplane: 'Click a face to put the workplane on it (Shift flips it). Click empty space to reset.',
      ruler: 'Click the workplane to place the ruler.',
      note: 'Click a shape or the workplane to pin a note.',
      place: 'Click on the workplane to place the shape.',
      align: 'Click a dot to align. Click a selected shape to make it the anchor.',
      mirror: 'Click an arrow to flip the selection.',
    }[ed.tool];
    clear(this.banner);
    if (ed.tool === 'split' && ed.split) { this._splitBanner(); return; }
    if (text) this.banner.append(h('span', {}, text), h('kbd', {}, 'Esc'));
    else if (ed.editing) this.banner.append(h('span', {}, 'Editing the parts of a group. Move, resize, add or delete parts, then finish.'), button({ label: 'Done', cls: 'btn-primary', onClick: () => ed.exitGroup() }));
    else if (ed.hasFrame) this.banner.append(h('span', {}, 'Temporary workplane active.'), button({ label: 'Reset workplane', cls: 'btn-outline', onClick: () => { ed.setFrame(null); this._updateBanner(); } }));
  }

  /** Split tool controls: plane position and angles, presets, Apply / Cancel. */
  _splitBanner() {
    const ed = this.editor;
    const num = (title, get, set, unit) => {
      const inp = h('input', { class: 'split-num', type: 'text', title });
      inp._get = get;
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { inp.blur(); } if (e.key === 'Escape') { inp.value = get(); inp.blur(); } });
      inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (isFinite(v)) set(v); else inp.value = get(); });
      return h('label', { class: 'split-field' }, h('span', {}, title), inp, unit ? h('small', {}, unit) : null);
    };
    const u = ed.units;
    const ang = (k) => () => String(ed.splitAngles()[k]);
    const setAng = (k) => (v) => { const a = ed.splitAngles(); a[k] = v; ed.setSplit({ angles: a }); };
    const fields = [
      num('Position', () => formatLength(ed.split.offset, u), (v) => ed.setSplit({ offset: parseLength(String(v), u) }), u === 'brick' ? 'bricks' : u),
      num('X', ang('x'), setAng('x'), '°'), num('Y', ang('y'), setAng('y'), '°'), num('Z', ang('z'), setAng('z'), '°'),
    ];
    const preset = (label, which, title) => button({ label, cls: 'btn-outline', title, onClick: () => ed.splitPreset(which) });
    this.splitNote = h('span', { class: 'split-note' });
    this.splitApply = button({ label: 'Split', icon: 'split', cls: 'btn-primary', title: 'Cut the shapes the plane passes through (Enter)', onClick: () => ed.applySplit() });
    this.banner.append(h('div', { class: 'split-bar' },
      h('div', { class: 'split-row' }, ...fields, h('span', { style: { flex: 1 } }),
        button({ label: 'Cancel', cls: 'btn-outline', title: 'Esc', onClick: () => ed.setTool('select') }), this.splitApply),
      h('div', { class: 'split-row' }, preset('Flat', 'xy', 'Horizontal plane'), preset('Front–back', 'xz', 'Upright, facing front'), preset('Side–side', 'yz', 'Upright, facing the side'),
        h('span', { class: 'split-hint' }, 'or click a face to cut along it'), h('span', { style: { flex: 1 } }), this.splitNote)));
    this._syncSplitBanner();
  }

  _syncSplitBanner() {
    const ed = this.editor;
    if (!this.splitApply || !ed.split || !this.banner.contains(this.splitApply)) return;
    for (const inp of this.banner.querySelectorAll('.split-num')) if (document.activeElement !== inp) inp.value = inp._get();
    const n = ed.splitTargets().length, sel = ed.movableNodes().length;
    this.splitApply.classList.toggle('disabled', n === 0);
    this.splitNote.textContent = n === 0 ? 'The plane misses the selection' : sel > 1 ? `Cuts ${n} of ${sel} shapes` : '';
    this.splitNote.classList.toggle('warn', n === 0);
  }

  _updateStatus() {
    const ed = this.editor;
    const nodes = ed.selectedNodes();
    if (!nodes.length) { this.status.textContent = ''; return; }
    const b = ed.bounds(nodes);
    const u = ed.units, unit = u === 'brick' ? 'bricks' : u;
    const name = nodes.length === 1 ? (nodes[0].name || kindName(nodes[0])) : `${nodes.length} shapes`;
    this.status.textContent = b.isEmpty() ? name
      : `${name}  ·  ${formatLength(b.max.x - b.min.x, u)} × ${formatLength(b.max.y - b.min.y, u)} × ${formatLength(b.max.z - b.min.z, u)} ${unit}`;
  }

  _contextMenu(e) {
    const ed = this.editor;
    if (ed.disabled) return;
    const hit = ed.pickNode(e);
    if (hit && !ed.selection.has(hit.node.id)) ed.select([hit.node.id]);
    else if (!hit) ed.clearSelection();
    const n = ed.selection.size, movable = ed.movableNodes();
    const hasGroup = movable.some((x) => x.type === 'group');
    const at = { x: e.clientX, y: e.clientY };
    if (!n) {
      popupMenu([
        { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', disabled: !ed.clipboard, onClick: () => ed.paste() },
        { label: 'Select all', icon: 'select', shortcut: 'Ctrl+A', onClick: () => ed.selectAll() },
        { label: 'Show all', icon: 'bulb', shortcut: 'Ctrl+Shift+H', disabled: !ed.doc.nodes.some((x) => x.hidden), onClick: () => ed.showAll() },
        'sep',
        this.workspaceOn('slicer') && { label: 'Slice design…', icon: 'export', disabled: !ed.doc.nodes.length, onClick: () => this.openSlicer() },
        'sep',
        { label: 'Fit all in view', icon: 'fit', shortcut: 'F', onClick: () => this.fit() },
        { label: 'Home view', icon: 'home', onClick: () => this.viewport.home() },
        { label: 'Reset workplane', icon: 'workplane', disabled: !ed.hasFrame, onClick: () => { ed.setFrame(null); this._updateBanner(); } },
      ], at);
      return;
    }
    const locked = ed.selectedNodes().every((x) => x.locked);
    popupMenu([
      { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => ed.copy() },
      { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', disabled: !movable.length, onClick: () => ed.cut() },
      { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', disabled: !ed.clipboard, onClick: () => ed.paste() },
      { label: 'Duplicate', icon: 'duplicate', shortcut: 'Ctrl+D', onClick: () => ed.duplicate() },
      { label: 'Delete', icon: 'trash', shortcut: 'Del', disabled: !movable.length, onClick: () => ed.deleteSelection() },
      'sep',
      { label: 'Group', icon: 'group', shortcut: 'Ctrl+G', disabled: movable.length < 2, onClick: () => ed.group('union') },
      { label: 'Intersect', icon: 'intersect', shortcut: 'Ctrl+I', disabled: movable.length < 2, onClick: () => ed.group('intersect') },
      { label: 'Bundle', icon: 'bundle', shortcut: 'Ctrl+B', disabled: movable.length < 2, onClick: () => ed.group('bundle') },
      { label: 'Ungroup', icon: 'ungroup', shortcut: 'Ctrl+Shift+G', disabled: !hasGroup, onClick: () => ed.ungroup() },
      'sep',
      { label: 'Make solid', shortcut: 'S', disabled: !movable.length, onClick: () => ed.setHole(false) },
      { label: 'Make hole', shortcut: 'H', disabled: !movable.length, onClick: () => ed.setHole(true) },
      { label: 'Transparent', shortcut: 'T', checked: movable.length > 0 && movable.every((x) => x.transparent), disabled: !movable.length, onClick: () => ed.toggleTransparent() },
      'sep',
      { label: 'Align', icon: 'align', shortcut: 'L', disabled: !movable.length, onClick: () => ed.setTool('align') },
      { label: 'Mirror', icon: 'mirror', shortcut: 'M', disabled: !movable.length, onClick: () => ed.setTool('mirror') },
      { label: 'Split', icon: 'split', shortcut: 'K', disabled: !movable.length, onClick: () => ed.setTool('split') },
      { label: 'Drop to workplane', icon: 'drop', shortcut: 'D', disabled: !movable.length, onClick: () => ed.dropToWorkplane() },
      { label: 'Workplane on selection', icon: 'workplane', shortcut: 'Shift+W', onClick: () => { ed.workplaneAtSelection(); this._updateBanner(); } },
      'sep',
      this.workspaceOn('slicer') && { label: 'Slice…', icon: 'export', title: 'Add the selection to the build plate in the Slicer', onClick: () => this.openSlicer({ selectedOnly: true }) },
      'sep',
      { label: locked ? 'Unlock' : 'Lock', icon: locked ? 'unlock' : 'lock', shortcut: 'Ctrl+L', onClick: () => ed.toggleLock() },
      { label: 'Hide', icon: 'eyeOff', shortcut: 'Ctrl+H', onClick: () => ed.hideSelection() },
      { label: 'Rename…', icon: 'pencil', disabled: n !== 1, onClick: () => this.renameNode(ed.selectedNodes()[0]) },
      { label: 'Save to Your Creations', icon: 'star', onClick: () => this.shapes.saveCreation() },
      { label: 'Details…', icon: 'stats', onClick: () => statsDialog(this) },
    ], at);
  }

  // ---------------------------------------------------------------- keyboard
  _key(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (this.dashboard.isOpen) { if (e.key === 'Escape') this.dashboard.hide(); return; }
    if (this.viewMode === 'laser' || this.viewMode === 'slicer') return; // those workspaces have their own shortcuts
    const ed = this.editor;
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const voxel = this._isVoxel();

    // view + file shortcuts work in every mode
    if (ctrl && key === 's') { done(); this.saveNow(); return; }
    if (ctrl && key === 'o') { done(); this.openFile(); return; }
    if (ctrl && key === 'n') { done(); this.newDesign(); return; }
    if (ctrl && key === 'e') { done(); exportDialog(this); return; }
    if (!ctrl && key === 'f') { done(); this.fit(); return; }
    if (!ctrl && key === 'o') { done(); this.toggleProjection(); return; }
    if (key === 'Home') { done(); this.viewport.home(); return; }
    if (!ctrl && (key === '+' || key === '=')) { done(); this.viewport.zoomBy(0.8); return; }
    if (!ctrl && (key === '-' || key === '_')) { done(); this.viewport.zoomBy(1.25); return; }
    if (key === '?' || key === 'F1') { done(); shortcutsDialog(this); return; }
    if (voxel) { if (key === 'Escape') this.setViewMode('design'); return; }

    if (key === 'Escape') {
      done();
      if (ed.placing) ed.cancelPlace();
      else if (ed.edgeMode) { if (ed.edgeMode.picked.size) ed.clearEdgePicks(); else ed.exitEdgeMode(); }
      else if (ed.parts.active) { if (ed.parts.picked.size) ed.parts.clearPicks(); else ed.setTool('select'); }
      else if (ed.tool !== 'select') ed.setTool('select');
      else if (ed.selection.size) ed.clearSelection();
      else if (ed.editing) ed.exitGroup();
      return;
    }
    if (key === 'Enter' && ed.tool === 'split') { done(); ed.applySplit(); return; }
    if (key === 'Delete' || key === 'Backspace') { done(); ed.deleteSelection(); return; }
    if (key.startsWith('Arrow')) {
      done();
      const k = shift ? 10 : 1;
      if (ctrl) { if (key === 'ArrowUp') ed.nudge(0, 0, k); else if (key === 'ArrowDown') ed.nudge(0, 0, -k); return; }
      if (key === 'ArrowLeft') ed.nudge(-k, 0, 0); else if (key === 'ArrowRight') ed.nudge(k, 0, 0);
      else if (key === 'ArrowUp') ed.nudge(0, k, 0); else ed.nudge(0, -k, 0);
      return;
    }
    if (ctrl) {
      const map = {
        c: () => ed.copy(), x: () => ed.cut(), v: () => ed.paste(shift), d: () => ed.duplicate(),
        z: () => (shift ? ed.redo() : ed.undo()), y: () => ed.redo(), a: () => ed.selectAll(),
        g: () => (shift ? ed.ungroup() : ed.group('union')), i: () => ed.group('intersect'), b: () => ed.group('bundle'),
        l: () => ed.toggleLock(), h: () => (shift ? ed.showAll() : ed.hideSelection()),
      };
      if (map[key]) { done(); map[key](); }
      return;
    }
    if (e.altKey) return;
    const map = {
      w: () => { if (shift) { ed.workplaneAtSelection(); this._updateBanner(); } else ed.setTool('workplane'); },
      1: () => ed.setTool('select'), 2: () => ed.setTool(ed.tool === 'face' ? 'select' : 'face'),
      3: () => ed.setTool(ed.tool === 'edges' ? 'select' : 'edges'), 4: () => ed.setTool(ed.tool === 'corner' ? 'select' : 'corner'),
      p: () => this.toggleParts(),
      e: () => ed.setTool('edges'), r: () => ed.setTool('ruler'), n: () => ed.setTool('note'), l: () => ed.setTool('align'), m: () => ed.setTool('mirror'), k: () => ed.setTool('split'), a: () => this.toggleMoveArrows(),
      c: () => ed.toggleCruise(), d: () => ed.dropToWorkplane(), s: () => ed.setHole(false), h: () => ed.setHole(true), t: () => ed.toggleTransparent(),
    };
    if (map[key]) { done(); map[key](); }
  }
}
