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
export const ARC_SEGMENTS = 12;
const MIN_EDGE = 0.4; // mm // facets per quarter circle of fillet

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
  // tiny creases are faceting left where curved patches meet (e.g. a baked ball corner), not edges
  return chains.filter((c) => c.length >= MIN_EDGE);
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
  // face normals either side of each segment (segment k runs from point k to k + 1)
  const segA = segs.map((sg) => faces[sg.fA].n.clone()), segB = segs.map((sg) => faces[sg.fB].n.clone());
  return { points, closed, convex: segs[0].convex, nA, nB, segA, segB, color, length, ends: closed ? null : [ids[0], ids[n - 1]] };
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

/**
 * Closed mesh swept along an edge chain. Each segment carries the exact cross-section for its
 * own two faces; where segments meet, the section is the mitre (the two neighbouring sweeps cut
 * by the plane halfway between them), so joints and curved edges close up without gaps.
 * Returns a Manifold or null.
 */
function sweepPiece(api, chain, r, chamfer = false) {
  const P = chain.points, n = P.length, closed = chain.closed;
  const nseg = closed ? n : n - 1;
  if (nseg < 1) return null;
  let maxTheta = 0;
  for (let k = 0; k < nseg; k++) maxTheta = Math.max(maxTheta, Math.acos(THREE.MathUtils.clamp(chain.segA[k].dot(chain.segB[k]), -1, 1)));
  const segs = Math.max(2, Math.ceil((maxTheta / (Math.PI / 2)) * ARC_SEGMENTS));
  const dir = [], S = [];
  for (let k = 0; k < nseg; k++) {
    dir.push(P[(k + 1) % n].clone().sub(P[k]).normalize());
    const sec = section(P[k], chain.segA[k], chain.segB[k], r, chain.convex, segs, chamfer);
    if (!sec) return null;
    S.push(sec.pts);
  }
  // slide a section along its own sweep direction onto a plane
  const onto = (pts, d, origin, m) => {
    const den = d.dot(m);
    return pts.map((p) => p.clone().addScaledVector(d, origin.clone().sub(p).dot(m) / den));
  };
  const joint = (j) => {
    const kin = (j - 1 + nseg) % nseg, kout = j % nseg;
    const m = dir[kin].clone().add(dir[kout]);
    if (m.lengthSq() < 1e-6) return null;
    m.normalize();
    if (dir[kin].dot(m) < 0.2) return null; // turns back on itself
    const a = onto(S[kin], dir[kin], P[j], m), b = onto(S[kout], dir[kout], P[j], m);
    return a.map((p, i) => p.add(b[i]).multiplyScalar(0.5));
  };
  const secs = [];
  if (closed) {
    for (let j = 0; j < n; j++) secs.push(joint(j));
  } else {
    secs.push(S[0].map((p) => p.clone()));
    for (let j = 1; j < n - 1; j++) secs.push(joint(j));
    secs.push(onto(S[nseg - 1], dir[nseg - 1], P[n - 1], dir[nseg - 1]));
    if (chain.convex) {
      // run the cutter just past open ends so no skin is left at the end faces
      secs[0].forEach((p) => p.addScaledVector(dir[0], -EPS));
      secs[n - 1].forEach((p) => p.addScaledVector(dir[nseg - 1], EPS));
    }
  }
  if (secs.some((x) => !x)) return null;
  const m = secs[0].length;
  const c = chain.color || [0.7, 0.7, 0.7];
  const props = new Float32Array(n * m * 6);
  secs.forEach((sec, i) => sec.forEach((p, j) => props.set([p.x, p.y, p.z, c[0], c[1], c[2]], (i * m + j) * 6)));
  const tri = [];
  const V = (i, j) => i * m + (j % m);
  const rings = closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < m; j++) tri.push(V(i, j), V(i, j + 1), V(i2, j + 1), V(i, j), V(i2, j + 1), V(i2, j));
  }
  if (!closed) {
    for (let j = 1; j < m - 1; j++) tri.push(V(0, 0), V(0, j + 1), V(0, j));
    for (let j = 1; j < m - 1; j++) tri.push(V(n - 1, 0), V(n - 1, j), V(n - 1, j + 1));
  }
  let vol = 0; // orient outwards
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

const near = (p, q, tol = 2e-3) => p.distanceToSquared(q) < tol * tol;
const sameDir = (a, b) => a.dot(b) > 0.9995;

/** Reverse a chain (points and segments) without changing which face is on which side. */
function reversed(ch) {
  const segA = [...ch.segA].reverse(), segB = [...ch.segB].reverse();
  const points = [...ch.points].reverse();
  if (ch.closed) { points.unshift(points.pop()); segA.push(segA.shift()); segB.push(segB.shift()); }
  return { ...ch, points, segA, segB };
}
const swapped = (ch) => ({ ...ch, segA: ch.segB, segB: ch.segA });

