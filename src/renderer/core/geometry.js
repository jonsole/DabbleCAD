// Geometry engine: builds (and caches) the mesh for any node, including boolean groups.
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { KINDS } from './shapes.js';
import { geomKey, mat4 } from './doc.js';
import { solidBoolean, withSolid } from './solid.js';
import { findEdges, edgeSignature, matchRounds, filletEdges } from './edges.js';
import { analyseShape, solveEdits, movedGeometry } from './shapeedit.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const CREASE = 0.58; // ~33 degrees
const cache = new Map();
const CACHE_LIMIT = 500;
export const stats = { csgRuns: 0, csgFailures: 0, lastCsgMs: 0, solidRuns: 0, fallbackRuns: 0 };

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal', 'color'];
evaluator.useGroups = false;
evaluator.useCDTClipping = true;

const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

function finalize(g) {
  g.computeBoundingBox();
  g.computeBoundingSphere();
  if (g.attributes.position.count > 0) {
    try { g.computeBoundsTree(); } catch { /* fall back to brute force raycasts */ }
  }
  return g;
}

function finishPrimitive(raw, kind) {
  let g = raw;
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  g.clearGroups();
  g.morphAttributes = {};
  const tris = triCount(g);
  if (tris < 350000) {
    if (!g.index) g = mergeVertices(g, 1e-4);
    else g = mergeVertices(g.toNonIndexed(), 1e-4);
    g = toCreasedNormals(g, kind === 'mesh' ? 0.45 : CREASE);
  } else {
    // copy: the caller's position array (e.g. an imported mesh's params) must not be translated in place
    g = g.index ? g.toNonIndexed() : g.clone();
    g.computeVertexNormals();
  }
  g.computeBoundingBox();
  const bb = g.boundingBox;
  if (isFinite(bb.min.x)) g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
  return finalize(g);
}

function flipWinding(g) {
  for (const attr of Object.values(g.attributes)) {
    const a = attr.array, n = attr.itemSize;
    for (let i = 0; i < attr.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const t = a[(i + 1) * n + k];
        a[(i + 1) * n + k] = a[(i + 2) * n + k];
        a[(i + 2) * n + k] = t;
      }
    }
  }
}

