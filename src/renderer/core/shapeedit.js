// Shape edits: move a flat face in or out, or move an edge or a corner, of any shape or group.
//
// Edits are stored on the node (node.shapeEdits) by *where* the face, edge or corner is on the
// shape (a signature, like edge rounds), not by mesh vertex numbers, so they survive resizing
// and changes inside a group. They are applied by moving the mesh's vertices, so the shape keeps
// its triangles and stays a closed solid:
//   - a face moves along its normal, and each of its vertices slides along the faces next to
//     it (push / pull): a box's top face moved up makes the box taller, a pyramid frustum's top
//     moved up gets smaller as its sloping sides carry on
//   - an edge or a corner moves by a vector, and the faces around it tilt to follow
// Everything here works at the shape's real size (mm), in the node's own axes.
import * as THREE from 'three';
import { findEdges, edgeSignature, matchRounds } from './edges.js';

const COPLANAR = 0.99999; // triangles whose normals agree this closely are one flat face
const SOFT_COS = Math.cos((20 * Math.PI) / 180); // a face bordered this gently is a facet of a curve
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const keyOf = (x, y, z) => Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);

/**
 * Faces, edges and corners of a geometry (at real size). `toLocal` maps a real-size point into
 * the frame signatures are stored in (the node's unit frame, so they survive resizing).
 */
export function analyseShape(geo, toLocal) {
  const pos = geo.attributes.position, idx = geo.index;
  const count = idx ? idx.count : pos.count;
  const weld = new Map(), verts = [];
  const vOf = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const p = idx ? idx.getX(i) : i;
    const x = pos.getX(p), y = pos.getY(p), z = pos.getZ(p);
    const key = keyOf(x, y, z);
    let v = weld.get(key);
    if (v === undefined) { v = verts.length; weld.set(key, v); verts.push(new THREE.Vector3(x, y, z)); }
    vOf[i] = v;
  }
  const nv = verts.length;
  const tris = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const edgeTris = new Map();
  const vTris = Array.from({ length: nv }, () => []);
  for (let i = 0; i < count; i += 3) {
    const a = vOf[i], b = vOf[i + 1], c = vOf[i + 2];
    if (a === b || b === c || a === c) continue;
    const n = e1.subVectors(verts[b], verts[a]).cross(e2.subVectors(verts[c], verts[a])).clone();
    const len = n.length();
    if (len < 1e-12) continue;
    const t = tris.length;
    tris.push({ v: [a, b, c], n: n.divideScalar(len), area: len / 2, region: -1 });
    for (const v of [a, b, c]) vTris[v].push(t);
    for (const [s, u] of [[a, b], [b, c], [c, a]]) {
      const key = s < u ? s * nv + u : u * nv + s;
      let l = edgeTris.get(key);
      if (!l) edgeTris.set(key, (l = []));
      l.push(t);
    }
  }
  // flat regions: triangles joined across edges with (almost) the same normal
  const regions = [];
  for (let t0 = 0; t0 < tris.length; t0++) {
    if (tris[t0].region >= 0) continue;
    const id = regions.length;
    const reg = { id, tris: [], verts: new Set(), n: tris[t0].n.clone(), area: 0, c: new THREE.Vector3(), soft: false };
    const stack = [t0];
    tris[t0].region = id;
    while (stack.length) {
      const t = stack.pop();
      const T = tris[t];
      reg.tris.push(t);
      reg.area += T.area;
      reg.c.addScaledVector(verts[T.v[0]].clone().add(verts[T.v[1]]).add(verts[T.v[2]]), T.area / 3);
      for (const v of T.v) reg.verts.add(v);
      for (const [s, u] of [[T.v[0], T.v[1]], [T.v[1], T.v[2]], [T.v[2], T.v[0]]]) {
        for (const o of edgeTris.get(s < u ? s * nv + u : u * nv + s)) {
          if (o === t || tris[o].region >= 0) continue;
          if (tris[o].n.dot(reg.n) > COPLANAR) { tris[o].region = id; stack.push(o); }
        }
      }
    }
    reg.c.divideScalar(Math.max(reg.area, 1e-12));
    regions.push(reg);
  }
  // a region bordered by gently angled neighbours is one facet of a curved surface, not a face
  for (const [key, list] of edgeTris) {
    void key;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = tris[list[i]], B = tris[list[j]];
      if (A.region !== B.region && A.n.dot(B.n) > SOFT_COS) { regions[A.region].soft = true; regions[B.region].soft = true; }
    }
  }
  const vRegions = Array.from({ length: nv }, () => []);
  for (const reg of regions) for (const v of reg.verts) vRegions[v].push(reg.id);

  const bb = new THREE.Box3();
  for (const p of verts) bb.expandByPoint(toLocal(p.clone()));
  const size = Math.max(1e-3, bb.min.distanceTo(bb.max));

  const faces = regions.filter((r) => !r.soft && r.area > 1e-6).map((r) => ({
    region: r.id, n: r.n, c: r.c, area: r.area,
    sig: { n: r.n.toArray().map(r4), c: toLocal(r.c.clone()).toArray().map(r4), a: r4(r.area) },
  }));

  const chains = nv && tris.length ? findEdges(geo) : [];
  for (const ch of chains) ch.ids = ch.points.map((p) => weld.get(keyOf(p.x, p.y, p.z)));
  const cornerIds = new Set();
  for (const ch of chains) if (!ch.closed) { cornerIds.add(ch.ids[0]); cornerIds.add(ch.ids[ch.ids.length - 1]); }
  const corners = [...cornerIds].filter((v) => v !== undefined).map((v) => ({ v, sig: { p: toLocal(verts[v].clone()).toArray().map(r4) } }));

  return {
    verts, vOf, count, tris, vTris, regions, vRegions, faces, size, weld,
    chains, edgeSigs: chains.map((c) => edgeSignature(c, toLocal)),
    corners,
  };
}