/**
 * Join picked edges that meet end to end into longer chains so they are swept as one piece with
 * mitred joints (no notch where two rounded edges meet). Edges join only where exactly two of
 * them meet, with the same type and size, and both border the same face. A corner where three
 * meet is left for the ball patch. items: [{ chain, r, t, count }] -> same shape, merged.
 */
function mergeItems(items) {
  const open = items.filter((it) => !it.chain.closed);
  const out = items.filter((it) => it.chain.closed);
  const endsAt = (it, e) => (e === 0 ? it.chain.points[0] : it.chain.points[it.chain.points.length - 1]);
  const facesAt = (it, e) => { const k = e === 0 ? 0 : it.chain.segA.length - 1; return [it.chain.segA[k], it.chain.segB[k]]; };
  const link = new Map(); // item -> [link at end 0, link at end 1]
  for (const it of open) link.set(it, [null, null]);
  for (const it of open) for (const e of [0, 1]) {
    const p = endsAt(it, e);
    const here = [];
    for (const o of open) for (const f of [0, 1]) if (near(endsAt(o, f), p)) here.push({ o, f });
    if (here.length !== 2) continue;
    const other = here.find((h) => !(h.o === it && h.f === e));
    if (!other || other.o === it) continue;
    const o = other.o;
    if (o.chain.convex !== it.chain.convex || o.t !== it.t || Math.abs(o.r - it.r) > 1e-6) continue;
    const fa = facesAt(it, e), fb = facesAt(o, other.f);
    // Edges that share a face join round a corner, meeting in a mitre (inside fills then have no
    // notch, and a round or chamfer runs on smoothly). The mitre is only exact when both edges
    // have the same angle between their faces, so outside edges with different angles (the top
    // and side edges of a wedge) are cut separately, which already meets correctly.
    const shares = fa.some((a) => fb.some((b) => sameDir(a, b)));
    const sameAngle = Math.abs(fa[0].dot(fa[1]) - fb[0].dot(fb[1])) < 0.03;
    const shared = shares && (!it.chain.convex || sameAngle);
    if (shared) link.get(it)[e] = other;
  }
  const done = new Set();
  const walk = (first, entry) => {
    let chain = null, count = 0, it = first, inEnd = entry;
    while (it && !done.has(it)) {
      done.add(it);
      let ch = inEnd === 0 ? it.chain : reversed(it.chain);
      if (chain) {
        // keep the shared face on the same side all along
        const k = chain.segA.length - 1;
        if (!sameDir(chain.segA[k], ch.segA[0]) && !sameDir(chain.segB[k], ch.segB[0])) {
          if (sameDir(chain.segA[k], ch.segB[0]) || sameDir(chain.segB[k], ch.segA[0])) ch = swapped(ch);
        }
        chain = { ...chain, points: [...chain.points, ...ch.points.slice(1)], segA: [...chain.segA, ...ch.segA], segB: [...chain.segB, ...ch.segB], length: chain.length + ch.length };
      } else chain = { ...ch };
      count += it.count ?? 1;
      const next = link.get(it)[1 - inEnd];
      if (!next) break;
      it = next.o; inEnd = next.f;
    }
    if (chain.points.length > 2 && near(chain.points[0], chain.points[chain.points.length - 1])) {
      chain.points.pop(); chain.closed = true; // came back round to the start: a loop
    }
    return { chain, r: first.r, t: first.t, count };
  };
  for (const it of open) { // start from chain ends first
    if (done.has(it)) continue;
    const [l0, l1] = link.get(it);
    if (!l0 || !l1) out.push(walk(it, l0 ? 1 : 0));
  }
  for (const it of open) if (!done.has(it)) out.push(walk(it, 0)); // what's left are loops
  return out;
}

/**
 * Split a chain into runs by which of the `owners` chains each segment lies on (-1: none, i.e.
 * an edge that did not exist before). A round fill blends smoothly into its faces, so after
 * filling, an outside edge, the fill's end and the next outside edge can come out as one chain.
 */
