// On-canvas resize / rotate handles and dimension labels for the model selected on the build plate.
// Same look and gestures as the 3D Design gizmo (it reuses its .gz-* styles): drag a corner or edge to
// resize (Shift: uniform, Alt: from the centre), the arrow on top for height, the round handles to rotate
// (Shift: 45° steps, near the centre: 22.5°), click a dimension to type it. Models always rest on the
// plate, so there is no lift handle.
import * as THREE from 'three';
import { h, icon } from '../ui/dom.js';
import { protractor, formatLength, parseLength } from '../view/gizmo.js';

const RING_PX = 118;
const MIN_SIZE = 0.5;
const AXES = ['x', 'y', 'z'];

export class ModelGizmo {
  /** @param scene SlicerScene  @param opts { getModel(), active(), onChange(model, final) } */
  constructor(scene, { getModel, active, onChange }) {
    this.scene = scene;
    this.getModel = getModel;
    this.active = active;
    this.onChange = onChange;
    this.layer = h('div', { class: 'gizmo-layer' });
    scene.container.appendChild(this.layer);
    this.protractor = protractor();
    scene.scene.add(this.protractor);
    this.items = [];
    this._build();
    scene.onRender(() => this.layout());
  }

  // ---------------------------------------------------------------- camera helpers
  get _size() { return { w: this.scene.container.clientWidth, h: this.scene.container.clientHeight }; }
  _project(v, out = {}) {
    const p = v.clone().project(this.scene.camera), s = this._size;
    out.x = (p.x * 0.5 + 0.5) * s.w; out.y = (-p.y * 0.5 + 0.5) * s.h; out.behind = p.z > 1 || p.z < -1;
    return out;
  }
  _viewDir() { return new THREE.Vector3().setFromMatrixColumn(this.scene.camera.matrixWorld, 2).negate(); }
  _unitsPerPixel(point) {
    const cam = this.scene.camera, s = this._size;
    if (this.scene.isOrtho) return (cam.top - cam.bottom) / cam.zoom / s.h;
    const dist = Math.max(0.001, point.clone().sub(cam.position).dot(this._viewDir()));
    return (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / s.h;
  }
  _ray(ev) { this.scene.ray.setFromCamera(this.scene._ndc(ev), this.scene.camera); return this.scene.ray.ray; }

  // ---------------------------------------------------------------- construction
  _handle(cls, title, child) {
    const el = h('div', { class: 'gz-handle ' + cls, title });
    if (child) el.append(child);
    el.style.display = 'none';
    this.layer.append(el);
    return el;
  }
  _add(el, pos, opts = {}) { const it = { el, pos, group: 'edit', ...opts }; this.items.push(it); return it; }

  _build() {
    for (const i of [0, 1]) for (const j of [0, 1]) {
      const el = this._handle('gz-corner', 'Drag to resize (Shift: uniform, Alt: from centre)');
      this._add(el, (b) => [i ? b.maxX : b.minX, j ? b.maxY : b.minY, 0]);
      el.addEventListener('pointerdown', (e) => this._scaleDrag(e, { x: i, y: j }));
    }
    for (const i of [0, 1]) {
      const ex = this._handle('gz-edge', 'Drag to resize');
      this._add(ex, (b) => [i ? b.maxX : b.minX, (b.minY + b.maxY) / 2, 0]);
      ex.addEventListener('pointerdown', (e) => this._scaleDrag(e, { x: i }));
      const ey = this._handle('gz-edge', 'Drag to resize');
      this._add(ey, (b) => [(b.minX + b.maxX) / 2, i ? b.maxY : b.minY, 0]);
      ey.addEventListener('pointerdown', (e) => this._scaleDrag(e, { y: i }));
    }
    const top = this._handle('gz-corner gz-top', 'Drag to change height');
    this._add(top, (b) => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.height]);
    top.addEventListener('pointerdown', (e) => this._scaleDrag(e, { z: 1 }));
    const rot = (axis, pos, title) => {
      const el = this._handle('gz-rot gz-rot-' + axis, title, icon('rotate', 22));
      this._add(el, pos);
      el.addEventListener('pointerdown', (e) => this._rotateDrag(e, axis));
      el.addEventListener('pointerenter', () => { if (!this.dragKind) this._showProtractor(axis); });
      el.addEventListener('pointerleave', () => { if (!this.dragKind) { this.protractor.visible = false; this.scene.requestRender(); } });
    };
    rot('z', (b, c, o) => [b.maxX + o, b.minY - o, 0], 'Rotate around Z (Shift: 45° steps)');
    rot('x', (b, c, o) => [c.x, b.maxY + o * 1.5, b.height], 'Rotate around X (Shift: 45° steps)');
    rot('y', (b, c, o) => [b.minX - o * 1.5, c.y, b.height], 'Rotate around Y (Shift: 45° steps)');

    this.labels = {};
    const label = (key, pos, opts) => {
      const el = h('div', { class: 'gz-label gz-label-' + key });
      el.style.display = 'none';
      this.layer.append(el);
      this.labels[key] = this._add(el, pos, { group: 'dims', ...opts });
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', () => this._editLabel(key));
    };
    label('x', (b, c, o) => [c.x, b.minY - o * 0.75, 0]);
    label('y', (b, c, o) => [b.maxX + o * 0.75, c.y, 0]);
    label('z', (b, c) => [b.minX, b.minY, c.z], { dx: -30 });
    this.angleLabel = h('div', { class: 'gz-label gz-angle' });
    this.angleLabel.style.display = 'none';
    this.layer.append(this.angleLabel);
  }

