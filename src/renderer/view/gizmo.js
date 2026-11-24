// On-canvas manipulators: resize / lift / rotate handles, dimension labels,
// align + mirror controls, the ruler and sticky notes. Drawn as DOM over the canvas.
import * as THREE from 'three';
import { h, icon } from '../ui/dom.js';
import { about } from '../editor.js';

const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const S = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z);
const MIN_SIZE = 0.01;
const RING_PX = 118;

export function formatLength(mm, units) {
  if (units === 'in') return (mm / 25.4).toFixed(3).replace(/\.?0+$/, '');
  if (units === 'brick') return (mm / 8).toFixed(2).replace(/\.?0+$/, '');
  return mm.toFixed(2).replace(/\.?0+$/, '');
}
export function parseLength(text, units) {
  const v = parseFloat(String(text).replace(',', '.'));
  if (!isFinite(v)) return NaN;
  return units === 'in' ? v * 25.4 : units === 'brick' ? v * 8 : v;
}

export function protractor() {
  const pts = [];
  const seg = (a, r0, r1) => pts.push(Math.cos(a) * r0, Math.sin(a) * r0, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0);
  for (let i = 0; i < 360; i++) {
    const a = (i * Math.PI) / 180, b = ((i + 1) * Math.PI) / 180;
    pts.push(Math.cos(a), Math.sin(a), 0, Math.cos(b), Math.sin(b), 0);
    pts.push(Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0, Math.cos(b) * 0.6, Math.sin(b) * 0.6, 0);
    if (i % 5 === 0) seg(a, i % 45 === 0 ? 0.84 : i % 15 === 0 ? 0.9 : 0.94, 1);
  }
  for (let i = 0; i < 16; i++) seg((i * Math.PI) / 8, i % 2 === 0 ? 0.44 : 0.5, 0.6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x29c5ff, depthTest: false, transparent: true, opacity: 0.95 }));
  line.renderOrder = 10;
  line.matrixAutoUpdate = false;
  line.visible = false;
  line.raycast = () => {};
  return line;
}

