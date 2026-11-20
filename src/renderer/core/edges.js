// Edge features: find the sharp edges of a solid, remember them by where they are, and
// fillet chosen edges with a true constant-radius (rolling ball) round.
//
// A fillet is built as a swept "cutter": at each point along the edge, the cross-section is
// the sliver between the edge and a circle of the fillet radius that touches both faces.
// Convex edges subtract that sliver, concave (inside) edges add it, using the solid kernel.
import * as THREE from 'three';
import { kernel, toSolid, fromSolid } from './solid.js';

const SHARP_COS = Math.cos((30 * Math.PI) / 180); // faces meeting at more than 30 degrees form an edge
const TURN_COS = Math.cos((40 * Math.PI) / 180); // an edge chain ends where it turns more than this
const EPS = 0.02; // mm: cutters overlap the solid slightly so booleans don't leave slivers
export const ARC_SEGMENTS = 12; // facets per quarter circle of fillet

/**
 * Sharp edges of a closed triangle mesh, joined into chains (a straight box edge, a hole rim...).
 * Returns [{ points: Vector3[], closed, convex, nA: Vector3[], nB: Vector3[], color, length, ends }].
 */
export function findEdges(geo) {
  const pos = geo.attributes.position, col = geo.attributes.color, idx = geo.index;
  const corners = idx ? idx.count : pos.count;
  const weld = new Map(), verts = [];
  const vOf = new Int32Array(corners);
  for (let i = 0; i < corners; i++) {
    const p = idx ? idx.getX(i) : i;
    const x = pos.getX(p), y = pos.getY(p), z = pos.getZ(p);
    const key = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let v = weld.get(key);
    if (v === undefined) { v = verts.length; weld.set(key, v); verts.push(new THREE.Vector3(x, y, z)); }
    vOf[i] = v;
  }
  const nv = verts.length;
  const faces = []; // { v: [a, b, c], n, color }
  const edgeFaces = new Map(); // undirected edge key -> [{ f, a, b }] (a -> b as the face walks it)
  const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
  for (let i = 0; i < corners; i += 3) {
    const a = vOf[i], b = vOf[i + 1], c = vOf[i + 2];
    if (a === b || b === c || a === c) continue;
    const n = _e1.subVectors(verts[b], verts[a]).cross(_e2.subVectors(verts[c], verts[a])).clone();
    const len = n.length();
    if (len < 1e-12) continue;
    n.divideScalar(len);
    const p = idx ? idx.getX(i) : i;
    const color = col ? [col.getX(p), col.getY(p), col.getZ(p)] : null;
    const f = faces.length;
    faces.push({ v: [a, b, c], n, color });
    for (const [s, t] of [[a, b], [b, c], [c, a]]) {
      const key = s < t ? s * nv + t : t * nv + s;
      let list = edgeFaces.get(key);
      if (!list) edgeFaces.set(key, (list = []));
      list.push({ f, a: s, b: t });
    }
  }

  // sharp edges, each directed the way its "A" face walks it
  const sharp = [];
  const byVert = new Map();
  for (const list of edgeFaces.values()) {
    if (list.length !== 2) continue; // open or non-manifold: not something we can round
    const [p, q] = list;
    if (p.a !== q.b || p.b !== q.a) continue; // inconsistent winding
    const fA = faces[p.f], fB = faces[q.f];
    if (fA.n.dot(fB.n) > SHARP_COS) continue;
    const third = fB.v.find((v) => v !== p.a && v !== p.b);
    const convex = _e1.subVectors(verts[third], verts[p.a]).dot(fA.n) < 0;
    const e = { id: sharp.length, a: p.a, b: p.b, fA: p.f, fB: q.f, convex, used: false };
    sharp.push(e);
    for (const v of [e.a, e.b]) { let l = byVert.get(v); if (!l) byVert.set(v, (l = [])); l.push(e); }
  }

  const dirOf = (e) => _e1.subVectors(verts[e.b], verts[e.a]).normalize().clone();
  // the edge that continues a chain through vertex v (only through plain, gently turning joints)
  const continuation = (e, v, forward, stop) => {
    const l = byVert.get(v);
    if (!l || l.length !== 2) return null;
    const o = l[0] === e ? l[1] : l[0];
    if ((o.used && o !== stop) || o.convex !== e.convex) return null;
    // which face is "A" is arbitrary per edge: turn this one round so A stays on the same side
    if ((forward ? o.a !== v : o.b !== v) && o !== stop) { [o.a, o.b] = [o.b, o.a]; [o.fA, o.fB] = [o.fB, o.fA]; }
    if (forward ? o.a !== v : o.b !== v) return null;
    if (dirOf(e).dot(dirOf(o)) < TURN_COS) return null;
    return o;
  };

  const chains = [];
  for (const start of sharp) {
    if (start.used) continue;
    start.used = true;
    const segs = [start];
    let closed = false;
    for (let e = start; ;) {
      const o = continuation(e, e.b, true, start);
      if (!o) break;
      if (o === segs[0]) { closed = true; break; }
      o.used = true; segs.push(o); e = o;
    }
    if (!closed) {
      for (let e = start; ;) {
        const o = continuation(e, e.a, false, null);
        if (!o) break;
        o.used = true; segs.unshift(o); e = o;
      }
    }
    // a loop is detected walking forwards; re-check the case where it closed onto itself
    if (!closed && segs.length > 2 && segs[segs.length - 1].b === segs[0].a) closed = true;
    chains.push(makeChain(segs, closed, verts, faces));
  }
  return chains;
}

