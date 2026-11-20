// Editor: owns the document, selection, tools and every modelling command.
import * as THREE from 'three';
import { History, cloneNode, makeGroup, mat4, uid, newDoc } from './core/doc.js';
import { getGeometry, expandBox, getEdges, measure, nodeEdgeData, edgeRoundIndex, stats as geoStats } from './core/geometry.js';
import { toast } from './ui/dom.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

class Emitter {
  constructor() { this._l = {}; }
  on(evt, fn) { (this._l[evt] ||= []).push(fn); return this; }
  emit(evt, data) { for (const fn of this._l[evt] || []) fn(data); }
}

const SEL_COLOR = 0x29c5ff;
const selLineMat = new THREE.LineBasicMaterial({ color: SEL_COLOR });
const edgeLineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 });

function makeHoleMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xc9d0d8, roughness: 0.85, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  vec2 dCell = fract(gl_FragCoord.xy / 9.0) - 0.5;\n  diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.2, 0.3, length(dCell)));');
  };
  return m;
}
const holeMaterial = makeHoleMaterial();

const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const S = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z);
/** Transform about a pivot point. */
export const about = (pivot, m) => T(pivot.x, pivot.y, pivot.z).multiply(m).multiply(T(-pivot.x, -pivot.y, -pivot.z));

export class Editor extends Emitter {
  constructor(viewport, settings) {
    super();
    this.viewport = viewport;
    this.settings = settings;
    this.doc = newDoc();
    this.history = new History();
    this.selection = new Set();
    this.meshes = new Map();
    this.tool = 'select';
    this.cruise = false;
    this.frame = new THREE.Matrix4();
    this.frameInv = new THREE.Matrix4();
    this.hasFrame = false;
    this.ruler = null; // { x, y } in frame coordinates
    this.alignAnchor = null;
    this.clipboard = null;
    this.pasteCount = 0;
    this.dupState = null;
    this.placing = null;
    this.busy = false;
    this.history.reset(this._snapshot());

    viewport.handlers.leftDown = (e) => this._leftDown(e);
    viewport.handlers.hover = (e) => this._hover(e);
    viewport.handlers.contextMenu = (e) => this.emit('contextmenu', e);
    viewport.handlers.dblclick = (e) => this._dblclick(e);
  }

  // ---------------------------------------------------------------- document lifecycle
  load(doc) {
    this.exitEdgeMode(false);
    this.editing = null;
    this.doc = doc;
    this.selection.clear();
    this.setFrame(null);
    this.ruler = null;
    this.alignAnchor = null;
    this.dupState = null;
    this.setTool('select');
    this.viewport.setWorkplaneSize(doc.workplane.width, doc.workplane.length);
    this.viewport.setGridStep(this.gridStep(), this.units === 'brick' ? 4 : 10);
    this.sync();
    this.history.reset(this._snapshot());
    this.emit('doc', { loaded: true });
    this.emit('selection');
    this.emit('history');
  }

  get snap() { return this.doc.workplane.snap; }
  get units() { return this.doc.workplane.units; }
  gridStep() { return this.units === 'in' ? 2.54 : this.units === 'brick' ? 8 : 1; }

  setWorkplane(patch) {
    Object.assign(this.doc.workplane, patch);
    this.viewport.setWorkplaneSize(this.doc.workplane.width, this.doc.workplane.length);
    this.viewport.setGridStep(this.gridStep(), this.units === 'brick' ? 4 : 10);
    this.emit('doc', { workplane: true });
    this.emit('selection');
  }

  _snapshot() {
    return {
      nodes: this.doc.nodes.map((n) => cloneNode(n)),
      notes: this.doc.notes.map((n) => ({ ...n, pos: [...n.pos] })),
      selection: [...this.selection],
    };
  }

  _restore(state) {
    this.doc.nodes = state.nodes.map((n) => cloneNode(n));
    this.doc.notes = state.notes.map((n) => ({ ...n, pos: [...n.pos] }));
    const ids = new Set(this.doc.nodes.map((n) => n.id));
    this.selection = new Set(state.selection.filter((id) => ids.has(id)));
    if (this.edgeMode) {
      if (ids.has(this.edgeMode.id) && this.selection.has(this.edgeMode.id)) { this.edgeMode.picked.clear(); this.edgeMode.hover = -1; }
      else this.exitEdgeMode(false);
    }
    this.dupState = null;
    this.alignAnchor = null;
    this.sync();
    this.emit('doc', {});
    this.emit('selection');
    this.emit('history');
  }

  commit() {
    this.history.push(this._snapshot());
    this.emit('doc', {});
    this.emit('history');
  }

  undo() { const s = this.history.undo(); if (s) this._restore(s); }
  redo() { const s = this.history.redo(); if (s) this._restore(s); }