// ------------------------------------------------------------------ matching stored edits
function faceScore(a, b, size) {
  const dn = a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2];
  if (dn < 0.98) return Infinity;
  const dc = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]) / size;
  const da = Math.abs(a.a - b.a) / Math.max(a.a, b.a, 1e-9);
  return dc + 0.15 * da + 2 * (1 - dn);
}

function greedy(items, cands, score, limit) {
  const pairs = [];
  items.forEach((it, i) => cands.forEach((c, j) => { const s = score(it, c); if (s < limit) pairs.push({ i, j, s }); }));
  pairs.sort((p, q) => p.s - q.s);
  const usedI = new Set(), out = new Array(cands.length);
  for (const p of pairs) {
    if (usedI.has(p.i) || out[p.j] !== undefined) continue;
    usedI.add(p.i); out[p.j] = p.i;
  }
  return out;
}

/**
 * Which stored edit applies to which face, edge and corner found now. Returns arrays indexed by
 * face / chain / corner, holding the index into `edits` (or undefined).
 */
export function matchEdits(A, edits) {
  const list = (k) => edits.map((e, i) => ({ e, i })).filter((x) => x.e.k === k);
  const F = list('f'), E = list('e'), C = list('c');
  const mf = greedy(F, A.faces, (x, f) => faceScore(x.e.sig, f.sig, A.size), 0.25);
  const me = matchRounds(E.map((x) => ({ sig: x.e.sig })), A.edgeSigs, A.size);
  const mc = greedy(C, A.corners, (x, c) => Math.hypot(x.e.sig.p[0] - c.sig.p[0], x.e.sig.p[1] - c.sig.p[1], x.e.sig.p[2] - c.sig.p[2]) / A.size, 0.06);
  return {
    faces: mf.map((k) => (k === undefined ? undefined : F[k].i)),
    chains: me.map((k) => (k === undefined ? undefined : E[k].i)),
    corners: mc.map((k) => (k === undefined ? undefined : C[k].i)),
  };
}

// ------------------------------------------------------------------ moving vertices
/** The way vertex v of a face slides when the face moves 1 mm along its normal. */
function slide(A, reg, v) {
  const n = reg.n;
  const others = [];
  for (const r of A.vRegions[v]) {
    if (r === reg.id) continue;
    const g = A.regions[r].n;
    if (g.dot(n) > COPLANAR) continue;
    if (!others.some((o) => Math.abs(o.dot(g)) > 0.9999)) others.push(g);
  }
  let d = null;
  if (others.length === 1) {
    const g = others[0];
    d = n.clone().addScaledVector(g, -n.dot(g));
  } else if (others.length >= 2) {
    // the two most different neighbouring faces: the vertex slides along the line they share
    let best = 2, p = null, q = null;
    for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) {
      const c = Math.abs(others[i].dot(others[j]));
      if (c < best) { best = c; p = others[i]; q = others[j]; }
    }
    d = new THREE.Vector3().crossVectors(p, q);
  }
  if (!d || d.lengthSq() < 1e-8) return n.clone();
  d.normalize();
  const along = d.dot(n);
  if (Math.abs(along) < 0.2) return n.clone(); // nearly parallel to the face: no sensible slide
  return d.divideScalar(along);
}