function makeChain(segs, closed, verts, faces) {
  const ids = segs.map((s) => s.a);
  if (!closed) ids.push(segs[segs.length - 1].b);
  const points = ids.map((v) => verts[v].clone());
  const n = points.length;
  const nA = [], nB = [];
  for (let i = 0; i < n; i++) {
    // faces of the segments either side of this point
    const near = [];
    if (closed) near.push(segs[(i - 1 + segs.length) % segs.length], segs[i]);
    else { if (i > 0) near.push(segs[i - 1]); if (i < segs.length) near.push(segs[i]); }
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const s of near) { a.add(faces[s.fA].n); b.add(faces[s.fB].n); }
    nA.push(a.normalize()); nB.push(b.normalize());
  }
  let length = 0;
  for (let i = 0; i < segs.length; i++) length += verts[segs[i].a].distanceTo(verts[segs[i].b]);
  const color = faces[segs[0].fA].color;
  return { points, closed, convex: segs[0].convex, nA, nB, color, length, ends: closed ? null : [ids[0], ids[n - 1]] };
}

// ------------------------------------------------------------------ signatures
/**
 * Where an edge is, independent of how the mesh happens to be triangulated: its middle point,
 * overall direction (or loop axis), length and whether it is a loop. `toLocal` maps points
 * into the frame the signature is stored in.
 */
export function edgeSignature(chain, toLocal = (p) => p) {
  const pts = chain.points.map((p) => toLocal(p.clone()));
  let length = 0;
  const segLen = [];
  const n = pts.length, segCount = chain.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) { const l = pts[i].distanceTo(pts[(i + 1) % n]); segLen.push(l); length += l; }
  let mid = pts[0].clone();
  if (chain.closed) {
    mid = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(n);
  } else {
    let walked = 0;
    for (let i = 0; i < segCount; i++) {
      if (walked + segLen[i] >= length / 2) {
        const t = segLen[i] > 0 ? (length / 2 - walked) / segLen[i] : 0;
        mid = pts[i].clone().lerp(pts[i + 1], t);
        break;
      }
      walked += segLen[i];
    }
  }
  let dir;
  if (chain.closed) {
    dir = new THREE.Vector3(); // Newell's method: the loop's axis
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      dir.x += (p.y - q.y) * (p.z + q.z); dir.y += (p.z - q.z) * (p.x + q.x); dir.z += (p.x - q.x) * (p.y + q.y);
    }
  } else {
    dir = pts[n - 1].clone().sub(pts[0]);
  }
  if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
  dir.normalize();
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return { m: mid.toArray().map(r4), d: dir.toArray().map(r4), l: r4(length), c: chain.closed ? 1 : 0, v: chain.convex ? 1 : 0 };
}