function paint(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Geometry of a child, baked into its parent's space with a colour attribute. */
function bakedChild(child, parentMatrix) {
  let g = getGeometry(child).clone();
  if (g.index) g = g.toNonIndexed();
  g.boundsTree = undefined;
  const m = parentMatrix ? parentMatrix.clone().multiply(mat4(child.matrix)) : mat4(child.matrix);
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
  if (!(child.type === 'group' && child.multicolor && g.attributes.color)) paint(g, child.color);
  return g;
}

// Bundles are transparent to booleans: their members act as individual operands.
function collectOperands(children, parentMatrix, out) {
  for (const c of children) {
    if (c.type === 'group' && c.mode === 'bundle') {
      const m = parentMatrix ? parentMatrix.clone().multiply(mat4(c.matrix)) : mat4(c.matrix);
      collectOperands(c.children, m, out);
    } else {
      const g = bakedChild(c, parentMatrix);
      if (g.attributes.position.count >= 3) out.push({ g, hole: c.hole });
    }
  }
  return out;
}

function mergeRaw(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const arr = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) { arr.set(g.attributes[name].array.subarray(0, g.attributes[name].count * 3), o); o += g.attributes[name].count * 3; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return out;
}

function csg(a, b, op) {
  const A = a.isBrush ? a : new Brush(a);
  const B = new Brush(b);
  A.updateMatrixWorld();
  B.updateMatrixWorld();
  // the CSG library still passes an option its BVH dependency has renamed; keep the console readable
  const warn = console.warn;
  console.warn = (...args) => { if (!String(args[0]).includes('maxLeafSize')) warn.apply(console, args); };
  try { return evaluator.evaluate(A, B, op); } finally { console.warn = warn; }
}

function buildGroup(node) {
  if (node.mode === 'bundle') {
    const parts = node.children.map((c) => bakedChild(c, null)).filter((g) => g.attributes.position.count);
    return parts.length ? mergeRaw(parts) : emptyGeometry();
  }
  const ops = collectOperands(node.children, null, []);
  const solids = ops.filter((o) => !o.hole).map((o) => o.g);
  const holes = ops.filter((o) => o.hole).map((o) => o.g);
  if (!ops.length) return emptyGeometry();
  const t0 = performance.now();
  stats.csgRuns += 1;
  // Preferred path: the solid kernel, which always returns a closed, printable mesh.
  const solid = solidBoolean(solids, holes, node.mode);
  if (solid) {
    stats.solidRuns += 1;
    stats.lastCsgMs = performance.now() - t0;
    if (!solid.attributes.position.count) return emptyGeometry();
    return toCreasedNormals(solid, CREASE);
  }
  // Fallback for operands that are not closed solids (e.g. some imported meshes).
  stats.fallbackRuns += 1;
  try {
    let result;
    if (!solids.length) {
      result = holes[0];
      for (let i = 1; i < holes.length; i++) result = csg(result, holes[i], ADDITION);
    } else {
      result = solids[0];
      const joinOp = node.mode === 'intersect' ? INTERSECTION : ADDITION;
      for (let i = 1; i < solids.length; i++) result = csg(result, solids[i], joinOp);
      for (const h of holes) {
        if ((result.isBrush ? result.geometry : result).attributes.position.count < 3) break;
        result = csg(result, h, SUBTRACTION);
      }
    }
    let g = result.isBrush ? result.geometry : result;
    g.boundsTree = undefined;
    g.halfEdges = undefined;
    g.groupIndices = undefined;
    g.clearGroups();
    if (g.index) g = g.toNonIndexed();
    stats.lastCsgMs = performance.now() - t0;
    return g;
  } catch (err) {
    console.warn('Boolean operation failed, falling back to a simple merge', err);
    stats.csgFailures += 1;
    return mergeRaw(solids.length ? solids : holes);
  }
}

// Facets around the rounding ball. 8 only gives each rounded edge two flat facets (it reads as a
// chamfer), so use a smooth ball for simple shapes. The Minkowski sum costs roughly
// triangles x segments^2 on non-convex meshes, so back off as the mesh gets heavier.
// A multiple of 4 keeps the quarter arcs even.
const roundSegments = (tris) => Math.max(8, Math.min(32, 4 * Math.floor(Math.sqrt(50000 / Math.max(tris, 1)) / 4)));

export const ROUND_LIMIT = 6000; // triangles; beyond this the operation takes too long to be usable

/**
 * Round (or bevel) every outside edge without removing material: the solid is shrunk
 * towards its centre by the radius and then grown back by a ball, so the overall size is
 * unchanged. Holes and gaps end up slightly tighter. Returns the input when it cannot run.
 */
function roundEdges(base, radius, style) {
  const tris = triCount(base);
  stats.roundSkipped = null;
  if (tris < 4 || tris > ROUND_LIMIT) { stats.roundSkipped = tris > ROUND_LIMIT ? 'detail' : 'empty'; return base.clone(); }
  const bb = base.boundingBox;
  const size = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
  const c = [(bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2];
  const r = Math.min(radius, Math.min(...size) / 2 - 0.05);
  if (!(r > 0.01)) return base.clone();
  const flat = base.index ? base.toNonIndexed() : base;
  const out = withSolid(flat, (api, s, k) => {
    const ball = k(api.Manifold.sphere(r, style === 'bevel' ? 4 : roundSegments(tris)));
    const scale = size.map((v) => (v - 2 * r) / v);
    const small = k(k(k(s.translate(-c[0], -c[1], -c[2])).scale(scale)).translate(c[0], c[1], c[2]));
    return small.minkowskiSum(ball);
  });
  if (!out || !out.attributes.position.count) { stats.roundSkipped = 'open'; return base.clone(); }
  return toCreasedNormals(out, style === 'bevel' ? 0.2 : CREASE);
}

/**
 * The node's own matrix scales its geometry after this runs, so rounding the unit-sized shape
 * would stretch the radius along any resized axis. Instead stretch the shape first, round it at
 * its real size, then undo the stretch so the matrix puts it back (and normals stay correct).
 */
/** Size the node's own matrix scales its geometry by, per local axis. */
function nodeScale(node) {
  const m = node.matrix || [];
  const axis = (i) => Math.max(1e-6, Math.hypot(m[i] ?? 0, m[i + 1] ?? 0, m[i + 2] ?? 0) || 1);
  return [axis(0), axis(4), axis(8)];
}

/** Position (and colour) of a geometry, stretched to the node's real size. */
function scaledCopy(base, [sx, sy, sz]) {
  const pre = new THREE.BufferGeometry();
  for (const name of ['position', 'color']) if (base.attributes[name]) pre.setAttribute(name, base.attributes[name].clone());
  if (base.index) pre.setIndex(base.index.clone());
  pre.scale(sx, sy, sz);
  pre.computeBoundingBox();
  return pre;
}

function roundInWorldScale(base, node) {
  const [sx, sy, sz] = nodeScale(node);
  if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6 && Math.abs(sz - 1) < 1e-6) {
    return roundEdges(base, node.round, node.roundStyle);
  }
  const pre = scaledCopy(base, [sx, sy, sz]);
  const out = roundEdges(pre, node.round, node.roundStyle);
  if (!out.attributes.normal) return base.clone(); // rounding was skipped: keep the original shape
  out.scale(1 / sx, 1 / sy, 1 / sz);
  return out;
}

const edgeCache = new Map();

/**
 * The sharp edges of a node's own shape (before any edge rounding is applied), found at its
 * real size. `lines` are the edges in the node's local frame, for drawing and picking;
 * `sigs` identify them so a rounded edge can be found again after the shape changes.
 */
export function nodeEdgeData(node) {
  const plain = { ...node, round: 0, edgeRounds: null };
  const scale = nodeScale(node);
  const key = geomKey(plain) + '#' + scale.map((v) => v.toFixed(5)).join(',');
  let d = edgeCache.get(key);
  if (d) return d;
  const base = getGeometry(plain);
  const scaled = scaledCopy(base, scale);
  const toLocal = (p) => p.set(p.x / scale[0], p.y / scale[1], p.z / scale[2]);
  const chains = base.attributes.position.count && triCount(base) <= EDGE_LIMIT ? findEdges(scaled) : [];
  const bb = base.boundingBox || new THREE.Box3().setFromBufferAttribute(base.attributes.position);
  d = {
    key, scale, scaled, chains,
    sigs: chains.map((c) => edgeSignature(c, toLocal)),
    lines: chains.map((c) => c.points.map((p) => toLocal(p.clone()))),
    size: Math.max(1e-3, bb.min.distanceTo(bb.max)),
    tooDetailed: triCount(base) > EDGE_LIMIT,
  };
  edgeCache.set(key, d);
  if (edgeCache.size > 24) edgeCache.delete(edgeCache.keys().next().value);
  return d;
}

export const EDGE_LIMIT = 60000; // triangles; edge finding and fillets get slow beyond this

/** For each edge of nodeEdgeData(node), the index into node.edgeRounds rounding it (or undefined). */
export function edgeRoundIndex(node) {
  const d = nodeEdgeData(node);
  return node.edgeRounds && node.edgeRounds.length ? matchRounds(node.edgeRounds, d.sigs, d.size) : new Array(d.sigs.length);
}

/** For each edge of nodeEdgeData(node), the fillet radius applied to it (or undefined). */
export function edgeRadii(node) {
  return edgeRoundIndex(node).map((k) => (k === undefined ? undefined : node.edgeRounds[k].r));
}

function applyEdgeRounds(node) {
  const base = getGeometry({ ...node, edgeRounds: null });
  const d = nodeEdgeData(node);
  const match = matchRounds(node.edgeRounds, d.sigs, d.size);
  const bb = d.scaled.boundingBox;
  const maxR = Math.min(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) / 2 - 0.05;
  const items = [];
  match.forEach((k, j) => {
    const e = k === undefined ? null : node.edgeRounds[k];
    if (e && e.r > 0) items.push({ chain: d.chains[j], r: Math.min(e.r, maxR), t: e.t === 'chamfer' ? 'chamfer' : 'round', order: k });
  });
  stats.edgeRoundsLost = node.edgeRounds.length - items.length;
  stats.edgeRoundsFailed = 0;
  const keep = () => { const g = base.clone(); g.userData = {}; return g; };
  if (!items.length || !(maxR > 0.01)) return keep();
  const res = filletEdges(d.scaled, items, d.chains);
  if (!res) { stats.edgeRoundsFailed = items.length; return keep(); }
  stats.edgeRoundsFailed = res.failed;
  const out = toCreasedNormals(res.geometry, CREASE);
  out.scale(1 / d.scale[0], 1 / d.scale[1], 1 / d.scale[2]);
  return out;
}

// ------------------------------------------------------------------ shape edits (faces, edges, corners moved)
const featCache = new Map();

/**
 * Faces, edges and corners of a node's shape before any of its own edits, at real size, plus
 * the vertex moves its edits make. Positions are real-size, in the node's own axes.
 */
export function nodeShapeEdits(node) {
  const plain = { ...node, round: 0, edgeRounds: null, shapeEdits: null };
  const scale = nodeScale(node);
  const key = geomKey(plain) + '#' + scale.map((v) => v.toFixed(5)).join(',');
  let A = featCache.get(key);
  if (!A) {
    const base = getGeometry(plain);
    const scaled = scaledCopy(base, scale);
    const toLocal = (p) => p.set(p.x / scale[0], p.y / scale[1], p.z / scale[2]);
    A = triCount(base) <= EDGE_LIMIT && base.attributes.position.count ? analyseShape(scaled, toLocal) : null;
    if (A) { A.scaled = scaled; A.scale = scale; A.key = key; }
    featCache.set(key, A);
    if (featCache.size > 24) featCache.delete(featCache.keys().next().value);
  }
  if (!A) return null;
  const edits = node.shapeEdits || [];
  const ek = JSON.stringify(edits);
  if (A.lastEditKey !== ek) { A.lastEditKey = ek; A.solved = solveEdits(A, edits); }
  return { A, ...A.solved };
}

function applyShapeEdits(node) {
  const st = nodeShapeEdits(node);
  const base = getGeometry({ ...node, shapeEdits: null });
  stats.shapeEditsFailed = st ? st.failed : node.shapeEdits.length;
  if (!st) { const g = base.clone(); g.userData = {}; return g; }
  const out = toCreasedNormals(movedGeometry(st.A.scaled, st.A, st.disp), CREASE);
  out.scale(1 / st.A.scale[0], 1 / st.A.scale[1], 1 / st.A.scale[2]);
  return out;
}

function emptyGeometry() {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(0), 3));
  return g;
}