  // ---------------------------------------------------------------- layout (every rendered frame)
  _model() {
    const m = this.active() ? this.getModel() : null;
    return m && !m.hidden ? m : null;
  }

  layout() {
    const m = this._model();
    if (!m) { for (const it of this.items) it.el.style.display = 'none'; return; }
    const bb = m.bounds, b = { ...bb };
    const c = new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.height / 2);
    const o = this._unitsPerPixel(c) * 30;
    const show = { edit: !m.locked, dims: true };
    if (this.dragKind === 'rotate') show.dims = false;
    const p = {}, v = new THREE.Vector3();
    for (const it of this.items) {
      if (!show[it.group]) { it.el.style.display = 'none'; continue; }
      const arr = it.pos(b, c, o);
      this._project(v.set(arr[0], arr[1], arr[2]), p);
      if (p.behind) { it.el.style.display = 'none'; continue; }
      it.el.style.display = '';
      it.el.style.transform = `translate(${Math.round(p.x + (it.dx || 0))}px, ${Math.round(p.y + (it.dy || 0))}px) translate(-50%, -50%)`;
    }
    if (!this.editingLabel) {
      const s = m.size;
      this.labels.x.el.textContent = formatLength(s.x, 'mm');
      this.labels.y.el.textContent = formatLength(s.y, 'mm');
      this.labels.z.el.textContent = formatLength(s.z, 'mm');
    }
  }

  // ---------------------------------------------------------------- model edits
  _snapshot(m) { return { x: m.x, y: m.y, sx: m.sx, sy: m.sy, sz: m.sz, rx: m.rx, ry: m.ry, rz: m.rz }; }
  /** The model's own scale axis that mostly runs along a world axis (exact for 90° turns). */
  _localAxis(m, w) {
    const e = m._rotation().elements, wi = AXES.indexOf(w);
    let best = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(e[i * 4 + wi]) > Math.abs(e[best * 4 + wi])) best = i;
    return ['sx', 'sy', 'sz'][best];
  }
  /** Resize to `ratios` ({x,y,z}) of the starting size, keeping `anchor` ({x,y} centres) in place. */
  _applyScale(m, snap, ratios, anchor) {
    Object.assign(m, snap);
    for (const w of AXES) {
      const r = ratios[w];
      if (r == null || Math.abs(r - 1) < 1e-9) continue;
      const k = this._localAxis(m, w);
      m[k] = Math.max(1, Math.min(100000, m[k] * r));
    }
    const s = m.size;
    m.x = anchor.x(s.x); m.y = anchor.y(s.y);
  }

  _commit(m, final) { this.onChange(m, final); this.scene.requestRender(); }

  // ---------------------------------------------------------------- drags
  _drag(e, kind, onMove, onEnd) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.dragKind = kind;
    let moved = false;
    const move = (ev) => { moved = true; onMove(ev); };
    const up = () => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this.dragKind = null;
      this.protractor.visible = false;
      this.angleLabel.style.display = 'none';
      if (onEnd) onEnd(moved);
      this.scene.requestRender();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** A vertical plane through `point` that faces the camera, for dragging along Z. */
  _verticalHit(ev, point) {
    const view = this._viewDir();
    const n = new THREE.Vector3(view.x, view.y, 0);
    if (n.lengthSq() < 1e-4) { const up = new THREE.Vector3().setFromMatrixColumn(this.scene.camera.matrixWorld, 1); n.set(up.x, up.y, 0); }
    n.normalize();
    return this._ray(ev).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, point), new THREE.Vector3());
  }

  _scaleDrag(e, which) {
    const m = this._model();
    if (!m || m.locked) return;
    const snap = this._snapshot(m), b0 = m.bounds, s0 = m.size.clone();
    const c0 = { x: (b0.minX + b0.maxX) / 2, y: (b0.minY + b0.maxY) / 2 };
    const ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this._drag(e, 'scale', (ev) => {
      const alt = ev.altKey;
      const r = {};
      if (which.z != null) {
        const p = this._verticalHit(ev, new THREE.Vector3(c0.x, c0.y, s0.z));
        if (!p) return;
        const hNew = Math.max(MIN_SIZE, alt ? 2 * Math.abs(p.z) : p.z);
        r.z = hNew / s0.z;
      } else {
        const p = this._ray(ev).intersectPlane(ground, new THREE.Vector3());
        if (!p) return;
        if (which.x != null) {
          const w = Math.max(MIN_SIZE, alt ? 2 * Math.abs(p.x - c0.x) : (which.x ? p.x - b0.minX : b0.maxX - p.x));
          r.x = w / s0.x;
        }
        if (which.y != null) {
          const l = Math.max(MIN_SIZE, alt ? 2 * Math.abs(p.y - c0.y) : (which.y ? p.y - b0.minY : b0.maxY - p.y));
          r.y = l / s0.y;
        }
      }
      if (ev.shiftKey) {
        const cands = Object.values(r).filter((v) => v != null && v !== 1);
        const u = cands.length ? cands.reduce((a, v) => (Math.abs(v - 1) > Math.abs(a - 1) ? v : a)) : 1;
        r.x = r.y = r.z = u;
      }
      const grow = (axis, k, lo, hi) => (s) => (alt || which[axis] == null ? c0[axis] : k ? lo + s / 2 : hi - s / 2);
      this._applyScale(m, snap, r, {
        x: grow('x', which.x, b0.minX, b0.maxX),
        y: grow('y', which.y, b0.minY, b0.maxY),
      });
      this._commit(m, false);
    }, () => this._commit(m, true));
  }

  _showProtractor(axis) {
    const m = this._model();
    if (!m || m.locked) return;
    const b = m.bounds;
    const c = new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, m.zFloat ?? b.height / 2);
    const basis = axis === 'x' ? new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0))
      : axis === 'y' ? new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0))
        : new THREE.Matrix4();
    const sc = this._unitsPerPixel(c) * RING_PX;
    this.protractor.matrix.copy(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)).multiply(basis).multiply(new THREE.Matrix4().makeScale(sc, sc, sc));
    this.protractor.updateMatrixWorld(true);
    this.protractor.visible = true;
    this.scene.requestRender();
  }

  _rotateDrag(e, axis) {
    const m = this._model();
    if (!m || m.locked) return;
    const snap = this._snapshot(m);
    const b = m.bounds;
    const c = new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.height / 2);
    const axisV = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const facing = -axisV.dot(this._viewDir());
    const usePlane = Math.abs(facing) > 0.18;
    const cs = this._project(c, {});
    const rect = this.scene.dom.getBoundingClientRect();
    const angleAt = (ev) => {
      if (usePlane) {
        const p = this._ray(ev).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(axisV, c), new THREE.Vector3());
        if (p) {
          const d = p.sub(c);
          return axis === 'x' ? Math.atan2(d.z, d.y) : axis === 'y' ? Math.atan2(d.x, d.z) : Math.atan2(d.y, d.x);
        }
      }
      const a = Math.atan2(-(ev.clientY - rect.top - cs.y), ev.clientX - rect.left - cs.x);
      return facing >= 0 ? a : -a;
    };
    this._showProtractor(axis);
    const R0 = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(snap.rx), THREE.MathUtils.degToRad(snap.ry), THREE.MathUtils.degToRad(snap.rz), 'XYZ'));
    const zc = c.z;          // while turning, the model keeps its height instead of dropping onto the plate
    let prev = angleAt(e), total = 0;
    this._drag(e, 'rotate', (ev) => {
      const a = angleAt(ev);
      let step = a - prev;
      if (step > Math.PI) step -= Math.PI * 2; else if (step < -Math.PI) step += Math.PI * 2;
      total += step; prev = a;
      const dist = Math.hypot(ev.clientX - rect.left - cs.x, ev.clientY - rect.top - cs.y);
      const inc = ev.shiftKey ? 45 : dist < RING_PX * 0.6 ? 22.5 : 1;
      const deg = Math.round(((total * 180) / Math.PI) / inc) * inc;
      const Rd = new THREE.Matrix4().makeRotationAxis(axisV, (deg * Math.PI) / 180);
      const eul = new THREE.Euler().setFromRotationMatrix(Rd.multiply(R0), 'XYZ');
      const rnd = (v) => Math.round(THREE.MathUtils.radToDeg(v) * 100) / 100 || 0;
      m.rx = rnd(eul.x); m.ry = rnd(eul.y); m.rz = rnd(eul.z);
      m.zFloat = zc;
      this.angleLabel.style.display = '';
      this.angleLabel.textContent = (Math.round(deg * 10) / 10) + '°';
      this.angleLabel.style.transform = `translate(${ev.clientX - rect.left + 18}px, ${ev.clientY - rect.top - 18}px)`;
      this._commit(m, false);
    }, () => { m.zFloat = null; this._commit(m, true); });   // let go: settle onto the plate
  }

  // ---------------------------------------------------------------- typed dimensions
  _editLabel(key) {
    const m = this._model();
    if (this.editingLabel || !m || m.locked) return;
    const it = this.labels[key], current = m.size[key];
    const input = h('input', { class: 'gz-input', type: 'text', value: formatLength(current, 'mm') });
    const initial = input.value;
    this.editingLabel = key;
    it.el.textContent = '';
    it.el.append(input);
    it.el.classList.add('editing');
    input.focus(); input.select();
    let finished = false;
    const finish = (apply, next) => {
      if (finished) return;
      finished = true;
      this.editingLabel = null;
      it.el.classList.remove('editing');
      const v = parseLength(input.value, 'mm');
      const edited = input.value.trim() !== initial.trim();
      input.remove();
      if (apply && edited && isFinite(v) && v > 0 && Math.abs(v - current) > 1e-9) {
        const snap = this._snapshot(m), b0 = m.bounds;
        const c0 = { x: (b0.minX + b0.maxX) / 2, y: (b0.minY + b0.maxY) / 2 };
        this._applyScale(m, snap, { [key]: Math.max(MIN_SIZE, v) / current }, { x: () => c0.x, y: () => c0.y });
        this._commit(m, true);
      }
      this.layout();
      if (next) setTimeout(() => this._editLabel(next), 0);
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
      else if (ev.key === 'Tab') { ev.preventDefault(); finish(true, AXES[(AXES.indexOf(key) + 1) % 3]); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  dispose() { this.layer.remove(); this.scene.scene.remove(this.protractor); }
}
