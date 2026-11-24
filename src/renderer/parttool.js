// Face, Edge and Corner modes: pick parts of one shape and move them.
//
// Face mode picks flat faces, Corner mode picks corners, and Edge mode (the Edges tool, see
// editor.js) picks edges. Whatever is picked can be moved with arrows: a face along its own
// direction, edges and corners along X, Y and Z. Moves are stored on the node as shape edits
// (core/shapeedit.js), so they stay editable and the shape keeps its own settings.
import * as THREE from 'three';
import { nodeShapeEdits, nodeEdgeData, edgeRoundIndex } from './core/geometry.js';
import { movedVertex } from './core/shapeedit.js';
import { formatLength, parseLength } from './view/gizmo.js';
import { h, toast } from './ui/dom.js';

const ACCENT = 0x3d8bfd;
const AXES = [
  { name: 'x', dir: new THREE.Vector3(1, 0, 0), color: 0xe5484d },
  { name: 'y', dir: new THREE.Vector3(0, 1, 0), color: 0x46a758 },
  { name: 'z', dir: new THREE.Vector3(0, 0, 1), color: 0x3e7bfa },
];
const ARROW_PX = 40; // how far an arrow sits from the part it moves, on screen

// drag with pointer capture on the handle, like the object handles
function track(el, e, onMove, onEnd) {
  try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  let ended = false;
  const up = (ev) => {
    if (ended) return;
    ended = true;
    try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('lostpointercapture', up);
    window.removeEventListener('pointerup', up, true);
    onEnd(ev);
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  // never left stuck to the pointer: the handle may be hidden or redrawn mid-drag
  el.addEventListener('lostpointercapture', up);
  window.addEventListener('pointerup', up, true);
}
const pkey = (p) => Math.round(p.x * 1e3) + ',' + Math.round(p.y * 1e3) + ',' + Math.round(p.z * 1e3);
const r4 = (v) => Math.round(v * 1e4) / 1e4;

function faceMaterial(opacity) {
  return new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide });
}

export class PartTool {
  constructor(editor) {
    this.ed = editor;
    this.vp = editor.viewport;
    this.mode = null; // 'face' | 'corner' while active (edges use the editor's edge mode)
    this.id = null; // the node whose parts are picked
    this.picked = new Set();
    this.hover = null; // { id, i }
    this.hoverId = null;
    this.arrows = null; // { group, origin, axes: [{ dir, color }] }
    this.drag = null;
    this._buildHandles();
    this.vp.onRender(() => this._layout());
    // object mode arrows follow the selection
    for (const ev of ['selection', 'transform', 'tool', 'doc']) editor.on(ev, () => { if (!this.mode && !editor.edgeMode && !this.drag) this._placeArrows(); });
  }

  get active() { return !!this.mode; }

  // ---------------------------------------------------------------- lifecycle
  start(mode) {
    const ed = this.ed;
    const sel = ed.movableNodes();
    this.mode = mode;
    this.id = sel.length === 1 && !sel[0].hidden ? sel[0].id : null;
    this.picked = new Set();
    this.hover = null; this.hoverId = null;
    ed.refreshOutlines();
    this.refresh();
  }

  end() {
    if (!this.mode) return;
    this.mode = null;
    for (const mesh of this.ed.meshes.values()) this._dropOverlay(mesh);
    this._setArrows(null);
    this._setMarks([]);
    this.vp.canvas.style.cursor = '';
    this.ed.refreshOutlines();
  }

  /** The shape's geometry changed (or undo): drop picks that no longer exist, redraw. */
  reset() { this.picked.clear(); this.hover = null; }

  // ---------------------------------------------------------------- geometry helpers
  node(id = this.id) { return id ? this.ed.node(id) : null; }

  /** Shape-edit state of a node plus the maps between its real-size frame and the world. */
  info(node) {
    const st = nodeShapeEdits(node);
    const mesh = this.ed.meshes.get(node.id);
    if (!st || !mesh) return null;
    const s = st.A.scale;
    mesh.updateMatrixWorld(true);
    const W = mesh.matrixWorld;
    const L = new THREE.Matrix3().setFromMatrix4(W).multiply(new THREE.Matrix3().set(1 / s[0], 0, 0, 0, 1 / s[1], 0, 0, 0, 1 / s[2]));
    const Linv = L.clone().invert();
    return {
      ...st, mesh, W, L, Linv,
      toWorld: (p) => p.clone().set(p.x / s[0], p.y / s[1], p.z / s[2]).applyMatrix4(W),
      toLocal: (p) => p.clone().set(p.x / s[0], p.y / s[1], p.z / s[2]),
      dirToWorld: (v) => v.clone().applyMatrix3(L),
      dirFromWorld: (v) => v.clone().applyMatrix3(Linv),
      normalToWorld: (n) => n.clone().applyMatrix3(Linv.clone().transpose()).normalize(),
      vert: (v) => movedVertex(st.A, st.disp, v),
    };
  }