function sigScore(a, b, size) {
  if (a.c !== b.c || a.v !== b.v) return Infinity;
  const dm = Math.hypot(a.m[0] - b.m[0], a.m[1] - b.m[1], a.m[2] - b.m[2]) / size;
  const dd = 1 - Math.abs(a.d[0] * b.d[0] + a.d[1] * b.d[1] + a.d[2] * b.d[2]);
  const dl = Math.abs(a.l - b.l) / Math.max(a.l, b.l, 1e-6);
  return dm + 0.5 * dd + 0.3 * dl;
}

/**
 * Pair stored edge rounds ({ sig, r }) with the edges found now. The shape may have changed
 * since the edge was picked, so this is a best match within a tolerance. Returns, for each
 * chain index, the index of the stored round applied to it (or undefined).
 */
export function matchRounds(rounds, sigs, size) {
  const pairs = [];
  rounds.forEach((rd, i) => sigs.forEach((s, j) => {
    const score = sigScore(rd.sig, s, size);
    if (score < 0.12) pairs.push({ i, j, score });
  }));
  pairs.sort((p, q) => p.score - q.score);
  const usedR = new Set(), out = new Array(sigs.length);
  for (const p of pairs) {
    if (usedR.has(p.i) || out[p.j] !== undefined) continue;
    usedR.add(p.i);
    out[p.j] = p.i;
  }
  return out;
}

// ------------------------------------------------------------------ fillets
/** Cross-section of the fillet cutter at one point of an edge, or null if the faces are parallel. */
function section(E, nA, nB, r, convex, segs, chamfer = false) {
  const axis = new THREE.Vector3().crossVectors(nA, nB);
  if (axis.lengthSq() < 1e-8) return null;
  axis.normalize();
  const s = convex ? -1 : 1;
  // ball centre: radius r from both faces, on the inside of a convex edge (outside of a concave one)
  const M = new THREE.Matrix3().set(nA.x, nA.y, nA.z, nB.x, nB.y, nB.z, axis.x, axis.y, axis.z);
  if (Math.abs(M.determinant()) < 1e-8) return null;
  const C = new THREE.Vector3(s * r, s * r, 0).applyMatrix3(M.invert()).add(E);
  const u1 = nA.clone().multiplyScalar(-s), u2 = nB.clone().multiplyScalar(-s);
  const theta = Math.acos(THREE.MathUtils.clamp(u1.dot(u2), -1, 1));
  if (theta < 1e-4) return null;
  const out = [E.clone().addScaledVector(E.clone().sub(C).normalize(), EPS)];
  if (chamfer) {
    // straight cut: set back r along each face from the edge (the fillet's tangent points scaled)
    const tA = C.clone().addScaledVector(u1, r).sub(E), tB = C.clone().addScaledVector(u2, r).sub(E);
    if (tA.lengthSq() < 1e-12 || tB.lengthSq() < 1e-12) return null;
    out.push(E.clone().addScaledVector(tA.normalize(), r), E.clone().addScaledVector(tB.normalize(), r));
    return { pts: out, C };
  }
  const st = Math.sin(theta);
  for (let k = 0; k <= segs; k++) {
    const f = k / segs;
    const d = u1.clone().multiplyScalar(Math.sin((1 - f) * theta) / st).addScaledVector(u2, Math.sin(f * theta) / st);
    out.push(C.clone().addScaledVector(d, r));
  }
  return { pts: out, C };
}