function splitByOwner(ch, owners, tol = 2e-3) {
  const P = ch.points, n = P.length, nseg = ch.closed ? n : n - 1;
  const seg = new THREE.Line3(), q = new THREE.Vector3();
  const ownerOf = (k) => {
    const mid = P[k].clone().lerp(P[(k + 1) % n], 0.5);
    return owners.findIndex((b) => {
      const Q = b.points, m = Q.length, bs = b.closed ? m : m - 1;
      for (let j = 0; j < bs; j++) {
        seg.set(Q[j], Q[(j + 1) % m]);
        if (seg.closestPointToPoint(mid, true, q).distanceToSquared(mid) < tol * tol) return true;
      }
      return false;
    });
  };
  const own = [];
  for (let k = 0; k < nseg; k++) own.push(ownerOf(k));
  if (own.every((o) => o === own[0])) return [{ chain: ch, owner: own[0] }];
  let start = 0;
  if (ch.closed) { while (own[start] === own[(start - 1 + nseg) % nseg]) start += 1; }
  const runs = [];
  for (let i = 0; i < nseg;) {
    const k0 = (start + i) % nseg, o = own[k0];
    const ks = [];
    while (i < nseg && own[(start + i) % nseg] === o) { ks.push((start + i) % nseg); i += 1; }
    const points = [...ks.map((k) => P[k]), P[(ks[ks.length - 1] + 1) % n]];
    runs.push({ owner: o, chain: { ...ch, closed: false, points, segA: ks.map((k) => ch.segA[k]), segB: ks.map((k) => ch.segB[k]) } });
  }
  return runs;
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
    for (const x of made) try { x.delete(); } catch { /* freed */ }
  }
}

/**
 * Where three chamfered convex edges with the same size meet, cut the corner off with a flat
 * triangle through the points where the chamfer bands meet on each face (the CAD "chamfer
 * corner"). The piece removed is the pyramid between the corner and that triangle's plane.
 */
function chamferCorner(api, V, ends, d) {
  if (ends.length !== 3) return null;
  const e = ends.map((x) => x.dir.clone().normalize());
  // on the face between edges i and j, the two chamfer lines cross at V + d/sin(angle) (ei + ej)
  const Q = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => {
    const sin = e[i].clone().cross(e[j]).length();
    return sin < 1e-3 ? null : V.clone().addScaledVector(e[i].clone().add(e[j]), d / sin);
  });
  if (Q.some((q) => !q)) return null;
  const N = Q[1].clone().sub(Q[0]).cross(Q[2].clone().sub(Q[0]));
  if (N.lengthSq() < 1e-12) return null;
  N.normalize();
  const off = Q[0].clone().sub(V).dot(N);
  const tips = [];
  for (const dir of e) {
    const den = dir.dot(N);
    if (Math.abs(den) < 1e-6 || off / den <= 0) return null;
    tips.push(V.clone().addScaledVector(dir, off / den));
  }
  // move the corner point outwards so the pyramid's sides sit just outside the faces, leaving
  // the triangle itself exactly in place
  const mid = tips[0].clone().add(tips[1]).add(tips[2]).multiplyScalar(1 / 3);
  const apex = V.clone().addScaledVector(V.clone().sub(mid).normalize(), 4 * EPS);
  try {
    return api.Manifold.hull([apex.toArray(), ...tips.map((p) => p.toArray())]);
  } catch {
    return null;
  }
}

/**
 * Round or chamfer the given edges of a closed solid. items: [{ chain, r, t, order }] in the
 * geometry's own frame, t = 'round' (r is the radius) or 'chamfer' (r is the set-back along each
 * face), order = when the edge was shaped (earlier edges are cut first).
 * `allChains` are all the edges of the solid, used to tell edges made by inside fills from
 * original ones. Returns { geometry, failed } (failed counts edges that could not be shaped),
 * or null when the solid itself could not be built.
 *
 * Order matters at corners where inside and outside edges meet: inside edges are filled
 * first, then the edges are found again on the filled solid, and each picked outside edge is
 * cut along what it has become. New edges a fill creates where it meets a picked outside edge
 * get the same treatment, so the round or chamfer carries on around the fill's end.
 */