  /** Moved triangles of a face (real size), its centre and normal. */
  faceShape(I, j) {
    const A = I.A, reg = A.regions[A.faces[j].region];
    const pts = [];
    const n = new THREE.Vector3(), c = new THREE.Vector3();
    let area = 0;
    for (const t of reg.tris) {
      const [a, b, d] = A.tris[t].v.map((v) => I.vert(v));
      pts.push(a, b, d);
      const cr = b.clone().sub(a).cross(d.clone().sub(a));
      const ar = cr.length() / 2;
      n.add(cr); area += ar;
      c.addScaledVector(a.clone().add(b).add(d), ar / 3);
    }
    if (area > 0) c.divideScalar(area);
    if (n.lengthSq() < 1e-12) n.copy(A.faces[j].n); else n.normalize();
    return { pts, n, c };
  }

  // ---------------------------------------------------------------- overlays
  _dropOverlay(mesh) {
    const o = mesh.userData.partOverlay;
    if (!o) return;
    mesh.remove(o);
    o.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); });
    mesh.userData.partOverlay = null;
  }

  /** Redraw picked / hovered parts and the move arrows. */
  refresh() {
    const ed = this.ed;
    if (this.id && !ed.meshes.has(this.id)) { this.id = null; this.picked.clear(); }
    if (this.hoverId && !ed.meshes.has(this.hoverId)) { this.hoverId = null; this.hover = null; }
    this._marks = [];
    if (this.mode) {
      const show = new Set([this.id, this.hoverId].filter(Boolean));
      for (const [id, mesh] of ed.meshes) { this._dropOverlay(mesh); if (show.has(id)) this._buildOverlay(id); }
    }
    this._setMarks(this._marks);
    this._placeArrows();
    this.vp.requestRender();
  }

  _buildOverlay(id) {
    const node = this.node(id);
    const I = node && this.info(node);
    if (!I) return;
    const group = new THREE.Group();
    const local = (p) => I.toLocal(p);
    if (this.mode === 'face') {
      const add = (list, opacity) => {
        if (!list.length) return;
        const arr = [];
        for (const j of list) for (const p of this.faceShape(I, j).pts) { const q = local(p); arr.push(q.x, q.y, q.z); }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        const m = new THREE.Mesh(g, faceMaterial(opacity));
        m.renderOrder = 5;
        group.add(m);
      };
      const picked = id === this.id ? [...this.picked].filter((j) => j < I.A.faces.length) : [];
      const hov = this.hover && this.hover.id === id && !picked.includes(this.hover.i) ? [this.hover.i] : [];
      add(picked, 0.45);
      add(hov, 0.22);
    } else if (this.mode === 'corner') {
      const meshes = [...this.ed.meshes.values()].filter((m) => m.visible);
      const many = I.A.corners.length > 400; // too many to check: show only picked and hovered
      I.A.corners.forEach((c, j) => {
        const w = I.toWorld(I.vert(c.v));
        const picked = id === this.id && this.picked.has(j);
        const hov = this.hover && this.hover.id === id && this.hover.i === j;
        if (!picked && !hov && (many || !this.ed._edgeVisible(w, meshes, this.vp.unitsPerPixel(w) * 3))) return;
        this._marks.push({ w, cls: hov ? 'mk-hover' : picked ? 'mk-picked' : 'mk-plain' });
      });
    }
    if (!group.children.length) return;
    group.traverse((x) => { x.raycast = () => {}; });
    I.mesh.add(group);
    I.mesh.userData.partOverlay = group;
    I.mesh.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- picking
  _pickFace(e, node) {
    const I = this.info(node);
    if (!I || !I.A.faces.length) return null;
    // the faces as one mesh to aim at (kept until the shape changes)
    const key = I.A.key + '|' + I.A.lastEditKey;
    let c = this._faceMesh;
    if (!c || c.key !== key) {
      if (c) c.mesh.geometry.dispose();
      const arr = [], owner = [];
      I.A.faces.forEach((f, j) => {
        for (const p of this.faceShape(I, j).pts) { const q = I.toLocal(p); arr.push(q.x, q.y, q.z); }
        for (let k = 0; k < I.A.regions[f.region].tris.length; k++) owner.push(j);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      c = this._faceMesh = { key, owner, mesh: new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })) };
    }
    const m = c.mesh, owner = c.owner;
    m.matrixWorld.copy(I.W);
    const rc = new THREE.Raycaster();
    const rect = this.vp.canvas.getBoundingClientRect();
    rc.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.vp.camera);
    const hits = rc.intersectObject(m, false);
    if (!hits.length) return null;
    return owner[hits[0].faceIndex];
  }

  _pickCorner(e, ids) {
    const rect = this.vp.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const meshes = [...this.ed.meshes.values()].filter((m) => m.visible);
    let best = null;
    for (const id of ids) {
      const node = id && this.node(id);
      const I = node && this.info(node);
      if (!I || !I.mesh.visible) continue;
      I.A.corners.forEach((c, j) => {
        const w = I.toWorld(I.vert(c.v));
        const s = this.vp.project(w);
        if (s.behind) return;
        const d = Math.hypot(s.x - mx, s.y - my);
        if (d < 12 && (!best || d < best.d) && this.ed._edgeVisible(w, meshes, this.vp.unitsPerPixel(w) * 3)) best = { id, i: j, d };
      });
    }
    return best && { id: best.id, i: best.i };
  }

  _pick(e) {
    const under = this.ed.pickNode(e);
    const underId = under ? under.node.id : null;
    if (this.mode === 'face') {
      const node = under && under.node;
      const i = node ? this._pickFace(e, node) : null;
      return { underId, hit: i == null ? null : { id: node.id, i } };
    }
    return { underId, hit: this._pickCorner(e, new Set([underId, this.id])) };
  }

  hoverAt(e) {
    if (this.drag) return;
    const { underId, hit } = this._pick(e);
    this.vp.canvas.style.cursor = hit ? 'pointer' : '';
    this._setHover(underId || (hit && hit.id) || null, hit);
  }

  _setHover(hoverId, hit) {
    const same = (p, q) => (p && q ? p.id === q.id && p.i === q.i : p === q);
    if (hoverId === this.hoverId && same(hit, this.hover)) return;
    this.hoverId = hoverId; this.hover = hit;
    this.refresh();
  }

  clearPicks() {
    if (!this.picked.size) return;
    this.picked.clear();
    this.refresh();
    this.ed.emit('selection');
  }

  click(e) {
    const { hit } = this._pick(e);
    const multi = e.shiftKey || e.metaKey;
    if (!hit) {
      if (!multi && this.picked.size) { this.picked.clear(); this.refresh(); this.ed.emit('selection'); }
      return;
    }
    const changed = () => { this.last = hit.i; this.ed.refreshOutlines(); this.refresh(); this.ed.emit('selection'); };
    if (multi) {
      if (hit.id !== this.id) { this.id = hit.id; this.picked = new Set([hit.i]); }
      else if (this.picked.has(hit.i)) this.picked.delete(hit.i); else this.picked.add(hit.i);
      changed();
      return;
    }
    // like objects: press a part to pick it and drag to move it; a click on the only picked part unpicks it
    const wasOnly = hit.id === this.id && this.picked.size === 1 && this.picked.has(hit.i);
    if (!(hit.id === this.id && this.picked.has(hit.i))) { this.id = hit.id; this.picked = new Set([hit.i]); changed(); }
    this.pressDrag(e, () => {
      if (wasOnly) this.picked = new Set();
      else if (this.picked.size > 1) this.picked = new Set([hit.i]);
      else return;
      changed();
    });
  }

  /**
   * A press on picked parts: dragging moves them, the same as dragging an object (a face along
   * its own direction; edges and corners across the workplane, Shift: one axis only). Without
   * any movement it is a click: onClick.
   */
  pressDrag(e, onClick) {
    const canvas = this.vp.canvas, x0 = e.clientX, y0 = e.clientY;
    const done = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
    const move = (ev) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      done();
      this._dragPicked(e, canvas);
    };
    const up = () => { done(); if (onClick) onClick(); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  // ---------------------------------------------------------------- what is picked, for any mode
  /**
   * The parts to move: { node, I, kind: 'f' | 'e' | 'c', items: [{ j }], anchor (world), axes }.
   * For edges, j is the index of the edge in the shape before its own edits.
   */
  target() {
    const t = this._target();
    if (t) t.edits = t.node.shapeEdits ? [...t.node.shapeEdits] : [];
    return t;
  }

  _target() {
    const ed = this.ed;
    if (this.mode) {
      const node = this.node();
      const I = node && this.info(node);
      if (!I || !this.picked.size) return null;
      if (this.mode === 'face') {
        const items = [...this.picked].filter((j) => j < I.A.faces.length).map((j) => ({ j }));
        if (!items.length) return null;
        const lastJ = this.picked.has(this.last) ? this.last : items[items.length - 1].j;
        const fs = this.faceShape(I, lastJ);
        return { node, I, kind: 'f', items, anchor: I.toWorld(fs.c), axes: [{ dir: I.normalToWorld(fs.n), color: ACCENT, name: 'n' }] };
      }
      const items = [...this.picked].filter((j) => j < I.A.corners.length).map((j) => ({ j }));
      if (!items.length) return null;
      const lastJ = this.picked.has(this.last) ? this.last : items[items.length - 1].j;
      return { node, I, kind: 'c', items, anchor: I.toWorld(I.vert(I.A.corners[lastJ].v)), axes: this._worldAxes() };
    }
    const em = ed.edgeMode;
    if (!em || !em.id || !em.picked.size) return null;
    const node = ed.node(em.id);
    const I = node && this.info(node);
    if (!I) return null;
    const d = nodeEdgeData(node);
    if (em.picked.size >= d.chains.length) return null; // all edges: that's the whole shape
    const base = this.baseChains(node, I, d);
    const items = [...em.picked].filter((i) => i < d.chains.length && base[i] !== undefined).map((i) => ({ j: base[i], shown: i }));
    if (!items.length) return null;
    const ch = d.chains[items[items.length - 1].shown];
    const mid = ch.points[Math.floor((ch.points.length - 1) / 2)].clone().lerp(ch.points[Math.ceil((ch.points.length - 1) / 2)], 0.5);
    if (ch.points.length === 2) mid.copy(ch.points[0]).lerp(ch.points[1], 0.5);
    return { node, I, kind: 'e', items, anchor: I.toWorld(mid), axes: this._worldAxes() };
  }

  _worldAxes() {
    const f = this.ed.frame;
    const all = AXES.map((a) => ({ ...a, dir: a.dir.clone().transformDirection(f) }));
    // with the X / Y / Z arrows off, X and Y are moved by dragging; only a black up/down arrow is left
    return this.ed.settings.moveArrows ? all : [{ ...all[2], plain: true }];
  }

  /**
   * World box around the picked faces, edges or corners (for Fit in view), grown to at least
   * a third of the shape's size so a single corner isn't zoomed right into. Null if none.
   */
  pickedBox() {
    const ed = this.ed;
    const box = new THREE.Box3();
    let node = null;
    if (this.mode) {
      node = this.node();
      const I = node && this.info(node);
      if (!I) return null;
      for (const j of this.picked) {
        if (this.mode === 'face' && j < I.A.faces.length) for (const p of this.faceShape(I, j).pts) box.expandByPoint(I.toWorld(p));
        if (this.mode === 'corner' && j < I.A.corners.length) box.expandByPoint(I.toWorld(I.vert(I.A.corners[j].v)));
      }
    } else if (ed.edgeMode && ed.edgeMode.id) {
      node = ed.node(ed.edgeMode.id);
      const mesh = node && ed.meshes.get(node.id);
      if (!mesh) return null;
      const d = nodeEdgeData(node);
      for (const i of ed.edgeMode.picked) if (d.lines[i]) for (const p of d.lines[i]) box.expandByPoint(p.clone().applyMatrix4(mesh.matrixWorld));
    }
    if (!node) return null;
    const whole = ed.worldBounds([node]);
    if (box.isEmpty()) return whole.isEmpty() ? null : whole;
    if (!whole.isEmpty()) {
      const min = whole.getSize(new THREE.Vector3()).length() / 3;
      const size = box.getSize(new THREE.Vector3()).length();
      if (size < min) box.expandByScalar((min - size) / 2);
    }
    return box;
  }

  /** Names what is picked, to tell whether Fit in view is pressed again for the same parts. */
  pickKey() {
    const em = this.ed.edgeMode;
    if (this.mode) return `${this.mode}:${this.id}:${[...this.picked].sort((a, b) => a - b).join(',')}`;
    return em ? `edge:${em.id}:${[...em.picked].sort((a, b) => a - b).join(',')}` : '';
  }

  /**
   * The direction to look from to see the picked parts face on (world, pointing out towards
   * the viewer): a face's normal; for an edge, halfway between the faces either side of it;
   * for a corner, the average of the faces that meet there. Null when nothing is picked.
   */
  faceOnDir() {
    const ed = this.ed;
    const sum = new THREE.Vector3();
    if (this.mode) {
      const node = this.node();
      const I = node && this.info(node);
      if (!I) return null;
      for (const j of this.picked) {
        if (this.mode === 'face' && j < I.A.faces.length) sum.add(I.normalToWorld(this.faceShape(I, j).n));
        if (this.mode === 'corner' && j < I.A.corners.length) {
          for (const r of I.A.vRegions[I.A.corners[j].v]) sum.add(I.normalToWorld(I.A.regions[r].n));
        }
      }
    } else if (ed.edgeMode && ed.edgeMode.id) {
      const node = ed.node(ed.edgeMode.id);
      const I = node && this.info(node);
      if (!I) return null;
      const d = nodeEdgeData(node);
      for (const i of ed.edgeMode.picked) {
        const ch = d.chains[i];
        if (!ch) continue;
        const m = new THREE.Vector3();
        for (let k = 0; k < ch.nA.length; k++) m.add(ch.nA[k]).add(ch.nB[k]);
        if (m.lengthSq() > 1e-12) sum.add(I.normalToWorld(m));
      }
    }
    return sum.lengthSq() > 1e-10 ? sum.normalize() : null;
  }

  /** Keys naming each shown edge by the shape's own vertices (stable while parts move). */
  chainKeys(node, I = this.info(node), d = nodeEdgeData(node)) {
    if (!I) return [];
    const byPos = new Map();
    I.A.verts.forEach((_, v) => byPos.set(pkey(I.vert(v)), v));
    return d.chains.map((ch) => {
      const ids = ch.points.map((p) => byPos.get(pkey(p)));
      return ids.some((v) => v === undefined) ? null : [...ids].sort((a, b) => a - b).join(',');
    });
  }

  /** For each shown edge, the matching edge of the shape before its own edits (or undefined). */
  baseChains(node, I, d) {
    const A = I.A;
    if (!A.chainKeys) A.chainKeys = A.chains.map((c) => [...c.ids].sort((a, b) => a - b).join(','));
    const keys = this.chainKeys(node, I, d);
    return keys.map((k) => { if (!k) return undefined; const j = A.chainKeys.indexOf(k); return j < 0 ? undefined : j; });
  }

  /** Current move of each target item: a number (faces, mm) or a world vector (edges, corners). */
  values(t) {
    const edits = t.edits;
    const m = t.I.match;
    const list = t.kind === 'f' ? m.faces : t.kind === 'e' ? m.chains : m.corners;
    return t.items.map(({ j }) => {
      const k = list[j];
      const e = k === undefined ? null : edits[k];
      if (t.kind === 'f') return e ? e.d : 0;
      return e ? t.I.dirToWorld(new THREE.Vector3().fromArray(e.v)).applyMatrix3(new THREE.Matrix3().setFromMatrix4(this.ed.frameInv)) : new THREE.Vector3();
    });
  }

  /**
   * Build the node's new shape edits with these moves for the target items (numbers for faces,
   * vectors in the workplane's axes for edges and corners). A zero move removes the edit.
   */
  editsWith(t, vals) {
    const edits = [...t.edits]; // the edits t.I.match was worked out for (not mid-drag ones)
    const m = t.I.match;
    const list = t.kind === 'f' ? m.faces : t.kind === 'e' ? m.chains : m.corners;
    const drop = new Set();
    const frame3 = new THREE.Matrix3().setFromMatrix4(this.ed.frame);
    t.items.forEach(({ j }, n) => {
      const k = list[j];
      let next;
      if (t.kind === 'f') {
        const d = r4(vals[n]);
        next = Math.abs(d) < 1e-6 ? null : { k: 'f', sig: t.I.A.faces[j].sig, d };
      } else {
        const w = vals[n].clone().applyMatrix3(frame3);
        const v = t.I.dirFromWorld(w).toArray().map(r4);
        const sig = t.kind === 'e' ? t.I.A.edgeSigs[j] : t.I.A.corners[j].sig;
        next = v.every((x) => Math.abs(x) < 1e-6) ? null : { k: t.kind, sig, v };
      }
      if (k !== undefined) { if (next) edits[k] = next; else drop.add(k); }
      else if (next) edits.push(next);
    });
    return edits.filter((_, k) => !drop.has(k));
  }

  /**
   * Give the node new shape edits, keeping its rounded edges and the picked edges on the same
   * edges as they move. live: while dragging (no undo step, rounded edges left off for speed).
   */
  applyEdits(node, edits, { live = false } = {}) {
    const ed = this.ed;
    const em = ed.edgeMode && ed.edgeMode.id === node.id ? ed.edgeMode : null;
    const before = { ...node, round: 0 };
    const oldKeys = (node.edgeRounds && node.edgeRounds.length) || em ? this.chainKeys(before) : [];
    const oldIdx = node.edgeRounds && node.edgeRounds.length ? edgeRoundIndex(node) : [];
    const rounds = node.edgeRounds;
    if (edits.length) node.shapeEdits = edits; else delete node.shapeEdits;
    if (live) { delete node.edgeRounds; ed.sync(); return; }
    // follow the edges to where they are now
    const after = { ...node, round: 0, edgeRounds: null };
    const d1 = nodeEdgeData(after);
    const newKeys = oldKeys.length ? this.chainKeys(after, this.info(after), d1) : [];
    const at = (j) => { const k = oldKeys[j]; const i = k ? newKeys.indexOf(k) : -1; return i < 0 ? undefined : i; };
    if (rounds && rounds.length) {
      const next = rounds.map((r) => ({ ...r }));
      oldIdx.forEach((k, j) => { if (k !== undefined && at(j) !== undefined) next[k].sig = d1.sigs[at(j)]; });
      node.edgeRounds = next;
    }
    if (em) {
      em.picked = new Set([...em.picked].map(at).filter((i) => i !== undefined));
      em.key = d1.key;
    }
    ed.sync();
  }

  // ---------------------------------------------------------------- handles
  // Drawn like the object handles: black arrows (as the lift arrow) to drag along, a white
  // square on what is being moved, and black squares on the corners that can be picked.
  _buildHandles() {
    this.layer = h('div', { class: 'gizmo-layer part-layer' });
    this.vp.container.appendChild(this.layer);
    // tails: a line from the square out to each arrow
    this.tailEls = [0, 1, 2].map(() => {
      const el = h('div', { class: 'gz-part-tail' });
      el.style.display = 'none';
      this.layer.append(el);
      return el;
    });
    this.arrowEls = [0, 1, 2].map((i) => {
      const el = h('div', { class: 'gz-handle gz-part-arrow' });
      el.style.display = 'none';
      el.addEventListener('pointerdown', (e) => this._arrowDown(e, i));
      // an object's up arrow shows its height above the workplane, as the lift cone did
      const lift = (on) => { const a = this.arrows && this.arrows.object && this.arrows.axes[i]; if (a && a.name === 'z') this.ed.emit('lifthover', on || !!this.drag); };
      el.addEventListener('pointerenter', () => lift(true));
      el.addEventListener('pointerleave', () => lift(false));
      this.layer.append(el);
      return el;
    });
    // the move along each arrow, on the model like the size labels; click to type a value
    this.labelEls = [0, 1, 2].map((i) => {
      const el = h('div', { class: 'gz-label gz-part-label' });
      el.style.display = 'none';
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', () => this._editLabel(i));
      this.layer.append(el);
      return el;
    });
    this.anchorEl = h('div', { class: 'gz-part-mark mk-picked gz-part-anchor', title: 'Drag to move' });
    this.anchorEl.style.display = 'none';
    // the square on the picked parts can be dragged too, like the parts themselves
    this.anchorEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      this.pressDrag(e, null);
    });
    this.layer.append(this.anchorEl);
    this.markEls = [];
    this.marks = []; // [{ w: world point, cls }]
  }

  _setArrows(spec) {
    this.arrows = spec;
    if (spec) {
      spec.axes.forEach((a, i) => {
        if (!this.arrowEls[i]) return;
        this.arrowEls[i].title = a.name === 'n' ? 'Drag to move the face in or out' : a.plain ? 'Drag to raise or lower' : `Drag to move along ${a.name.toUpperCase()}`;
        // X red, Y green, Z blue (as the X / Y / Z fields); a face's arrow is black like the lift arrow
        for (const el of [this.arrowEls[i], this.tailEls[i], this.labelEls[i]]) {
          el.classList.remove('ax-x', 'ax-y', 'ax-z', 'ax-n');
          el.classList.add('ax-' + (a.plain ? 'n' : a.name));
        }
      });
    }
    this._layout();
    this.vp.requestRender();
  }

  _placeArrows() {
    if (this.drag) {
      if (this.arrows) this.arrows.anchor = this.drag.vec ? this.drag.anchor0.clone().add(this.drag.vec) : this.drag.anchor0.clone().addScaledVector(this.drag.axis.dir, this.drag.delta);
      this._updateLabels();
      this._layout();
      return;
    }
    if (!this.mode && !this.ed.edgeMode) { this._setArrows(this._objectArrows()); return; }
    const t = this.target();
    if (!t || t.node.locked) { this._setArrows(null); return; }
    this._setArrows({ anchor: t.anchor, axes: t.axes, anchorMark: t.kind !== 'c' });
    this._updateLabels(t);
  }

  /** Label text: the current move along each arrow ('mixed' when picked parts differ). */
  _updateLabels(t = this.arrows && this.arrows.object ? null : this.target()) {
    if (!this.arrows || !t) return;
    const vals = this.values(t);
    this.arrows.axes.forEach((a, i) => {
      const el = this.labelEls[i];
      if (!el || this.editing === i) return;
      const list = vals.map((v) => (typeof v === 'number' ? v : v[a.name]));
      const same = list.every((x) => Math.abs(x - list[0]) < 1e-4);
      const text = same ? formatLength(list[0], this.ed.units) : '–';
      el.textContent = a.name === 'n' ? text : `${a.name.toUpperCase()} ${text}`;
      el.classList.toggle('moved', same && Math.abs(list[0]) > 1e-6);
      el._value = same ? list[0] : 0;
    });
  }

  _editLabel(i) {
    const A = this.arrows, el = this.labelEls[i];
    if (!A || !A.axes[i] || this.editing != null || this.drag) return;
    const t = this.target();
    if (!t || t.node.locked) return;
    const axis = A.axes[i];
    const input = h('input', { class: 'gz-input', type: 'text', value: formatLength(el._value || 0, this.ed.units) });
    const initial = input.value;
    this.editing = i;
    el.textContent = '';
    el.append(input);
    el.classList.add('editing');
    input.focus();
    input.select();
    let done = false;
    const finish = (apply, next) => {
      if (done) return;
      done = true;
      this.editing = null;
      el.classList.remove('editing');
      const v = parseLength(input.value, this.ed.units);
      input.remove();
      if (apply && input.value.trim() !== initial.trim() && isFinite(v)) this.setValue(axis.name === 'n' ? 'x' : axis.name, v);
      this._updateLabels();
      if (next != null) setTimeout(() => this._editLabel(next), 0);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      else if (e.key === 'Tab' && A.axes.length > 1) { e.preventDefault(); finish(true, (i + 1) % A.axes.length); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** Corner squares (Corner mode), as world points with their look. */
  _setMarks(marks) {
    this.marks = marks;
    while (this.markEls.length < marks.length) {
      const el = h('div', { class: 'gz-part-mark' });
      this.layer.insertBefore(el, this.anchorEl);
      this.markEls.push(el);
    }
    this.markEls.forEach((el, i) => {
      const m = marks[i];
      if (!m) { el.style.display = 'none'; return; }
      el.className = 'gz-part-mark ' + m.cls;
    });
    this._layout();
  }

  /** Put the handles where their points are on screen (every rendered frame). */
  _layout() {
    if (!this.layer) return;
    const vp = this.vp, p = {};
    const place = (el, x, y, extra = '') => { el.style.display = ''; el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)${extra}`; };
    this.marks.forEach((m, i) => {
      const el = this.markEls[i];
      vp.project(m.w, p);
      if (p.behind) el.style.display = 'none'; else place(el, p.x, p.y);
    });
    const A = this.arrows;
    const hideAll = () => { this.anchorEl.style.display = 'none'; for (const el of [...this.arrowEls, ...this.labelEls, ...this.tailEls]) el.style.display = 'none'; };
    if (!A) { hideAll(); return; }
    vp.project(A.anchor, p);
    if (p.behind) { hideAll(); return; }
    const ox = p.x, oy = p.y;
    if (A.anchorMark) place(this.anchorEl, ox, oy); else this.anchorEl.style.display = 'none';
    const len = vp.unitsPerPixel(A.anchor) * 30;
    this.arrowEls.forEach((el, i) => {
      const a = A.axes[i];
      const lab = this.labelEls[i], tail = this.tailEls[i];
      if (!a) { el.style.display = 'none'; lab.style.display = 'none'; tail.style.display = 'none'; return; }
      const q = vp.project(A.anchor.clone().addScaledVector(a.dir, len));
      const dx = q.x - ox, dy = q.y - oy, L = Math.hypot(dx, dy);
      if (L < 8 && !(this.drag && this.drag.axis === a)) { el.style.display = 'none'; lab.style.display = 'none'; tail.style.display = 'none'; return; } // pointing at the camera
      const ux = L ? dx / L : 0, uy = L ? dy / L : -1;
      place(el, ox + ux * ARROW_PX, oy + uy * ARROW_PX, ` rotate(${Math.atan2(ux, -uy)}rad)`);
      // the tail runs from the square to the base of the arrow
      tail.style.display = '';
      tail.style.width = `${Math.max(0, ARROW_PX - 9)}px`;
      tail.style.transform = `translate(${Math.round(ox)}px, ${Math.round(oy) - 1}px) rotate(${Math.atan2(uy, ux)}rad)`;
      // beside the arrow, past its tip
      if (A.object) { lab.style.display = 'none'; return; }   // objects show their sizes and height on the gizmo instead
      const w = lab.offsetWidth || 40, hh = lab.offsetHeight || 20;
      const r = ARROW_PX + 14 + Math.abs(ux) * w / 2 + Math.abs(uy) * hh / 2;
      place(lab, ox + ux * r, oy + uy * r);
    });
  }

  /**
   * Object mode: the same arrows as for faces, edges and corners, from the top middle of the
   * selection. Move arrows on: X / Y / Z; off: one black arrow to raise or lower it.
   */
  _objectArrows() {
    const ed = this.ed;
    if (ed.tool !== 'select' || ed.placing) return null;
    const nodes = ed.movableNodes();
    if (!nodes.length) return null;
    const b = ed.bounds(nodes);
    if (b.isEmpty()) return null;
    const anchor = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z).applyMatrix4(ed.frame);
    return { anchor, axes: this._worldAxes(), anchorMark: false, object: true };
  }

  /** Move the selected objects along one arrow. */
  _objectDrag(e, axis, el) {
    const ed = this.ed;
    const nodes = ed.movableNodes();
    if (!nodes.length) return;
    const start = ed.startMatrices(nodes);
    const anchor = this.arrows.anchor.clone();
    const along = (ev) => {
      const ray = this.vp.rayFromClient(ev.clientX, ev.clientY);
      const d = axis.dir, w0 = ray.origin.clone().sub(anchor);
      const b = ray.direction.dot(d), den = 1 - b * b;
      return den < 1e-6 ? null : (w0.dot(d) - w0.dot(ray.direction) * b) / den;
    };
    const t0 = along(e);
    if (t0 == null) return;
    const local = axis.dir.clone().transformDirection(ed.frameInv);
    this.drag = { axis, anchor0: anchor, delta: 0 };
    el.classList.add('dragging');
    ed.emit('drag', true);
    let last = 0;
    track(el, e, (ev) => {
      const t = along(ev);
      if (t == null) return;
      let delta = t - t0;
      if (ed.snap > 0 && !ev.altKey) delta = Math.round(delta / ed.snap) * ed.snap;
      if (delta === last) return;
      last = delta;
      this.drag.delta = delta;
      ed.applyLocal(nodes, start, new THREE.Matrix4().makeTranslation(local.x * delta, local.y * delta, local.z * delta));
      this._placeArrows();
    }, () => {
      this.drag = null;
      el.classList.remove('dragging');
      ed.emit('drag', false);
      if (last) { ed.sync(); ed.commit(); }
      ed.emit('selection');
    });
  }

  _arrowDown(e, i) {
    if (!this.arrows || !this.arrows.axes[i] || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.arrows.object) { this._objectDrag(e, this.arrows.axes[i], e.currentTarget); return; }
    this.startDrag(e, this.arrows.axes[i], e.currentTarget);
  }

  /** Drag the picked parts along an arrow. */
  startDrag(e, axis, el, t = this.target()) {
    if (!t || t.node.locked) return;
    const ed = this.ed;
    const startVals = this.values(t);
    const startEdits = t.node.shapeEdits ? [...t.node.shapeEdits] : null;
    const rounds = t.node.edgeRounds;
    const em = ed.edgeMode && ed.edgeMode.id === t.node.id ? ed.edgeMode : null;
    const emSave = em && { picked: new Set(em.picked), key: em.key };
    const restore = () => {
      if (rounds) t.node.edgeRounds = rounds;
      if (startEdits) t.node.shapeEdits = startEdits; else delete t.node.shapeEdits;
      if (em) { em.picked = emSave.picked; em.key = emSave.key; }
    };
    const along = (ev) => {
      const ray = this.vp.rayFromClient(ev.clientX, ev.clientY);
      const o = t.anchor, d = axis.dir;
      const w0 = ray.origin.clone().sub(o);
      const b = ray.direction.dot(d), den = 1 - b * b;
      if (den < 1e-6) return null;
      return (w0.dot(d) - w0.dot(ray.direction) * b) / den;
    };
    if (axis.free) return this._freeDrag(e, el, t, startVals, restore, em);
    const t0 = along(e);
    if (t0 == null) return;
    const snap = ed.snap > 0 ? ed.snap : 0;
    const local = axis.dir.clone().transformDirection(ed.frameInv); // the axis in workplane terms
    this.drag = { axis, anchor0: t.anchor.clone(), delta: 0 };
    el.classList.add('dragging');
    let last = 0, raf = 0;
    const apply = () => {
      const vals = startVals.map((v) => (t.kind === 'f' ? v + last : v.clone().addScaledVector(local, last)));
      if (em) em.key = null; // keep the picked edges while their shape changes
      this.applyEdits(t.node, this.editsWith(t, vals), { live: true });
    };
    track(el, e, (ev) => {
      const tt = along(ev);
      if (tt == null) return;
      let delta = tt - t0;
      if (snap && !ev.altKey) delta = Math.round(delta / snap) * snap;
      if (delta === last) return;
      last = delta;
      this.drag.delta = delta;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply(); ed.emit('partmove', { delta: last }); });
    }, () => {
      cancelAnimationFrame(raf);
      this.drag = null;
      el.classList.remove('dragging');
      restore();
      if (!last) { ed.sync(); this.refresh(); return; }
      // re-apply from the starting state so rounded edges and picked edges follow their edges
      const vals = startVals.map((v) => (t.kind === 'f' ? v + last : v.clone().addScaledVector(local, last)));
      this.commitEdits(t.node, this.editsWith(t, vals));
    });
  }

  /**
   * Drag the picked parts themselves across the workplane, like an object. A face goes by its
   * corners (all of them move together); its arrow still moves it in or out.
   */
  _dragPicked(e, el) {
    const t = this.target();
    if (!t || t.node.locked) return;
    if (t.kind !== 'f') { this.startDrag(e, { name: 'free', free: true }, el, t); return; }
    const A = t.I.A, js = new Set();
    for (const { j } of t.items) {
      const verts = A.regions[A.faces[j].region].verts;
      A.corners.forEach((c, k) => { if (verts.has(c.v)) js.add(k); });
    }
    if (!js.size) { this.startDrag(e, t.axes[0], el, t); return; }   // a face without corners (e.g. round): in and out only
    this.startDrag(e, { name: 'free', free: true }, el, { ...t, kind: 'c', items: [...js].map((j) => ({ j })) });
  }

  /** Drag edges or corners across the workplane through them (Shift: along X or Y only). */
  _freeDrag(e, el, t, startVals, restore, em) {
    const ed = this.ed;
    const a0 = t.anchor.clone().applyMatrix4(ed.frameInv);                 // the anchor in workplane terms
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -a0.z);
    const hit = (ev) => ed.localRay(ev).intersectPlane(plane, new THREE.Vector3());
    const p0 = hit(e);
    if (!p0) return;
    const snap = ed.snap > 0 ? ed.snap : 0;
    const frame3 = new THREE.Matrix3().setFromMatrix4(ed.frame);
    this.drag = { axis: { name: 'free', dir: new THREE.Vector3() }, anchor0: t.anchor.clone(), delta: 0, vec: new THREE.Vector3() };
    el.classList.add('dragging');
    let last = new THREE.Vector3(), raf = 0;
    const valsFor = (d) => startVals.map((v) => v.clone().add(d));
    const apply = () => {
      if (em) em.key = null;
      this.applyEdits(t.node, this.editsWith(t, valsFor(last)), { live: true });
    };
    track(el, e, (ev) => {
      const p = hit(ev);
      if (!p) return;
      const d = p.sub(p0); d.z = 0;
      if (ev.shiftKey) { if (Math.abs(d.x) >= Math.abs(d.y)) d.y = 0; else d.x = 0; }
      if (snap && !ev.altKey) { d.x = Math.round(d.x / snap) * snap; d.y = Math.round(d.y / snap) * snap; }
      if (d.equals(last)) return;
      last = d;
      this.drag.vec = d.clone().applyMatrix3(frame3);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply(); ed.emit('partmove', { delta: last.length() }); });
    }, () => {
      cancelAnimationFrame(raf);
      this.drag = null;
      el.classList.remove('dragging');
      restore();
      if (!last.lengthSq()) { ed.sync(); this.refresh(); return; }
      this.commitEdits(t.node, this.editsWith(t, valsFor(last)));
    });
  }

  /** Set the moves of the target and make an undo step (from the panel or after a drag). */
  commitEdits(node, edits) {
    const ed = this.ed;
    const before = JSON.stringify(node.shapeEdits || []);
    this.applyEdits(node, edits);
    const st = nodeShapeEdits(node);
    const failed = st ? st.failed : 0;
    if (JSON.stringify(node.shapeEdits || []) !== before) ed.commit();
    if (failed) toast(failed === 1 ? 'One move could not be made: it would turn the shape inside out' : `${failed} moves could not be made`, 'warn', 4000);
    this.refresh();
    ed.emit('selection');
  }

  /** From the panel: set the target's moves (a number for faces, { x, y, z } for edges and corners). */
  setValue(axisName, value) {
    const t = this.target();
    if (!t || t.node.locked) return;
    const vals = this.values(t).map((v) => {
      if (t.kind === 'f') return value;
      const w = v.clone();
      w[axisName] = value;
      return w;
    });
    this.commitEdits(t.node, this.editsWith(t, vals));
  }

  /** Put the target parts back where they were. */
  resetTarget() {
    const t = this.target();
    if (!t || t.node.locked) return;
    this.commitEdits(t.node, this.editsWith(t, t.items.map(() => (t.kind === 'f' ? 0 : new THREE.Vector3()))));
  }

  /** Remove every face, edge and corner move from a node. */
  resetAll(node) {
    if (!node || !node.shapeEdits || node.locked) return;
    this.commitEdits(node, []);
  }
}
