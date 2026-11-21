// Laser workspace: 2D canvas editor, layers, machine control. Owns its own tools and shortcuts.
import { addResizer } from '../ui/resizer.js';
import { h, clear, button, icon, toast, popupMenu, promptDialog } from '../ui/dom.js';
import { platform } from '../platform.js';
import { listFontNames, ensureFont } from '../core/fonts.js';
import {
  LAYER_COLORS, LAYER_NAMES, isToolLayer, newLaserDoc, layerOf, mul, apply, invert, translate, scaling, rotation, about,
  makeRect, makeEllipse, makePolygon, makePath, makeGroup, cloneShape, deep, walkShapes, flatten, boundsOf, hitShape, toPath, typeLabel, lid,
} from './model.js';
import { DEFAULT_MACHINE, planJob, toGcode, frameGcode, toMachine, usedLayers, formatTime, sValue } from './gcode.js';
import { LaserDevice } from './device.js';
import * as tools from './tools.js';
import { depthMapStudio } from './depthmap.js';
import { boxMakerDialog } from './boxmaker.js';

const RULER = 22;
const HANDLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
const CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

export class LaserWorkspace {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.doc = newLaserDoc();
    this.machine = { ...DEFAULT_MACHINE, ...(app.settings.laser || {}) };
    this.sel = [];
    this.tool = 'select';
    this.view = { scale: 1.6, ox: 60, oy: 40 };
    this.history = [];
    this.hIndex = -1;
    this.images = new Map();
    this.clipboard = null;
    this.anchor = 4; // 9-dot reference for X / Y fields
    this.lockAspect = true;
    this.active = false;
    this.device = new LaserDevice();
    this.cutSelected = false;
    this.selectedLayer = 0;
    this._build();
    this._bindDevice();
    this._pushHistory();
    document.addEventListener('keydown', (e) => this._key(e));
    // held Space turns a left-button drag into a pan (see _down)
    document.addEventListener('keyup', (e) => { if (e.key === ' ') this.spaceDown = false; });
    window.addEventListener('blur', () => { this.spaceDown = false; });
    new ResizeObserver(() => this._resize()).observe(this.wrap);
  }

  // ---------------------------------------------------------------- document
  load(laserDoc) {
    this.doc = laserDoc ? { ...newLaserDoc(), ...deep(laserDoc) } : newLaserDoc();
    this.sel = [];
    this.pen = null;
    this.nodeShape = null;
    this.history = [];
    this.hIndex = -1;
    this._pushHistory();
    this.selectedLayer = this.doc.currentLayer || 0;
    this._loadImages();
    if (this.active) { this.zoomToBed(); this.refresh(); }
  }

  getDoc() { return this.doc; }

  _loadImages() {
    walkShapes(this.doc.shapes, (s) => {
      if (s.type !== 'image' || this.images.has(s.id)) return;
      const img = new Image();
      img.onload = () => { this.images.set(s.id, img); this.redraw(); };
      img.src = s.src;
    });
  }

  getImage = (s) => this.images.get(s.id) || null;

  _snapshot() { return { shapes: deep(this.doc.shapes), layers: deep(this.doc.layers), layerOrder: deep(this.doc.layerOrder || []) }; }
  _pushHistory() {
    this.history.length = this.hIndex + 1;
    this.history.push(this._snapshot());
    if (this.history.length > 80) this.history.shift();
    this.hIndex = this.history.length - 1;
  }

  /** Call after any change to the document. */
  commit() {
    this._pushHistory();
    this.app._markDirty();
    this.refresh();
  }

  _restore(i) {
    const s = this.history[i];
    if (!s) return;
    this.hIndex = i;
    this.doc.shapes = deep(s.shapes);
    this.doc.layers = deep(s.layers);
    this.doc.layerOrder = deep(s.layerOrder);
    const ids = new Set(this.doc.shapes.map((x) => x.id));
    this.sel = this.sel.filter((id) => ids.has(id));
    this.nodeSel = null;
    this._loadImages();
    this.app._markDirty();
    this.refresh();
  }

  undo() { if (this.hIndex > 0) this._restore(this.hIndex - 1); }
  redo() { if (this.hIndex < this.history.length - 1) this._restore(this.hIndex + 1); }

  selected() { return this.sel.map((id) => this.doc.shapes.find((s) => s.id === id)).filter(Boolean); }
  movable() { return this.selected().filter((s) => !s.locked); }
  select(ids) { this.sel = [...new Set(ids)]; this.nodeSel = null; this.refresh(); }

  add(shapes, select = true) {
    this.doc.shapes.push(...shapes);
    this._loadImages();
    if (select) this.sel = shapes.map((s) => s.id);
    this.commit();
  }

  transform(matrix, shapes = this.movable()) {
    for (const s of shapes) s.m = mul(matrix, s.m);
  }

  // ---------------------------------------------------------------- layout
  _build() {
    const tb = (ic, title, onClick, label) => button({ icon: ic, title, onClick, label });
    const menuBtn = (label, ic, items) => { const b = button({ icon: ic, label, title: label, onClick: () => popupMenu(items(), b) }); return b; };
    this.toolbar = h('div', { class: 'toolbar laser-toolbar', role: 'toolbar', 'aria-label': 'Laser tools' },
      tb('import', 'Import SVG, DXF or images (Ctrl+I)', () => this.importDialog(), 'Import'),
      menuBtn('Export', 'export', () => [
        { label: 'Save G-code…', icon: 'export', onClick: () => this.saveGcode() },
        { label: 'Export SVG…', onClick: () => tools.exportVector(this, 'svg') },
        { label: 'Export DXF…', onClick: () => tools.exportVector(this, 'dxf') },
      ]),
      tb('cube', 'Bring the outline of the 3D design (where it meets the workplane) into the laser workspace', () => tools.from3D(this), 'From 3D'),
      h('span', { class: 'sep' }),
      tb('undo', 'Undo (Ctrl+Z)', () => this.undo()), tb('redo', 'Redo (Ctrl+Y)', () => this.redo()),
      h('span', { class: 'sep' }),
      tb('copy', 'Copy (Ctrl+C)', () => this.copy()), tb('paste', 'Paste (Ctrl+V)', () => this.paste()),
      tb('duplicate', 'Duplicate (Ctrl+D)', () => this.duplicate()), tb('trash', 'Delete (Del)', () => this.remove()),
      h('span', { class: 'sep' }),
      tb('group', 'Group (Ctrl+G)', () => this.group(), 'Group'), tb('ungroup', 'Ungroup (Ctrl+U)', () => this.ungroup(), 'Ungroup'),
      h('span', { class: 'sep' }),
      menuBtn('Arrange', 'align', () => [
        { label: 'Align left', onClick: () => this.align('x', 0) }, { label: 'Align centres (vertical axis)', onClick: () => this.align('x', 0.5) }, { label: 'Align right', onClick: () => this.align('x', 1) },
        { label: 'Align top', onClick: () => this.align('y', 0) }, { label: 'Align centres (horizontal axis)', onClick: () => this.align('y', 0.5) }, { label: 'Align bottom', onClick: () => this.align('y', 1) },
        'sep',
        { label: 'Distribute horizontally', onClick: () => this.distribute('x') }, { label: 'Distribute vertically', onClick: () => this.distribute('y') },
        'sep',
        { label: 'Move to centre of work area', shortcut: 'P', onClick: () => this.moveToBed(4) },
        { label: 'Move to upper left', onClick: () => this.moveToBed(0) }, { label: 'Move to lower left', onClick: () => this.moveToBed(6) },
        'sep',
        { label: 'Flip horizontal', shortcut: 'Ctrl+Shift+H', onClick: () => this.flip('x') }, { label: 'Flip vertical', shortcut: 'Ctrl+Shift+V', onClick: () => this.flip('y') },
        { label: 'Rotate 90° clockwise', shortcut: '.', onClick: () => this.rotate(90) }, { label: 'Rotate 90° counter-clockwise', shortcut: ',', onClick: () => this.rotate(-90) },
        'sep',
        { label: 'Bring to front', shortcut: 'PgUp', onClick: () => this.order(1) }, { label: 'Send to back', shortcut: 'PgDn', onClick: () => this.order(-1) },
        { label: 'Lock / unlock', onClick: () => this.toggleLock() },
      ]),
      menuBtn('Modify', 'intersect', () => [
        { label: 'Weld (union)', shortcut: 'Ctrl+W', onClick: () => tools.boolean(this, 'union') },
        { label: 'Subtract (first minus the rest)', onClick: () => tools.boolean(this, 'subtract') },
        { label: 'Intersect', onClick: () => tools.boolean(this, 'intersect') },
        { label: 'Exclude (XOR)', onClick: () => tools.boolean(this, 'xor') },
        'sep',
        { label: 'Offset shapes…', shortcut: 'Alt+O', onClick: () => tools.offsetDialog(this) },
        { label: 'Convert to path', onClick: () => this.convertToPath() },
        { label: 'Close path', onClick: () => this.closePaths() },
        { label: 'Break apart', onClick: () => this.breakApart() },
        'sep',
        { label: 'Grid array…', onClick: () => tools.gridArrayDialog(this) },
        { label: 'Circular array…', onClick: () => tools.circularArrayDialog(this) },
        'sep',
        { label: 'Trace image…', onClick: () => tools.traceDialog(this) },
      ]),
      menuBtn('Create', 'plus', () => [
        { label: 'Depth map from STL or image…', onClick: () => depthMapStudio(this) },
        { label: 'Box maker (finger joints)…', onClick: () => boxMakerDialog(this) },
        { label: 'QR code…', onClick: () => tools.qrDialog(this) },
        { label: 'Material test…', onClick: () => tools.materialTestDialog(this) },
        { label: 'Interval test…', onClick: () => tools.intervalTestDialog(this) },
      ]),
      tb('stats', 'Depth Map Studio: turn an STL model or an image into a height map for relief engraving', () => depthMapStudio(this), 'Depth Map'),
      h('span', { class: 'spacer' }),
      tb('eye', 'Preview the job path and time (Alt+P)', () => tools.previewDialog(this), 'Preview'),
      tb('settings', 'Device settings: work area, origin, controller', () => tools.deviceDialog(this), 'Device'));

    this.propBar = h('div', { class: 'laser-props' });
    this.toolBtns = {};
    const toolBtn = (id, ic, title) => { const b = button({ icon: ic, title, onClick: () => this.setTool(id) }); this.toolBtns[id] = b; return b; };
    this.toolCol = h('div', { class: 'laser-tools' },
      toolBtn('select', 'select', 'Select (Esc)'), toolBtn('node', 'lnode', 'Edit nodes (`)'),
      toolBtn('line', 'lline', 'Draw lines and curves (Ctrl+L). Click for corners, drag for curves, double-click to finish.'),
      toolBtn('rect', 'lrect', 'Rectangle (Ctrl+R). Shift for a square.'), toolBtn('ellipse', 'lellipse', 'Ellipse (Ctrl+E). Shift for a circle.'),
      toolBtn('polygon', 'lpolygon', 'Polygon'), toolBtn('text', 'ltext', 'Text (Ctrl+T)'),
      toolBtn('measure', 'ruler', 'Measure (Alt+M)'), toolBtn('position', 'target', 'Click to move the laser head to a spot'));

    this.canvas = h('canvas', { class: 'laser-canvas', 'aria-label': 'Laser bed drawing area' });
    this.ctx = this.canvas.getContext('2d');
    this.coords = h('div', { class: 'laser-coords' });
    this.wrap = h('div', { class: 'laser-canvas-wrap' }, this.canvas, this.coords);

    this.layerList = h('div', { class: 'laser-layer-list' });
    this.layerEditor = h('div', { class: 'laser-layer-editor' });
    this.laserPanel = h('div', {});
    this.movePanel = h('div', {});
    this.consoleLog = h('div', { class: 'laser-console-log' });
    this.consoleInput = h('input', { class: 'input', type: 'text', placeholder: 'Type a command, e.g. $$ or G0 X10 Y10', spellcheck: false });
    this.consoleInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' || !this.consoleInput.value.trim()) return;
      const line = this.consoleInput.value.trim();
      this.consoleInput.value = '';
      if (!this.device.connected) return this.log('Not connected', 'error');
      if (this.device.job) return this.log('A job is running. Pause or stop it first.', 'error');
      this.device.send(line).catch((err) => this.log(err.message, 'error'));
    });
    const section = (title, body, open = true) => h('details', { class: 'laser-section', open }, h('summary', {}, title), body);
    this.side = h('div', { class: 'laser-side' },
      section('Layers', h('div', {}, this.layerList, this.layerEditor)),
      section('Laser', this.laserPanel),
      section('Move', this.movePanel, false),
      section('Console', h('div', {}, this.consoleLog, this.consoleInput), false));
    this.side.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') e.stopPropagation(); });

    this.palette = h('div', { class: 'laser-palette' });
    this.statusBar = h('div', { class: 'laser-status' });
    this.root.append(this.toolbar, this.propBar,
      h('div', { class: 'laser-main' }, this.toolCol, this.wrap, this.side),
      h('div', { class: 'laser-bottom' }, this.palette, this.statusBar));
    addResizer(this.side, { side: 'right', key: 'laser-side', min: 260, max: 640 });

    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => this._down(e));
    cv.addEventListener('pointermove', (e) => this._move(e));
    cv.addEventListener('pointerup', (e) => this._up(e));
    cv.addEventListener('pointercancel', (e) => this._up(e));
    cv.addEventListener('dblclick', (e) => this._dblclick(e));
    cv.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    this._buildPalette();
    this._buildLaserPanel();
    this._buildMovePanel();
  }

  setActive(on) {
    this.active = on;
    if (!on) return;
    this._resize();
    if (!this._zoomed) { this.zoomToBed(); this._zoomed = true; }
    this.refresh();
  }

  saveMachine() { this.app.patchSettings({ laser: { ...this.machine } }); this.refresh(); }

  // ---------------------------------------------------------------- view
  _resize() {
    if (!this.active) return;
    const w = this.wrap.clientWidth, hgt = this.wrap.clientHeight;
    if (!w || !hgt) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = hgt + 'px';
    this.dpr = dpr; this.w = w; this.h = hgt;
    this.redraw();
  }

  zoomToBed() { this.zoomTo({ x0: 0, y0: 0, x1: this.machine.bedW, y1: this.machine.bedH }); }
  zoomTo(b) {
    const w = this.w || this.wrap.clientWidth || 800, hgt = this.h || this.wrap.clientHeight || 600;
    const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
    const scale = Math.min((w - RULER - 60) / bw, (hgt - RULER - 60) / bh);
    this.view.scale = Math.max(0.05, Math.min(200, scale));
    this.view.ox = RULER + (w - RULER - bw * this.view.scale) / 2 - b.x0 * this.view.scale;
    this.view.oy = RULER + (hgt - RULER - bh * this.view.scale) / 2 - b.y0 * this.view.scale;
    this.redraw();
  }

  toScreen(p) { return [p[0] * this.view.scale + this.view.ox, p[1] * this.view.scale + this.view.oy]; }
  toBed(e) { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left - this.view.ox) / this.view.scale, (e.clientY - r.top - this.view.oy) / this.view.scale]; }
  screenOf(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  snap(p, e) {
    const g = this.machine.gridSnap;
    if (!g || (e && e.altKey)) return p;
    return [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
  }

  _wheel(e) {
    e.preventDefault();
    const [sx, sy] = this.screenOf(e);
    const f = Math.exp(-Math.max(-1, Math.min(1, e.deltaY * 0.0016)));
    const next = Math.max(0.05, Math.min(400, this.view.scale * f));
    const k = next / this.view.scale;
    this.view.ox = sx - (sx - this.view.ox) * k;
    this.view.oy = sy - (sy - this.view.oy) * k;
    this.view.scale = next;
    this.redraw();
  }

  redraw() {
    if (this._raf || !this.active) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
  }

  refresh() {
    if (!this.active) return;
    this._renderProps();
    this._renderLayers();
    this._renderPaletteState();
    this._renderStatus();
    for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('active', this.tool === id);
    this.redraw();
  }

  layerFilled = (li) => layerOf(this.doc, li).mode !== 'line';
  visible(s) { return s.type === 'group' ? true : layerOf(this.doc, s.layer).show !== false; }

  _draw() {
    const ctx = this.ctx, v = this.view, m = this.machine;
    if (!this.w) return;
    const light = document.documentElement.dataset.theme === 'light';
    const C = light
      ? { bg: '#e4e9f0', bed: '#ffffff', minor: '#eef2f6', major: '#d3dbe6', edge: '#8b98aa', text: '#445063', ink: '#101418', ruler: '#f3f6fa', sel: '#0a84ff' }
      : { bg: '#14161b', bed: '#22262e', minor: '#292e38', major: '#363d4a', edge: '#6b7890', text: '#9aa5b6', ink: '#f2f4f8', ruler: '#1e2128', sel: '#29c5ff' };
    this.colors = C;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    const [bx, by] = this.toScreen([0, 0]);
    const bw = m.bedW * v.scale, bh = m.bedH * v.scale;
    ctx.fillStyle = C.bed;
    ctx.fillRect(bx, by, bw, bh);
    // grid
    if (m.showGrid !== false) {
      const step = v.scale >= 6 ? 1 : v.scale >= 1.2 ? 10 : v.scale >= 0.25 ? 50 : 100;
      const major = step === 1 ? 10 : step === 10 ? 50 : step * 5;
      ctx.lineWidth = 1;
      const originRight = m.origin.endsWith('r'), originBottom = m.origin.startsWith('b');
      for (let x = 0; x <= m.bedW + 1e-6; x += step) {
        const sx = Math.round(bx + (originRight ? m.bedW - x : x) * v.scale) + 0.5;
        ctx.strokeStyle = Math.abs(x % major) < 1e-6 ? C.major : C.minor;
        ctx.beginPath(); ctx.moveTo(sx, by); ctx.lineTo(sx, by + bh); ctx.stroke();
      }
      for (let y = 0; y <= m.bedH + 1e-6; y += step) {
        const sy = Math.round(by + (originBottom ? m.bedH - y : y) * v.scale) + 0.5;
        ctx.strokeStyle = Math.abs(y % major) < 1e-6 ? C.major : C.minor;
        ctx.beginPath(); ctx.moveTo(bx, sy); ctx.lineTo(bx + bw, sy); ctx.stroke();
      }
    }
    ctx.strokeStyle = C.edge; ctx.lineWidth = 1.2;
    ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, bw, bh);
    // machine origin marker
    const o = this.toScreen([m.origin.endsWith('r') ? m.bedW : 0, m.origin.startsWith('b') ? m.bedH : 0]);
    ctx.fillStyle = '#e53935'; ctx.fillRect(o[0] - 4, o[1] - 4, 8, 8);

    // shapes
    const selSet = new Set(this.sel);
    for (const s of this.doc.shapes) this._drawShape(ctx, s, selSet.has(s.id), C);

    // selection frame + handles
    const b = this.selBounds();
    if (b && this.tool === 'select' && !this.drag?.creating) {
      const [x0, y0] = this.toScreen([b.x0, b.y0]), [x1, y1] = this.toScreen([b.x1, b.y1]);
      ctx.setLineDash([5, 4]); ctx.strokeStyle = C.sel; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      if (this.movable().length) {
        for (const [hx, hy] of HANDLES) { const px = x0 + (x1 - x0) * hx, py = y0 + (y1 - y0) * hy; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111'; ctx.fillRect(px - 4.5, py - 4.5, 9, 9); ctx.strokeRect(px - 4.5, py - 4.5, 9, 9); }
        const rx = (x0 + x1) / 2, ry = y0 - 26;
        ctx.strokeStyle = C.sel; ctx.beginPath(); ctx.moveTo(rx, y0); ctx.lineTo(rx, ry); ctx.stroke();
        ctx.fillStyle = C.sel; ctx.beginPath(); ctx.arc(rx, ry, 5.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    this._drawNodes(ctx, C);
    this._drawTransient(ctx, C);
    this._drawMachine(ctx, C);
    this._drawRulers(ctx, C);
  }

  _drawShape(ctx, s, selected, C, parent) {
    const m = parent ? mul(parent, s.m) : s.m;
    if (s.type === 'group') { for (const c of s.children) this._drawShape(ctx, c, selected, C, m); return; }
    const layer = layerOf(this.doc, s.layer);
    if (layer.show === false) return;
    const v = this.view;
    let color = LAYER_COLORS[s.layer];
    if (s.layer === 0) color = C.ink; // the first layer follows the theme so it is visible on any background
    if (s.type === 'image') {
      const img = this.images.get(s.id);
      ctx.save();
      ctx.transform(v.scale, 0, 0, v.scale, v.ox, v.oy);
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      if (img) { ctx.globalAlpha = 0.92; ctx.drawImage(img, 0, 0, s.w, s.h); }
      ctx.restore();
    }
    const polys = flatten(s, parent || undefined);
    ctx.beginPath();
    for (const p of polys) {
      for (let i = 0; i < p.pts.length; i++) { const q = this.toScreen(p.pts[i]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }
      if (p.closed) ctx.closePath();
    }
    if (s.type !== 'image' && layer.mode !== 'line') { ctx.globalAlpha = 0.28; ctx.fillStyle = color; ctx.fill('evenodd'); ctx.globalAlpha = 1; }
    ctx.lineWidth = selected ? 1.6 : 1.1;
    ctx.strokeStyle = s.type === 'image' ? (selected ? C.sel : 'rgba(128,128,128,.6)') : color;
    if (selected) ctx.setLineDash([6, 3]);
    if (layer.output === false) ctx.globalAlpha = 0.45;
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  _drawNodes(ctx, C) {
    if (this.tool !== 'node') return;
    const s = this.doc.shapes.find((x) => x.id === this.nodeShape);
    if (!s || s.type !== 'path') return;
    s.subs.forEach((sub, si) => sub.nodes.forEach((n, ni) => {
      const p = this.toScreen(apply(s.m, [n.x, n.y]));
      const on = this.nodeSel && this.nodeSel.sub === si && this.nodeSel.idx === ni;
      if (on) for (const [hx, hy] of [[n.ix, n.iy], [n.ox, n.oy]]) {
        if (hx == null) continue;
        const q = this.toScreen(apply(s.m, [hx, hy]));
        ctx.strokeStyle = C.sel; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        ctx.fillStyle = C.sel; ctx.beginPath(); ctx.arc(q[0], q[1], 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = on ? '#ff5252' : '#fff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1;
      ctx.fillRect(p[0] - 4, p[1] - 4, 8, 8); ctx.strokeRect(p[0] - 4, p[1] - 4, 8, 8);
    }));
  }

  _drawTransient(ctx, C) {
    const d = this.drag;
    ctx.lineWidth = 1.2; ctx.strokeStyle = C.sel;
    if (d && d.kind === 'marquee' && d.cur) {
      const a = this.toScreen(d.start), b = this.toScreen(d.cur);
      const crossing = d.cur[0] < d.start[0];
      ctx.setLineDash(crossing ? [5, 4] : []);
      ctx.fillStyle = crossing ? 'rgba(80,220,120,.12)' : 'rgba(41,197,255,.12)';
      ctx.strokeStyle = crossing ? '#3ad27a' : C.sel;
      ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      ctx.setLineDash([]);
    }
    if (d && d.kind === 'create' && d.cur) {
      const r = this._createRect(d);
      const a = this.toScreen([r.x, r.y]);
      ctx.beginPath();
      if (d.tool === 'ellipse') ctx.ellipse(a[0] + (r.w * this.view.scale) / 2, a[1] + (r.h * this.view.scale) / 2, (r.w * this.view.scale) / 2, (r.h * this.view.scale) / 2, 0, 0, Math.PI * 2);
      else ctx.rect(a[0], a[1], r.w * this.view.scale, r.h * this.view.scale);
      ctx.stroke();
      this._tip(ctx, `${r.w.toFixed(1)} × ${r.h.toFixed(1)} mm`, a[0], a[1] - 8, C);
    }
    if (this.pen && this.pen.nodes.length) {
      const sub = { closed: false, nodes: this.pen.nodes };
      const pts = flatten({ type: 'path', m: [1, 0, 0, 1, 0, 0], subs: [sub], layer: 0 })[0]?.pts || [[sub.nodes[0].x, sub.nodes[0].y]];
      ctx.beginPath();
      pts.forEach((p, i) => { const q = this.toScreen(p); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      if (this.cur) { const q = this.toScreen(this.cur); ctx.lineTo(q[0], q[1]); }
      ctx.stroke();
      for (const n of this.pen.nodes) { const q = this.toScreen([n.x, n.y]); ctx.fillStyle = '#fff'; ctx.fillRect(q[0] - 3, q[1] - 3, 6, 6); ctx.strokeRect(q[0] - 3, q[1] - 3, 6, 6); }
    }
    if (d && d.kind === 'measure' && d.cur) {
      const a = this.toScreen(d.start), b = this.toScreen(d.cur);
      ctx.strokeStyle = '#ff9f43'; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      const dx = d.cur[0] - d.start[0], dy = d.cur[1] - d.start[1];
      this._tip(ctx, `${Math.hypot(dx, dy).toFixed(2)} mm   ΔX ${Math.abs(dx).toFixed(2)}  ΔY ${Math.abs(dy).toFixed(2)}   ${(Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1)}°`, b[0] + 12, b[1] - 10, C);
    }
    if (d && d.kind === 'rotate' && d.angle != null) { const b = this.toScreen(d.cur); this._tip(ctx, `${d.angle.toFixed(1)}°`, b[0] + 14, b[1] - 10, C); }
  }

  _tip(ctx, text, x, y, C) {
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(20,24,30,.92)'; ctx.fillRect(x, y - 16, w, 20);
    ctx.fillStyle = '#fff'; ctx.fillText(text, x + 6, y - 2);
    void C;
  }

  _drawMachine(ctx) {
    const m = this.machine;
    // job origin (green) for relative start modes, on the bounds the G-code will actually use
    if (this.doc.startFrom !== 'absolute') {
      const b = this._jobBounds !== undefined ? this._jobBounds : boundsOf(this.doc.shapes);
      if (b) {
        const i = this.doc.jobOrigin ?? 6;
        const p = this.toScreen([b.x0 + (b.w * (i % 3)) / 2, b.y0 + (b.h * Math.floor(i / 3)) / 2]);
        ctx.fillStyle = '#2ecc71'; ctx.fillRect(p[0] - 5, p[1] - 5, 10, 10);
      }
    }
    const st = this.device.status;
    const pos = st && (st.wpos || st.mpos);
    if (this.device.connected && pos) {
      const bxm = m.origin.endsWith('r') ? m.bedW - pos[0] : pos[0], bym = m.origin.startsWith('b') ? m.bedH - pos[1] : pos[1];
      const p = this.toScreen([bxm, bym]);
      ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(p[0] - 10, p[1]); ctx.lineTo(p[0] + 10, p[1]); ctx.moveTo(p[0], p[1] - 10); ctx.lineTo(p[0], p[1] + 10); ctx.stroke();
      ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _drawRulers(ctx, C) {
    const v = this.view, m = this.machine;
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, this.w, RULER); ctx.fillRect(0, 0, RULER, this.h);
    ctx.strokeStyle = C.major; ctx.fillStyle = C.text; ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.lineWidth = 1;
    const step = v.scale >= 8 ? 5 : v.scale >= 3 ? 10 : v.scale >= 1.2 ? 20 : v.scale >= 0.5 ? 50 : v.scale >= 0.2 ? 100 : 500;
    const right = m.origin.endsWith('r'), bottom = m.origin.startsWith('b');
    ctx.beginPath();
    for (let x = 0; x <= m.bedW + 1e-6; x += step) {
      const sx = Math.round(this.toScreen([right ? m.bedW - x : x, 0])[0]) + 0.5;
      if (sx < RULER || sx > this.w) continue;
      ctx.moveTo(sx, RULER - 7); ctx.lineTo(sx, RULER);
      ctx.fillText(String(x), sx + 2, 10);
    }
    for (let y = 0; y <= m.bedH + 1e-6; y += step) {
      const sy = Math.round(this.toScreen([0, bottom ? m.bedH - y : y])[1]) + 0.5;
      if (sy < RULER || sy > this.h) continue;
      ctx.moveTo(RULER - 7, sy); ctx.lineTo(RULER, sy);
      ctx.save(); ctx.translate(10, sy - 2); ctx.rotate(-Math.PI / 2); ctx.fillText(String(y), 0, 0); ctx.restore();
    }
    ctx.stroke();
    ctx.fillStyle = C.ruler; ctx.fillRect(0, 0, RULER, RULER);
  }

  // ---------------------------------------------------------------- hit testing
  selBounds() { const s = this.selected(); return s.length ? boundsOf(s) : null; }

  hit(pt) {
    const tol = 5 / this.view.scale;
    for (let i = this.doc.shapes.length - 1; i >= 0; i--) {
      const s = this.doc.shapes[i];
      if (hitShape(s, pt, tol, (li) => this.layerFilled(li) && layerOf(this.doc, li).show !== false)) {
        let shown = false;
        walkShapes([s], (x) => { if (x.type !== 'group' && layerOf(this.doc, x.layer).show !== false) shown = true; });
        if (shown) return s;
      }
    }
    return null;
  }

  _handleAt(sp) {
    const b = this.selBounds();
    if (!b || !this.movable().length) return null;
    const [x0, y0] = this.toScreen([b.x0, b.y0]), [x1, y1] = this.toScreen([b.x1, b.y1]);
    if (Math.hypot(sp[0] - (x0 + x1) / 2, sp[1] - (y0 - 26)) < 9) return { rotate: true };
    for (let i = 0; i < HANDLES.length; i++) {
      const px = x0 + (x1 - x0) * HANDLES[i][0], py = y0 + (y1 - y0) * HANDLES[i][1];
      if (Math.abs(sp[0] - px) < 7 && Math.abs(sp[1] - py) < 7) return { index: i };
    }
    return null;
  }

  // ---------------------------------------------------------------- pointer
  setTool(tool) {
    if (this.pen) this._finishPen(false);
    this.tool = tool;
    this.drag = null;
    if (tool === 'node') {
      const s = this.selected()[0];
      this.nodeShape = s && s.type === 'path' ? s.id : null;
      if (s && s.type !== 'path' && s.type !== 'image' && s.type !== 'group') toast('Use Modify → Convert to path to edit this shape\'s nodes');
    }
    this.canvas.style.cursor = tool === 'select' ? '' : 'crosshair';
    this.refresh();
  }

  _down(e) {
    const act = document.activeElement;
    if (act && act !== document.body && (this.propBar.contains(act) || this.side.contains(act))) act.blur();
    this.canvas.focus?.();
    const sp = this.screenOf(e), raw = this.toBed(e), p = this.snap(raw, e);
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (e.button === 1 || (e.button === 0 && this.spaceDown) || e.button === 2 && this.tool !== 'line') {
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.ox, oy: this.view.oy, button: e.button, moved: 0 };
      return;
    }
    if (e.button === 2 && this.tool === 'line') { this._finishPen(false); return; }
    if (e.button !== 0) return;
    const t = this.tool;
    if (t === 'rect' || t === 'ellipse' || t === 'polygon') { this.drag = { kind: 'create', tool: t, start: p, cur: null, creating: true }; return; }
    if (t === 'measure') { this.drag = { kind: 'measure', start: raw, cur: raw }; return; }
    if (t === 'text') { tools.textDialog(this, null, p); return; }
    if (t === 'position') { this.jogTo(raw); return; }
    if (t === 'line') return this._penDown(p, e);
    if (t === 'node') return this._nodeDown(raw, sp, e);
    // select tool
    const hnd = this._handleAt(sp);
    const shapes = this.movable();
    if (hnd && shapes.length) {
      const b = this.selBounds();
      const start = new Map(shapes.map((s) => [s.id, [...s.m]]));
      if (hnd.rotate) this.drag = { kind: 'rotate', b, start, a0: Math.atan2(raw[1] - b.cy, raw[0] - b.cx), cur: raw };
      else this.drag = { kind: 'scale', b, start, index: hnd.index };
      return;
    }
    const s = this.hit(raw);
    if (s) {
      if (e.shiftKey || e.ctrlKey) { this.select(this.sel.includes(s.id) ? this.sel.filter((id) => id !== s.id) : [...this.sel, s.id]); return; }
      if (!this.sel.includes(s.id)) this.select([s.id]);
      const mv = this.movable();
      this.drag = { kind: 'move', from: raw, b: this.selBounds(), start: new Map(mv.map((x) => [x.id, [...x.m]])), moved: false };
      return;
    }
    this.drag = { kind: 'marquee', start: raw, cur: null, add: e.shiftKey };
  }

  _move(e) {
    const raw = this.toBed(e), p = this.snap(raw, e), d = this.drag;
    this.cur = this.tool === 'line' ? p : raw;
    const [mx, my] = toMachine(this.machine, raw[0], raw[1]);
    this.coords.textContent = `X ${mx.toFixed(2)}   Y ${my.toFixed(2)} mm`;
    if (!d) {
      if (this.tool === 'select') { const hnd = this._handleAt(this.screenOf(e)); this.canvas.style.cursor = hnd ? (hnd.rotate ? 'grab' : CURSORS[hnd.index]) : this.hit(raw) ? 'move' : ''; }
      if (this.pen) this.redraw();
      return;
    }
    if (d.kind === 'pan') { d.moved += 1; this.view.ox = d.ox + e.clientX - d.sx; this.view.oy = d.oy + e.clientY - d.sy; }
    else if (d.kind === 'create' || d.kind === 'measure') { d.cur = d.kind === 'measure' ? raw : p; d.shift = e.shiftKey; }
    else if (d.kind === 'marquee') d.cur = raw;
    else if (d.kind === 'move') {
      let dx = raw[0] - d.from[0], dy = raw[1] - d.from[1];
      if (!d.moved && Math.hypot(dx, dy) * this.view.scale < 3) return;
      d.moved = true;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const g = this.machine.gridSnap;
      if (g && !e.altKey && d.b) { dx = Math.round((d.b.x0 + dx) / g) * g - d.b.x0; dy = Math.round((d.b.y0 + dy) / g) * g - d.b.y0; if (e.shiftKey) { if (Math.abs(raw[0] - d.from[0]) > Math.abs(raw[1] - d.from[1])) dy = 0; else dx = 0; } }
      for (const s of this.movable()) { const m0 = d.start.get(s.id); if (m0) s.m = mul(translate(dx, dy), m0); }
      this._renderProps();
    } else if (d.kind === 'scale') {
      const [hx, hy] = HANDLES[d.index], b = d.b;
      const ax = e.ctrlKey ? b.cx : b.x0 + b.w * (1 - hx), ay = e.ctrlKey ? b.cy : b.y0 + b.h * (1 - hy);
      let sx = hx === 0.5 || b.w < 1e-9 ? 1 : (p[0] - ax) / (b.x0 + b.w * hx - ax);
      let sy = hy === 0.5 || b.h < 1e-9 ? 1 : (p[1] - ay) / (b.y0 + b.h * hy - ay);
      const corner = hx !== 0.5 && hy !== 0.5;
      if (corner && !e.shiftKey) { const k = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = k; sy = k; }
      if (Math.abs(sx) < 1e-4) sx = 1e-4; if (Math.abs(sy) < 1e-4) sy = 1e-4;
      const mtx = about(ax, ay, scaling(sx, sy));
      for (const s of this.movable()) { const m0 = d.start.get(s.id); if (m0) s.m = mul(mtx, m0); }
      this._renderProps();
    } else if (d.kind === 'rotate') {
      let ang = Math.atan2(raw[1] - d.b.cy, raw[0] - d.b.cx) - d.a0;
      let deg = (ang * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15; else if (e.ctrlKey) deg = Math.round(deg / 5) * 5;
      d.angle = -deg; d.cur = raw;
      const mtx = about(d.b.cx, d.b.cy, rotation((deg * Math.PI) / 180));
      for (const s of this.movable()) { const m0 = d.start.get(s.id); if (m0) s.m = mul(mtx, m0); }
    } else if (d.kind === 'pen') {
      const n = d.node;
      n.ox = p[0]; n.oy = p[1]; n.ix = 2 * n.x - p[0]; n.iy = 2 * n.y - p[1];
    } else if (d.kind === 'node') this._nodeDrag(raw, e);
    this.redraw();
  }

  _up(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'pan') {
      if (d.button === 2 && d.moved < 3) this._contextMenu(e);
    } else if (d.kind === 'create') {
      if (d.cur) {
        const r = this._createRect(d);
        if (r.w > 0.2 && r.h > 0.2) {
          const L = this.doc.currentLayer;
          const s = d.tool === 'rect' ? makeRect(L, r.x, r.y, r.w, r.h) : d.tool === 'ellipse' ? makeEllipse(L, r.x, r.y, r.w, r.h) : makePolygon(L, r.x, r.y, r.w, r.h, this.polySides || 6);
          this.tool = 'select'; this.canvas.style.cursor = '';
          this.add([s]);
          return;
        }
      }
    } else if (d.kind === 'marquee') {
      if (!d.cur || Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]) * this.view.scale < 3) { if (!d.add) this.select([]); }
      else {
        const x0 = Math.min(d.start[0], d.cur[0]), x1 = Math.max(d.start[0], d.cur[0]), y0 = Math.min(d.start[1], d.cur[1]), y1 = Math.max(d.start[1], d.cur[1]);
        const crossing = d.cur[0] < d.start[0];
        const ids = [];
        for (const s of this.doc.shapes) {
          const b = boundsOf([s]);
          if (!b || !this.visible(s)) continue;
          const inside = b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1;
          const touch = b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1;
          if (inside || (crossing && touch)) ids.push(s.id);
        }
        this.select(d.add ? [...this.sel, ...ids] : ids);
      }
    } else if (d.kind === 'move') { if (d.moved) this.commit(); }
    else if (d.kind === 'scale' || d.kind === 'rotate') this.commit();
    else if (d.kind === 'node') { if (d.moved) this.commit(); }
    else if (d.kind === 'pen') { if (d.node.ox != null && Math.hypot(d.node.ox - d.node.x, d.node.oy - d.node.y) * this.view.scale < 4) { delete d.node.ox; delete d.node.oy; delete d.node.ix; delete d.node.iy; } }
    this.redraw();
  }

  _createRect(d) {
    let w = d.cur[0] - d.start[0], hgt = d.cur[1] - d.start[1];
    if (d.shift) { const k = Math.max(Math.abs(w), Math.abs(hgt)); w = Math.sign(w || 1) * k; hgt = Math.sign(hgt || 1) * k; }
    return { x: Math.min(d.start[0], d.start[0] + w), y: Math.min(d.start[1], d.start[1] + hgt), w: Math.abs(w), h: Math.abs(hgt) };
  }

  _dblclick(e) {
    if (this.tool === 'line') { if (this.pen && this.pen.nodes.length > 1) this.pen.nodes.pop(); this._finishPen(false); return; }
    const raw = this.toBed(e);
    if (this.tool === 'node') return this._nodeInsert(raw);
    const s = this.hit(raw);
    if (!s) return;
    if (s.type === 'text') tools.textDialog(this, s);
    else if (s.type === 'path') { this.select([s.id]); this.setTool('node'); }
  }

  // ---- pen (line tool)
  _penDown(p) {
    if (!this.pen) this.pen = { nodes: [] };
    const first = this.pen.nodes[0];
    if (first && this.pen.nodes.length > 2 && Math.hypot(first.x - p[0], first.y - p[1]) * this.view.scale < 8) return this._finishPen(true);
    const node = { x: p[0], y: p[1] };
    this.pen.nodes.push(node);
    this.drag = { kind: 'pen', node };
    this.redraw();
  }

  _finishPen(closed) {
    const pen = this.pen;
    this.pen = null;
    if (!pen || pen.nodes.length < 2) { this.redraw(); return; }
    const s = makePath(this.doc.currentLayer, [{ closed, nodes: pen.nodes }]);
    this.add([s]);
  }

  // ---- node editing
  _nodeDown(raw, sp) {
    const s = this.doc.shapes.find((x) => x.id === this.nodeShape);
    const near = (pt) => { const q = this.toScreen(pt); return Math.hypot(q[0] - sp[0], q[1] - sp[1]) < 8; };
    if (s && s.type === 'path') {
      if (this.nodeSel) {
        const n = s.subs[this.nodeSel.sub]?.nodes[this.nodeSel.idx];
        if (n) for (const which of ['i', 'o']) {
          if (n[which + 'x'] != null && near(apply(s.m, [n[which + 'x'], n[which + 'y']]))) { this.drag = { kind: 'node', shape: s, node: n, handle: which, inv: invert(s.m), moved: false }; return; }
        }
      }
      for (let si = 0; si < s.subs.length; si++) for (let ni = 0; ni < s.subs[si].nodes.length; ni++) {
        const n = s.subs[si].nodes[ni];
        if (near(apply(s.m, [n.x, n.y]))) { this.nodeSel = { sub: si, idx: ni }; this.drag = { kind: 'node', shape: s, node: n, inv: invert(s.m), moved: false }; this.redraw(); return; }
      }
    }
    const hitS = this.hit(raw);
    if (hitS && hitS.type === 'path') { this.sel = [hitS.id]; this.nodeShape = hitS.id; this.nodeSel = null; this.refresh(); }
    else if (hitS) toast('Convert this shape to a path first (Modify → Convert to path)');
    else { this.nodeSel = null; this.redraw(); }
  }

  _nodeDrag(raw, e) {
    const d = this.drag, n = d.node;
    const p = apply(d.inv, this.snap(raw, e));
    d.moved = true;
    if (d.handle) {
      n[d.handle + 'x'] = p[0]; n[d.handle + 'y'] = p[1];
      const other = d.handle === 'i' ? 'o' : 'i';
      if (!e.altKey && n[other + 'x'] != null && n.smooth !== false) { n[other + 'x'] = 2 * n.x - p[0]; n[other + 'y'] = 2 * n.y - p[1]; }
    } else {
      const dx = p[0] - n.x, dy = p[1] - n.y;
      n.x = p[0]; n.y = p[1];
      for (const k of ['i', 'o']) if (n[k + 'x'] != null) { n[k + 'x'] += dx; n[k + 'y'] += dy; }
    }
  }

  _nodeInsert(raw) {
    const s = this.doc.shapes.find((x) => x.id === this.nodeShape);
    if (!s || s.type !== 'path') return;
    const p = apply(invert(s.m), raw);
    let best = null;
    s.subs.forEach((sub, si) => {
      const count = sub.closed ? sub.nodes.length : sub.nodes.length - 1;
      for (let i = 0; i < count; i++) {
        const a = sub.nodes[i], b = sub.nodes[(i + 1) % sub.nodes.length];
        const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / len));
        const dist = Math.hypot(p[0] - a.x - t * dx, p[1] - a.y - t * dy);
        if (!best || dist < best.dist) best = { dist, si, i, pt: [a.x + t * dx, a.y + t * dy] };
      }
    });
    if (!best || best.dist * this.view.scale > 14) return;
    const sub = s.subs[best.si];
    const a = sub.nodes[best.i], b = sub.nodes[(best.i + 1) % sub.nodes.length];
    delete a.ox; delete a.oy; delete b.ix; delete b.iy;
    sub.nodes.splice(best.i + 1, 0, { x: best.pt[0], y: best.pt[1] });
    this.nodeSel = { sub: best.si, idx: best.i + 1 };
    this.commit();
  }

  nodeAction(kind) {
    const s = this.doc.shapes.find((x) => x.id === this.nodeShape);
    if (!s || !this.nodeSel) return false;
    const sub = s.subs[this.nodeSel.sub], n = sub && sub.nodes[this.nodeSel.idx];
    if (!n) return false;
    if (kind === 'delete') {
      sub.nodes.splice(this.nodeSel.idx, 1);
      if (sub.nodes.length < 2) s.subs.splice(this.nodeSel.sub, 1);
      if (!s.subs.length) { this.doc.shapes = this.doc.shapes.filter((x) => x !== s); this.sel = []; this.nodeShape = null; }
      this.nodeSel = null;
    } else if (kind === 'corner') { delete n.ix; delete n.iy; delete n.ox; delete n.oy; }
    else if (kind === 'smooth') {
      const N = sub.nodes.length, prev = sub.nodes[(this.nodeSel.idx - 1 + N) % N], next = sub.nodes[(this.nodeSel.idx + 1) % N];
      const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6;
      n.ix = n.x - tx; n.iy = n.y - ty; n.ox = n.x + tx; n.oy = n.y + ty;
    }
    this.commit();
    return true;
  }

  // ---------------------------------------------------------------- commands
  remove() {
    if (this.tool === 'node' && this.nodeSel && this.nodeAction('delete')) return;
    const ids = new Set(this.movable().map((s) => s.id));
    if (!ids.size) return;
    this.doc.shapes = this.doc.shapes.filter((s) => !ids.has(s.id));
    this.sel = this.sel.filter((id) => !ids.has(id));
    this.commit();
  }
  copy() { const s = this.selected(); if (s.length) { this.clipboard = s.map((x) => cloneShape(x, false)); toast(`Copied ${s.length} object${s.length > 1 ? 's' : ''}`); } }
  cut() { this.copy(); this.remove(); }
  paste() {
    if (!this.clipboard) return;
    const fresh = this.clipboard.map((s) => { const c = cloneShape(s); c.m = mul(translate(5, 5), c.m); c.locked = false; return c; });
    this.clipboard = fresh.map((x) => cloneShape(x, false));
    this.add(fresh);
  }
  duplicate() { const s = this.selected(); if (s.length) this.add(s.map((x) => { const c = cloneShape(x); c.locked = false; return c; })); }
  selectAll() { this.select(this.doc.shapes.filter((s) => this.visible(s)).map((s) => s.id)); }

  group() {
    const s = this.movable();
    if (s.length < 2) return toast('Select two or more objects to group');
    const ids = new Set(s.map((x) => x.id));
    const g = makeGroup(this.doc.shapes.filter((x) => ids.has(x.id)));
    const at = this.doc.shapes.findIndex((x) => ids.has(x.id));
    this.doc.shapes = this.doc.shapes.filter((x) => !ids.has(x.id));
    this.doc.shapes.splice(Math.min(at, this.doc.shapes.length), 0, g);
    this.sel = [g.id];
    this.commit();
  }
  ungroup() {
    const out = [];
    for (const g of this.movable().filter((x) => x.type === 'group')) {
      const kids = g.children.map((c) => ({ ...c, m: mul(g.m, c.m) }));
      this.doc.shapes.splice(this.doc.shapes.indexOf(g), 1, ...kids);
      out.push(...kids.map((k) => k.id));
    }
    if (!out.length) return;
    this.sel = out;
    this.commit();
  }

  nudge(dx, dy) { if (this.movable().length) { this.transform(translate(dx, dy)); this.commit(); } }
  flip(axis) { const b = this.selBounds(); if (!b || !this.movable().length) return; this.transform(about(b.cx, b.cy, scaling(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1))); this.commit(); }
  rotate(deg) { const b = this.selBounds(); if (!b || !this.movable().length) return; this.transform(about(b.cx, b.cy, rotation((deg * Math.PI) / 180))); this.commit(); }
  toggleLock() { const s = this.selected(); if (!s.length) return; const lock = !s.every((x) => x.locked); for (const x of s) x.locked = lock; this.commit(); }
  order(dir) {
    const ids = new Set(this.sel), picked = this.doc.shapes.filter((s) => ids.has(s.id)), rest = this.doc.shapes.filter((s) => !ids.has(s.id));
    if (!picked.length) return;
    this.doc.shapes = dir > 0 ? [...rest, ...picked] : [...picked, ...rest];
    this.commit();
  }
  align(axis, f) {
    const shapes = this.movable();
    const ref = shapes.length > 1 ? this.selBounds() : { x0: 0, y0: 0, w: this.machine.bedW, h: this.machine.bedH };
    if (!shapes.length) return;
    for (const s of shapes) {
      const b = boundsOf([s]);
      if (!b) continue;
      if (axis === 'x') s.m = mul(translate(ref.x0 + ref.w * f - (b.x0 + b.w * f), 0), s.m);
      else s.m = mul(translate(0, ref.y0 + ref.h * f - (b.y0 + b.h * f)), s.m);
    }
    this.commit();
  }
  distribute(axis) {
    const items = this.movable().map((s) => ({ s, b: boundsOf([s]) })).filter((x) => x.b);
    if (items.length < 3) return toast('Select three or more objects to distribute');
    const c = axis === 'x' ? 'cx' : 'cy';
    items.sort((a, b) => a.b[c] - b.b[c]);
    const first = items[0].b[c], last = items[items.length - 1].b[c];
    items.forEach((it, i) => { const d = first + ((last - first) * i) / (items.length - 1) - it.b[c]; it.s.m = mul(axis === 'x' ? translate(d, 0) : translate(0, d), it.s.m); });
    this.commit();
  }
  moveToBed(dot) {
    const b = this.selBounds();
    if (!b || !this.movable().length) return;
    const fx = (dot % 3) / 2, fy = Math.floor(dot / 3) / 2;
    this.transform(translate(this.machine.bedW * fx - (b.x0 + b.w * fx), this.machine.bedH * fy - (b.y0 + b.h * fy)));
    this.commit();
  }
  convertToPath() {
    let n = 0;
    this.doc.shapes = this.doc.shapes.map((s) => { if (this.sel.includes(s.id) && !['path', 'image', 'group'].includes(s.type)) { n += 1; return toPath(s); } return s; });
    if (n) this.commit(); else toast('Select a rectangle, ellipse, polygon or text to convert');
  }
  closePaths() {
    let n = 0;
    for (const s of this.selected()) if (s.type === 'path') for (const sub of s.subs) if (!sub.closed && sub.nodes.length > 2) { sub.closed = true; n += 1; }
    if (n) this.commit(); else toast('No open paths are selected');
  }
  breakApart() {
    const out = [];
    for (const s of this.selected()) {
      if (s.type !== 'path' || s.subs.length < 2) continue;
      const parts = s.subs.map((sub) => ({ ...cloneShape(s), id: lid(), subs: [deep(sub)] }));
      this.doc.shapes.splice(this.doc.shapes.indexOf(s), 1, ...parts);
      out.push(...parts.map((p) => p.id));
    }
    if (out.length) { this.sel = out; this.commit(); } else toast('Select a path made of several pieces');
  }
  setLayer(li) {
    const s = this.selected();
    this.doc.currentLayer = li;
    this.selectedLayer = li;
    layerOf(this.doc, li);
    if (s.length) { walkShapes(s, (x) => { if (x.type !== 'group') x.layer = li; }); this.commit(); } else { this.app._markDirty(); this.refresh(); }
  }

  // ---------------------------------------------------------------- property bar
  _renderProps() {
    const bar = this.propBar;
    const active = document.activeElement;
    if (active && bar.contains(active) && active.tagName === 'INPUT' && active.type !== 'checkbox') return;
    clear(bar);
    const b = this.selBounds();
    const m = this.machine;
    const field = (label, value, onSet, width = 70, title = '') => {
      const input = h('input', { class: 'input', type: 'text', value, title, style: { width: width + 'px' } });
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
      input.addEventListener('change', () => { const v = parseFloat(input.value.replace(',', '.')); if (isFinite(v)) onSet(v); else this._renderProps(); });
      input.addEventListener('focus', () => input.select());
      return h('label', { class: 'lp-field' }, h('span', {}, label), input);
    };
    const dots = h('div', { class: 'nine-dot', title: 'Reference point for X and Y' });
    for (let i = 0; i < 9; i++) { const d = h('button', { type: 'button', class: i === this.anchor ? 'on' : '' }); d.addEventListener('click', () => { this.anchor = i; this._renderProps(); }); dots.append(d); }
    if (!b) {
      bar.append(h('span', { class: 'lp-hint' }, this.tool === 'line' ? 'Click to add points, drag for curves, double-click or Enter to finish, click the first point to close.'
        : this.tool === 'node' ? 'Click a path, then drag its nodes. Double-click a segment to add a node. S = smooth, C = corner, Del = delete node.'
          : 'Nothing selected. Draw with the tools on the left, or import a file.'));
      if (this.tool === 'polygon') bar.append(field('Sides', this.polySides || 6, (v) => { this.polySides = Math.max(3, Math.min(64, Math.round(v))); }, 50));
      return;
    }
    const fx = (this.anchor % 3) / 2, fy = Math.floor(this.anchor / 3) / 2;
    const [ax, ay] = toMachine(m, b.x0 + b.w * fx, b.y0 + b.h * fy);
    const moveTo = (nx, ny) => {
      const cx = m.origin.endsWith('r') ? m.bedW - nx : nx, cy = m.origin.startsWith('b') ? m.bedH - ny : ny;
      this.transform(translate(cx - (b.x0 + b.w * fx), cy - (b.y0 + b.h * fy))); this.commit();
    };
    const resize = (w, hgt) => {
      if ((!(w > 0) && b.w > 1e-9) || (!(hgt > 0) && b.h > 1e-9)) return this._renderProps();
      this.transform(about(b.x0 + b.w * fx, b.y0 + b.h * fy, scaling(b.w > 1e-9 ? w / b.w : 1, b.h > 1e-9 ? hgt / b.h : 1))); this.commit();
    };
    const lock = h('button', { class: 'btn' + (this.lockAspect ? ' active' : ''), type: 'button', title: 'Lock aspect ratio' }, icon(this.lockAspect ? 'lock' : 'unlock', 16));
    lock.addEventListener('click', () => { this.lockAspect = !this.lockAspect; this._renderProps(); });
    bar.append(dots,
      field('X', ax.toFixed(3).replace(/\.?0+$/, ''), (v) => moveTo(v, ay)), field('Y', ay.toFixed(3).replace(/\.?0+$/, ''), (v) => moveTo(ax, v)),
      field('W', b.w.toFixed(3).replace(/\.?0+$/, ''), (v) => resize(v, this.lockAspect && b.w > 1e-9 ? (b.h * v) / b.w : b.h)), lock,
      field('H', b.h.toFixed(3).replace(/\.?0+$/, ''), (v) => resize(this.lockAspect && b.h > 1e-9 ? (b.w * v) / b.h : b.w, v)),
      field('Rotate', '0', (v) => this.rotate(-v), 54, 'Rotate by this many degrees (counter-clockwise positive)'));
    const sel = this.selected();
    if (sel.length === 1) {
      const s = sel[0];
      bar.append(h('span', { class: 'sep' }), h('span', { class: 'lp-type' }, typeLabel(s) + (s.locked ? ' (locked)' : '')));
      if (s.type === 'rect') bar.append(field('Corner radius', s.r || 0, (v) => { s.r = Math.max(0, v); this.commit(); }, 56));
      if (s.type === 'polygon') bar.append(field('Sides', s.sides, (v) => { s.sides = Math.max(3, Math.min(64, Math.round(v))); this.commit(); }, 50));
      if (s.type === 'text') bar.append(button({ label: 'Edit text', icon: 'pencil', cls: 'btn-outline', onClick: () => tools.textDialog(this, s) }));
      if (s.type !== 'group') bar.append(field('Power scale %', s.powerScale ?? 100, (v) => { s.powerScale = Math.max(0, Math.min(100, v)); this.commit(); }, 50, 'Scales this shape\'s power relative to its layer'));
    } else bar.append(h('span', { class: 'sep' }), h('span', { class: 'lp-type' }, `${sel.length} objects`));
  }

  // ---------------------------------------------------------------- layers
  _buildPalette() {
    this.swatches = LAYER_COLORS.map((c, i) => {
      const b = h('button', { class: 'lp-swatch', type: 'button', title: isToolLayer(i) ? `${LAYER_NAMES[i]}: guide layer (never sent to the laser)` : `Layer ${LAYER_NAMES[i]}`, style: { background: c } }, LAYER_NAMES[i]);
      b.addEventListener('click', () => this.setLayer(i));
      this.palette.append(b);
      return b;
    });
  }
  _renderPaletteState() { this.swatches.forEach((b, i) => b.classList.toggle('on', i === this.doc.currentLayer)); }

  _renderLayers() {
    const list = this.layerList;
    clear(list);
    const order = usedLayers(this.doc);
    if (!order.includes(this.selectedLayer)) this.selectedLayer = order.includes(this.doc.currentLayer) ? this.doc.currentLayer : order[0] ?? this.doc.currentLayer;
    if (!order.length) list.append(h('div', { class: 'insp-note' }, 'Layers appear here once you draw something. Pick a colour below to choose the layer for new shapes.'));
    const spd = (L) => (this.machine.speedUnits === 'mm/min' ? `${Math.round(L.speed * 60)}` : `${+L.speed.toFixed(2)}`);
    order.forEach((li, pos) => {
      const L = layerOf(this.doc, li);
      const out = h('input', { type: 'checkbox', checked: L.output !== false && !isToolLayer(li), disabled: isToolLayer(li), title: isToolLayer(li) ? 'Guide layers are never sent to the laser' : 'Output: send this layer to the laser' });
      out.addEventListener('change', () => { L.output = out.checked; this.commit(); });
      const show = h('input', { type: 'checkbox', checked: L.show !== false, title: 'Show this layer' });
      show.addEventListener('change', () => { L.show = show.checked; this.commit(); });
      const mv = (dir) => { const o = [...order]; const j = pos + dir; if (j < 0 || j >= o.length) return; [o[pos], o[j]] = [o[j], o[pos]]; this.doc.layerOrder = o; this.commit(); };
      const up = h('button', { class: 'mini', type: 'button', title: 'Cut earlier' }, icon('arrowUp', 13)), dn = h('button', { class: 'mini', type: 'button', title: 'Cut later' }, icon('arrowDown', 13));
      up.addEventListener('click', (e) => { e.stopPropagation(); mv(-1); });
      dn.addEventListener('click', (e) => { e.stopPropagation(); mv(1); });
      const row = h('div', { class: 'll-row' + (li === this.selectedLayer ? ' on' : '') },
        h('span', { class: 'll-chip', style: { background: LAYER_COLORS[li] } }, LAYER_NAMES[li]),
        h('span', { class: 'll-mode' }, isToolLayer(li) ? 'Guide' : L.mode === 'line' ? 'Line' : L.mode === 'fill' ? 'Fill' : 'Offset fill'),
        h('span', { class: 'll-sp' }, `${spd(L)} / ${+L.powerMax.toFixed(1)}%`), up, dn, out, show);
      row.addEventListener('click', (e) => { if (e.target.tagName === 'INPUT') return; this.selectedLayer = li; this._renderLayers(); });
      row.addEventListener('dblclick', () => { const ids = []; for (const s of this.doc.shapes) { let has = false; walkShapes([s], (x) => { if (x.type !== 'group' && x.layer === li) has = true; }); if (has) ids.push(s.id); } this.select(ids); });
      list.append(row);
    });
    this._renderLayerEditor(order);
    this._updateJobInfo();
  }

  _renderLayerEditor(order) {
    const ed = this.layerEditor;
    clear(ed);
    const li = this.selectedLayer;
    if (!order.includes(li)) return;
    const L = layerOf(this.doc, li);
    const perMin = this.machine.speedUnits === 'mm/min';
    const num = (label, get, set, step = 1, min = 0, max = 1e6, suffix = '') => {
      const input = h('input', { class: 'input', type: 'number', step, min, max, value: get() });
      input.addEventListener('change', () => { const v = parseFloat(input.value); if (isFinite(v)) { set(Math.min(max, Math.max(min, v))); this.commit(); } });
      return h('label', { class: 'le-row' }, h('span', {}, label), input, suffix ? h('em', {}, suffix) : null);
    };
    const check = (label, key, obj = L) => { const cb = h('input', { type: 'checkbox', checked: !!obj[key] }); cb.addEventListener('change', () => { obj[key] = cb.checked; this.commit(); }); return h('label', { class: 'check' }, cb, label); };
    const mode = h('select', { class: 'select' }, h('option', { value: 'line' }, 'Line'), h('option', { value: 'fill' }, 'Fill'), h('option', { value: 'offset' }, 'Offset Fill'));
    mode.value = L.mode;
    mode.addEventListener('change', () => { L.mode = mode.value; this.commit(); });
    ed.append(h('div', { class: 'le-title' }, h('span', { class: 'll-chip', style: { background: LAYER_COLORS[li] } }, LAYER_NAMES[li]), `Layer ${LAYER_NAMES[li]} settings`));
    if (isToolLayer(li)) { ed.append(h('div', { class: 'insp-note' }, 'Guide layers are for layout help and are never sent to the laser.')); return; }
    ed.append(this._materialRow(L));
    ed.append(h('label', { class: 'le-row' }, h('span', {}, 'Mode'), mode),
      num('Speed', () => (perMin ? Math.round(L.speed * 60) : L.speed), (v) => { L.speed = Math.max(0.1, perMin ? v / 60 : v); }, perMin ? 10 : 1, 0.1, 1e6, perMin ? 'mm/min' : 'mm/s'),
      num('Max power', () => L.powerMax, (v) => { L.powerMax = v; }, 0.5, 0, 100, '%'),
      num('Min power', () => L.powerMin, (v) => { L.powerMin = v; }, 0.5, 0, 100, '%'),
      num('Passes', () => L.passes, (v) => { L.passes = Math.max(1, Math.round(v)); }, 1, 1, 100));
    let hasImage = false;
    walkShapes(this.doc.shapes, (s) => { if (s.type === 'image' && s.layer === li) hasImage = true; });
    if (L.mode !== 'line' || hasImage) {
      ed.append(num('Line interval', () => L.interval, (v) => { L.interval = v; }, 0.01, 0.02, 10, `mm (${Math.round(25.4 / L.interval)} DPI)`));
      ed.append(num('Overscan', () => L.overscan, (v) => { L.overscan = v; }, 0.5, 0, 50, '%'), check('Bi-directional scanning', 'bidirectional'));
    }
    if (L.mode === 'fill') ed.append(num('Scan angle', () => L.angle, (v) => { L.angle = v; }, 5, -360, 360, '°'), check('Cross-hatch', 'crosshatch'));
    if (L.mode === 'line') ed.append(num('Kerf offset', () => L.kerf, (v) => { L.kerf = v; }, 0.01, -5, 5, 'mm'),
      num('Tabs per shape', () => L.tabs, (v) => { L.tabs = Math.round(v); }, 1, 0, 50), num('Tab size', () => L.tabSize, (v) => { L.tabSize = v; }, 0.1, 0.05, 20, 'mm'));
    ed.append(check('Air assist', 'air'));
    if (hasImage) {
      const im = h('select', { class: 'select' }, tools.IMAGE_MODES.map(([v, n]) => h('option', { value: v }, n)));
      im.value = L.image.mode;
      im.addEventListener('change', () => { L.image.mode = im.value; this.commit(); });
      ed.append(h('div', { class: 'le-sub' }, 'Image'), h('label', { class: 'le-row' }, h('span', {}, 'Image mode'), im),
        num('Brightness', () => L.image.brightness, (v) => { L.image.brightness = v; }, 1, -100, 100), num('Contrast', () => L.image.contrast, (v) => { L.image.contrast = v; }, 1, -100, 100),
        num('Gamma', () => L.image.gamma, (v) => { L.image.gamma = v; }, 0.05, 0.1, 5), check('Negative image', 'negative', L.image));
    }
  }

  // Material library: your own saved speed / power settings, kept with the app's settings.
  _materialRow(L) {
    const KEYS = ['mode', 'speed', 'powerMax', 'powerMin', 'passes', 'interval', 'angle', 'crosshatch', 'kerf', 'air'];
    const list = () => (Array.isArray(this.app.settings.laserMaterials) ? this.app.settings.laserMaterials : []);
    const store = (next) => this.app.patchSettings({ laserMaterials: next });
    const sel = h('select', { class: 'select', title: 'Apply settings you saved for a material' }, h('option', { value: '' }, list().length ? 'Apply saved material…' : 'No saved materials yet'),
      ...list().map((mat, i) => h('option', { value: i }, mat.name)));
    sel.addEventListener('change', () => {
      const mat = list()[+sel.value];
      if (sel.value === '' || !mat) return;
      for (const k of KEYS) if (mat[k] !== undefined) L[k] = mat[k];
      this.commit();
      toast(`Applied "${mat.name}"`);
    });
    const save = button({ label: 'Save', cls: 'btn-outline', title: 'Save this layer\'s settings as a material', onClick: async () => {
      const name = await promptDialog('Save material', 'Name (for example: 3 mm birch ply, cut)', '');
      if (!name || !name.trim()) return;
      const mat = { name: name.trim() };
      for (const k of KEYS) mat[k] = L[k];
      store([...list().filter((x) => x.name !== mat.name), mat].sort((a, b) => a.name.localeCompare(b.name)));
      this.commit();
      toast(`Saved "${mat.name}" to your material library`);
    } });
    const del = button({ label: 'Remove', cls: 'btn-ghost', title: 'Remove a saved material', onClick: (e) => {
      if (!list().length) { toast('There are no saved materials'); return; }
      popupMenu(list().map((mat) => ({ label: 'Remove "' + mat.name + '"', onClick: () => { store(list().filter((x) => x.name !== mat.name)); this.commit(); } })), e.currentTarget);
    } });
    return h('div', { class: 'le-row le-material' }, h('span', {}, 'Material'), sel, save, del);
  }

  // ---------------------------------------------------------------- job / machine
  plan() { return planJob(this.doc, this.machine, this.getImage, { selectionOnly: this.cutSelected && this.sel.length ? new Set(this.sel) : null }); }

  _updateJobInfo() {
    clearTimeout(this._jobTimer);
    this._jobTimer = setTimeout(() => {
      try {
        const p = this.plan();
        this._jobBounds = p.bounds;
        if (this.doc.startFrom !== 'absolute') this.redraw();
        this.jobInfo.textContent = p.bounds ? `Job: ${p.bounds.w.toFixed(1)} × ${p.bounds.h.toFixed(1)} mm · about ${formatTime(p.stats.time)}` : 'Job: nothing to output';
      } catch (err) { this.jobInfo.textContent = 'Job: ' + (err.message || err); }
    }, 250);
  }

  _buildLaserPanel() {
    const p = this.laserPanel;
    this.connBtn = button({ label: 'Connect', icon: 'plug', cls: 'btn-outline', onClick: () => this.toggleConnection() });
    this.stateEl = h('div', { class: 'laser-state' }, 'Disconnected');
    this.posEl = h('div', { class: 'laser-pos' }, '');
    this.progress = h('div', { class: 'laser-progress' }, h('i'));
    this.jobInfo = h('div', { class: 'insp-note' }, '');
    const startFrom = h('select', { class: 'select' }, h('option', { value: 'absolute' }, 'Machine coordinates'), h('option', { value: 'current' }, 'Where the head is now'), h('option', { value: 'user' }, 'Saved origin'));
    startFrom.addEventListener('change', () => { this.doc.startFrom = startFrom.value; this.app._markDirty(); this.refresh(); });
    this.startFromSel = startFrom;
    this.jobDots = h('div', { class: 'nine-dot', title: 'Job origin: which point of the job sits at the start position' });
    for (let i = 0; i < 9; i++) { const d = h('button', { type: 'button' }); d.addEventListener('click', () => { this.doc.jobOrigin = i; this.app._markDirty(); this.refresh(); }); this.jobDots.append(d); }
    const cutSel = h('input', { type: 'checkbox' });
    cutSel.addEventListener('change', () => { this.cutSelected = cutSel.checked; this._updateJobInfo(); });
    p.append(
      h('div', { class: 'lz-row' }, this.connBtn, h('div', { style: { flex: 1 } }, this.stateEl, this.posEl)),
      h('div', { class: 'lz-row' },
        button({ label: 'Start', icon: 'play', cls: 'btn-primary', title: 'Send the job to the laser', onClick: () => this.start() }),
        button({ label: 'Pause', icon: 'pause', cls: 'btn-outline', title: 'Pause / resume', onClick: () => this.pauseResume() }),
        button({ label: 'Stop', icon: 'stop', cls: 'btn-danger', title: 'Stop the job and turn the laser off', onClick: () => this.stop() })),
      this.progress,
      h('div', { class: 'lz-row' },
        button({ label: 'Frame', icon: 'frame', cls: 'btn-outline', title: 'Trace the rectangular bounds of the job with the laser off', onClick: () => this.frame(false) }),
        button({ label: 'Tight frame', cls: 'btn-outline', title: 'Trace a tight (rubber-band) outline of the job', onClick: () => this.frame(true) }),
        button({ label: 'Home', icon: 'home', cls: 'btn-outline', title: 'Home the machine ($H)', onClick: () => this.cmd('$H') })),
      h('div', { class: 'lz-row' },
        button({ label: 'Go to origin', cls: 'btn-outline', onClick: () => this.cmd('G90 G0 X0 Y0') }),
        button({ label: 'Unlock', cls: 'btn-outline', title: 'Clear an alarm ($X)', onClick: () => this.cmd('$X') }),
        button({ label: 'Set origin', cls: 'btn-outline', title: 'Remember the current head position as the User Origin', onClick: () => this.setUserOrigin() })),
      h('div', { class: 'lz-row lz-start' }, h('label', { class: 'le-row', style: { flex: 1 } }, h('span', {}, 'Start from'), startFrom), h('div', {}, h('small', {}, 'Job origin'), this.jobDots)),
      h('label', { class: 'check' }, cutSel, 'Cut selected graphics only'),
      this.jobInfo,
      h('div', { class: 'lz-row' },
        button({ label: 'Save G-code', icon: 'export', cls: 'btn-outline', onClick: () => this.saveGcode() }),
        button({ label: 'Run G-code file', cls: 'btn-outline', onClick: () => this.runGcodeFile() })));
  }

  _buildMovePanel() {
    const p = this.movePanel;
    this.jogDist = h('input', { class: 'input', type: 'number', value: 10, min: 0.1, step: 1 });
    this.jogSpeed = h('input', { class: 'input', type: 'number', value: 3000, min: 10, step: 100 });
    this.firePower = h('input', { class: 'input', type: 'number', value: 1, min: 0.1, max: 20, step: 0.5 });
    const jog = (dx, dy) => () => {
      const d = parseFloat(this.jogDist.value) || 1, f = parseFloat(this.jogSpeed.value) || 1000;
      const sx = this.machine.origin.endsWith('r') ? -1 : 1, sy = this.machine.origin.startsWith('b') ? 1 : -1;
      this.jogBy(dx * d * sx, dy * d * sy, f);
    };
    const pad = h('div', { class: 'jog-pad' },
      h('span'), button({ icon: 'arrowUp', title: 'Jog away from you', onClick: jog(0, 1) }), h('span'),
      button({ icon: 'arrowLeft', title: 'Jog left', onClick: jog(-1, 0) }), button({ icon: 'home', title: 'Home', onClick: () => this.cmd('$H') }), button({ icon: 'arrowRight', title: 'Jog right', onClick: jog(1, 0) }),
      h('span'), button({ icon: 'arrowDown', title: 'Jog toward you', onClick: jog(0, -1) }), h('span'));
    const fire = button({ label: 'Fire (hold)', icon: 'laser', cls: 'btn-outline', title: 'Hold to fire the laser at low power for positioning' });
    const on = () => { if (!this.device.connected) return this.log('Not connected', 'error'); if (this.device.job) return this.log('A job is running', 'error'); const s = sValue(this.machine, Math.min(20, parseFloat(this.firePower.value) || 1) / 100); this.device.send(`M3 S${s}`, false); this.device.send('G1 F1000', false); fire.classList.add('active'); };
    const off = () => { if (fire.classList.contains('active')) { fire.classList.remove('active'); if (this.device.connected) this.device.send('M5', false); } };
    fire.addEventListener('pointerdown', on);
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) fire.addEventListener(ev, off);
    window.addEventListener('blur', off);
    const gx = h('input', { class: 'input', type: 'number', value: 0, step: 1 }), gy = h('input', { class: 'input', type: 'number', value: 0, step: 1 });
    p.append(h('div', { class: 'lz-row' }, pad, h('div', { style: { flex: 1 } },
      h('label', { class: 'le-row' }, h('span', {}, 'Distance'), this.jogDist, h('em', {}, 'mm')),
      h('label', { class: 'le-row' }, h('span', {}, 'Speed'), this.jogSpeed, h('em', {}, 'mm/min')))),
    h('div', { class: 'lz-row' }, h('label', { class: 'le-row', style: { flex: 1 } }, h('span', {}, 'Move to X'), gx), h('label', { class: 'le-row', style: { flex: 1 } }, h('span', {}, 'Y'), gy),
      button({ label: 'Go', cls: 'btn-outline', onClick: () => this.cmd(`G90 G0 X${parseFloat(gx.value) || 0} Y${parseFloat(gy.value) || 0}`) })),
    h('div', { class: 'lz-row' }, fire, h('label', { class: 'le-row', style: { flex: 1 } }, h('span', {}, 'Power'), this.firePower, h('em', {}, '%'))));
  }

  _bindDevice() {
    const d = this.device;
    d.on('line', (l) => this.log(l.text, l.kind));
    d.on('connection', (on) => {
      clear(this.connBtn).append(icon('plug'), h('span', { class: 'btn-label' }, on ? 'Disconnect' : 'Connect'));
      this.connBtn.classList.toggle('active', on);
      this.log(on ? 'Connected' : 'Disconnected', 'info');
    });
    d.on('status', (st) => {
      this.stateEl.textContent = st.state;
      const pos = st.wpos || st.mpos;
      this.posEl.textContent = pos ? `X ${pos[0].toFixed(2)}   Y ${pos[1].toFixed(2)}` : '';
      this.redraw();
    });
    platform.onSerialPorts((ports) => {
      if (!ports.length) { toast('No serial ports were found. Check the USB cable and that the laser is powered on.', 'warn', 5000); platform.chooseSerialPort(''); return; }
      let chosen = false;
      const close = popupMenu(ports.map((p) => ({ label: `${p.label}${p.name && p.name !== p.label ? ' (' + p.name + ')' : ''}`, icon: 'plug', onClick: () => { chosen = true; platform.chooseSerialPort(p.id); } })), this.connBtn);
      const watch = setInterval(() => { if (!document.querySelector('.menu')) { clearInterval(watch); if (!chosen) platform.chooseSerialPort(''); } }, 200);
      void close;
    });
  }

  log(text, kind = 'in') {
    const row = h('div', { class: 'lc-' + kind }, (kind === 'out' ? '> ' : '') + text);
    this.consoleLog.append(row);
    while (this.consoleLog.children.length > 400) this.consoleLog.firstChild.remove();
    this.consoleLog.scrollTop = this.consoleLog.scrollHeight;
  }

  async toggleConnection() {
    if (this.device.connected) return this.device.disconnect();
    if (!this.device.supported) return toast('Serial ports are not available here', 'error');
    try { await this.device.connect(this.machine.baud || 115200); }
    catch (err) { if (!/No port selected|cancel/i.test(String(err.message || err))) toast('Could not connect: ' + (err.message || err), 'error', 5000); }
  }

  _needDevice(duringJob = false) {
    if (!this.device.connected) { toast('Connect to your laser first (Laser panel → Connect)', 'warn'); return false; }
    if (this.device.job && !duringJob) { toast('A job is running. Pause or stop it first.', 'warn'); return false; }
    return true;
  }
  cmd(line) { if (this._needDevice()) this.device.send(line).catch((err) => this.log(err.message, 'error')); }
  jogBy(dx, dy, feed) { if (this._needDevice()) this.device.jog(+dx.toFixed(3), +dy.toFixed(3), feed).catch(() => {}); }
  jogTo(bedPt) { if (!this._needDevice()) return; const [x, y] = toMachine(this.machine, bedPt[0], bedPt[1]); this.cmd(`G90 G0 X${x.toFixed(3)} Y${y.toFixed(3)}`); }
  setUserOrigin() {
    const st = this.device.status, pos = st && (st.wpos || st.mpos);
    if (!this.device.connected || !pos) return toast('Connect first so the head position is known', 'warn');
    this.doc.userOrigin = [pos[0], pos[1]];
    this.app._markDirty();
    toast(`User origin set to X ${pos[0].toFixed(2)}, Y ${pos[1].toFixed(2)}`);
  }

  async start() {
    if (!this._needDevice()) return;
    const plan = this.plan();
    if (!plan.bounds) return toast('There is nothing to output. Check that layers have Output switched on.', 'warn');
    if (this.doc.startFrom === 'user' && !this.doc.userOrigin) return toast('Set a User Origin first (Laser panel → Set origin)', 'warn');
    if (plan.warnings.length && !(await tools.confirmStart(plan.warnings))) return;
    if (!this._needDevice()) return;
    const gcode = toGcode(plan, this.doc, this.machine);
    this.log(`Starting job: ${plan.stats.count} moves, about ${formatTime(plan.stats.time)}`, 'info');
    const bar = this.progress.firstChild;
    const res = await this.device.run(gcode, (job) => { bar.style.width = `${(job.sent / job.total) * 100}%`; });
    bar.style.width = res.done ? '100%' : bar.style.width;
    this.log(res.done ? `Job finished${res.errors ? ` with ${res.errors} controller errors` : ''}` : `Job stopped: ${res.reason}`, res.done && !res.errors ? 'info' : 'error');
    setTimeout(() => { bar.style.width = '0%'; }, 2500);
  }

  pauseResume() {
    if (!this._needDevice(true)) return;
    if (/^Hold/i.test(this.device.status.state)) this.device.resume(); else this.device.pause();
  }
  stop() { if (this.device.connected) { this.device.stop(); this.log('Stop sent', 'error'); } }

  async frame(rubber) {
    if (!this._needDevice()) return;
    const plan = this.plan();
    if (!plan.bounds) return toast('There is nothing to frame', 'warn');
    for (const line of frameGcode(plan, this.doc, this.machine, rubber).split('\n').filter(Boolean)) this.device.send(line, false);
  }

  async saveGcode() {
    const plan = this.plan();
    if (!plan.bounds) return toast('There is nothing to output. Check that layers have Output switched on.', 'warn');
    for (const w of plan.warnings) toast(w, 'warn', 5000);
    const path = await platform.saveDialog({ title: 'Save G-code', defaultName: `${this.app._fileBase()}.gcode`, filters: [{ name: 'G-code', extensions: ['gcode', 'nc', 'gc'] }], data: toGcode(plan, this.doc, this.machine) });
    if (path) toast('Saved G-code to ' + path);
  }

  async runGcodeFile() {
    if (!this._needDevice()) return;
    const files = await platform.openDialog({ title: 'Run G-code', filters: [{ name: 'G-code', extensions: ['gcode', 'nc', 'gc', 'txt'] }] });
    if (!files.length || !this._needDevice()) return;
    const bar = this.progress.firstChild;
    this.log('Running ' + files[0].name, 'info');
    const res = await this.device.run(new TextDecoder().decode(files[0].data), (job) => { bar.style.width = `${(job.sent / job.total) * 100}%`; });
    this.log(res.done ? 'File finished' : 'File stopped: ' + res.reason, res.done ? 'info' : 'error');
    bar.style.width = '0%';
  }

  async importDialog() {
    const files = await platform.openDialog({ title: 'Import', multi: true, filters: [{ name: 'Vector and image files', extensions: ['svg', 'dxf', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }] });
    if (files.length) tools.importFiles(this, files);
  }

  /** Files dropped on the window while the laser workspace is open. */
  importData(files) { return tools.importFiles(this, files); }

  _renderStatus() {
    const n = this.doc.shapes.length;
    if (this.startFromSel) this.startFromSel.value = this.doc.startFrom || 'absolute';
    if (this.jobDots) [...this.jobDots.children].forEach((d, i) => { d.classList.toggle('on', i === (this.doc.jobOrigin ?? 6)); });
    if (this.jobDots) this.jobDots.parentElement.style.opacity = this.doc.startFrom === 'absolute' ? 0.35 : 1;
    this.statusBar.textContent = `${n} object${n === 1 ? '' : 's'} · ${this.machine.name} · ${this.machine.bedW} × ${this.machine.bedH} mm · snap ${this.machine.gridSnap || 'off'}`;
  }

  _contextMenu(e) {
    const raw = this.toBed(e), s = this.hit(raw);
    if (s && !this.sel.includes(s.id)) this.select([s.id]);
    const n = this.sel.length;
    popupMenu([
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: !n, onClick: () => this.copy() }, { label: 'Cut', shortcut: 'Ctrl+X', disabled: !n, onClick: () => this.cut() },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !this.clipboard, onClick: () => this.paste() }, { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !n, onClick: () => this.duplicate() },
      { label: 'Delete', shortcut: 'Del', disabled: !n, onClick: () => this.remove() }, 'sep',
      { label: 'Group', shortcut: 'Ctrl+G', disabled: n < 2, onClick: () => this.group() }, { label: 'Ungroup', shortcut: 'Ctrl+U', disabled: !this.selected().some((x) => x.type === 'group'), onClick: () => this.ungroup() },
      { label: 'Convert to path', disabled: !n, onClick: () => this.convertToPath() }, { label: 'Edit nodes', disabled: n !== 1, onClick: () => this.setTool('node') }, 'sep',
      { label: 'Lock / unlock', disabled: !n, onClick: () => this.toggleLock() },
      { label: 'Move laser here', onClick: () => this.jogTo(raw) },
      { label: 'Zoom to work area', onClick: () => this.zoomToBed() }, { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => this.selectAll() },
    ], { x: e.clientX, y: e.clientY });
  }

  // ---------------------------------------------------------------- keyboard
  _key(e) {
    if (!this.active) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (document.querySelector('.modal-backdrop') || this.app.dashboard.isOpen) return;
    if (this.drag && this.drag.kind !== 'pan' && this.drag.kind !== 'create' && this.drag.kind !== 'marquee' && this.drag.kind !== 'measure') { e.preventDefault(); return; }
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === ' ') { done(); this.spaceDown = true; return; }
    if (k === 'Escape') { done(); if (this.pen) this._finishPen(false); else if (this.tool !== 'select') this.setTool('select'); else this.select([]); return; }
    if (k === 'Enter' && this.pen) { done(); this._finishPen(false); return; }
    if (k === 'Delete' || k === 'Backspace') { done(); this.remove(); return; }
    if (k.startsWith('Arrow')) {
      done();
      const step = ctrl ? 0.1 : shift ? 5 : this.machine.gridSnap || 1;
      this.nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0);
      return;
    }
    if (k === 'PageUp') { done(); this.order(1); return; }
    if (k === 'PageDown') { done(); this.order(-1); return; }
    if (ctrl) {
      const map = {
        z: () => (shift ? this.redo() : this.undo()), y: () => this.redo(), c: () => this.copy(), x: () => this.cut(), v: () => this.paste(), d: () => this.duplicate(),
        a: () => this.selectAll(), g: () => (shift ? this.ungroup() : this.group()), u: () => this.ungroup(), l: () => this.setTool('line'), r: () => this.setTool('rect'),
        e: () => this.setTool('ellipse'), t: () => this.setTool('text'), i: () => this.importDialog(), w: () => tools.boolean(this, 'union'),
        h: () => { if (shift) this.flip('x'); }, s: () => { this.app.saveNow(); },
      };
      if (k === 'v' && shift) { done(); this.flip('y'); return; }
      if (map[k]) { done(); map[k](); }
      return;
    }
    if (e.altKey) {
      const map = { p: () => tools.previewDialog(this), o: () => tools.offsetDialog(this), m: () => this.setTool('measure') };
      if (map[k]) { done(); map[k](); }
      return;
    }
    const map = {
      '`': () => this.setTool('node'), '.': () => this.rotate(90), ',': () => this.rotate(-90), p: () => this.moveToBed(4),
      s: () => { if (this.tool === 'node') this.nodeAction('smooth'); }, c: () => { if (this.tool === 'node') this.nodeAction('corner'); },
      f: () => { const b = this.selBounds() || boundsOf(this.doc.shapes); if (b) this.zoomTo(b); else this.zoomToBed(); }, Home: () => this.zoomToBed(),
      '+': () => { this.view.scale *= 1.25; this.redraw(); }, '=': () => { this.view.scale *= 1.25; this.redraw(); }, '-': () => { this.view.scale /= 1.25; this.redraw(); },
    };
    if (map[k]) { done(); map[k](); }
  }
}