/** Closed mesh swept along an edge chain from per-point cross-sections. Returns a Manifold or null. */
function sweepPiece(api, chain, r, chamfer = false) {
  const n = chain.points.length;
  // same facet count at every point so neighbouring sections line up
  let maxTheta = 0;
  for (let i = 0; i < n; i++) maxTheta = Math.max(maxTheta, Math.acos(THREE.MathUtils.clamp(chain.nA[i].dot(chain.nB[i]), -1, 1)));
  const segs = Math.max(2, Math.ceil((maxTheta / (Math.PI / 2)) * ARC_SEGMENTS));
  const secs = [];
  for (let i = 0; i < n; i++) {
    const s = section(chain.points[i], chain.nA[i], chain.nB[i], r, chain.convex, segs, chamfer);
    if (!s) return null;
    secs.push(s.pts);
  }
  const m = secs[0].length;
  if (!chain.closed && chain.convex) {
    // run the cutter just past open ends so no skin is left at the end faces
    const t0 = chain.points[0].clone().sub(chain.points[1]).normalize().multiplyScalar(EPS);
    const t1 = chain.points[n - 1].clone().sub(chain.points[n - 2]).normalize().multiplyScalar(EPS);
    secs[0].forEach((p) => p.add(t0));
    secs[n - 1].forEach((p) => p.add(t1));
  }
  const c = chain.color || [0.7, 0.7, 0.7];
  const props = new Float32Array(n * m * 6);
  secs.forEach((sec, i) => sec.forEach((p, j) => props.set([p.x, p.y, p.z, c[0], c[1], c[2]], (i * m + j) * 6)));
  const tri = [];
  const V = (i, j) => i * m + (j % m);
  const rings = chain.closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < m; j++) tri.push(V(i, j), V(i, j + 1), V(i2, j + 1), V(i, j), V(i2, j + 1), V(i2, j));
  }
  if (!chain.closed) {
    for (let j = 1; j < m - 1; j++) tri.push(V(0, 0), V(0, j + 1), V(0, j));
    for (let j = 1; j < m - 1; j++) tri.push(V(n - 1, 0), V(n - 1, j), V(n - 1, j + 1));
  }
  // orient outwards
  let vol = 0;
  for (let k = 0; k < tri.length; k += 3) {
    const a = tri[k] * 6, b = tri[k + 1] * 6, d = tri[k + 2] * 6;
    vol += props[a] * (props[b + 1] * props[d + 2] - props[b + 2] * props[d + 1])
      - props[a + 1] * (props[b] * props[d + 2] - props[b + 2] * props[d])
      + props[a + 2] * (props[b] * props[d + 1] - props[b + 1] * props[d]);
  }
  if (vol < 0) for (let k = 0; k < tri.length; k += 3) { const t = tri[k + 1]; tri[k + 1] = tri[k + 2]; tri[k + 2] = t; }
  try {
    const mesh = new api.Mesh({ numProp: 6, vertProperties: props, triVerts: Uint32Array.from(tri) });
    const solid = new api.Manifold(mesh);
    if (solid.status() !== 'NoError' || solid.isEmpty()) { solid.delete(); return null; }
    return solid;
  } catch {
    return null;
  }
}

/**
 * Where three rounded convex edges with the same radius meet, fill the corner with a ball
 * patch (the corner of the box spanned by the edges, minus the rolling ball).
 */