export function getGeometry(node) {
  const key = geomKey(node);
  let g = cache.get(key);
  if (g) {
    cache.delete(key); // refresh LRU position
    cache.set(key, g);
    return g;
  }
  if (node.round > 0) {
    g = finalize(roundInWorldScale(getGeometry({ ...node, round: 0 }), node));
  } else if (node.edgeRounds && node.edgeRounds.length) {
    g = finalize(applyEdgeRounds(node));
  } else if (node.shapeEdits && node.shapeEdits.length) {
    g = finalize(applyShapeEdits(node));
  } else if (node.type === 'group') {
    g = finalize(buildGroup(node));
  } else {
    const def = KINDS[node.kind];
    let raw;
    try {
      raw = def.build(node.params);
    } catch (err) {
      console.warn('Shape build failed', node.kind, err);
      raw = new THREE.BoxGeometry(20, 20, 20);
    }
    g = finishPrimitive(raw, node.kind);
  }
  cache.set(key, g);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    const old = cache.get(oldest);
    cache.delete(oldest);
    disposeGeometry(old);
  }
  return g;
}

function disposeGeometry(g) {
  if (g.userData.edges) g.userData.edges.dispose();
  g.dispose();
}

/** Points whose transformed bounds equal the transformed geometry's bounds (convex hull vertices). */
export function hullPoints(g) {
  if (g.userData.hull) return g.userData.hull;
  const pos = g.attributes.position;
  let pts;
  if (pos.count <= 400) {
    pts = new Float32Array(pos.array.subarray(0, pos.count * 3));
  } else {
    try {
      const vecs = [];
      const stride = Math.max(1, Math.floor(pos.count / 60000));
      for (let i = 0; i < pos.count; i += stride) vecs.push(new THREE.Vector3().fromBufferAttribute(pos, i));
      const hull = new ConvexHull().setFromPoints(vecs);
      const seen = new Set();
      const out = [];
      for (const face of hull.faces) {
        let e = face.edge;
        do {
          const p = e.head().point;
          if (!seen.has(p)) { seen.add(p); out.push(p.x, p.y, p.z); }
          e = e.next;
        } while (e !== face.edge);
      }
      // sub-sampled inputs: add the true extreme vertices in 26 directions so bounds stay tight
      // (bounding-box corners would inflate the bounds of rotated shapes)
      if (stride > 1) {
        const dirs = [];
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) dirs.push([x, y, z]);
        const best = new Float64Array(dirs.length).fill(-Infinity), bi = new Int32Array(dirs.length);
        const a = pos.array, s = pos.isInterleavedBufferAttribute ? null : pos.itemSize;
        for (let i = 0; i < pos.count; i++) {
          const px = s ? a[i * s] : pos.getX(i), py = s ? a[i * s + 1] : pos.getY(i), pz = s ? a[i * s + 2] : pos.getZ(i);
          for (let d = 0; d < dirs.length; d++) {
            const v = dirs[d][0] * px + dirs[d][1] * py + dirs[d][2] * pz;
            if (v > best[d]) { best[d] = v; bi[d] = i; }
          }
        }
        for (const i of new Set(bi)) out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
      pts = new Float32Array(out.length >= 12 ? out : pos.array.subarray(0, pos.count * 3));
    } catch {
      pts = new Float32Array(pos.array.subarray(0, pos.count * 3));
    }
  }
  g.userData.hull = pts;
  return pts;
}