/** Per-vertex moves for one edit: Map vertex -> Vector3. */
function editMoves(A, kind, index, edit) {
  const out = new Map();
  if (kind === 'f') {
    const reg = A.regions[A.faces[index].region];
    for (const v of reg.verts) out.set(v, slide(A, reg, v).multiplyScalar(edit.d));
  } else {
    const vec = new THREE.Vector3().fromArray(edit.v);
    const ids = kind === 'e' ? A.chains[index].ids : [A.corners[index].v];
    for (const v of ids) if (v !== undefined) out.set(v, vec.clone());
  }
  return out;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
/** Would these moves turn any triangle over? */
function flips(A, disp, touched) {
  const tset = new Set();
  for (const v of touched) for (const t of A.vTris[v]) tset.add(t);
  const P = (v, out) => out.copy(A.verts[v]).add(disp[v] || ZERO);
  for (const t of tset) {
    const T = A.tris[t];
    P(T.v[0], _a); P(T.v[1], _b); P(T.v[2], _c);
    _b.sub(_a); _c.sub(_a);
    const n = _b.cross(_c);
    if (n.dot(T.n) < -1e-9 * Math.max(1, T.area)) return true;
  }
  return false;
}
const ZERO = new THREE.Vector3();

/**
 * Work out the vertex moves for a node's edits. Returns { disp, match, failed, failedIdx }:
 * disp[v] is the move of vertex v (or undefined). An edit that would turn the shape inside
 * out is left out and counted in `failed`.
 */
export function solveEdits(A, edits) {
  const match = matchEdits(A, edits);
  const disp = new Array(A.verts.length);
  const failedIdx = [];
  const jobs = [];
  match.faces.forEach((k, j) => { if (k !== undefined) jobs.push({ k, kind: 'f', j }); });
  match.chains.forEach((k, j) => { if (k !== undefined) jobs.push({ k, kind: 'e', j }); });
  match.corners.forEach((k, j) => { if (k !== undefined) jobs.push({ k, kind: 'c', j }); });
  jobs.sort((p, q) => p.k - q.k);
  for (const job of jobs) {
    const moves = editMoves(A, job.kind, job.j, edits[job.k]);
    const before = new Map();
    for (const [v, m] of moves) { before.set(v, disp[v]); disp[v] = (disp[v] ? disp[v].clone() : new THREE.Vector3()).add(m); }
    if (flips(A, disp, moves.keys())) {
      for (const [v, old] of before) disp[v] = old;
      failedIdx.push(job.k);
    }
  }
  const matched = jobs.length;
  return { disp, match, failed: failedIdx.length + (edits.length - matched), failedIdx };
}

/** The geometry with its vertices moved (non-indexed, with colour if the input had it). */
export function movedGeometry(geo, A, disp) {
  const pos = geo.attributes.position, col = geo.attributes.color, idx = geo.index;
  const out = new Float32Array(A.count * 3);
  const colors = col ? new Float32Array(A.count * 3) : null;
  for (let i = 0; i < A.count; i++) {
    const p = idx ? idx.getX(i) : i;
    const d = disp[A.vOf[i]];
    out[i * 3] = pos.getX(p) + (d ? d.x : 0);
    out[i * 3 + 1] = pos.getY(p) + (d ? d.y : 0);
    out[i * 3 + 2] = pos.getZ(p) + (d ? d.z : 0);
    if (colors) { colors[i * 3] = col.getX(p); colors[i * 3 + 1] = col.getY(p); colors[i * 3 + 2] = col.getZ(p); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** A vertex's position after the moves. */
export const movedVertex = (A, disp, v, out = new THREE.Vector3()) => out.copy(A.verts[v]).add(disp[v] || ZERO);

/** Is a stored edit well formed? (for files) */
export function validEdit(e) {
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && isFinite(x));
  if (!e || !e.sig) return false;
  if (e.k === 'f') return vec3(e.sig.n) && vec3(e.sig.c) && isFinite(e.sig.a) && typeof e.d === 'number' && isFinite(e.d);
  if (e.k === 'e') return vec3(e.sig.m) && vec3(e.sig.d) && isFinite(e.sig.l) && vec3(e.v);
  if (e.k === 'c') return vec3(e.sig.p) && vec3(e.v);
  return false;
}