function cornerPiece(api, V, ends, r) {
  const normals = [];
  for (const e of ends) for (const nrm of [e.nA, e.nB]) if (!normals.some((x) => x.dot(nrm) > 0.999)) normals.push(nrm);
  if (normals.length !== 3 || ends.length !== 3) return null;
  const M = new THREE.Matrix3().set(...normals[0].toArray(), ...normals[1].toArray(), ...normals[2].toArray());
  if (Math.abs(M.determinant()) < 1e-6) return null;
  const C = new THREE.Vector3(-r, -r, -r).applyMatrix3(M.invert()).add(V);
  const dirs = ends.map((e) => e.dir);
  const D = new THREE.Matrix3().set(dirs[0].x, dirs[1].x, dirs[2].x, dirs[0].y, dirs[1].y, dirs[2].y, dirs[0].z, dirs[1].z, dirs[2].z);
  if (Math.abs(D.determinant()) < 1e-6) return null;
  const k = C.clone().sub(V).applyMatrix3(D.clone().invert());
  if (k.x <= 0 || k.y <= 0 || k.z <= 0) return null;
  const grow = 1 + EPS / r; // push the flat sides just outside the faces
  const pts = [];
  for (const a of [0, k.x]) for (const b of [0, k.y]) for (const c of [0, k.z]) {
    const p = V.clone().addScaledVector(dirs[0], a).addScaledVector(dirs[1], b).addScaledVector(dirs[2], c);
    pts.push(p.sub(C).multiplyScalar(grow).add(C).toArray());
  }
  const made = [];
  try {
    const box = api.Manifold.hull(pts); made.push(box);
    const ball = api.Manifold.sphere(r, ARC_SEGMENTS * 4); made.push(ball);
    const moved = ball.translate([C.x, C.y, C.z]); made.push(moved);
    return box.subtract(moved);
  } catch {
    return null;
  } finally {
    for (const s of made) try { s.delete(); } catch { /* freed */ }
  }
}

/**
 * Round or chamfer the given edges of a closed solid. items: [{ chain, r, t }] in the geometry's
 * own frame, t = 'round' (r is the radius) or 'chamfer' (r is the set-back along each face).
 * Returns { geometry, failed } where failed counts edges that could not be rounded, or null
 * when the solid itself could not be built.
 */
export function filletEdges(geo, items) {
  const api = kernel();
  if (!api) return null;
  const base = toSolid(geo);
  if (!base) return null;
  const made = [base];
  let failed = 0;
  try {
    const cut = [], add = [];
    const corners = new Map(); // vertex key -> [{ nA, nB, dir, r }]
    const vkey = (p) => p.toArray().map((x) => Math.round(x * 1e3)).join(',');
    for (const { chain, r, t } of items) {
      const chamfer = t === 'chamfer';
      const piece = sweepPiece(api, chain, r, chamfer);
      if (!piece) { failed += 1; continue; }
      made.push(piece);
      (chain.convex ? cut : add).push(piece);
      if (chain.convex && !chain.closed && !chamfer) {
        const n = chain.points.length;
        for (const [i, j] of [[0, 1], [n - 1, n - 2]]) {
          const key = vkey(chain.points[i]);
          let l = corners.get(key);
          if (!l) corners.set(key, (l = []));
          l.push({ V: chain.points[i], nA: chain.nA[i], nB: chain.nB[i], dir: chain.points[j].clone().sub(chain.points[i]).normalize(), r });
        }
      }
    }
    for (const ends of corners.values()) {
      if (ends.length !== 3 || ends.some((e) => Math.abs(e.r - ends[0].r) > 1e-6)) continue;
      const piece = cornerPiece(api, ends[0].V, ends, ends[0].r);
      if (piece) { made.push(piece); cut.push(piece); }
    }
    let result = base;
    if (add.length) {
      const u = add.length === 1 ? add[0] : api.Manifold.union(add);
      if (u !== add[0]) made.push(u);
      result = result.add(u); made.push(result);
    }
    if (cut.length) {
      const u = cut.length === 1 ? cut[0] : api.Manifold.union(cut);
      if (u !== cut[0]) made.push(u);
      result = result.subtract(u); made.push(result);
    }
    if (result.status() !== 'NoError' || result.isEmpty()) return null;
    return { geometry: fromSolid(result), failed };
  } catch (err) {
    console.warn('Edge rounding failed', err);
    return null;
  } finally {
    for (const s of made) try { s.delete(); } catch { /* freed */ }
  }
}
