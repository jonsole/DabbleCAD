// Auto-orient: choose the way up for a model that needs the least support material.
// Candidates are the directions of the model's big flat faces (they make good bases), the six axes and
// the current orientation. Each one is scored by an estimate of the support volume (overhanging area
// times the height it has to be propped up from the plate), the overhang area itself (rough underside
// finish), and a penalty for a tiny contact patch (a model that would barely stick to the bed).
import * as THREE from 'three';

const DOWN = new THREE.Vector3(0, 0, -1);

/** Triangle data of a (non-indexed) position array, optionally scaled. */
function prepare(pos, scale) {
  const n = pos.length / 9;
  const P = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { P[i] = pos[i] * scale[0]; P[i + 1] = pos[i + 1] * scale[1]; P[i + 2] = pos[i + 2] * scale[2]; }
  const N = new Float32Array(n * 3), A = new Float32Array(n);
  let flip = scale[0] * scale[1] * scale[2] < 0 ? -1 : 1;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    A[t] = len / 2;
    N[t * 3] = (flip * nx) / len; N[t * 3 + 1] = (flip * ny) / len; N[t * 3 + 2] = (flip * nz) / len;
  }
  return { P, N, A, n };
}

/** Score one orientation: `d` is the model-space direction that ends up facing the plate. */
function score(m, d, cosLimit) {
  const { P, N, A, n } = m;
  const dx = d.x, dy = d.y, dz = d.z;
  // height above the lowest point along -d
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const h = -(P[i] * dx + P[i + 1] * dy + P[i + 2] * dz);
    if (h < lo) lo = h; if (h > hi) hi = h;
  }
  let supportVol = 0, overhang = 0, contact = 0, total = 0;
  for (let t = 0; t < n; t++) {
    const a = A[t];
    total += a;
    const nd = N[t * 3] * dx + N[t * 3 + 1] * dy + N[t * 3 + 2] * dz;
    if (nd <= cosLimit) continue;               // steep enough to print without support
    const o = t * 9;
    const h0 = -(P[o] * dx + P[o + 1] * dy + P[o + 2] * dz) - lo;
    const h1 = -(P[o + 3] * dx + P[o + 4] * dy + P[o + 5] * dz) - lo;
    const h2 = -(P[o + 6] * dx + P[o + 7] * dy + P[o + 8] * dz) - lo;
    if (Math.max(h0, h1, h2) < 0.3 && nd > 0.98) { contact += a; continue; }  // it is the base itself
    const h = (h0 + h1 + h2) / 3;
    overhang += a;
    supportVol += a * nd * h;
  }
  let cost = supportVol + overhang * 2;
  const smallBase = 1 - Math.min(1, contact / (0.03 * total + 1e-9));
  cost += smallBase * total * 0.25;
  return { cost, supportVol, overhang, contact, height: hi - lo };
}

/** Candidate "down" directions in model space. */
function candidates(m, current) {
  const buckets = new Map();
  for (let t = 0; t < m.n; t++) {
    const x = m.N[t * 3], y = m.N[t * 3 + 1], z = m.N[t * 3 + 2];
    const key = `${Math.round(x * 25)},${Math.round(y * 25)},${Math.round(z * 25)}`;
    const b = buckets.get(key);
    if (b) { b.a += m.A[t]; b.v.x += x * m.A[t]; b.v.y += y * m.A[t]; b.v.z += z * m.A[t]; }
    else buckets.set(key, { a: m.A[t], v: new THREE.Vector3(x * m.A[t], y * m.A[t], z * m.A[t]) });
  }
  const top = [...buckets.values()].sort((p, q) => q.a - p.a).slice(0, 36).map((b) => b.v.normalize());
  const list = [...top, current];
  for (const a of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) list.push(new THREE.Vector3(...a));
  return list;
}

/**
 * @param positions non-indexed triangle positions (model space)
 * @param scale     [sx, sy, sz] factors (1 = 100 %)
 * @param current   { rx, ry, rz } degrees (XYZ Euler, as PlateModel stores them)
 * @param supportAngle degrees: faces flatter than this (from horizontal) need support
 * @returns { rx, ry, rz, before, after, changed }
 */
export function bestOrientation(positions, scale, current, supportAngle = 50) {
  const m = prepare(positions, scale);
  const cosLimit = Math.cos((Math.max(1, Math.min(89, supportAngle)) * Math.PI) / 180);
  const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(current.rx), THREE.MathUtils.degToRad(current.ry), THREE.MathUtils.degToRad(current.rz), 'XYZ'));
  const curDown = DOWN.clone().applyQuaternion(q0.clone().invert());
  const before = score(m, curDown, cosLimit);
  let best = { d: curDown, s: before };
  for (const d of candidates(m, curDown)) {
    const s = score(m, d, cosLimit);
    if (s.cost < best.s.cost - 1e-6 || (Math.abs(s.cost - best.s.cost) < 1e-6 && s.height < best.s.height)) best = { d, s };
  }
  // not worth turning the model for a marginal gain
  if (best.s.cost > before.cost * 0.97 - 1e-6) return { ...current, before, after: before, changed: false };
  const q = new THREE.Quaternion().setFromUnitVectors(best.d.clone().normalize(), DOWN);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const r = (v) => Math.round(THREE.MathUtils.radToDeg(v) * 100) / 100 || 0;
  return { rx: r(e.x), ry: r(e.y), rz: r(e.z), before, after: best.s, changed: true };
}
