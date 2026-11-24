// Editor: owns the document, selection, tools and every modelling command.
import * as THREE from 'three';
import { History, cloneNode, makeGroup, makeShape, mat4, uid, newDoc } from './core/doc.js';
import { kindName } from './core/shapes.js';
import { getGeometry, expandBox, getEdges, measure, nodeEdgeData, edgeRoundIndex, stats as geoStats } from './core/geometry.js';
import { toast } from './ui/dom.js';
import { PartTool } from './parttool.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

class Emitter {
  constructor() { this._l = {}; }
  on(evt, fn) { (this._l[evt] ||= []).push(fn); return this; }
  emit(evt, data) { for (const fn of this._l[evt] || []) fn(data); }
}

/**
 * Thick edge lines that win the depth test against the faces they lie on. An inside (valley)
 * edge is the deepest point of its corner, so without this the faces either side hide most of
 * the line. Each end is pulled 1.5% of its distance toward the camera along its own view ray,
 * which leaves it at the same place on screen.
 */
function edgeLineMaterial() {
  const m = new LineMaterial({ color: SEL_COLOR, linewidth: 3 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );',
      `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
      if ( projectionMatrix[ 2 ][ 3 ] == - 1.0 ) { start.xyz *= 0.985; end.xyz *= 0.985; }
      else { start.z += 0.6; end.z += 0.6; }`);
  };
  return m;
}