  // ---------------------------------------------------------------- scene sync
  sync() {
    const live = new Set();
    for (const node of this.doc.nodes) {
      live.add(node.id);
      this._syncMesh(node);
    }
    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      this.viewport.objects.remove(mesh);
      if (mesh.material !== holeMaterial) mesh.material.dispose();
      const solid = mesh.userData.solidMaterial;
      if (solid && solid !== mesh.material) solid.dispose();
      this.meshes.delete(id);
    }
    if (this.edgeMode) {
      if (!this.meshes.has(this.edgeMode.id)) this.exitEdgeMode(false);
      else this._syncEdgeOverlay();
    }
    this.viewport.requestRender();
  }

  _syncMesh(node) {
    const geo = getGeometry(node);
    let mesh = this.meshes.get(node.id);
    if (!mesh) {
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.03 }));
      mesh.matrixAutoUpdate = false;
      mesh.userData.id = node.id;
      mesh.userData.solidMaterial = mesh.material;
      this.meshes.set(node.id, mesh);
      this.viewport.objects.add(mesh);
    }
    if (mesh.geometry !== geo) {
      mesh.geometry = geo;
      if (mesh.userData.line) { mesh.remove(mesh.userData.line); mesh.userData.line = null; }
    }
    mesh.matrix.fromArray(node.matrix);
    mesh.visible = !node.hidden;
    const solid = mesh.userData.solidMaterial;
    if (node.hole) {
      mesh.material = holeMaterial;
      mesh.castShadow = false;
      mesh.renderOrder = 2;
    } else {
      mesh.material = solid;
      const vc = node.type === 'group' && node.multicolor && !!geo.attributes.color;
      if (solid.vertexColors !== vc) { solid.vertexColors = vc; solid.needsUpdate = true; }
      solid.color.set(vc ? '#ffffff' : node.color);
      const tr = !!node.transparent;
      if (solid.transparent !== tr) { solid.transparent = tr; solid.needsUpdate = true; }
      solid.opacity = tr ? 0.45 : 1;
      solid.depthWrite = !tr;
      solid.side = mesh.matrix.determinant() < 0 || tr ? THREE.DoubleSide : THREE.FrontSide;
      mesh.castShadow = !tr;
      mesh.renderOrder = tr ? 1 : 0;
    }
    this._syncOutline(mesh, this.selection.has(node.id));
    mesh.updateMatrixWorld(true);
  }

  _syncOutline(mesh, selected) {
    const picking = this.edgeMode && this.edgeMode.id === mesh.userData.id;
    const want = selected && !picking ? selLineMat : this.settings.edges && !picking ? edgeLineMat : null;
    let line = mesh.userData.line;
    if (!want) {
      if (line) { mesh.remove(line); mesh.userData.line = null; }
      return;
    }
    const eg = getEdges(mesh.geometry);
    if (!eg) return;
    if (!line) {
      line = new THREE.LineSegments(eg, want);
      line.raycast = () => {};
      mesh.add(line);
      mesh.userData.line = line;
    }
    line.material = want;
  }

  refreshOutlines() {
    for (const [id, mesh] of this.meshes) { this._syncOutline(mesh, this.selection.has(id)); mesh.updateMatrixWorld(true); }
    this.viewport.requestRender();
  }

  /** Push node matrices to meshes without rebuilding anything (used while dragging). */
  touch(nodes) {
    for (const n of nodes) {
      const mesh = this.meshes.get(n.id);
      if (!mesh) continue;
      mesh.matrix.fromArray(n.matrix);
      mesh.updateMatrixWorld(true);
    }
    this.viewport.requestRender();
    this.emit('transform');
  }

  // ---------------------------------------------------------------- selection
  node(id) { return this.doc.nodes.find((n) => n.id === id); }
  selectedNodes() { return this.doc.nodes.filter((n) => this.selection.has(n.id)); }
  movableNodes() { return this.selectedNodes().filter((n) => !n.locked); }

  select(ids, { add = false, toggle = false } = {}) {
    this.exitEdgeMode(false);
    if (!add && !toggle) this.selection.clear();
    for (const id of ids) {
      if (toggle && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.alignAnchor = this.selection.has(this.alignAnchor) ? this.alignAnchor : null;
    this.refreshOutlines();
    this.emit('selection');
  }

  selectAll() { this.select(this.doc.nodes.filter((n) => !n.hidden).map((n) => n.id)); }
  clearSelection() { if (this.selection.size) this.select([]); }

  /** Bounds of nodes in workplane-frame coordinates (or world when world = true). */
  bounds(nodes, world = false) {
    const box = new THREE.Box3();
    const m = new THREE.Matrix4();
    for (const n of nodes) {
      const g = getGeometry(n);
      if (!g.attributes.position.count) continue;
      m.fromArray(n.matrix);
      if (!world) m.premultiply(this.frameInv);
      expandBox(box, g, m);
    }
    return box;
  }

  snapValue(v) {
    const s = this.snap;
    return s > 0 ? Math.round(v / s) * s : v;
  }

  /** Apply a frame-local delta matrix to nodes, starting from saved matrices. */
  applyLocal(nodes, start, deltaLocal) {
    const world = this.frame.clone().multiply(deltaLocal).multiply(this.frameInv);
    this.applyWorld(nodes, start, world);
  }

  applyWorld(nodes, start, deltaWorld) {
    const m = new THREE.Matrix4();
    for (const n of nodes) {
      m.fromArray(start.get(n.id)).premultiply(deltaWorld);
      m.toArray(n.matrix);
    }
    this.touch(nodes);
  }

  startMatrices(nodes) {
    const map = new Map();
    for (const n of nodes) map.set(n.id, [...n.matrix]);
    return map;
  }

  /** One-shot local transform of the movable selection, with history. */
  transformSelection(deltaLocal, nodes = this.movableNodes()) {
    if (!nodes.length) return;
    this.applyLocal(nodes, this.startMatrices(nodes), deltaLocal);
    this.sync();
    this.commit();
    this.emit('selection');
  }

  // ---------------------------------------------------------------- workplane frame / tools
  setFrame(matrix) {
    if (matrix) {
      this.frame.copy(matrix);
      this.hasFrame = true;
    } else {
      this.frame.identity();
      this.hasFrame = false;
    }
    this.frameInv.copy(this.frame).invert();
    this.ruler = null;
    this.viewport.setFrame(this.hasFrame ? this.frame : null);
    this.emit('selection');
    this.emit('tool');
  }

  setTool(tool) {
    if (this.placing && tool !== 'place') this.cancelPlace();
    if (tool !== 'select') this.exitEdgeMode(false);
    this.tool = this.tool === tool && tool !== 'select' && tool !== 'place' ? 'select' : tool;
    if (this.tool !== 'align') this.alignAnchor = null;
    this.viewport.canvas.style.cursor = ['workplane', 'ruler', 'note'].includes(this.tool) ? 'crosshair' : '';
    this.emit('tool');
    this.emit('selection');
  }

  toggleCruise() {
    this.cruise = !this.cruise;
    this.emit('tool');
    toast(this.cruise ? 'Cruise on: drag a shape onto other shapes' : 'Cruise off');
  }

  localRay(e) { return this.viewport.rayFromClient(e.clientX, e.clientY).applyMatrix4(this.frameInv); }

  /** Intersection of the pointer with the workplane (frame z = height), in frame coordinates. */
  planePoint(e, height = 0) {
    const ray = this.localRay(e);
    if (Math.abs(ray.direction.z) < 1e-6) return null;
    const t = (height - ray.origin.z) / ray.direction.z;
    if (t < 0) return null;
    return ray.at(t, new THREE.Vector3());
  }

  pickNode(e, exclude = null) {
    const list = [];
    for (const [id, mesh] of this.meshes) if (mesh.visible && !(exclude && exclude.has(id))) list.push(mesh);
    const hits = this.viewport.pick(e.clientX, e.clientY, list);
    if (!hits.length) return null;
    const hit = hits[0];
    const normal = hit.face
      ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize()
      : new THREE.Vector3(0, 0, 1);
    return { node: this.node(hit.object.userData.id), point: hit.point.clone(), normal, mesh: hit.object };
  }

  // ---------------------------------------------------------------- edge rounding
  // Edge mode: the sharp edges of the one selected shape or group are drawn over it and can be
  // clicked to pick them, then rounded with their own radius. Edges are stored by where they
  // are on the shape (node.edgeRounds), so they survive resizing and edits nearby.

  enterEdgeMode() {
    const nodes = this.movableNodes();
    if (nodes.length !== 1 || nodes[0].hidden) return false;
    const d = nodeEdgeData(nodes[0]);
    if (d.tooDetailed) { toast('This shape has too much detail to pick edges', 'warn', 4000); return false; }
    if (!d.chains.length) { toast('This shape has no sharp edges to round', 'warn', 4000); return false; }
    this.edgeMode = { id: nodes[0].id, picked: new Set(), hover: -1 };
    this.refreshOutlines();
    this._syncEdgeOverlay();
    this.emit('selection');
    return true;
  }

  exitEdgeMode(emit = true) {
    if (!this.edgeMode) return;
    const mesh = this.meshes.get(this.edgeMode.id);
    this.edgeMode = null;
    if (mesh && mesh.userData.edgeOverlay) {
      for (const l of mesh.userData.edgeOverlay) { mesh.remove(l); l.geometry.dispose(); l.material.dispose(); }
      mesh.userData.edgeOverlay = null;
    }
    this.viewport.canvas.style.cursor = '';
    this.refreshOutlines();
    if (emit) this.emit('selection');
  }

  /** Edge mode state for the inspector: the node, its edges, which are picked and their radii. */
  edgeInfo() {
    const em = this.edgeMode;
    const node = em && this.node(em.id);
    if (!node) return null;
    const d = nodeEdgeData(node);
    const idx = edgeRoundIndex(node);
    const radii = idx.map((k) => (k === undefined ? undefined : node.edgeRounds[k].r));
    return { node, count: d.chains.length, picked: [...em.picked], radii, rounded: radii.filter((r) => r > 0).length };
  }

  pickAllEdges(on = true) {
    if (!this.edgeMode) return;
    const d = nodeEdgeData(this.node(this.edgeMode.id));
    this.edgeMode.picked = new Set(on ? d.chains.map((_, i) => i) : []);
    this._syncEdgeOverlay();
    this.emit('selection');
  }

  /** Round the picked edges with radius r (0 removes their rounding). */
  async roundPickedEdges(r) {
    const em = this.edgeMode;
    const node = em && this.node(em.id);
    if (!node || !em.picked.size) return;
    const d = nodeEdgeData(node);
    const idx = edgeRoundIndex(node);
    const replaced = new Set([...em.picked].map((i) => idx[i]).filter((k) => k !== undefined));
    const keep = (node.edgeRounds || []).filter((_, k) => !replaced.has(k));
    const added = r > 0 ? [...em.picked].map((i) => ({ sig: d.sigs[i], r })) : [];
    const next = [...keep, ...added];
    await this._busy(() => {
      if (next.length) node.edgeRounds = next; else delete node.edgeRounds;
      this.sync();
      this.commit();
    });
    if (r > 0) {
      const failed = geoStats.edgeRoundsFailed || 0;
      if (failed) toast(failed === added.length ? 'Those edges could not be rounded (try a smaller radius)' : `${failed} edge${failed > 1 ? 's' : ''} could not be rounded`, 'warn', 4000);
    }
    this.emit('selection');
  }

  _syncEdgeOverlay() {
    const em = this.edgeMode;
    const node = em && this.node(em.id);
    const mesh = em && this.meshes.get(em.id);
    if (!node || !mesh) return;
    const d = nodeEdgeData(node);
    if (em.key !== d.key) { if (em.key) em.picked.clear(); em.key = d.key; } // edges were re-found: old picks no longer apply
    const idx = edgeRoundIndex(node);
    const pos = [], col = [];
    const C = { base: new THREE.Color(0x9aa7b8), round: new THREE.Color(0xff9800), pick: new THREE.Color(0x29c5ff), hover: new THREE.Color(0xffffff) };
    d.lines.forEach((pts, i) => {
      const c = i === em.hover ? C.hover : em.picked.has(i) ? C.pick : idx[i] !== undefined ? C.round : C.base;
      const n = pts.length, segs = d.chains[i].closed ? n : n - 1;
      for (let k = 0; k < segs; k++) {
        const a = pts[k], b = pts[(k + 1) % n];
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    });
    const geo = new LineSegmentsGeometry();
    geo.setPositions(pos);
    geo.setColors(col);
    let lines = mesh.userData.edgeOverlay;
    if (!lines) {
      // thick lines, plus a faint copy drawn through the model so edges on the far side can still be found
      const behind = new LineSegments2(geo, new LineMaterial({ vertexColors: true, linewidth: 1.5, transparent: true, opacity: 0.25, depthTest: false }));
      const front = new LineSegments2(geo, new LineMaterial({ vertexColors: true, linewidth: 3 }));
      behind.renderOrder = 5; front.renderOrder = 6;
      for (const l of [behind, front]) { l.raycast = () => {}; mesh.add(l); }
      lines = mesh.userData.edgeOverlay = [behind, front];
    } else {
      const old = lines[0].geometry;
      for (const l of lines) l.geometry = geo;
      old.dispose();
    }
    for (const l of lines) l.material.resolution.set(this.viewport.width, this.viewport.height);
    mesh.updateMatrixWorld(true);
    this.viewport.requestRender();
  }

  /** Index of the edge under the pointer (nearest on screen, not hidden by the model), or -1. */
  _pickEdge(e) {
    const em = this.edgeMode;
    const node = this.node(em.id), mesh = this.meshes.get(em.id);
    if (!node || !mesh) return -1;
    const vp = this.viewport;
    const d = nodeEdgeData(node);
    const idx = edgeRoundIndex(node);
    const rect = vp.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const W = mesh.matrixWorld;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), pa = {}, pb = {};
    const cands = [];
    d.lines.forEach((pts, i) => {
      let best = Infinity, at = null;
      const n = pts.length, segs = d.chains[i].closed ? n : n - 1;
      for (let k = 0; k < segs; k++) {
        a.copy(pts[k]).applyMatrix4(W); b.copy(pts[(k + 1) % n]).applyMatrix4(W);
        vp.project(a, pa); vp.project(b, pb);
        if (pa.behind || pb.behind) continue;
        const dx = pb.x - pa.x, dy = pb.y - pa.y, L = dx * dx + dy * dy;
        const t = L > 0 ? Math.min(1, Math.max(0, ((mx - pa.x) * dx + (my - pa.y) * dy) / L)) : 0;
        const dist = Math.hypot(pa.x + t * dx - mx, pa.y + t * dy - my);
        if (dist < best) { best = dist; at = a.clone().lerp(b, t); }
      }
      if (best < 10) cands.push({ i, dist: best, at });
    });
    if (!cands.length) return -1;
    cands.sort((p, q) => p.dist - q.dist);
    const ray = vp.rayFromClient(e.clientX, e.clientY);
    const hits = vp.pick(e.clientX, e.clientY, [...this.meshes.values()].filter((m) => m.visible));
    const front = hits.length ? hits[0].distance : Infinity;
    const s = node.matrix;
    const scale = Math.max(Math.hypot(s[0], s[1], s[2]), Math.hypot(s[4], s[5], s[6]), Math.hypot(s[8], s[9], s[10]));
    for (const c of cands) {
      const along = c.at.clone().sub(ray.origin).dot(ray.direction);
      // a rounded edge sits off the surface (or inside a filled corner), so allow for its radius
      const r = idx[c.i] !== undefined ? node.edgeRounds[idx[c.i]].r : 0;
      if (along <= front + vp.unitsPerPixel(c.at) * 8 + r * scale * 1.5) return c.i;
    }
    return -1;
  }

  _edgeHover(e) {
    const i = this._pickEdge(e);
    this.viewport.canvas.style.cursor = i >= 0 ? 'pointer' : '';
    if (i !== this.edgeMode.hover) { this.edgeMode.hover = i; this._syncEdgeOverlay(); }
  }

  _edgeClick(e) {
    const em = this.edgeMode;
    const i = this._pickEdge(e);
    if (i < 0) {
      const hit = this.pickNode(e);
      if (hit && hit.node.id !== em.id) this.select([hit.node.id]); // clicking another shape leaves edge mode
      return;
    }
    if (em.picked.has(i)) em.picked.delete(i); else em.picked.add(i);
    this._syncEdgeOverlay();
    this.emit('selection');
  }

  // ---------------------------------------------------------------- pointer handling
  _hover(e) {
    if (this.disabled) return;
    if (this.edgeMode) return this._edgeHover(e);
    if (this.tool === 'workplane' || this.tool === 'ruler' || this.tool === 'note' || this.placing) return;
    const hit = this.pickNode(e);
    this.viewport.canvas.style.cursor = hit && !hit.node.locked ? 'move' : '';
  }

  _dblclick(e) {
    if (this.disabled || this.edgeMode) return;
    const hit = this.pickNode(e);
    if (hit) this.emit('dblclick', hit.node);
  }

  _leftDown(e) {
    if (this.disabled || this.placing) return; // handled by the placement listeners
    if (this.edgeMode) return this._edgeClick(e);
    if (this.tool === 'workplane') return this._pickWorkplane(e);
    if (this.tool === 'ruler') {
      const p = this.planePoint(e);
      if (p) this.ruler = { x: this.snapValue(p.x), y: this.snapValue(p.y) };
      this.setTool('select');
      return;
    }
    if (this.tool === 'note') {
      const hit = this.pickNode(e);
      let pos = hit ? hit.point : null;
      if (!pos) { const p = this.planePoint(e); if (p) pos = p.applyMatrix4(this.frame); }
      if (pos) this.emit('note-new', pos);
      this.setTool('select');
      return;
    }
    const hit = this.pickNode(e);
    if (!hit) return this._marquee(e);
    const node = hit.node;
    if (this.tool === 'align' && this.selection.has(node.id) && !e.shiftKey) {
      this.alignAnchor = this.alignAnchor === node.id ? null : node.id;
      this.emit('selection');
      return;
    }
    if (e.shiftKey) { this.select([node.id], { toggle: true }); return; }
    if (!this.selection.has(node.id)) this.select([node.id]);
    this._dragMove(e, hit);
  }

  _pickWorkplane(e) {
    const hit = this.pickNode(e);
    if (!hit) {
      this.setFrame(null);
    } else {
      const n = hit.normal.clone();
      if (e.shiftKey) n.negate();
      const up = new THREE.Vector3(0, 0, 1);
      let x = new THREE.Vector3().crossVectors(up, n);
      if (x.lengthSq() < 1e-6) x.set(1, 0, 0); else x.normalize();
      if (Math.abs(n.z) > 0.999) x.set(1, 0, 0);
      const y = new THREE.Vector3().crossVectors(n, x).normalize();
      this.setFrame(new THREE.Matrix4().makeBasis(x, y, n).setPosition(hit.point));
    }
    this.setTool('select');
  }

  /** Put the workplane on top of the current selection (Shift+W). */
  workplaneAtSelection() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const b = this.bounds(nodes);
    const origin = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z).applyMatrix4(this.frame);
    this.setFrame(this.frame.clone().setPosition(origin));
  }

  _track(e, onMove, onEnd) {
    const el = this.viewport.canvas;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd(ev);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  _dragMove(e, hit) {
    const sx = e.clientX, sy = e.clientY;
    let dragging = false, nodes, start, box0, hitLocal, moved = false, dup = false;
    const begin = (ev) => {
      if (ev.altKey) dup = this._duplicateInPlace().length > 0;
      nodes = this.movableNodes();
      if (!nodes.length) return false;
      start = this.startMatrices(nodes);
      box0 = this.bounds(nodes);
      hitLocal = hit.point.clone().applyMatrix4(this.frameInv);
      this.emit('drag', true);
      return true;
    };
    this._track(e, (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        if (!begin(ev)) return;
        dragging = true;
      }
      if (this.cruise) {
        const target = this.pickNode(ev, this.selection);
        if (target) {
          const c0 = new THREE.Vector3((box0.min.x + box0.max.x) / 2, (box0.min.y + box0.max.y) / 2, box0.min.z).applyMatrix4(this.frame);
          const up = new THREE.Vector3(0, 0, 1).transformDirection(this.frame);
          const rot = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, target.normal));
          const world = T(target.point.x, target.point.y, target.point.z).multiply(rot).multiply(T(-c0.x, -c0.y, -c0.z));
          this.applyWorld(nodes, start, world);
          moved = true;
          return;
        }
      }
      const p = this.planePoint(ev, hitLocal.z);
      if (!p) return;
      let dx = p.x - hitLocal.x, dy = p.y - hitLocal.y;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      dx = this.snapValue(box0.min.x + dx) - box0.min.x;
      dy = this.snapValue(box0.min.y + dy) - box0.min.y;
      if (ev.shiftKey) { if (Math.abs(p.x - hitLocal.x) > Math.abs(p.y - hitLocal.y)) dy = 0; else dx = 0; }
      this.applyLocal(nodes, start, T(dx, dy, 0));
      moved = true;
    }, () => {
      if (!dragging) return;
      this.emit('drag', false);
      if (moved || dup) { this.sync(); this.commit(); this.emit('selection'); }
    });
  }

  _marquee(e) {
    const sx = e.clientX, sy = e.clientY;
    const rect = this.viewport.canvas.getBoundingClientRect();
    let box = null;
    this._track(e, (ev) => {
      if (!box) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        box = document.createElement('div');
        box.className = 'marquee';
        this.viewport.container.appendChild(box);
      }
      box.style.left = Math.min(sx, ev.clientX) - rect.left + 'px';
      box.style.top = Math.min(sy, ev.clientY) - rect.top + 'px';
      box.style.width = Math.abs(ev.clientX - sx) + 'px';
      box.style.height = Math.abs(ev.clientY - sy) + 'px';
    }, (ev) => {
      if (!box) {
        if (!e.shiftKey) this.clearSelection();
        return;
      }
      box.remove();
      const x0 = Math.min(sx, ev.clientX) - rect.left, x1 = Math.max(sx, ev.clientX) - rect.left;
      const y0 = Math.min(sy, ev.clientY) - rect.top, y1 = Math.max(sy, ev.clientY) - rect.top;
      const ids = [];
      const v = new THREE.Vector3(), out = {};
      for (const n of this.doc.nodes) {
        if (n.hidden) continue;
        const b = this.bounds([n], true);
        if (b.isEmpty()) continue;
        let inside = true;
        for (let i = 0; i < 8 && inside; i++) {
          v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
          this.viewport.project(v, out);
          if (out.behind || out.x < x0 || out.x > x1 || out.y < y0 || out.y > y1) inside = false;
        }
        if (inside) ids.push(n.id);
      }
      this.select(ids, { add: e.shiftKey });
    });
  }

  // ---------------------------------------------------------------- adding shapes
  /** Position a new node so its footprint is centred on (x, y) of the workplane and it rests on it. */
  placeAt(node, x, y) {
    const base = node._base || (node._base = [...node.matrix]);
    const g = getGeometry(node);
    const box = expandBox(new THREE.Box3(), g, mat4(base));
    const cx = box.isEmpty() ? 0 : (box.min.x + box.max.x) / 2, cy = box.isEmpty() ? 0 : (box.min.y + box.max.y) / 2;
    const minz = box.isEmpty() ? 0 : box.min.z;
    const hw = box.isEmpty() ? 0 : (box.max.x - box.min.x) / 2, hl = box.isEmpty() ? 0 : (box.max.y - box.min.y) / 2;
    // snap the footprint corner so edges land on the grid
    const px = this.snapValue(x - hw) + hw, py = this.snapValue(y - hl) + hl;
    const m = this.frame.clone().multiply(T(px - cx, py - cy, -minz)).multiply(mat4(base));
    m.toArray(node.matrix);
  }

  addNode(node, { select = true, commit = true } = {}) {
    delete node._base;
    this.doc.nodes.push(node);
    if (select) this.selection = new Set([node.id]);
    this.sync();
    if (commit) this.commit();
    this.emit('selection');
  }

  /** Workplane point under the middle of the viewport (falls back to the origin). */
  viewCenterPoint() {
    const r = this.viewport.canvas.getBoundingClientRect();
    // the 3D view is hidden (e.g. laser workspace): there is no meaningful view centre
    if (!(r.width > 0 && r.height > 0)) return { x: 0, y: 0 };
    const p = this.planePoint({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return { x: 0, y: 0 };
    const hw = this.doc.workplane.width / 2, hl = this.doc.workplane.length / 2;
    if (!this.hasFrame && (Math.abs(p.x) > hw * 1.5 || Math.abs(p.y) > hl * 1.5)) return { x: 0, y: 0 };
    return { x: p.x, y: p.y };
  }

  addAtViewCenter(node) {
    const c = this.viewCenterPoint();
    this.placeAt(node, c.x, c.y);
    this.addNode(node);
  }

  /** Interactive placement: the shape follows the pointer until it is dropped / clicked. */
  beginPlace(node, { drag = false } = {}) {
    this.cancelPlace();
    this.setTool('place');
    const ghost = new THREE.Mesh(getGeometry(node), new THREE.MeshStandardMaterial({
      color: node.hole ? '#c9d0d8' : node.color, transparent: true, opacity: 0.6, depthWrite: false,
      vertexColors: node.type === 'group' && node.multicolor,
    }));
    if (ghost.material.vertexColors) ghost.material.color.set('#ffffff');
    ghost.matrixAutoUpdate = false;
    ghost.visible = false;
    this.viewport.helpers.add(ghost);
    const canvas = this.viewport.canvas;
    const overCanvas = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      return el === canvas || (el && el.closest && el.closest('.gizmo-layer') && !el.closest('.gz-handle'));
    };
    const update = (ev) => {
      const p = overCanvas(ev) ? this.planePoint(ev) : null;
      ghost.visible = !!p;
      if (p) {
        this.placeAt(node, p.x, p.y);
        ghost.matrix.fromArray(node.matrix);
        ghost.updateMatrixWorld(true);
      }
      this.viewport.requestRender();
      return !!p;
    };
    const finish = (ev) => {
      const ok = update(ev);
      this.cancelPlace();
      if (ok) this.addNode(node);
    };
    const onMove = (ev) => update(ev);
    const onUp = (ev) => { if (drag) finish(ev); };
    const onDown = (ev) => {
      if (drag || ev.button !== 0) return;
      if (overCanvas(ev)) { ev.preventDefault(); ev.stopPropagation(); finish(ev); }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointerdown', onDown, true);
    this.placing = {
      node,
      dispose: () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointerdown', onDown, true);
        this.viewport.helpers.remove(ghost);
        ghost.material.dispose();
        this.viewport.requestRender();
      },
    };
  }

  cancelPlace() {
    if (!this.placing) return;
    this.placing.dispose();
    this.placing = null;
    if (this.tool === 'place') { this.tool = 'select'; this.emit('tool'); }
  }

  // ---------------------------------------------------------------- commands
  deleteSelection() {
    const ids = new Set(this.movableNodes().map((n) => n.id));
    if (!ids.size) return;
    this.doc.nodes = this.doc.nodes.filter((n) => !ids.has(n.id));
    for (const id of ids) this.selection.delete(id);
    this.sync();
    this.commit();
    this.emit('selection');
  }

  copy(nodes = this.selectedNodes()) {
    if (!nodes.length) return;
    this.clipboard = nodes.map((n) => cloneNode(n));
    this.pasteCount = 0;
    toast(nodes.length === 1 ? 'Copied 1 shape' : `Copied ${nodes.length} shapes`);
  }

  cut() {
    // locked shapes are not deleted, so they are not cut either
    const nodes = this.movableNodes();
    if (!nodes.length) return;
    this.copy(nodes);
    this.pasteCount = -1;
    this.deleteSelection();
  }

  paste(inPlace = false) {
    if (!this.clipboard || !this.clipboard.length) return;
    this.pasteCount += 1;
    const step = inPlace ? 0 : Math.max(this.snap, 1) * 10 * this.pasteCount;
    const delta = this.frame.clone().multiply(T(step, 0, 0)).multiply(this.frameInv);
    const fresh = this.clipboard.map((n) => {
      const c = cloneNode(n, true);
      c.locked = false;
      mat4(c.matrix).premultiply(delta).toArray(c.matrix);
      return c;
    });
    this.doc.nodes.push(...fresh);
    this.selection = new Set(fresh.map((n) => n.id));
    this.sync();
    this.commit();
    this.emit('selection');
  }

  _duplicateInPlace() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return [];
    const fresh = nodes.map((n) => { const c = cloneNode(n, true); c.locked = false; return c; });
    this.doc.nodes.push(...fresh);
    this.selection = new Set(fresh.map((n) => n.id));
    this.sync();
    this.emit('selection');
    return fresh;
  }

  /** Ctrl+D: duplicate in place; after transforming the copy, repeat that transform on each press. */
  duplicate() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const ds = this.dupState;
    const repeat = ds && nodes.length === ds.start.size && nodes.every((n) => ds.start.has(n.id));
    const start = new Map();
    const fresh = nodes.map((n) => {
      const c = cloneNode(n, true);
      c.locked = false;
      if (repeat) {
        const cur = mat4(n.matrix);
        const delta = cur.clone().multiply(mat4(ds.start.get(n.id)).invert());
        delta.multiply(cur).toArray(c.matrix);
      }
      start.set(c.id, [...n.matrix]);
      return c;
    });
    this.doc.nodes.push(...fresh);
    this.selection = new Set(fresh.map((n) => n.id));
    this.dupState = { start };
    this.sync();
    this.commit();
    this.emit('selection');
  }

  async group(mode = 'union') {
    const nodes = this.movableNodes();
    if (nodes.length < 2) { toast('Select two or more shapes to group'); return; }
    const ids = new Set(nodes.map((n) => n.id));
    const index = this.doc.nodes.findIndex((n) => n.id === nodes[nodes.length - 1].id);
    const g = makeGroup(nodes.map((n) => cloneNode(n)), mode);
    await this._busy(() => getGeometry(g));
    const after = this.doc.nodes[index + 1];
    this.doc.nodes = this.doc.nodes.filter((n) => !ids.has(n.id));
    const at = after ? this.doc.nodes.indexOf(after) : this.doc.nodes.length;
    this.doc.nodes.splice(at, 0, g);
    this.selection = new Set([g.id]);
    this.sync();
    this.commit();
    this.emit('selection');
    if (!getGeometry(g).attributes.position.count) toast('The result is empty: the holes removed everything', 'warn', 4000);
    else if (geoStats.csgFailures && mode !== 'bundle') { /* a fallback merge was reported in the console */ }
  }

  ungroup() {
    const groups = this.movableNodes().filter((n) => n.type === 'group');
    if (!groups.length) return;
    const selected = [];
    for (const g of groups) {
      const gm = mat4(g.matrix);
      const kids = g.children.map((c) => {
        const k = cloneNode(c);
        gm.clone().multiply(mat4(c.matrix)).toArray(k.matrix);
        return k;
      });
      const at = this.doc.nodes.indexOf(g);
      this.doc.nodes.splice(at, 1, ...kids);
      this.selection.delete(g.id);
      selected.push(...kids.map((k) => k.id));
    }
    for (const id of selected) this.selection.add(id);
    this.sync();
    this.commit();
    this.emit('selection');
  }

  /** Open a group for editing: its parts become ordinary shapes until exitGroup(). */
  enterGroup(node) {
    this.exitEdgeMode(false);
    if (this.editing || !node || node.type !== 'group' || node.locked) return false;
    const gm = mat4(node.matrix);
    const kids = node.children.map((c) => {
      const k = cloneNode(c);
      gm.clone().multiply(mat4(c.matrix)).toArray(k.matrix);
      return k;
    });
    const at = this.doc.nodes.indexOf(node);
    if (at < 0) return false;
    const outside = new Set(this.doc.nodes.filter((n) => n.id !== node.id).map((n) => n.id));
    this.doc.nodes.splice(at, 1, ...kids);
    this.editing = { id: node.id, mode: node.mode, name: node.name, color: node.color, hole: node.hole, multicolor: node.multicolor, transparent: node.transparent, outside };
    this.selection = new Set();
    this.sync();
    this.commit();
    this.emit('selection');
    this.emit('editing', true);
    return true;
  }

  /** Close the group opened with enterGroup(), re-combining its parts (and anything added meanwhile). */
  async exitGroup() {
    this.exitEdgeMode(false);
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    // undo may have brought the original group back; then there is nothing to rebuild
    if (!this.doc.nodes.some((n) => n.id === e.id)) {
      const members = this.doc.nodes.filter((n) => !e.outside.has(n.id));
      if (members.length >= 2) {
        for (const m of members) m.locked = false;
        this.selection = new Set(members.map((n) => n.id));
        await this.group(e.mode);
        const g = this.selectedNodes()[0];
        if (g && g.type === 'group') {
          Object.assign(g, { name: e.name, color: e.color, multicolor: e.multicolor, transparent: e.transparent, hole: e.hole });
          this.sync();
          this.commit();
          this.emit('selection');
        }
      }
    }
    this.emit('editing', false);
  }

  /** Run a potentially slow job after letting the busy indicator paint. */
  async _busy(fn) {
    this.busy = true;
    this.emit('busy', true);
    await new Promise((r) => setTimeout(r, 30));
    try { return await fn(); } finally {
      this.busy = false;
      this.emit('busy', false);
    }
  }

  patchSelection(patch, { commit = true, includeLocked = false } = {}) {
    const nodes = includeLocked ? this.selectedNodes() : this.movableNodes();
    if (!nodes.length) return;
    for (const n of nodes) Object.assign(n, typeof patch === 'function' ? patch(n) : patch);
    this.sync();
    if (commit) this.commit();
    this.emit('selection');
  }

  setHole(hole) { this.patchSelection({ hole }); }
  setColor(color, commit = true) {
    this.patchSelection((n) => (n.type === 'group' ? { color, multicolor: false, hole: false } : { color, hole: false }), { commit });
  }
  setMulticolor(on) { this.patchSelection((n) => (n.type === 'group' ? { multicolor: on } : {})); }
  toggleTransparent() {
    const nodes = this.movableNodes();
    const on = !nodes.every((n) => n.transparent);
    this.patchSelection({ transparent: on });
  }
  toggleLock() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const lock = !nodes.every((n) => n.locked);
    this.patchSelection({ locked: lock }, { includeLocked: true });
  }
  hideSelection() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    for (const n of nodes) n.hidden = true;
    this.selection.clear();
    this.sync();
    this.commit();
    this.emit('selection');
  }
  showAll() {
    if (!this.doc.nodes.some((n) => n.hidden)) return;
    for (const n of this.doc.nodes) n.hidden = false;
    this.sync();
    this.commit();
    this.emit('selection');
  }

  setParam(key, value, commit = true, ids = null) {
    const pool = ids ? ids.map((id) => this.node(id)).filter((n) => n && !n.locked) : this.movableNodes();
    const nodes = pool.filter((n) => n.type === 'shape' && key in n.params);
    if (!nodes.length) return;
    for (const n of nodes) n.params = { ...n.params, [key]: value };
    this.sync();
    if (commit) this.commit();
    this.emit('transform');
  }

  rename(id, name) {
    const n = this.node(id);
    if (!n) return;
    n.name = name;
    this.commit();
  }

  nudge(dx, dy, dz) {
    const step = this.snap > 0 ? this.snap : 1;
    this.transformSelection(T(dx * step, dy * step, dz * step));
  }

  dropToWorkplane() {
    const nodes = this.movableNodes();
    if (!nodes.length) return;
    const start = this.startMatrices(nodes);
    for (const n of nodes) {
      const b = this.bounds([n]);
      if (!b.isEmpty()) this.applyLocal([n], start, T(0, 0, -b.min.z));
    }
    this.sync();
    this.commit();
    this.emit('selection');
  }

  /** axis: 'x'|'y'|'z', mode: 'min'|'center'|'max'. preview = don't commit (returns restore fn). */
  align(axis, mode, preview = false) {
    const nodes = this.movableNodes();
    if (!nodes.length) return () => {};
    const anchor = this.alignAnchor && this.node(this.alignAnchor);
    const ref = this.bounds(anchor ? [anchor] : this.selectedNodes());
    const pos = (b) => (mode === 'min' ? b.min[axis] : mode === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2);
    const start = this.startMatrices(nodes);
    for (const n of nodes) {
      if (anchor && n.id === anchor.id) continue;
      const b = this.bounds([n]);
      if (b.isEmpty()) continue;
      const d = pos(ref) - pos(b);
      this.applyLocal([n], start, T(axis === 'x' ? d : 0, axis === 'y' ? d : 0, axis === 'z' ? d : 0));
    }
    if (preview) {
      return () => { for (const n of nodes) n.matrix = [...start.get(n.id)]; this.touch(nodes); };
    }
    this.sync();
    this.commit();
    this.emit('selection');
    return () => {};
  }

  mirror(axis) {
    const nodes = this.movableNodes();
    if (!nodes.length) return;
    const c = this.bounds(nodes).getCenter(new THREE.Vector3());
    this.transformSelection(about(c, S(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1)), nodes);
  }

  rotateSelection(axis, degrees) {
    const nodes = this.movableNodes();
    if (!nodes.length || !degrees) return;
    const c = this.bounds(nodes).getCenter(new THREE.Vector3());
    const a = (degrees * Math.PI) / 180;
    const r = axis === 'x' ? new THREE.Matrix4().makeRotationX(a) : axis === 'y' ? new THREE.Matrix4().makeRotationY(a) : new THREE.Matrix4().makeRotationZ(a);
    this.transformSelection(about(c, r), nodes);
  }

  /** Set an absolute size along an axis (frame coordinates), anchored at the minimum side. */
  setSize(axis, value, uniform = false) {
    const nodes = this.movableNodes();
    const b = this.bounds(nodes);
    if (b.isEmpty() || !(value > 0)) return;
    const size = b.max[axis] - b.min[axis];
    if (size < 1e-9) return;
    const f = value / size;
    const s = uniform ? S(f, f, f) : S(axis === 'x' ? f : 1, axis === 'y' ? f : 1, axis === 'z' ? f : 1);
    this.transformSelection(about(new THREE.Vector3(b.min.x, b.min.y, b.min.z), s), nodes);
  }

  setPosition(axis, value) {
    const nodes = this.movableNodes();
    const b = this.bounds(nodes);
    if (b.isEmpty() || !isFinite(value)) return;
    const d = value - b.min[axis];
    this.transformSelection(T(axis === 'x' ? d : 0, axis === 'y' ? d : 0, axis === 'z' ? d : 0), nodes);
  }

  /** Linear or circular pattern of the selection. */
  pattern({ type, count, dx = 0, dy = 0, dz = 0, angle = 360 }) {
    const nodes = this.selectedNodes();
    if (!nodes.length || count < 2) return;
    const all = [...nodes.map((n) => n.id)];
    const center = type === 'circular' ? new THREE.Vector3(0, 0, 0) : null;
    for (let i = 1; i < count; i++) {
      let local;
      if (type === 'circular') {
        const full = Math.abs(angle) >= 360;
        const a = ((angle * Math.PI) / 180) * (i / (full ? count : count - 1));
        local = about(center, new THREE.Matrix4().makeRotationZ(a));
      } else {
        local = T(dx * i, dy * i, dz * i);
      }
      const world = this.frame.clone().multiply(local).multiply(this.frameInv);
      for (const n of nodes) {
        const c = cloneNode(n, true);
        c.locked = false;
        mat4(c.matrix).premultiply(world).toArray(c.matrix);
        this.doc.nodes.push(c);
        all.push(c.id);
      }
    }
    this.selection = new Set(all);
    this.sync();
    this.commit();
    this.emit('selection');
  }

  // ---------------------------------------------------------------- notes
  addNote(pos, text) {
    this.doc.notes.push({ id: uid('note'), pos: [pos.x, pos.y, pos.z], text });
    this.commit();
  }
  updateNote(id, text) {
    const n = this.doc.notes.find((x) => x.id === id);
    if (!n) return;
    n.text = text;
    this.commit();
  }
  removeNote(id) {
    this.doc.notes = this.doc.notes.filter((x) => x.id !== id);
    this.commit();
  }

  // ---------------------------------------------------------------- info
  measureNodes(nodes) {
    let volume = 0, area = 0, triangles = 0;
    for (const n of nodes) {
      if (n.hole) continue;
      const m = measure(getGeometry(n), mat4(n.matrix));
      volume += m.volume; area += m.area; triangles += m.triangles;
    }
    return { volume, area, triangles };
  }

  worldBounds(nodes = this.doc.nodes.filter((n) => !n.hidden)) { return this.bounds(nodes, true); }

  fitView() {
    const sel = this.selectedNodes();
    const box = this.worldBounds(sel.length ? sel : undefined);
    if (box.isEmpty()) this.viewport.home(); else this.viewport.fit(box);
  }
}