const _v = new THREE.Vector3();
/** Expand `box` by geometry `g` transformed with `matrix`. */
export function expandBox(box, g, matrix) {
  const pts = hullPoints(g);
  for (let i = 0; i < pts.length; i += 3) {
    _v.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(matrix);
    box.expandByPoint(_v);
  }
  return box;
}

export function getEdges(g) {
  if (g.userData.edges !== undefined) return g.userData.edges;
  g.userData.edges = triCount(g) > 250000 ? null : new THREE.EdgesGeometry(g, 28);
  return g.userData.edges;
}

/** Signed volume (mm^3) and surface area (mm^2) of a geometry under a matrix. */
export function measure(g, matrix) {
  const pos = g.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  let volume = 0, area = 0;
  const idx = g.index;
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(matrix);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(matrix);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(matrix);
    volume += a.dot(ab.crossVectors(b, c)) / 6;
    area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
  }
  return { volume: Math.abs(volume), area, triangles: n / 3 };
}

/** World-space, export-ready copy of a node's geometry (winding fixed for mirrored transforms). */
export function bakedWorldGeometry(node, colorize = true) {
  let g = getGeometry(node).clone();
  if (g.index) g = g.toNonIndexed();
  g.boundsTree = undefined;
  const m = mat4(node.matrix);
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
  if (colorize && !(node.type === 'group' && node.multicolor && g.attributes.color)) paint(g, node.color);
  return g;
}

export function clearGeometryCache() {
  for (const g of cache.values()) disposeGeometry(g);
  cache.clear();
}