/** The thin selection line, pulled toward the camera the same way so inside edges show. */
function edgeThinMaterial() {
  const m = new THREE.LineBasicMaterial({ color: SEL_COLOR });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      if ( projectionMatrix[ 2 ][ 3 ] == - 1.0 ) mvPosition.xyz *= 0.985; else mvPosition.z += 0.6;
      gl_Position = projectionMatrix * mvPosition;`);
  };
  return m;
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

    this.parts = new PartTool(this); // Face and Corner modes, and moving picked parts
    viewport.handlers.leftDown = (e) => this._leftDown(e);
    viewport.handlers.hover = (e) => this._hover(e);
    viewport.handlers.contextMenu = (e) => this.emit('contextmenu', e);
    viewport.handlers.dblclick = (e) => this._dblclick(e);
  }

  // ---------------------------------------------------------------- document lifecycle
  load(doc) {
    this.exitEdgeMode(false);
    this.parts.end();
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
      const em = this.edgeMode;
      if (!ids.has(em.id)) em.id = null;
      em.picked.clear(); em.hover = null; em.key = null;
    }
    if (this.parts) this.parts.reset();
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
      const em = this.edgeMode;
      if (em.id && !this.meshes.has(em.id)) { em.id = null; em.picked.clear(); }
      if (em.hoverId && !this.meshes.has(em.hoverId)) { em.hoverId = null; em.hover = null; }
      this._syncEdgeOverlays();
    }
    if (this.parts && (this.parts.active || this.edgeMode)) this.parts.refresh();
    this.viewport.requestRender();
  }

  _syncMesh(node) {
    const geo = getGeometry(node);
    let mesh = this.meshes.get(node.id);
    if (!mesh) {
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.03 }));
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
    const picking = (this.edgeMode && this.edgeMode.id === mesh.userData.id) || (this.parts && this.parts.active && this.parts.id === mesh.userData.id);
    // while picking edges, the shape keeps its ordinary edge lines (if shown) instead of the
    // selection outline; selected edges are drawn on top
    const want = selected && !picking ? selLineMat : this.settings.edges ? edgeLineMat : null;
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
    if (this.tool === 'split' && !this.movableNodes().length) this.setTool('select');
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
    this.tool = this.tool === tool && tool !== 'select' && tool !== 'place' ? 'select' : tool;
    const part = (t) => t === 'face' || t === 'corner';
    // leaving a part mode: the shape that was being worked on becomes the selection
    const was = this.edgeMode ? this.edgeMode.id : this.parts.active ? this.parts.id : null;
    if (this.tool !== 'edges' && this.edgeMode) this._endEdgeTool();
    if (this.parts.active && this.parts.mode !== this.tool) this.parts.end();
    if (was && !part(this.tool) && this.tool !== 'edges' && this.node(was)) { this.selection = new Set([was]); this.refreshOutlines(); }
    if (was && (part(this.tool) || this.tool === 'edges') && this.node(was)) this.selection = new Set([was]);
    if (this.tool === 'edges' && !this.edgeMode) this._startEdgeTool();
    if (part(this.tool) && !this.parts.active) this.parts.start(this.tool);
    if (this.tool !== 'align') this.alignAnchor = null;
    if (this.tool === 'split' && !this._startSplit()) this.tool = 'select';
    if (this.tool !== 'split') this.split = null;
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

  // ---------------------------------------------------------------- edge tool
  // The Edges tool: point at any shape or group to see its sharp edges, click to pick them
  // (shift-click for several), then give the picked edges a type (sharp, round, chamfer) and
  // size in the inspector. Edges are stored by where they are on the shape (node.edgeRounds),
  // so they survive resizing and nearby edits. Picks always belong to one node (edgeMode.id).

  _startEdgeTool() {
    const sel = this.movableNodes();
    const node = sel.length === 1 ? sel[0] : null;
    // starting with a shape selected selects all of its edges
    const picked = new Set(node && !node.hidden ? nodeEdgeData(node).chains.map((_, i) => i) : []);
    this.edgeMode = { id: node ? node.id : null, picked, hoverId: null, hover: null, key: null };
    this.refreshOutlines();
    this._syncEdgeOverlays();
  }

  _endEdgeTool() {
    if (!this.edgeMode) return;
    this.edgeMode = null;
    this.parts.refresh(); // its move arrows go
    for (const mesh of this.meshes.values()) this._dropEdgeOverlay(mesh);
    this.viewport.canvas.style.cursor = '';
    this.refreshOutlines();
  }

  /** Start the Edges tool, with the one selected shape (if any) ready to pick from. */
  enterEdgeMode() { if (this.tool !== 'edges') this.setTool('edges'); }

  exitEdgeMode(emit = true) {
    if (this.parts.active) { this.parts.end(); this.tool = 'select'; this.emit('tool'); if (emit) this.emit('selection'); return; }
    if (!this.edgeMode) return;
    this._endEdgeTool();
    this.tool = 'select';
    this.emit('tool');
    if (emit) this.emit('selection');
  }

  /** State for the edge properties panel: the node, picked edges and their current style. */
  edgeInfo() {
    const em = this.edgeMode;
    if (!em) return null;
    const node = em.id && this.node(em.id);
    if (!node) return { node: null, count: 0, picked: [], styles: [] };
    const d = nodeEdgeData(node);
    const idx = edgeRoundIndex(node);
    const style = (i) => {
      const k = idx[i];
      if (k === undefined) return { t: 'sharp', r: 0 };
      const e = node.edgeRounds[k];
      return { t: e.t === 'chamfer' ? 'chamfer' : 'round', r: e.r };
    };
    const picked = [...em.picked].filter((i) => i < d.chains.length);
    return {
      node, count: d.chains.length, picked,
      styles: picked.map(style),
      inside: picked.filter((i) => !d.chains[i].convex).length,
    };
  }

  pickAllEdges(on = true) {
    const em = this.edgeMode;
    if (!em || !em.id) return;
    const d = nodeEdgeData(this.node(em.id));
    em.picked = new Set(on ? d.chains.map((_, i) => i) : []);
    this._syncEdgeOverlays();
    this.emit('selection');
  }

  clearEdgePicks() {
    if (!this.edgeMode) return;
    this.edgeMode.picked.clear();
    this._syncEdgeOverlays();
    this.emit('selection');
  }

  /** Give the picked edges a style: t = 'sharp' | 'round' | 'chamfer', r = radius or chamfer size. */
  async setPickedEdgeStyle(t, r) {
    const em = this.edgeMode;
    const node = em && em.id && this.node(em.id);
    if (!node || !em.picked.size || node.locked) return;
    const d = nodeEdgeData(node);
    const idx = edgeRoundIndex(node);
    const picked = [...em.picked].filter((i) => i < d.chains.length);
    // edges already shaped keep their place in the list (the order edges are cut in); new ones go last
    const shape = t !== 'sharp' && r > 0;
    const replace = new Map(picked.filter((i) => idx[i] !== undefined).map((i) => [idx[i], i]));
    const next = [];
    (node.edgeRounds || []).forEach((e, k) => {
      if (!replace.has(k)) next.push(e);
      else if (shape) next.push({ sig: d.sigs[replace.get(k)], r, t });
    });
    const added = shape ? picked.filter((i) => idx[i] === undefined).map((i) => ({ sig: d.sigs[i], r, t })) : [];
    next.push(...added);
    await this._busy(() => {
      if (next.length) node.edgeRounds = next; else delete node.edgeRounds;
      this.sync();
      this.commit();
    });
    const failed = added.length ? geoStats.edgeRoundsFailed || 0 : 0;
    if (failed) toast(failed >= added.length ? 'Those edges could not be shaped (try a smaller size)' : `${failed} edge${failed > 1 ? 's' : ''} could not be shaped`, 'warn', 4000);
    this.emit('selection');
  }

  /** Does this node have edges shaped by the Edges tool or the all-edges radius? */
  hasShapedEdges(node) { return !!node && ((node.edgeRounds && node.edgeRounds.length > 0) || node.round > 0); }

  /**
   * Bake the node's rounded and chamfered edges into it: it becomes a plain mesh shape with the
   * current geometry, so the edges are part of the shape and new edges can be picked on it.
   * A group's parts can no longer be edited afterwards (Ctrl+Z undoes it).
   */
  async applyEdges(node = this.edgeMode && this.edgeMode.id ? this.node(this.edgeMode.id) : this.movableNodes()[0]) {
    if (!this.hasShapedEdges(node) || node.locked) return;
    let ok = false;
    await this._busy(() => {
      const geo = getGeometry(node);
      if (!geo.attributes.position.count) return;
      const flat = geo.index ? geo.toNonIndexed() : geo;
      const positions = new Float32Array(flat.attributes.position.array);
      // mesh shapes are re-centred on their footprint when built: shift the matrix to match
      const bb = new THREE.Box3().setFromBufferAttribute(flat.attributes.position);
      const shift = new THREE.Matrix4().makeTranslation((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.min.z);
      const baked = makeShape('mesh', { mesh: { id: uid('m'), positions } }, node.color, node.name || kindName(node));
      Object.assign(baked, { id: node.id, hole: node.hole, transparent: node.transparent, hidden: node.hidden, matrix: mat4(node.matrix).multiply(shift).toArray() });
      const i = this.doc.nodes.indexOf(node);
      if (i < 0) return;
      this.doc.nodes[i] = baked;
      this.sync();
      this.commit();
      ok = true;
    });
    if (!ok) return;
    if (this.edgeMode) { this.edgeMode.picked.clear(); this.edgeMode.key = null; this.edgeMode.hover = null; this._syncEdgeOverlays(); }
    toast(node.type === 'group' && node.multicolor ? 'Edges applied (the shape is now one colour)' : 'Edges applied');
    this.emit('selection');
  }

  _dropEdgeOverlay(mesh) {
    const lines = mesh.userData.edgeOverlay;
    if (!lines) return;
    for (const l of lines) { mesh.remove(l); l.material.dispose(); l.geometry.dispose(); }
    mesh.userData.edgeOverlay = null;
  }

  /** Draw the edges of the picking node and of the node under the pointer. */
  _syncEdgeOverlays() {
    const em = this.edgeMode;
    if (!em) return;
    const show = new Set([em.id, em.hoverId].filter((id) => id && this.meshes.has(id)));
    for (const [id, mesh] of this.meshes) if (!show.has(id)) this._dropEdgeOverlay(mesh);
    for (const id of show) this._buildEdgeOverlay(id);
    if (this.parts) this.parts.refresh(); // move arrows for the picked edges
    this.viewport.requestRender();
  }

  _buildEdgeOverlay(id) {
    const em = this.edgeMode;
    const node = this.node(id), mesh = this.meshes.get(id);
    if (!node || !mesh) return;
    const d = nodeEdgeData(node);
    if (id === em.id && em.key !== d.key) { if (em.key) em.picked.clear(); em.key = d.key; } // edges were re-found
    // selected edges: the thin selection line; the edge under the pointer: a thick one
    const active = id === em.id;
    const thin = [], thick = [];
    d.lines.forEach((pts, i) => {
      const hovered = em.hover && em.hover.id === id && em.hover.i === i;
      const out = hovered ? thick : active && em.picked.has(i) ? thin : null;
      if (!out) return;
      const n = pts.length, segs = d.chains[i].closed ? n : n - 1;
      for (let s = 0; s < segs; s++) {
        const a = pts[s], b = pts[(s + 1) % n];
        out.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    });
    this._dropEdgeOverlay(mesh);
    if (!thin.length && !thick.length) return;
    const lines = [];
    if (thin.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(thin, 3));
      lines.push(new THREE.LineSegments(g, edgeThinMaterial()));
    }
    if (thick.length) {
      const g = new LineSegmentsGeometry();
      g.setPositions(thick);
      const l = new LineSegments2(g, edgeLineMaterial());
      l.material.resolution.set(this.viewport.width, this.viewport.height);
      lines.push(l);
    }
    for (const l of lines) { l.renderOrder = 6; l.raycast = () => {}; mesh.add(l); }
    mesh.userData.edgeOverlay = lines;
    mesh.updateMatrixWorld(true);
  }

  /** The edge under the pointer ({ id, i }), nearest on screen and not hidden by the model, or null. */
  _pickEdge(e, underId) {
    const em = this.edgeMode;
    const vp = this.viewport;
    const rect = vp.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), pa = {}, pb = {};
    const cands = [];
    for (const id of new Set([underId, em.id])) {
      const node = id && this.node(id), mesh = id && this.meshes.get(id);
      if (!node || !mesh || !mesh.visible) continue;
      const d = nodeEdgeData(node);
      const W = mesh.matrixWorld;
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
        if (best < 10) cands.push({ id, i, dist: best, at, node });
      });
    }
    if (!cands.length) return null;
    cands.sort((p, q) => p.dist - q.dist);
    const meshes = [...this.meshes.values()].filter((m) => m.visible);
    for (const c of cands) {
      // Visible if nothing is hit before the edge on a ray aimed straight at it. (Aiming through
      // the pointer instead hides inside edges: beside a valley the surface is nearer than the edge.)
      const k = edgeRoundIndex(c.node)[c.i];
      const r = k !== undefined ? c.node.edgeRounds[k].r : 0; // a shaped edge sits off the surface
      const m = c.node.matrix;
      const scale = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
      if (this._edgeVisible(c.at, meshes, vp.unitsPerPixel(c.at) * 3 + r * scale * 1.5)) return { id: c.id, i: c.i };
    }
    return null;
  }

  _edgeVisible(point, meshes, tol) {
    const vp = this.viewport, cam = vp.camera;
    let origin, dir;
    if (vp.isOrtho) {
      dir = vp.viewDirection();
      origin = point.clone().addScaledVector(dir, -1e5);
    } else {
      origin = cam.getWorldPosition(new THREE.Vector3());
      dir = point.clone().sub(origin).normalize();
    }
    const dist = point.distanceTo(origin);
    const rc = this._edgeRay || (this._edgeRay = new THREE.Raycaster());
    rc.set(origin, dir);
    rc.far = dist + 1;
    const hits = rc.intersectObjects(meshes, false);
    return !hits.length || hits[0].distance >= dist - tol;
  }

  _edgeHover(e) {
    const em = this.edgeMode;
    const under = this.pickNode(e);
    const hoverId = under ? under.node.id : null;
    const hit = this._pickEdge(e, hoverId);
    this.viewport.canvas.style.cursor = hit ? 'pointer' : '';
    const same = (p, q) => (p && q ? p.id === q.id && p.i === q.i : p === q);
    if (hoverId !== em.hoverId || !same(hit, em.hover)) {
      em.hoverId = hoverId || (hit && hit.id) || null;
      em.hover = hit;
      this._syncEdgeOverlays();
    }
  }

  _edgeClick(e) {
    const em = this.edgeMode;
    const under = this.pickNode(e);
    const hit = this._pickEdge(e, under ? under.node.id : null);
    const multi = e.shiftKey || e.metaKey;
    if (!hit) {
      if (!multi && em.picked.size) { em.picked.clear(); this._syncEdgeOverlays(); this.emit('selection'); }
      return;
    }
    const changed = () => { this.refreshOutlines(); this._syncEdgeOverlays(); this.emit('selection'); };
    if (multi) {
      if (hit.id !== em.id) { em.id = hit.id; em.key = null; em.picked = new Set([hit.i]); }
      else if (em.picked.has(hit.i)) em.picked.delete(hit.i); else em.picked.add(hit.i);
      changed();
      return;
    }
    // like objects: press an edge to pick it and drag to move it; a click on the only picked edge unpicks it
    const wasOnly = hit.id === em.id && em.picked.size === 1 && em.picked.has(hit.i);
    if (!(hit.id === em.id && em.picked.has(hit.i))) {
      if (hit.id !== em.id) { em.id = hit.id; em.key = null; }
      em.picked = new Set([hit.i]);
      changed();
    }
    this.parts.pressDrag(e, () => {
      if (wasOnly) em.picked = new Set();
      else if (em.picked.size > 1) em.picked = new Set([hit.i]);
      else return;
      changed();
    });
  }

  // ---------------------------------------------------------------- pointer handling
  _hover(e) {
    if (this.disabled) return;
    if (this.parts.active) return this.parts.hoverAt(e);
    if (this.edgeMode) return this._edgeHover(e);
    if (this.tool === 'workplane' || this.tool === 'ruler' || this.tool === 'note' || this.placing) return;
    const hit = this.pickNode(e);
    this.viewport.canvas.style.cursor = hit && !hit.node.locked ? 'move' : '';
  }

  _dblclick(e) {
    if (this.disabled || this.edgeMode || this.parts.active) return;
    const hit = this.pickNode(e);
    if (hit) this.emit('dblclick', hit.node);
  }

  _leftDown(e) {
    if (this.disabled || this.placing) return; // handled by the placement listeners
    if (this.parts.active) return this.parts.click(e);
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
    if (this.tool === 'split') {
      // Split: a click on a face lays the plane flush with it; Shift+click adds or removes a shape
      if (hit && e.shiftKey) { this.select([hit.node.id], { toggle: true }); return; }
      if (hit) this.splitToFace(hit);
      return;
    }
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
  placeAt(node, x, y, frame = this.frame) {
    const base = node._base || (node._base = [...node.matrix]);
    const g = getGeometry(node);
    const box = expandBox(new THREE.Box3(), g, mat4(base));
    const cx = box.isEmpty() ? 0 : (box.min.x + box.max.x) / 2, cy = box.isEmpty() ? 0 : (box.min.y + box.max.y) / 2;
    const minz = box.isEmpty() ? 0 : box.min.z;
    const hw = box.isEmpty() ? 0 : (box.max.x - box.min.x) / 2, hl = box.isEmpty() ? 0 : (box.max.y - box.min.y) / 2;
    // snap the footprint corner so edges land on the grid
    const px = this.snapValue(x - hw) + hw, py = this.snapValue(y - hl) + hl;
    const m = frame.clone().multiply(T(px - cx, py - cy, -minz)).multiply(mat4(base));
    m.toArray(node.matrix);
  }

  /**
   * A temporary workplane on the face under a pick: z along the face normal, x level where it
   * can be. Its origin is the main workplane's origin projected onto the face, so the grid (and
   * snapping) stays in line with the main grid, e.g. shapes on a flat top snap like on the floor.
   */
  _faceFrame(hit) {
    const n = hit.normal.clone().normalize();
    const up = new THREE.Vector3(0, 0, 1).transformDirection(this.frame);
    let x = new THREE.Vector3().crossVectors(up, n);
    if (x.lengthSq() < 1e-6) x = new THREE.Vector3(1, 0, 0).transformDirection(this.frame);
    x.normalize();
    const y = new THREE.Vector3().crossVectors(n, x).normalize();
    x.crossVectors(y, n).normalize();
    const o = new THREE.Vector3().setFromMatrixPosition(this.frame);
    o.addScaledVector(n, hit.point.clone().sub(o).dot(n));
    return new THREE.Matrix4().makeBasis(x, y, n).setPosition(o);
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
    // Over an existing shape, the workplane moves onto the face under the pointer for the time
    // being (its grid shows there) and the new shape sits on that face, aligned to it.
    let shown = null;
    const showGrid = (f) => {
      if (f === shown || (f && shown && f.equals(shown))) return;
      shown = f;
      this.viewport.setFrame(f || (this.hasFrame ? this.frame : null));
    };
    const update = (ev) => {
      let ok = false, face = null;
      if (overCanvas(ev)) {
        const hit = this.pickNode(ev);
        if (hit && hit.node) {
          face = this._faceFrame(hit);
          const q = hit.point.clone().applyMatrix4(face.clone().invert());
          this.placeAt(node, q.x, q.y, face);
          ok = true;
        } else {
          const p = this.planePoint(ev);
          if (p) { this.placeAt(node, p.x, p.y); ok = true; }
        }
      }
      showGrid(face);
      ghost.visible = ok;
      if (ok) {
        ghost.matrix.fromArray(node.matrix);
        ghost.updateMatrixWorld(true);
      }
      this.viewport.requestRender();
      return ok;
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
        showGrid(null); // the workplane goes back where it was
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

  // ---------------------------------------------------------------- split
  // The cutting plane, in workplane-frame coordinates: it passes through `c + n * offset`, where
  // c is the middle of the selection when the tool started and n is the plane's z axis turned by q.
  _startSplit() {
    const nodes = this.movableNodes();
    if (!nodes.length) { toast('Select the shapes to split first'); return false; }
    const b = this.bounds(nodes);
    if (b.isEmpty()) return false;
    this.split = { c: b.getCenter(new THREE.Vector3()), q: new THREE.Quaternion(), offset: 0, size: b.getSize(new THREE.Vector3()).length() };
    return true;
  }

  /** The plane in frame coordinates: { point, normal, matrix } (matrix: z = normal, origin on the plane). */
  splitPlane() {
    const sp = this.split;
    if (!sp) return null;
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(sp.q);
    const point = sp.c.clone().addScaledVector(normal, sp.offset);
    const matrix = new THREE.Matrix4().compose(point, sp.q, new THREE.Vector3(1, 1, 1));
    return { point, normal, matrix };
  }

  /** Angles of the plane (degrees, X then Y then Z) for showing and typing. */
  splitAngles() {
    if (!this.split) return { x: 0, y: 0, z: 0 };
    const e = new THREE.Euler().setFromQuaternion(this.split.q, 'XYZ');
    const d = (r) => Math.round((r * 180) / Math.PI * 10) / 10 + 0;
    return { x: d(e.x), y: d(e.y), z: d(e.z) };
  }

  setSplit({ offset, angles, q } = {}) {
    const sp = this.split;
    if (!sp) return;
    if (offset != null && isFinite(offset)) sp.offset = offset;
    if (q) sp.q.copy(q).normalize();
    if (angles) {
      const r = (deg) => (deg * Math.PI) / 180;
      sp.q.setFromEuler(new THREE.Euler(r(angles.x), r(angles.y), r(angles.z), 'XYZ'));
    }
    this.emit('split');
    this.viewport.requestRender();
  }

  /** Preset directions: 'xy' flat, 'xz' upright front-to-back, 'yz' upright side-to-side (through the middle). */
  splitPreset(which) {
    const q = new THREE.Quaternion();
    if (which === 'xz') q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);   // normal along Y
    else if (which === 'yz') q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); // normal along X
    this.setSplit({ q, offset: 0 });
  }

  /** Lay the plane flush with a picked face. */
  splitToFace(hit) {
    const sp = this.split;
    if (!sp) return;
    const n = hit.normal.clone().transformDirection(this.frameInv).normalize();
    const p = hit.point.clone().applyMatrix4(this.frameInv);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.setSplit({ q, offset: p.sub(sp.c).dot(n) });
  }

  /** The selected shapes the plane passes through (the others are left alone). */
  splitTargets() {
    const pl = this.splitPlane();
    if (!pl) return [];
    const nW = pl.normal.clone().transformDirection(this.frame).normalize();
    const pW = pl.point.clone().applyMatrix4(this.frame);
    const d0 = nW.dot(pW), v = new THREE.Vector3(), m = new THREE.Matrix4();
    return this.movableNodes().filter((n) => {
      const pos = getGeometry(n).attributes.position;
      if (!pos || !pos.count) return false;
      m.fromArray(n.matrix);
      let above = false, below = false;
      for (let i = 0; i < pos.count; i++) {
        const d = nW.dot(v.fromBufferAttribute(pos, i).applyMatrix4(m)) - d0;
        if (d > 1e-4) above = true; else if (d < -1e-4) below = true;
        if (above && below) return true;
      }
      return false;
    });
  }

  /**
   * Cut every selected shape the plane passes through into two pieces, one each side. Each piece is
   * a group of the original shape (unchanged, still editable) and a big box hole covering the other
   * side, so ungrouping a piece gives the original back. One undo step.
   */
  async applySplit() {
    const pl = this.splitPlane();
    const targets = this.splitTargets();
    if (!pl || !targets.length) { toast('The plane doesn\'t pass through any selected shape'); return; }
    const planeW = this.frame.clone().multiply(pl.matrix);
    const pieces = [];
    for (const node of targets) {
      const nb = this.bounds([node], true);
      const r = nb.getSize(new THREE.Vector3()).length();
      const D = Math.max(40, r * 2 + 20);                // the hole box: comfortably bigger than the shape
      // centred on the shape (its middle dropped onto the plane), so it covers the shape even far from the plane's middle
      const local = nb.getCenter(new THREE.Vector3()).applyMatrix4(planeW.clone().invert());
      const planeAt = planeW.clone().multiply(T(local.x, local.y, 0));
      const name = node.name || kindName(node);
      for (const side of [1, -1]) {
        const keep = cloneNode(node, true);
        keep.locked = false;
        const hole = makeShape('box', { radius: 0, steps: 10 }, '#cfd8dc', 'Split cut');
        hole.hole = true;
        // put one face of the box on the plane, the box covering the side that goes away
        const hb = new THREE.Box3().setFromBufferAttribute(getGeometry(hole).attributes.position);
        const hs = hb.getSize(new THREE.Vector3()), k = D / Math.max(hs.x, hs.y, hs.z);
        planeAt.clone().multiply(S(k, k, k))
          .multiply(T(-(hb.min.x + hb.max.x) / 2, -(hb.min.y + hb.max.y) / 2, side === 1 ? -hb.max.z : -hb.min.z))
          .toArray(hole.matrix);
        const g = makeGroup([keep, hole], 'union');
        g.name = `${name} (part ${side === 1 ? 1 : 2})`;
        g.color = node.color;
        if (node.type === 'group' && node.multicolor) g.multicolor = true;
        g.transparent = !!node.transparent;
        pieces.push({ from: node, g });
      }
    }
    await this._busy(() => { for (const p of pieces) getGeometry(p.g); });
    for (const node of targets) {
      const at = this.doc.nodes.indexOf(node);
      this.doc.nodes.splice(at, 1, ...pieces.filter((p) => p.from === node).map((p) => p.g));
    }
    this.selection = new Set(pieces.map((p) => p.g.id));
    this.split = null;
    this.tool = 'select';
    this.sync();
    this.commit();
    this.emit('tool');
    this.emit('selection');
    const empty = pieces.filter((p) => !getGeometry(p.g).attributes.position.count).length;
    if (empty) toast(`${empty === 1 ? 'One piece is' : empty + ' pieces are'} empty: the plane only touched ${empty === 1 ? 'that shape' : 'those shapes'} at the edge`, 'warn', 5000);
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
    // Face, Edge and Corner modes: centre on the picked parts (or the shape being worked on)
    // Pressed again without the view having moved: turn to look at the picked parts face on.
    if (this.parts.active || this.edgeMode) {
      const vp = this.viewport, last = this._lastFit;
      const key = this.parts.pickKey();
      const near = (a, b, tol) => Math.abs(a - b) <= tol;
      const still = last && last.key === key && !vp._anim && vp.target.distanceTo(last.target) <= last.radius * 1e-3
        && near(vp.radius, last.radius, last.radius * 1e-3) && near(vp.theta, last.theta, 1e-4) && near(vp.phi, last.phi, 1e-4);
      const dir = still ? this.parts.faceOnDir() : null;
      if (dir) {
        const phi = Math.min(Math.PI - 0.0006, Math.max(0.0006, Math.acos(Math.max(-1, Math.min(1, dir.z)))));
        const theta = Math.hypot(dir.x, dir.y) < 1e-6 ? vp.theta : Math.atan2(dir.y, dir.x);
        vp.animateTo({ theta, phi });
      } else {
        const box = this.parts.pickedBox();
        if (!box) { this._lastFit = null; } else vp.fit(box);
      }
      const goal = vp._anim ? vp._anim.to : null;
      if (goal) { this._lastFit = { key, target: goal.target.clone(), radius: goal.radius, theta: goal.theta, phi: goal.phi }; return; }
      if (this._lastFit) return;
    }
    const sel = this.selectedNodes();
    const box = this.worldBounds(sel.length ? sel : undefined);
    if (box.isEmpty()) this.viewport.home(); else this.viewport.fit(box);
  }
}