export function filletEdges(geo, items, allChains = []) {
  const api = kernel();
  if (!api) return null;
  const base = toSolid(geo);
  if (!base) return null;
  const made = [base];
  let failed = 0;
  const unionOf = (list) => { const u = list.length === 1 ? list[0] : api.Manifold.union(list); if (u !== list[0]) made.push(u); return u; };
  const build = (list) => {
    const pieces = [];
    for (const it of mergeItems(list)) {
      const piece = sweepPiece(api, it.chain, it.r, it.t === 'chamfer');
      if (!piece) { failed += it.count ?? 1; continue; }
      made.push(piece); pieces.push(piece);
      it.done = true;
    }
    return pieces;
  };
  // Earlier stages changed the solid: find each picked edge again as what it has become, and
  // carry its treatment onto new edges an earlier stage made where they continue it (the end
  // of an inside fill, the top of a rounded corner), so it runs round instead of stopping short.
  const remap = (solid, stage, before) => {
    const now = findEdges(fromSolid(solid)).filter((c) => c.convex);
    const style = new Map();
    for (const it of stage) {
      let k = before.indexOf(it.chain);
      if (k < 0) k = before.push(it.chain) - 1;
      style.set(k, it);
    }
    const mapped = [], fresh = [], found = new Set();
    for (const c of now) for (const run of splitByOwner(c, before)) {
      if (run.owner < 0) fresh.push(run.chain);
      else if (style.has(run.owner)) {
        const it = style.get(run.owner);
        mapped.push({ chain: run.chain, r: it.r, t: it.t, count: found.has(it) ? 0 : 1 });
        found.add(it);
      }
    }
    failed += stage.filter((it) => !found.has(it)).length;
    // a new edge continues a picked one if it starts where that one ends, along a shared face,
    // turning less than 60 degrees
    const tips = [];
    for (const m of mapped) {
      const P = m.chain.points, n = P.length;
      if (m.chain.closed || n < 2) continue;
      tips.push({ m, at: P[0], heading: P[0].clone().sub(P[1]).normalize(), faces: [m.chain.segA[0], m.chain.segB[0]] });
      tips.push({ m, at: P[n - 1], heading: P[n - 1].clone().sub(P[n - 2]).normalize(), faces: [m.chain.segA[n - 2], m.chain.segB[n - 2]] });
    }
    const continues = (c, end) => {
      const P = c.points, n = P.length;
      const at = end === 0 ? P[0] : P[n - 1];
      const leave = (end === 0 ? P[1].clone().sub(P[0]) : P[n - 2].clone().sub(P[n - 1])).normalize();
      const k = end === 0 ? 0 : c.segA.length - 1;
      return tips.find((tp) => near(tp.at, at) && tp.heading.dot(leave) > 0.5
        && [c.segA[k], c.segB[k]].some((f) => tp.faces.some((g) => sameDir(f, g))));
    };
    for (const c of fresh) {
      if (c.closed) continue;
      const tp = continues(c, 0) || continues(c, 1);
      if (tp) mapped.push({ chain: c, r: tp.m.r, t: tp.m.t, count: 0 });
    }
    return mapped;
  };
  // corners where three outside edges of the same type and size meet: a ball patch for
  // rounds, a flat triangle for chamfers
  const cornerPieces = (list) => {
    const corners = [];
    for (const it of mergeItems(list)) {
      const ch = it.chain;
      if (ch.closed) continue;
      const n = ch.points.length, last = ch.segA.length - 1;
      corners.push({ V: ch.points[0], nA: ch.segA[0], nB: ch.segB[0], dir: ch.points[1].clone().sub(ch.points[0]).normalize(), r: it.r, t: it.t });
      corners.push({ V: ch.points[n - 1], nA: ch.segA[last], nB: ch.segB[last], dir: ch.points[n - 2].clone().sub(ch.points[n - 1]).normalize(), r: it.r, t: it.t });
    }
    const used = new Set(), pieces = [];
    for (const c of corners) {
      if (used.has(c)) continue;
      const group = corners.filter((o) => near(o.V, c.V));
      group.forEach((o) => used.add(o));
      if (group.length !== 3 || group.some((o) => Math.abs(o.r - c.r) > 1e-6 || o.t !== c.t)) continue;
      const piece = c.t === 'chamfer' ? chamferCorner(api, c.V, group, c.r) : cornerPiece(api, c.V, group, c.r);
      if (piece) { made.push(piece); pieces.push(piece); }
    }
    return pieces;
  };
  try {
    const inside = items.filter((it) => !it.chain.convex).map((it) => ({ ...it, count: 1 }));
    const outside = items.filter((it) => it.chain.convex).map((it) => ({ ...it, count: 1 }));
    const before = [...(allChains.length ? allChains : items.map((it) => it.chain))];
    let result = base, changed = false;

    // stage 1: inside fills
    const fills = build(inside);
    if (fills.length) { result = result.add(unionOf(fills)); made.push(result); changed = true; }

    // then outside edges, one type and size at a time, in the order they were shaped (like CAD
    // features): each stage is cut into the result of the ones before it
    const stages = new Map();
    for (const it of outside) {
      const key = it.t + ':' + it.r.toFixed(4);
      if (!stages.has(key)) stages.set(key, []);
      stages.get(key).push(it);
    }
    const first = (list) => Math.min(...list.map((it) => it.order ?? 0));
    const order = [...stages.values()].sort((a, b) => first(a) - first(b));
    for (const stage of order) {
      const list = changed ? remap(result, stage, before) : stage;
      const cuts = build(list);
      cuts.push(...cornerPieces(list));
      if (cuts.length) { result = result.subtract(unionOf(cuts)); made.push(result); changed = true; }
    }
    if (result.status() !== 'NoError' || result.isEmpty()) return null;
    return { geometry: fromSolid(result), failed };
  } catch (err) {
    console.warn('Edge rounding failed', err);
    return null;
  } finally {
    for (const x of made) try { x.delete(); } catch { /* freed */ }
  }
}