export class Gizmo {
  constructor(editor, viewport) {
    this.editor = editor;
    this.viewport = viewport;
    this.box = null;
    this.dragging = false;
    this.hoverLift = false;
    this.showNotes = true;
    this.layer = h('div', { class: 'gizmo-layer' });
    viewport.container.appendChild(this.layer);

    this.protractor = protractor();
    viewport.helpers.add(this.protractor);
    this.rulerLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x29c5ff, depthTest: false, transparent: true }));
    this.rulerLines.renderOrder = 9;
    this.rulerLines.matrixAutoUpdate = false;
    this.rulerLines.visible = false;
    this.rulerLines.raycast = () => {};
    viewport.helpers.add(this.rulerLines);

    // Split tool: the see-through cutting plane and its outline
    this.splitMesh = new THREE.Group();
    const planeMat = new THREE.MeshBasicMaterial({ color: 0x29c5ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const planeFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x29c5ff, transparent: true, opacity: 0.9 }));
    const cross = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0, -0.5, 0, 0, 0.5, 0], 3));
    const crossLines = new THREE.LineSegments(cross, new THREE.LineBasicMaterial({ color: 0x29c5ff, transparent: true, opacity: 0.35 }));
    for (const o of [planeFill, edge, crossLines]) { o.raycast = () => {}; o.renderOrder = 8; }
    this.splitMesh.add(planeFill, edge, crossLines);
    this.splitMesh.matrixAutoUpdate = false;
    this.splitMesh.visible = false;
    viewport.helpers.add(this.splitMesh);

    this._build();
    editor.on('split', () => this.refresh());
    editor.on('selection', () => this.refresh());
    editor.on('transform', () => this.refresh());
    editor.on('doc', () => { this.refresh(); this._renderNotes(); });
    editor.on('tool', () => this.refresh());
    viewport.onRender(() => this.layout());
  }

  // ---------------------------------------------------------------- construction
  _handle(cls, title, child) {
    const el = h('div', { class: 'gz-handle ' + cls, title });
    if (child) el.append(child);
    el.style.display = 'none';
    this.layer.append(el);
    return el;
  }

  _build() {
    this.items = [];
    const add = (el, pos, opts = {}) => { const it = { el, pos, group: 'edit', ...opts }; this.items.push(it); return it; };
    // corner + edge resize handles (bottom of the bounding box)
    for (const i of [0, 1]) for (const j of [0, 1]) {
      const el = this._handle('gz-corner', 'Drag to resize (Shift: uniform, Alt: from centre)');
      add(el, (b) => [i ? b.max.x : b.min.x, j ? b.max.y : b.min.y, b.min.z]);
      el.addEventListener('pointerdown', (e) => this._scaleDrag(e, { x: i, y: j }));
    }
    for (const i of [0, 1]) {
      const ex = this._handle('gz-edge', 'Drag to resize');
      add(ex, (b, c) => [i ? b.max.x : b.min.x, c.y, b.min.z]);
      ex.addEventListener('pointerdown', (e) => this._scaleDrag(e, { x: i }));
      const ey = this._handle('gz-edge', 'Drag to resize');
      add(ey, (b, c) => [c.x, i ? b.max.y : b.min.y, b.min.z]);
      ey.addEventListener('pointerdown', (e) => this._scaleDrag(e, { y: i }));
    }
    const top = this._handle('gz-corner gz-top', 'Drag to change height');
    add(top, (b, c) => [c.x, c.y, b.max.z]);
    top.addEventListener('pointerdown', (e) => this._scaleDrag(e, { z: 1 }));
    const lift = this._handle('gz-lift', 'Drag to raise or lower');
    add(lift, (b, c) => [c.x, c.y, b.max.z], { dy: -30, noArrows: true });
    lift.addEventListener('pointerdown', (e) => this._liftDrag(e));
    lift.addEventListener('pointerenter', () => { this.hoverLift = true; this.layout(); });
    lift.addEventListener('pointerleave', () => { this.hoverLift = false; this.layout(); });
    // rotation handles
    const rot = (axis, pos, title) => {
      const el = this._handle('gz-rot gz-rot-' + axis, title, icon('rotate', 22));
      add(el, pos);
      el.addEventListener('pointerdown', (e) => this._rotateDrag(e, axis));
      el.addEventListener('pointerenter', () => { if (!this.dragging) this._showProtractor(axis); });
      el.addEventListener('pointerleave', () => { if (!this.dragging) { this.protractor.visible = false; this.viewport.requestRender(); } });
    };
    rot('z', (b, c, o) => [b.max.x + o, b.min.y - o, b.min.z], 'Rotate around Z (Shift: 45° steps)');
    rot('x', (b, c, o) => [c.x, b.max.y + o * 1.5, b.max.z], 'Rotate around X (Shift: 45° steps)');
    rot('y', (b, c, o) => [b.min.x - o * 1.5, c.y, b.max.z], 'Rotate around Y (Shift: 45° steps)');

    // dimension labels
    this.labels = {};
    const label = (key, pos, opts) => {
      const el = h('div', { class: 'gz-label gz-label-' + key });
      el.style.display = 'none';
      this.layer.append(el);
      const it = add(el, pos, { ...opts, label: key });
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', () => this._editLabel(key));
      this.labels[key] = it;
    };
    label('x', (b, c, o) => [c.x, b.min.y - o * 0.75, b.min.z], { group: 'dims' });
    label('y', (b, c, o) => [b.max.x + o * 0.75, c.y, b.min.z], { group: 'dims' });
    label('z', (b, c) => [b.min.x, b.min.y, c.z], { group: 'dims', dx: -30 });
    label('e', (b, c) => [c.x, c.y, b.max.z], { group: 'elev', dx: 44, dy: -30 });
    label('rx', (b, c) => [b.min.x, b.min.y, b.min.z], { group: 'ruler', dx: -4, dy: 22 });
    label('ry', (b, c) => [b.min.x, b.min.y, b.min.z], { group: 'ruler', dx: -44, dy: 2 });
    this.angleLabel = h('div', { class: 'gz-label gz-angle' });
    this.angleLabel.style.display = 'none';
    this.layer.append(this.angleLabel);

    // align dots
    const modes = ['min', 'center', 'max'];
    const along = (b, c, axis, k) => (k === 0 ? b.min[axis] : k === 1 ? c[axis] : b.max[axis]);
    for (const axis of ['x', 'y', 'z']) modes.forEach((mode, k) => {
      const el = this._handle('gz-align', `Align ${mode === 'min' ? 'minimum' : mode === 'max' ? 'maximum' : 'centre'} (${axis.toUpperCase()})`);
      add(el, (b, c, o) => (axis === 'x' ? [along(b, c, 'x', k), b.min.y - o * 1.7, b.min.z]
        : axis === 'y' ? [b.min.x - o * 1.7, along(b, c, 'y', k), b.min.z]
          : [b.max.x + o * 0.9, b.max.y + o * 0.9, along(b, c, 'z', k)]), { group: 'align' });
      let restore = null;
      el.addEventListener('pointerenter', () => { if (!restore) { restore = this.editor.align(axis, mode, true); this._boxOnly(); } });
      el.addEventListener('pointerleave', () => { if (restore) { restore(); restore = null; this._boxOnly(); } });
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (restore) { restore(); restore = null; }
        this.editor.align(axis, mode);
      });
    });
    // mirror arrows
    for (const axis of ['x', 'y', 'z']) {
      const el = this._handle('gz-mirror gz-mirror-' + axis, `Mirror along ${axis.toUpperCase()}`, icon('flip', 22));
      add(el, (b, c, o) => (axis === 'x' ? [c.x, b.min.y - o * 1.5, b.min.z]
        : axis === 'y' ? [b.min.x - o * 1.5, c.y, b.min.z] : [b.max.x + o * 0.9, b.max.y + o * 0.9, c.z]), { group: 'mirror' });
      el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.editor.mirror(axis); });
    }
    // split: an arrow to slide the plane along its normal, rings to turn it, the offset as a label
    const splitAt = (k) => (b, c, o) => { const s = this._splitScreen; return s ? s[k] : [c.x, c.y, c.z]; };
    const slide = this.splitSlide = this._handle('gz-split-slide', 'Drag to move the cutting plane', icon('arrowUp', 20));
    add(slide, splitAt('arrow'), { group: 'split' });
    slide.addEventListener('pointerdown', (e) => this._splitSlideDrag(e));
    for (const axis of ['x', 'y', 'z']) {
      const el = this._handle('gz-rot gz-rot-' + axis, `Turn the cutting plane around ${axis.toUpperCase()} (Shift: 45° steps)`, icon('rotate', 22));
      add(el, splitAt('rot' + axis), { group: 'split' });
      el.addEventListener('pointerdown', (e) => this._splitRotateDrag(e, axis));
    }
    this.splitLabel = h('div', { class: 'gz-label gz-split-label', title: 'Click to type the plane position' });
    this.splitLabel.style.display = 'none';
    this.layer.append(this.splitLabel);
    add(this.splitLabel, splitAt('label'), { group: 'split', dx: 34 });
    this.splitLabel.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.splitLabel.addEventListener('click', () => this._editSplitOffset());

    // ruler dismiss + notes host
    this.rulerClose = h('button', { class: 'gz-ruler-close', title: 'Remove ruler', type: 'button' }, '×');
    this.rulerClose.style.display = 'none';
    this.rulerClose.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.editor.ruler = null; this.refresh(); });
    this.notesHost = h('div', { class: 'gz-notes' });
    this.layer.append(this.rulerClose, this.notesHost);
  }

  // ---------------------------------------------------------------- state
  _boxOnly() {
    const nodes = this.editor.edgeMode || this.editor.parts.active ? [] : this.editor.selectedNodes(); // no handles while picking parts
    const b = nodes.length ? this.editor.bounds(nodes) : null;
    this.box = b && !b.isEmpty() ? b : null;
    this.viewport.requestRender();
  }

  refresh() {
    this._boxOnly();
    this._updateRuler();
    this.layout();
  }

  _updateRuler() {
    const r = this.editor.ruler;
    this.rulerLines.visible = !!r;
    if (!r) return;
    const pts = [];
    const wp = this.editor.doc.workplane;
    const lenX = Math.max(60, this.editor.hasFrame ? 120 : wp.width / 2 - r.x), lenY = Math.max(60, this.editor.hasFrame ? 120 : wp.length / 2 - r.y);
    pts.push(0, 0, 0, lenX, 0, 0, 0, 0, 0, 0, lenY, 0);
    for (let i = 1; i * 10 <= lenX; i++) pts.push(i * 10, 0, 0, i * 10, i % 5 === 0 ? -4 : -2, 0);
    for (let i = 1; i * 10 <= lenY; i++) pts.push(0, i * 10, 0, i % 5 === 0 ? -4 : -2, i * 10, 0);
    this.rulerLines.geometry.dispose();
    this.rulerLines.geometry = new THREE.BufferGeometry();
    this.rulerLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.rulerLines.matrix.copy(this.editor.frame).multiply(T(r.x, r.y, 0.05));
    this.rulerLines.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- layout (every rendered frame)
  layout() {
    const ed = this.editor, vp = this.viewport;
    const b = this.box;
    const tool = ed.tool;
    const locked = ed.selection.size > 0 && ed.movableNodes().length === 0;
    const show = {
      edit: !!b && !locked && (tool === 'select' || tool === 'place') && !ed.placing,
      dims: !!b && ed.settings.showDims !== false && tool !== 'align' && tool !== 'mirror' && tool !== 'split' && !ed.placing,
      elev: !!b && !locked && tool === 'select' && (this.hoverLift || this.dragKind === 'lift' || Math.abs(b.min.z) > 1e-6),
      align: !!b && !locked && tool === 'align',
      mirror: !!b && !locked && tool === 'mirror',
      split: !!b && !!ed.split && tool === 'split',
      ruler: !!b && !!ed.ruler,
    };
    if (this.dragKind === 'rotate') { show.dims = false; show.elev = false; }
    const p = {};
    this._layoutSplit(show.split);
    if (b) {
      const c = b.getCenter(new THREE.Vector3());
      const o = vp.unitsPerPixel(c.clone().applyMatrix4(ed.frame)) * 30;
      const v = new THREE.Vector3();
      for (const it of this.items) {
        if (!show[it.group] || (it.noArrows && ed.settings.moveArrows)) { it.el.style.display = 'none'; continue; }   // the Z arrow takes over from the lift cone
        const arr = it.pos(b, c, o);
        v.set(arr[0], arr[1], arr[2]).applyMatrix4(ed.frame);
        vp.project(v, p);
        if (p.behind) { it.el.style.display = 'none'; continue; }
        it.el.style.display = '';
        it.el.style.transform = `translate(${Math.round(p.x + (it.dx || 0))}px, ${Math.round(p.y + (it.dy || 0))}px) translate(-50%, -50%)`;
      }
      if (!this.editingLabel) {
        const u = ed.units;
        if (ed.split) this.splitLabel.textContent = '↕ ' + formatLength(ed.split.offset, u);
        this.labels.x.el.textContent = formatLength(b.max.x - b.min.x, u);
        this.labels.y.el.textContent = formatLength(b.max.y - b.min.y, u);
        this.labels.z.el.textContent = formatLength(b.max.z - b.min.z, u);
        this.labels.e.el.textContent = '↕ ' + formatLength(b.min.z, u);
        if (ed.ruler) {
          this.labels.rx.el.textContent = 'X ' + formatLength(b.min.x - ed.ruler.x, u);
          this.labels.ry.el.textContent = 'Y ' + formatLength(b.min.y - ed.ruler.y, u);
        }
      }
    } else {
      for (const it of this.items) it.el.style.display = 'none';
    }
    // ruler origin button
    if (ed.ruler) {
      vp.project(new THREE.Vector3(ed.ruler.x, ed.ruler.y, 0).applyMatrix4(ed.frame), p);
      this.rulerClose.style.display = p.behind ? 'none' : '';
      this.rulerClose.style.transform = `translate(${Math.round(p.x - 16)}px, ${Math.round(p.y + 16)}px) translate(-50%, -50%)`;
    } else {
      this.rulerClose.style.display = 'none';
    }
    // notes
    const v2 = new THREE.Vector3();
    for (const el of this.notesHost.children) {
      const n = el._note;
      vp.project(v2.set(n.pos[0], n.pos[1], n.pos[2]), p);
      el.style.display = p.behind || !this.showNotes ? 'none' : '';
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    }
  }

  // ---------------------------------------------------------------- drags
  _drag(e, kind, onMove, onEnd, { alwaysCommit = false } = {}) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.dragKind = kind;
    this.dragging = true;
    this.editor.emit('drag', true);
    let moved = false;
    const move = (ev) => { moved = true; onMove(ev); };
    const up = (ev) => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this.dragKind = null;
      this.dragging = false;
      this.protractor.visible = false;
      this.angleLabel.style.display = 'none';
      this.editor.emit('drag', false);
      if (onEnd) onEnd(ev);
      if (moved || alwaysCommit) { this.editor.sync(); this.editor.commit(); this.editor.emit('selection'); }
      else this.refresh();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** A vertical plane through `point` that faces the camera, for dragging along Z. */
  _verticalHit(ev, point) {
    const ed = this.editor;
    const ray = ed.localRay(ev);
    const view = this.viewport.viewDirection().transformDirection(ed.frameInv);
    const n = new THREE.Vector3(view.x, view.y, 0);
    if (n.lengthSq() < 1e-4) {
      const up = new THREE.Vector3().setFromMatrixColumn(this.viewport.camera.matrixWorld, 1).transformDirection(ed.frameInv);
      n.set(up.x, up.y, 0);
    }
    n.normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
    return ray.intersectPlane(plane, new THREE.Vector3());
  }

  _scaleDrag(e, which) {
    const ed = this.editor;
    const nodes = ed.movableNodes();
    if (!nodes.length || !this.box) return;
    const start = ed.startMatrices(nodes);
    const b0 = this.box.clone();
    const c0 = b0.getCenter(new THREE.Vector3());
    const size0 = b0.getSize(new THREE.Vector3());
    const snapSize = (v) => Math.max(ed.snap > 0 ? ed.snap : MIN_SIZE, ed.snapValue(v));
    this._drag(e, 'scale', (ev) => {
      const alt = ev.altKey;
      let sx = 1, sy = 1, sz = 1;
      if (which.z != null) {
        const p = this._verticalHit(ev, new THREE.Vector3(c0.x, c0.y, b0.max.z));
        if (!p) return;
        const hNew = alt ? 2 * snapSize(Math.abs(p.z - c0.z)) : snapSize(p.z - b0.min.z);
        if (size0.z > 1e-9) sz = hNew / size0.z;
      } else {
        const p = ed.planePoint(ev, b0.min.z);
        if (!p) return;
        if (which.x != null && size0.x > 1e-9) {
          const anchor = which.x ? b0.min.x : b0.max.x, sign = which.x ? 1 : -1;
          const w = alt ? 2 * snapSize(Math.abs(p.x - c0.x)) : snapSize((p.x - anchor) * sign);
          sx = w / size0.x;
        }
        if (which.y != null && size0.y > 1e-9) {
          const anchor = which.y ? b0.min.y : b0.max.y, sign = which.y ? 1 : -1;
          const l = alt ? 2 * snapSize(Math.abs(p.y - c0.y)) : snapSize((p.y - anchor) * sign);
          sy = l / size0.y;
        }
      }
      if (ev.shiftKey) {
        const cands = [sx, sy, sz].filter((s) => s !== 1);
        const s = cands.length ? cands.reduce((a, v) => (Math.abs(v - 1) > Math.abs(a - 1) ? v : a)) : 1;
        sx = sy = sz = s;
      }
      const pivot = new THREE.Vector3(
        alt ? c0.x : which.x === 1 ? b0.min.x : which.x === 0 ? b0.max.x : c0.x,
        alt ? c0.y : which.y === 1 ? b0.min.y : which.y === 0 ? b0.max.y : c0.y,
        alt && which.z != null ? c0.z : b0.min.z);
      if (which.x == null && !alt) pivot.x = ev.shiftKey ? c0.x : pivot.x;
      if (which.y == null && !alt) pivot.y = ev.shiftKey ? c0.y : pivot.y;
      ed.applyLocal(nodes, start, about(pivot, S(sx, sy, sz)));
    });
  }

  _liftDrag(e) {
    const ed = this.editor;
    const nodes = ed.movableNodes();
    if (!nodes.length || !this.box) return;
    const start = ed.startMatrices(nodes);
    const b0 = this.box.clone();
    const c0 = b0.getCenter(new THREE.Vector3());
    const anchor = new THREE.Vector3(c0.x, c0.y, b0.max.z);
    const p0 = this._verticalHit(e, anchor);
    this._drag(e, 'lift', (ev) => {
      const p = this._verticalHit(ev, anchor);
      if (!p || !p0) return;
      const dz = ed.snapValue(b0.min.z + (p.z - p0.z)) - b0.min.z;
      ed.applyLocal(nodes, start, T(0, 0, dz));
    });
  }

  /** Place the protractor ring around the selection for a rotation axis (also shown on hover). */
  _showProtractor(axis) {
    const ed = this.editor, vp = this.viewport;
    if (!this.box) return;
    const c = this.box.getCenter(new THREE.Vector3());
    const cWorld = c.clone().applyMatrix4(ed.frame);
    const basis = axis === 'x' ? new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))
      : axis === 'y' ? new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0))
        : new THREE.Matrix4();
    const scale = vp.unitsPerPixel(cWorld) * RING_PX;
    this.protractor.matrix.copy(ed.frame).multiply(T(c.x, c.y, c.z)).multiply(basis).multiply(S(scale, scale, scale));
    this.protractor.updateMatrixWorld(true);
    this.protractor.visible = true;
    vp.requestRender();
  }

  _rotateDrag(e, axis) {
    const ed = this.editor, vp = this.viewport;
    const dup = e.altKey && ed._duplicateInPlace().length > 0;
    const nodes = ed.movableNodes();
    if (!nodes.length) return;
    this._boxOnly();
    if (!this.box) return;
    const start = ed.startMatrices(nodes);
    const c = this.box.getCenter(new THREE.Vector3());
    const cWorld = c.clone().applyMatrix4(ed.frame);
    const axisLocal = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const axisWorld = axisLocal.clone().transformDirection(ed.frame);
    const facing = -axisWorld.dot(vp.viewDirection());
    const usePlane = Math.abs(facing) > 0.18;
    const cs = vp.project(cWorld, {});
    const rect = vp.canvas.getBoundingClientRect();
    const angleAt = (ev) => {
      if (usePlane) {
        const ray = ed.localRay(ev);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axisLocal, c);
        const p = ray.intersectPlane(plane, new THREE.Vector3());
        if (p) {
          const d = p.sub(c);
          return axis === 'x' ? Math.atan2(d.z, d.y) : axis === 'y' ? Math.atan2(d.x, d.z) : Math.atan2(d.y, d.x);
        }
      }
      const a = Math.atan2(-(ev.clientY - rect.top - cs.y), ev.clientX - rect.left - cs.x);
      return facing >= 0 ? a : -a;
    };
    const a0 = angleAt(e);
    this._showProtractor(axis);
    let prev = a0, total = 0;
    this._drag(e, 'rotate', (ev) => {
      const a = angleAt(ev);
      let step = a - prev;
      if (step > Math.PI) step -= Math.PI * 2; else if (step < -Math.PI) step += Math.PI * 2;
      total += step;
      prev = a;
      const dist = Math.hypot(ev.clientX - rect.left - cs.x, ev.clientY - rect.top - cs.y);
      const inc = ev.shiftKey ? 45 : dist < RING_PX * 0.6 ? 22.5 : 1;
      const deg = Math.round(((total * 180) / Math.PI) / inc) * inc;
      const rad = (deg * Math.PI) / 180;
      const r = axis === 'x' ? new THREE.Matrix4().makeRotationX(rad) : axis === 'y' ? new THREE.Matrix4().makeRotationY(rad) : new THREE.Matrix4().makeRotationZ(rad);
      ed.applyLocal(nodes, start, about(c, r));
      this.angleLabel.style.display = '';
      this.angleLabel.textContent = (Math.round(deg * 10) / 10) + '°';
      this.angleLabel.style.transform = `translate(${ev.clientX - rect.left + 18}px, ${ev.clientY - rect.top - 18}px)`;
    }, null, { alwaysCommit: dup });
  }

  // ---------------------------------------------------------------- split plane
  /** Size and place the cutting plane, and work out where its handles go (frame coordinates). */
  _layoutSplit(on) {
    const ed = this.editor, vp = this.viewport;
    const pl = on ? ed.splitPlane() : null;
    this.splitMesh.visible = !!pl;
    this._splitScreen = null;
    if (!pl) return;
    const size = Math.max(30, ed.split.size * 1.25);
    this.splitMesh.matrix.copy(ed.frame).multiply(pl.matrix).multiply(S(size, size, 1));
    this.splitMesh.updateMatrixWorld(true);
    const o = vp.unitsPerPixel(pl.point.clone().applyMatrix4(ed.frame)) * 30;
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(ed.split.q), ay = new THREE.Vector3(0, 1, 0).applyQuaternion(ed.split.q);
    const at = (v) => [v.x, v.y, v.z];
    const P = pl.point, half = size / 2;
    this._splitScreen = {
      arrow: at(P.clone().addScaledVector(pl.normal, o * 1.6)),
      label: at(P.clone().addScaledVector(pl.normal, o * 1.6)),
      // the rings sit near the middle of the plane (its far corners can be off screen)
      rotx: at(P.clone().addScaledVector(ax, Math.min(half, o * 3.4))),
      roty: at(P.clone().addScaledVector(ay, -Math.min(half, o * 3.4))),
      rotz: at(P.clone().addScaledVector(ax, -Math.min(half, o * 3.4))),
    };
    // point the slide arrow along the plane's normal as seen on screen
    const a = {}, b2 = {};
    vp.project(P.clone().applyMatrix4(ed.frame), a);
    vp.project(P.clone().addScaledVector(pl.normal, o).applyMatrix4(ed.frame), b2);
    const deg = (Math.atan2(b2.x - a.x, -(b2.y - a.y)) * 180) / Math.PI;
    const svg = this.splitSlide.firstChild;
    if (svg) svg.style.transform = `rotate(${Math.round(deg)}deg)`;
  }

  _splitSlideDrag(e) {
    const ed = this.editor;
    const pl = ed.splitPlane();
    if (!pl) return;
    const n = pl.normal.clone(), P = pl.point.clone(), off0 = ed.split.offset;
    // the point on the normal line closest to the pointer ray
    const along = (ev) => {
      const ray = ed.localRay(ev);
      const w0 = P.clone().sub(ray.origin), b = n.dot(ray.direction), d = n.dot(w0), e2 = ray.direction.dot(w0);
      const den = 1 - b * b;
      return den < 1e-6 ? null : (b * e2 - d) / den;
    };
    const t0 = along(e);
    if (t0 == null) return;
    this._splitDrag(e, 'split', (ev) => {
      const t = along(ev);
      if (t == null) return;
      ed.setSplit({ offset: ed.snapValue(off0 + t - t0) });
    });
  }

  _splitRotateDrag(e, axis) {
    const ed = this.editor, vp = this.viewport;
    const pl = ed.splitPlane();
    if (!pl) return;
    const c = pl.point.clone(), cWorld = c.clone().applyMatrix4(ed.frame);
    const q0 = ed.split.q.clone(), off0 = ed.split.offset, c0 = ed.split.c.clone();
    const axisLocal = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const cs = vp.project(cWorld, {});
    const rect = vp.canvas.getBoundingClientRect();
    const facing = -axisLocal.clone().transformDirection(ed.frame).dot(vp.viewDirection());
    const angleAt = (ev) => {
      const a = Math.atan2(-(ev.clientY - rect.top - cs.y), ev.clientX - rect.left - cs.x);
      return facing >= 0 ? a : -a;
    };
    let prev = angleAt(e), total = 0;
    this._splitDrag(e, 'rotate', (ev) => {
      const a = angleAt(ev);
      let step = a - prev;
      if (step > Math.PI) step -= Math.PI * 2; else if (step < -Math.PI) step += Math.PI * 2;
      total += step; prev = a;
      const dist = Math.hypot(ev.clientX - rect.left - cs.x, ev.clientY - rect.top - cs.y);
      const inc = ev.shiftKey ? 45 : dist < RING_PX * 0.6 ? 22.5 : 1;
      const deg = Math.round(((total * 180) / Math.PI) / inc) * inc;
      const q = new THREE.Quaternion().setFromAxisAngle(axisLocal, (deg * Math.PI) / 180).multiply(q0);
      // turn about the plane's own point, so the plane keeps passing through it
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      ed.setSplit({ q, offset: c.clone().sub(c0).dot(n) });
      void off0;
      this.angleLabel.style.display = '';
      this.angleLabel.textContent = (Math.round(deg * 10) / 10) + '°';
      this.angleLabel.style.transform = `translate(${ev.clientX - rect.left + 18}px, ${ev.clientY - rect.top - 18}px)`;
    });
  }

  /** Drags of the split handles change only the plane, not the document (no history). */
  _splitDrag(e, kind, onMove) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.dragKind = kind; this.dragging = true;
    const up = () => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this.dragKind = null; this.dragging = false;
      this.angleLabel.style.display = 'none';
      this.refresh();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  _editSplitOffset() {
    const ed = this.editor;
    if (!ed.split || this.editingLabel) return;
    const el = this.splitLabel;
    const input = h('input', { class: 'gz-input', type: 'text', value: formatLength(ed.split.offset, ed.units) });
    this.editingLabel = 'split';
    el.textContent = ''; el.append(input); el.classList.add('editing');
    input.focus(); input.select();
    let done = false;
    const finish = (apply) => {
      if (done) return; done = true;
      this.editingLabel = null; el.classList.remove('editing');
      const v = parseLength(input.value, ed.units);
      input.remove();
      if (apply && isFinite(v)) ed.setSplit({ offset: v });
      this.refresh();
    };
    input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  }

  // ---------------------------------------------------------------- typed dimensions
  _editLabel(key) {
    const ed = this.editor;
    if (this.editingLabel || !this.box || !ed.movableNodes().length) return;
    const it = this.labels[key];
    const b = this.box;
    const current = key === 'x' ? b.max.x - b.min.x : key === 'y' ? b.max.y - b.min.y : key === 'z' ? b.max.z - b.min.z
      : key === 'e' ? b.min.z : key === 'rx' ? b.min.x - ed.ruler.x : b.min.y - ed.ruler.y;
    const input = h('input', { class: 'gz-input', type: 'text', value: formatLength(current, ed.units) });
    const initial = input.value;
    const selKey = [...ed.selection].join(',');
    this.editingLabel = key;
    it.el.textContent = '';
    it.el.append(input);
    it.el.classList.add('editing');
    input.focus();
    input.select();
    let finished = false;
    const finish = (apply, next) => {
      if (finished) return;
      finished = true;
      this.editingLabel = null;
      it.el.classList.remove('editing');
      const v = parseLength(input.value, ed.units);
      input.remove();
      // untouched text (the rounded prefill) or a selection that changed meanwhile is not an edit
      const edited = input.value.trim() !== initial.trim() && [...ed.selection].join(',') === selKey;
      if (apply && edited && isFinite(v) && Math.abs(v - current) > 1e-9) {
        if (key === 'x' || key === 'y' || key === 'z') { if (v > 0) ed.setSize(key, v); }
        else if (key === 'e') ed.setPosition('z', v);
        else if (key === 'rx') ed.setPosition('x', ed.ruler.x + v);
        else if (key === 'ry') ed.setPosition('y', ed.ruler.y + v);
      }
      this.refresh();
      if (next) setTimeout(() => this._editLabel(next), 0);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      else if (e.key === 'Tab') { e.preventDefault(); const order = ['x', 'y', 'z']; finish(true, order[(order.indexOf(key) + 1) % 3]); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ---------------------------------------------------------------- notes
  _renderNotes() {
    const host = this.notesHost;
    while (host.firstChild) host.removeChild(host.firstChild);
    for (const n of this.editor.doc.notes) {
      const el = h('div', { class: 'gz-note', title: 'Click to edit' }, h('span', { class: 'gz-note-pin' }), h('span', { class: 'gz-note-text' }, n.text || 'Note'));
      el._note = n;
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', () => this.editor.emit('note-edit', n));
      host.append(el);
    }
    this.viewport.requestRender();
  }
}
