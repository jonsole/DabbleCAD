// Sketch: draw a precise 2D outline (rectangles, circles / ellipses, polygons) and pull it up
// into a 3D shape. Shapes are edited the way 3D shapes are in the main view: drag to move,
// handles to resize and rotate, dimensions shown on the shape, and an inspector-style panel.
// Items can add material (Solid) or cut it away (Hole).
import { h, modal, button, toast, clear, icon } from './dom.js';
import { regionPolys } from '../core/solid.js';

const W = 760, H = 460;
const SEL = '#29c5ff';
const HANDLE = 4.5; // half size of a handle square, px
const ROT_OFFSET = 26; // px from the top edge to the rotate handle
let nextId = 1;

const rad = (deg) => (deg * Math.PI) / 180;
const rot = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const fmt = (v) => String(+(+v).toFixed(2));

/**
 * The shape's own frame: centre, angle and half sizes. Rectangles and ellipses keep their angle
 * (rot, degrees); a polygon's rotation is baked into its points, so its frame is its bounding box.
 */
function frameOf(it) {
  if (it.type === 'rect') return { c: [it.x + it.w / 2, it.y + it.h / 2], a: rad(it.rot || 0), hx: it.w / 2, hy: it.h / 2 };
  if (it.type === 'circle') return { c: [it.cx, it.cy], a: rad(it.rot || 0), hx: it.rx ?? it.r, hy: it.ry ?? it.r };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of it.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { c: [(x0 + x1) / 2, (y0 + y1) / 2], a: 0, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2 };
}
const toWorld = (f, q) => { const r = rot(q, f.a); return [f.c[0] + r[0], f.c[1] + r[1]]; };
const toLocal = (f, p) => rot([p[0] - f.c[0], p[1] - f.c[1]], -f.a);

function outline(item) {
  if (item.type === 'rect') {
    const f = frameOf(item);
    return [[-f.hx, -f.hy], [f.hx, -f.hy], [f.hx, f.hy], [-f.hx, f.hy]].map((q) => toWorld(f, q));
  }
  if (item.type === 'circle') {
    const f = frameOf(item);
    const n = Math.max(24, Math.min(96, Math.round(Math.max(f.hx, f.hy) * 6)));
    return Array.from({ length: n }, (_, i) => toWorld(f, [f.hx * Math.cos((i / n) * Math.PI * 2), f.hy * Math.sin((i / n) * Math.PI * 2)]));
  }
  return item.pts.map((p) => [p[0], p[1]]);
}

/** Give a shape a new box in its own (starting) frame f0: lx0..lx1 by ly0..ly1. */
function setBox(it, it0, f0, lx0, lx1, ly0, ly1) {
  const w = Math.max(0.1, lx1 - lx0), hh = Math.max(0.1, ly1 - ly0);
  const c = toWorld(f0, [(lx0 + lx1) / 2, (ly0 + ly1) / 2]);
  if (it.type === 'rect') Object.assign(it, { x: c[0] - w / 2, y: c[1] - hh / 2, w, h: hh });
  else if (it.type === 'circle') Object.assign(it, { cx: c[0], cy: c[1], rx: w / 2, ry: hh / 2, r: (w + hh) / 4 });
  else {
    const sx = f0.hx > 1e-9 ? w / (2 * f0.hx) : 1, sy = f0.hy > 1e-9 ? hh / (2 * f0.hy) : 1;
    it.pts = it0.pts.map((p) => {
      const q = toLocal(f0, p);
      return toWorld(f0, [(lx0 + lx1) / 2 + q[0] * sx, (ly0 + ly1) / 2 + q[1] * sy]);
    });
  }
}

/** Rotate a shape about its centre by deg, starting from its state it0. */
function rotateTo(it, it0, deg) {
  if (it.type === 'poly') {
    const c = frameOf(it0).c;
    it.pts = it0.pts.map((p) => { const r = rot([p[0] - c[0], p[1] - c[1]], rad(deg)); return [c[0] + r[0], c[1] + r[1]]; });
  } else {
    let a = ((it0.rot || 0) + deg) % 360;
    if (a > 180) a -= 360; if (a <= -180) a += 360;
    it.rot = Math.abs(a) < 1e-9 ? 0 : a;
  }
}

/** Interior angle at each corner of a polygon, in degrees (over 180 at an inward corner). */
function interiorAngles(pts) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  const ccw = area >= 0;
  return pts.map((b, i) => {
    const a = pts[(i - 1 + n) % n], c = pts[(i + 1) % n];
    const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
    // anticlockwise from the outgoing edge to the incoming one is the inside of an anticlockwise polygon
    let t = Math.atan2(v[0] * u[1] - v[1] * u[0], v[0] * u[0] + v[1] * u[1]);
    if (!ccw) t = -t;
    if (t < 0) t += Math.PI * 2;
    return (t * 180) / Math.PI;
  });
}

/**
 * Set the interior angle at corner i: the corner and its incoming edge stay put, the outgoing
 * edge swings round (keeping its length), so only the next point moves.
 */
function setInteriorAngle(it, i, deg) {
  const pts = it.pts, n = pts.length;
  if (n < 3 || !(deg > 0 && deg < 360)) return false;
  let area = 0;
  for (let k = 0; k < n; k++) { const p = pts[k], q = pts[(k + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  const s = area >= 0 ? 1 : -1;
  const ia = (i - 1 + n) % n, ic = (i + 1) % n;
  const a = pts[ia], b = pts[i], c = pts[ic];
  const u = [a[0] - b[0], a[1] - b[1]], lu = Math.hypot(u[0], u[1]);
  const v = [c[0] - b[0], c[1] - b[1]], lv = Math.hypot(v[0], v[1]);
  if (lu < 1e-9 || lv < 1e-9) return false;
  if (!isLocked(it, ic)) { // swing the outgoing edge: the next point moves
    const d = rot([u[0] / lu, u[1] / lu], -s * rad(deg));
    pts[ic] = [+(b[0] + d[0] * lv).toFixed(4), +(b[1] + d[1] * lv).toFixed(4)];
    return true;
  }
  if (!isLocked(it, ia)) { // next point is locked: swing the incoming edge, the previous point moves
    const d = rot([v[0] / lv, v[1] / lv], s * rad(deg));
    pts[ia] = [+(b[0] + d[0] * lu).toFixed(4), +(b[1] + d[1] * lu).toFixed(4)];
    return true;
  }
  return 'locked';
}

// ------------------------------------------------------------------ named dimensions
// A corner angle, an edge length or a rectangle / ellipse size can be given a name (A, L1...).
// Every dimension using the same name is held at that value: params[name] = { kind, value },
// item.angleRef[i] / item.lenRef[i] (edge i runs from point i to i + 1) / item.wRef / item.hRef.

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const stripUnit = (t) => String(t).trim().replace(/\s*(°|deg|mm)$/i, '');
/** Names used in a formula. */
const namesIn = (expr) => String(expr).match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];

/**
 * What was typed in a dimension box: "12.5" -> { value }, "A" -> { name }, "A=45" ->
 * { name, value }, "B=L*2" -> { name, expr }, "L*2" -> { expr }.
 */
function parseDim(text) {
  const t = stripUnit(text);
  if (!t) return { error: true };
  if (isFinite(Number(t))) return { value: Number(t) };
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(t);
  if (m) {
    const rhs = stripUnit(m[2]);
    return rhs !== '' && isFinite(Number(rhs)) ? { name: m[1], value: Number(rhs) } : { name: m[1], expr: rhs };
  }
  if (NAME.test(t)) return { name: t };
  return { expr: t };
}

/** Evaluate a formula: numbers, names, + - * / and brackets. Throws an Error with a message. */
function evalExpr(expr, params, kind, seen = new Set()) {
  const src = stripUnit(expr);
  let i = 0;
  const fail = (msg) => { throw new Error(msg); };
  const peek = () => { while (src[i] === ' ') i++; return src[i]; };
  const factor = () => {
    const c = peek();
    if (c === '-') { i++; return -factor(); }
    if (c === '+') { i++; return factor(); }
    if (c === '(') { i++; const v = sum(); if (peek() !== ')') fail('Missing )'); i++; return v; }
    let m = /^(\d+(?:\.\d*)?|\.\d+)/.exec(src.slice(i));
    if (m) { i += m[0].length; return Number(m[0]); }
    m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (m) { i += m[0].length; return paramValue(m[0], params, kind, seen); }
    return fail(c === undefined ? 'The formula ends too soon' : `Unexpected "${c}" in the formula`);
  };
  const prod = () => {
    let v = factor();
    for (;;) {
      const c = peek();
      if (c === '*') { i++; v *= factor(); } else if (c === '/') { i++; const d = factor(); if (d === 0) fail('Division by zero'); v /= d; } else return v;
    }
  };
  const sum = () => {
    let v = prod();
    for (;;) { const c = peek(); if (c === '+') { i++; v += prod(); } else if (c === '-') { i++; v -= prod(); } else return v; }
  };
  const v = sum();
  if (peek() !== undefined) fail(`Unexpected "${peek()}" in the formula`);
  if (!isFinite(v)) fail('The formula is not a number');
  return v;
}

/** A named dimension's value (working out its formula, if it has one). */
function paramValue(name, params, kind, seen = new Set()) {
  const pm = params[name];
  if (!pm) throw new Error(`${name} isn't defined`);
  if (kind && pm.kind !== kind) throw new Error(`${name} is ${pm.kind === 'angle' ? 'an angle' : 'a length'}`);
  if (pm.expr === undefined) return pm.value;
  if (seen.has(name)) throw new Error(`${name} depends on itself`);
  const v = evalExpr(pm.expr, params, pm.kind, new Set([...seen, name]));
  pm.value = v; // kept for display
  return v;
}
/** The value a dimension is linked to (a name or a formula), or undefined if it can't be worked out. */
const refValue = (ref, params, kind) => { try { return evalExpr(ref, params, kind); } catch { return undefined; } };

const edgeLen = (pts, i) => { const a = pts[i], b = pts[(i + 1) % pts.length]; return Math.hypot(b[0] - a[0], b[1] - a[1]); };
const angleDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };

/** Linear solve (Gaussian elimination with partial pivoting); A is n x n, modified in place. */
function linSolve(A, bv) {
  const n = bv.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    [A[c], A[p]] = [A[p], A[c]]; [bv[c], bv[p]] = [bv[p], bv[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      bv[r] -= f * bv[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = bv[r];
    for (let k = r + 1; k < n; k++) v -= A[r][k] * x[k];
    x[r] = v / A[r][r];
  }
  return x;
}

/**
 * Re-solve the sketch so every named dimension has its value. Rectangle and ellipse sizes are
 * set directly. Polygon angles and lengths are met by moving unlocked points as little as
 * possible (damped least squares, which takes the smallest change when there is freedom left).
 * hold: { fixed: Set of "itemId:pointIndex" kept still, cons: extra one-off targets to keep }.
 * Returns true when everything is met.
 */
const newUid = () => 'u' + Math.random().toString(36).slice(2, 9);
const edgeVec = (it, i) => { const p = it.pts[i], q = it.pts[(i + 1) % it.pts.length]; return [q[0] - p[0], q[1] - p[1]]; };

/** How far a geometric constraint is from being met (0 when met), in mm. */
function geoResidual(g) {
  if (g.type === 'horizontal') return edgeVec(g.A, g.a.i)[1];
  if (g.type === 'vertical') return edgeVec(g.A, g.a.i)[0];
  if (g.type === 'parallel' || g.type === 'perpendicular') {
    const d1 = edgeVec(g.A, g.a.i), d2 = edgeVec(g.B, g.b.i);
    const l1 = Math.hypot(d1[0], d1[1]), l2 = Math.hypot(d2[0], d2[1]);
    if (l1 < 1e-9 || l2 < 1e-9) return 0;
    const v = g.type === 'parallel' ? d1[0] * d2[1] - d1[1] * d2[0] : d1[0] * d2[0] + d1[1] * d2[1];
    return (v / (l1 * l2)) * ((l1 + l2) / 2);
  }
  if (g.type === 'online') { // point a lies on the line through edge b
    const p = g.A.pts[g.a.i], e0 = g.B.pts[g.b.i], d = edgeVec(g.B, g.b.i), l = Math.hypot(d[0], d[1]);
    return l < 1e-9 ? 0 : (d[0] * (p[1] - e0[1]) - d[1] * (p[0] - e0[0])) / l;
  }
  return 0;
}

function solveSketch(items, params, hold = {}, constraints = []) {
  for (const it of items) {
    if (it.type !== 'rect' && it.type !== 'circle') continue;
    const w = it.wRef ? refValue(it.wRef, params, 'length') : undefined, hh = it.hRef ? refValue(it.hRef, params, 'length') : undefined;
    if (!(w > 0) && !(hh > 0)) continue;
    const f0 = frameOf(it);
    const hx = w > 0 ? w / 2 : f0.hx, hy = hh > 0 ? hh / 2 : f0.hy;
    setBox(it, clone(it), f0, -hx, hx, -hy, hy);
  }
  const cons = [];
  for (const it of items) {
    if (it.type !== 'poly') continue;
    (it.angleRef || []).forEach((ref, i) => { const v = ref && refValue(ref, params, 'angle'); if (v !== undefined && v !== null && v !== '') cons.push({ it, type: 'angle', i, value: v }); });
    (it.lenRef || []).forEach((ref, i) => { const v = ref && refValue(ref, params, 'length'); if (v !== undefined && v !== null && v !== '') cons.push({ it, type: 'len', i, value: v }); });
  }
  cons.push(...(hold.cons || []));
  const byUid = new Map(items.filter((it) => it.type === 'poly').map((it) => [it.uid, it]));
  const geo = [];
  for (const c of constraints) {
    const A = c.a && byUid.get(c.a.uid), B = c.b && byUid.get(c.b.uid);
    if (A && (!c.b || B)) geo.push({ ...c, A, B });
  }
  if (!cons.length && !geo.length) return true;
  const polys = [...new Set([...cons.map((c) => c.it), ...geo.flatMap((g) => (g.B ? [g.A, g.B] : [g.A]))])];
  const fixed = hold.fixed || new Set();
  const scale = new Map(polys.map((it) => [it, Math.max(1, it.pts.reduce((t, _, i) => t + edgeLen(it.pts, i), 0) / it.pts.length)]));
  const terms = [
    ...cons.map((c) => ({ its: [c.it], f: () => (c.type === 'angle'
      ? rad(angleDiff(interiorAngles(c.it.pts)[c.i], c.value)) * scale.get(c.it)
      : edgeLen(c.it.pts, c.i) - c.value) })),
    ...geo.map((g) => ({ its: g.B ? [g.A, g.B] : [g.A], f: () => geoResidual(g) })),
  ];
  const resid = () => terms.map((t) => t.f());
  const norm = (r) => r.reduce((t, v) => t + v * v, 0);
  const met = () => Math.sqrt(norm(resid())) < 1e-3;
  const healthy = () => polys.every((it) => it.pts.every((_, i) => edgeLen(it.pts, i) >= 0.01));
  if (met()) return true;

  // Damped least squares over the free points of the given shapes.
  const attempt = (shapes) => {
    const vars = [];
    for (const it of shapes) it.pts.forEach((_, i) => { if (!isLocked(it, i) && !fixed.has(it.id + ':' + i)) vars.push({ it, i }); });
    if (!vars.length) return false;
    const n = vars.length * 2;
    let x = vars.flatMap((v) => v.it.pts[v.i]);
    const put = (xs) => vars.forEach((v, k) => { v.it.pts[v.i] = [xs[2 * k], xs[2 * k + 1]]; });
    let r = resid(), f = norm(r), mu = 1e-4;
    for (let iter = 0; iter < 200 && f > 1e-14; iter++) {
      const J = r.map(() => new Float64Array(n));
      for (let j = 0; j < n; j++) {
        const hstep = 1e-6 * Math.max(1, Math.abs(x[j]));
        const xs = [...x]; xs[j] += hstep; put(xs);
        const r2 = resid();
        for (let i = 0; i < r.length; i++) J[i][j] = (r2[i] - r[i]) / hstep;
      }
      put(x);
      const A = Array.from({ length: n }, (_, i) => { const row = new Float64Array(n); for (let k = 0; k < n; k++) { let v = 0; for (let q = 0; q < r.length; q++) v += J[q][i] * J[q][k]; row[k] = v; } row[i] += mu; return row; });
      const g = Array.from({ length: n }, (_, i) => { let v = 0; for (let q = 0; q < r.length; q++) v -= J[q][i] * r[q]; return v; });
      const d = linSolve(A, g);
      if (!d) { mu *= 10; continue; }
      const x2 = x.map((v, i) => v + d[i]);
      put(x2);
      const r2 = resid(), f2 = norm(r2);
      if (f2 < f) { x = x2; r = r2; f = f2; mu = Math.max(mu / 4, 1e-10); } else { put(x); mu *= 5; if (mu > 1e9) break; }
    }
    put(x.map((v) => Math.round(v * 1e5) / 1e5));
    // meeting the constraints by shrinking an edge to nothing doesn't count
    return met() && healthy();
  };

  // Move as few shapes as possible, like a CAD solver: try each shape with an unmet term on its
  // own (the least constrained first), and only then everything together.
  const start = polys.map((it) => it.pts.map((q) => [...q]));
  const reset = () => polys.forEach((it, k) => { it.pts = start[k].map((q) => [...q]); });
  const load = (it) => terms.filter((t) => t.its.includes(it)).length;
  const unmet = [...new Set(terms.filter((t) => Math.abs(t.f()) >= 1e-4).flatMap((t) => t.its))].sort((a, b) => load(a) - load(b));
  for (const it of unmet) {
    if (attempt([it])) return true;
    reset();
  }
  if (polys.length > 1 || !unmet.length) {
    if (attempt(polys)) return true;
    reset();
  }
  return false;
}

/** Edge i's length: its far end slides along the edge (or its start, if the far end is locked). */
function setEdgeLength(it, i, len) {
  const pts = it.pts, n = pts.length, j = (i + 1) % n;
  if (!(len > 0)) return false;
  const a = pts[i], b = pts[j];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (l < 1e-9) return false;
  const d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  if (!isLocked(it, j)) { pts[j] = [a[0] + d[0] * len, a[1] + d[1] * len]; return true; }
  if (!isLocked(it, i)) { pts[i] = [b[0] - d[0] * len, b[1] - d[1] * len]; return true; }
  return 'locked';
}

/**
 * Add a point to a polygon after point k (on edge k), keeping its per-point data in step:
 * locks, named angles (per point), named lengths (per edge; the split edge loses its length
 * name), and constraints. A constraint on the split edge applies to both halves (they stay in
 * line), except point-on-line, which stays with the first half. Returns the new constraints.
 */
function insertPoint(it, k, p, constraints) {
  const n = it.pts.length, at = k + 1;
  it.pts.splice(at, 0, [p[0], p[1]]);
  if (it.lock) it.lock.splice(at, 0, false);
  if (it.angleRef) it.angleRef.splice(at, 0, null);
  if (it.lenRef) { it.lenRef[k] = null; it.lenRef.splice(at, 0, null); if (!it.lenRef.some(Boolean)) delete it.lenRef; }
  void n;
  const shift = (ref) => (ref.uid !== it.uid || ref.i <= k ? ref : { ...ref, i: ref.i + 1 });
  const out = [];
  for (const c of constraints) {
    const moved = { ...c, a: shift(c.a), ...(c.b ? { b: shift(c.b) } : {}) };
    out.push(moved);
    // the second half of a split edge gets the same line constraint
    const onSplit = (ref) => ref && ref.uid === it.uid && ref.kind === 'edge' && ref.i === k;
    if (c.type !== 'online' && (onSplit(c.a) || onSplit(c.b))) {
      const half = (ref) => (onSplit(ref) ? { ...ref, i: at } : shift(ref));
      out.push({ ...c, a: half(c.a), ...(c.b ? { b: half(c.b) } : {}) });
    }
  }
  return out;
}

/**
 * Remove point k of a polygon (it keeps at least 3). Its two edges become one: constraints on
 * the point or either edge are dropped, as are the length names of those edges and the
 * point's angle name; everything after it is renumbered. Returns the new constraints, or null.
 */
function removePoint(it, k, constraints) {
  const n = it.pts.length;
  if (n <= 3) return null;
  const prev = (k - 1 + n) % n;
  it.pts.splice(k, 1);
  if (it.lock) { it.lock.splice(k, 1); if (!it.lock.some(Boolean)) delete it.lock; }
  if (it.angleRef) { it.angleRef.splice(k, 1); if (!it.angleRef.some(Boolean)) delete it.angleRef; }
  if (it.lenRef) {
    it.lenRef[prev] = null; // the merged edge is new
    it.lenRef.splice(k, 1);
    if (!it.lenRef.some(Boolean)) delete it.lenRef;
  }
  const gone = (ref) => ref.uid === it.uid && (ref.kind === 'point' ? ref.i === k : ref.i === k || ref.i === prev);
  const shift = (ref) => (ref.uid !== it.uid || ref.i < k ? ref : { ...ref, i: ref.i - 1 });
  return constraints.filter((c) => !gone(c.a) && !(c.b && gone(c.b)))
    .map((c) => ({ ...c, a: shift(c.a), ...(c.b ? { b: shift(c.b) } : {}) }));
}

const isLocked = (it, i) => !!(it.lock && it.lock[i]);
const anyLocked = (it) => it.type === 'poly' && !!(it.lock && it.lock.some(Boolean));

function moveItem(it, dx, dy) {
  if (it.type === 'rect') { it.x += dx; it.y += dy; }
  else if (it.type === 'circle') { it.cx += dx; it.cy += dy; }
  else it.pts = it.pts.map((p) => [p[0] + dx, p[1] + dy]);
}

const inside = (pt, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
};

const kindName = (it) => (it.type === 'rect' ? 'Rectangle'
  : it.type === 'circle' ? (Math.abs((it.rx ?? it.r) - (it.ry ?? it.r)) < 1e-6 ? 'Circle' : 'Ellipse')
    : 'Polygon');

/** Convert sketch items into extrusion polygons (centred on their bounding box). */
export function sketchPolys(items) {
  const adds = items.filter((i) => !i.cut).map(outline).filter((p) => p.length >= 3);
  const cuts = items.filter((i) => i.cut).map(outline).filter((p) => p.length >= 3);
  if (!adds.length) return null;
  let polys = regionPolys(adds, cuts);
  if (!polys) polys = adds.map((outer) => ({ outer, holes: [] })); // kernel unavailable: cuts are ignored
  if (!polys.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const [x, y] of p.outer) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const shift = (pt) => [pt[0] - cx, pt[1] - cy];
  return polys.map((p) => ({ outer: p.outer.map(shift), holes: p.holes.map((hh) => hh.map(shift)) }));
}

const clone = (it) => ({ ...it, pts: it.pts ? it.pts.map((p) => [...p]) : undefined, lock: it.lock ? [...it.lock] : undefined,
  angleRef: it.angleRef ? [...it.angleRef] : undefined, lenRef: it.lenRef ? [...it.lenRef] : undefined });

/** Opens the sketch editor. Resolves to { polys, sketch, depth } or null. */
export function sketchDialog(existing) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({ title: 'Sketch', width: W + 380, onClose: () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); resolve(result); } });
    const canvas = h('canvas', { class: 'sketch-canvas', width: W, height: H, tabindex: 0, 'aria-label': 'Sketch drawing area' });
    const ctx = canvas.getContext('2d');
    let items = existing && existing.items ? existing.items.map((i) => ({ ...clone(i), uid: i.uid || newUid(), id: nextId++ })) : [];
    // geometric constraints between polygon edges and points: { type, a: { uid, kind, i }, b }
    let constraints = existing && existing.constraints ? JSON.parse(JSON.stringify(existing.constraints)) : [];
    let picks = []; // edges and points picked for constraints: { uid, kind: 'edge' | 'point', i }
    let hoverPick = null;
    let depth = existing && existing.depth ? existing.depth : 10;
    let sheet = existing && existing.sheet ? existing.sheet : 120;
    let tool = 'select', snap = 1, selected = null, draft = null, drag = null, cursor = null, hover = null;
    let params = existing && existing.params ? JSON.parse(JSON.stringify(existing.params)) : {};
    const undo = [];
    const snapshot = () => JSON.stringify({ items, params, constraints });
    const restore = (str) => { const st = JSON.parse(str); items = st.items; params = st.params || {}; constraints = st.constraints || []; };
    const solve = (hold = {}) => solveSketch(items, params, hold, constraints);
    const remember = () => { undo.push(snapshot()); if (undo.length > 50) undo.shift(); };
    /** Re-solve after an edit; if the named dimensions can't all be met, put things back. */
    const settle = (hold, { revert = true } = {}) => {
      if (solve(hold)) return true;
      if (revert && undo.length) { restore(undo.pop()); toast('That can\'t be done while keeping the named dimensions and locked points'); }
      return false;
    };
    const sel = () => items.find((i) => i.id === selected) || null;
    const toastLocked = () => toast('This shape has locked points, so it can\'t be moved, resized or rotated. Unlock them in Points.');

    // the view: k pixels per mm, (ox, oy) the sketch point at the middle of the canvas
    const view = { k: W / sheet, ox: 0, oy: 0 };
    let gridStep = 5;
    const scale = () => view.k;
    const toPx = (p) => [W / 2 + (p[0] - view.ox) * view.k, H / 2 - (p[1] - view.oy) * view.k];
    const fromPx = (q) => [view.ox + (q[0] - W / 2) / view.k, view.oy - (q[1] - H / 2) / view.k];
    const rawMm = (e) => {
      const r = canvas.getBoundingClientRect();
      return fromPx([(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]);
    };
    const zoomAt = (q, factor) => {
      const m = fromPx(q);
      view.k = Math.min(400, Math.max(0.3, view.k * factor));
      view.ox = m[0] - (q[0] - W / 2) / view.k;
      view.oy = m[1] + (q[1] - H / 2) / view.k;
      draw();
    };
    const fit = () => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const it of items) for (const [x, y] of outline(it)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (!isFinite(x0)) { view.k = W / sheet; view.ox = 0; view.oy = 0; draw(); return; }
      const w = Math.max(x1 - x0, 1), hh = Math.max(y1 - y0, 1);
      view.k = Math.min(400, Math.max(0.3, Math.min((W * 0.8) / w, (H * 0.75) / hh)));
      view.ox = (x0 + x1) / 2; view.oy = (y0 + y1) / 2;
      draw();
    };
    const snapStep = (e) => (e && e.altKey) || !snap ? 0 : snap;
    const snapV = (v, s) => (s ? Math.round(v / s) * s : Math.round(v * 100) / 100);
    const toMm = (e) => { const [x, y] = rawMm(e); const s = snapStep(e); return [snapV(x, s), snapV(y, s)]; };
    const pxOf = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

    // ---- handles of the selected shape, in canvas pixels
    function handles(it) {
      const f = frameOf(it);
      const out = [];
      for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) {
        if (!sx && !sy) continue;
        if (it.type === 'poly' && (f.hx < 1e-6 && sx || f.hy < 1e-6 && sy)) continue;
        out.push({ kind: 'size', sx, sy, px: toPx(toWorld(f, [sx * f.hx, sy * f.hy])) });
      }
      // rotate handle: above the top edge, along the shape's own "up" on screen
      const top = toPx(toWorld(f, [0, f.hy])), cen = toPx(f.c);
      let ux = top[0] - cen[0], uy = top[1] - cen[1];
      const len = Math.hypot(ux, uy);
      if (len < 1e-6) { const u = rot([0, 1], f.a); ux = u[0]; uy = -u[1]; } else { ux /= len; uy /= len; }
      out.push({ kind: 'rotate', px: [top[0] + ux * ROT_OFFSET, top[1] + uy * ROT_OFFSET], from: top });
      if (anyLocked(it)) out.length = 0; // a locked point pins the shape: no resizing or rotating
      if (it.type === 'poly') {
        it.pts.forEach((p, i) => out.push({ kind: 'vertex', i, locked: isLocked(it, i), px: toPx(p) }));
        // a '+' in the middle of each edge adds a point there
        it.pts.forEach((p, i) => {
          const a = toPx(p), b = toPx(it.pts[(i + 1) % it.pts.length]);
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 26) out.push({ kind: 'insert', i, px: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
        });
      }
      return out;
    }
    const handleAt = (it, px) => {
      const list = handles(it);
      // vertices first (they sit on the outline), then rotate, then size handles
      const order = [...list.filter((x) => x.kind === 'vertex'), ...list.filter((x) => x.kind === 'insert'), ...list.filter((x) => x.kind === 'rotate'), ...list.filter((x) => x.kind === 'size')];
      return order.find((hd) => !hd.locked && Math.hypot(hd.px[0] - px[0], hd.px[1] - px[1]) <= (hd.kind === 'rotate' ? 9 : hd.kind === 'insert' ? 6 : HANDLE + 3)) || null;
    };
    const cursorFor = (hd, it) => {
      if (!hd) return '';
      if (hd.kind === 'rotate') return 'grab';
      if (hd.kind === 'vertex') return 'crosshair';
      if (hd.kind === 'insert') return 'copy';
      // pick the resize cursor nearest the handle's direction on screen
      const f = frameOf(it);
      const d = rot([hd.sx, hd.sy], f.a);
      const ang = ((Math.atan2(-d[1], d[0]) * 180) / Math.PI + 360) % 180;
      return ang < 22.5 || ang >= 157.5 ? 'ew-resize' : ang < 67.5 ? 'nesw-resize' : ang < 112.5 ? 'ns-resize' : 'nwse-resize';
    };

    function smallTag(text, x, y) {
      ctx.font = 'bold 10px sans-serif';
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = 'rgba(30,34,44,0.9)'; ctx.strokeStyle = 'rgba(255,179,71,0.9)'; ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 8, w, 16, 3); else ctx.rect(x - w / 2, y - 8, w, 16);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffb347'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }

    function label(text, x, y, linked = false) {
      ctx.font = '11px sans-serif';
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = linked ? SEL : '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 9, w, 18, 4); else ctx.rect(x - w / 2, y - 9, w, 18);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1b1d22';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }

    function draw() {
      const k = scale();
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = css('--bg-2', '#1c1f27'); ctx.fillRect(0, 0, W, H);
      // grid spacing follows the zoom: the finest step that stays at least 8 px apart
      const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((st) => st * k >= 8) || 1000;
      const major = step * 5; // every fifth line is darker
      const [vx0, vy1] = fromPx([0, 0]), [vx1, vy0] = fromPx([W, H]);
      ctx.lineWidth = 1;
      const line = (v, isX) => {
        const onMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        ctx.strokeStyle = Math.abs(v) < step / 2 ? 'rgba(120,160,255,0.55)' : onMajor ? 'rgba(128,140,160,0.24)' : 'rgba(128,140,160,0.1)';
        const q = toPx(isX ? [v, 0] : [0, v]);
        ctx.beginPath();
        if (isX) { const x = Math.round(q[0]) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); } else { const y = Math.round(q[1]) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
      };
      for (let v = Math.floor(vx0 / step) * step; v <= vx1; v += step) line(v, true);
      for (let v = Math.floor(vy0 / step) * step; v <= vy1; v += step) line(v, false);
      gridStep = step;
      const path = (pts, close = true) => { ctx.beginPath(); pts.forEach((p, i) => { const q = toPx(p); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); if (close) ctx.closePath(); };
      for (const pass of [false, true]) {
        for (const it of items) {
          if (!!it.cut !== pass) continue;
          path(outline(it));
          ctx.fillStyle = it.cut ? 'rgba(201,208,216,0.30)' : 'rgba(63,167,163,0.45)';
          ctx.fill();
          ctx.strokeStyle = it.id === selected ? SEL : it.id === hover ? 'rgba(41,197,255,0.6)' : it.cut ? '#aab3bd' : '#58c9c4';
          ctx.lineWidth = it.id === selected ? 2 : 1.5;
          ctx.setLineDash(it.cut ? [6, 4] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      // picked (and hovered) edges and points, for constraints
      const drawPick = (pk, strong) => {
        const pi = byUid(pk.uid);
        if (!pi || pi.type !== 'poly' || pk.i >= pi.pts.length) return;
        ctx.strokeStyle = strong ? SEL : 'rgba(41,197,255,0.55)';
        if (pk.kind === 'edge') {
          const a = toPx(pi.pts[pk.i]), b = toPx(pi.pts[(pk.i + 1) % pi.pts.length]);
          ctx.lineWidth = strong ? 4 : 3; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        } else {
          const q = toPx(pi.pts[pk.i]);
          ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q[0], q[1], 8, 0, Math.PI * 2); ctx.stroke();
        }
      };
      if (tool === 'select') {
        if (hoverPick && !picks.some((q) => samePick(q, hoverPick))) drawPick(hoverPick, false);
        for (const pk of picks) drawPick(pk, true);
      }
      const it = sel();
      if (it && tool === 'select') {
        const f = frameOf(it);
        // box outline in the shape's own frame
        if (it.type !== 'rect') {
          path([[-f.hx, -f.hy], [f.hx, -f.hy], [f.hx, f.hy], [-f.hx, f.hy]].map((q) => toWorld(f, q)));
          ctx.strokeStyle = 'rgba(41,197,255,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
        }
        const hs = handles(it);
        const r = hs.find((x) => x.kind === 'rotate');
        if (r) { ctx.strokeStyle = SEL; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(r.from[0], r.from[1]); ctx.lineTo(r.px[0], r.px[1]); ctx.stroke(); }
        for (const hd of hs) {
          if (hd.kind === 'size') {
            ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#1b1d22'; ctx.lineWidth = 1;
            ctx.fillRect(hd.px[0] - HANDLE, hd.px[1] - HANDLE, HANDLE * 2, HANDLE * 2);
            ctx.strokeRect(hd.px[0] - HANDLE + 0.5, hd.px[1] - HANDLE + 0.5, HANDLE * 2 - 1, HANDLE * 2 - 1);
          } else if (hd.kind === 'insert') {
            ctx.fillStyle = css('--bg-2', '#1c1f27'); ctx.strokeStyle = SEL; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(hd.px[0], hd.px[1], 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(hd.px[0] - 2.5, hd.px[1]); ctx.lineTo(hd.px[0] + 2.5, hd.px[1]); ctx.moveTo(hd.px[0], hd.px[1] - 2.5); ctx.lineTo(hd.px[0], hd.px[1] + 2.5); ctx.stroke();
          } else if (hd.kind === 'vertex' && hd.locked) {
            ctx.fillStyle = '#8a93a3'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
            ctx.fillRect(hd.px[0] - 4.5, hd.px[1] - 4.5, 9, 9); ctx.strokeRect(hd.px[0] - 4.5, hd.px[1] - 4.5, 9, 9);
          } else if (hd.kind === 'vertex') {
            ctx.fillStyle = SEL; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(hd.px[0], hd.px[1], 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          } else {
            ctx.fillStyle = '#ffffff'; ctx.strokeStyle = SEL; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(hd.px[0], hd.px[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.strokeStyle = '#1b1d22'; ctx.lineWidth = 1.3;
            ctx.beginPath(); ctx.arc(hd.px[0], hd.px[1], 3.6, -Math.PI * 0.9, Math.PI * 0.55); ctx.stroke();
          }
        }
        // interior angles at a polygon's corners, just inside each corner
        if (it.type === 'poly' && it.pts.length >= 3) {
          const angs = interiorAngles(it.pts), n = it.pts.length;
          it.pts.forEach((p, i) => {
            const P = toPx(p), A = toPx(it.pts[(i - 1 + n) % n]), C = toPx(it.pts[(i + 1) % n]);
            const ua = [A[0] - P[0], A[1] - P[1]], uc = [C[0] - P[0], C[1] - P[1]];
            const la = Math.hypot(ua[0], ua[1]) || 1, lc = Math.hypot(uc[0], uc[1]) || 1;
            let bx = ua[0] / la + uc[0] / lc, by = ua[1] / la + uc[1] / lc;
            let bl = Math.hypot(bx, by);
            if (bl < 1e-6) { bx = -ua[1] / la; by = ua[0] / la; bl = 1; } // straight corner: go sideways
            bx /= bl; by /= bl;
            if (angs[i] > 180) { bx = -bx; by = -by; } // inward corner: the inside is the other way
            const nm = it.angleRef && it.angleRef[i];
            const linked = !!nm && refValue(nm, params, 'angle') !== undefined;
            label(linked ? `${nm} ${fmt(angs[i])}°` : `${fmt(angs[i])}°`, P[0] + bx * 26, P[1] + by * 26, linked);
          });
          // edge lengths, just outside each edge
          const cen = it.pts.reduce((acc, q) => [acc[0] + q[0] / n, acc[1] + q[1] / n], [0, 0]);
          const Cp = toPx(cen);
          it.pts.forEach((p, i) => {
            const A = toPx(p), B = toPx(it.pts[(i + 1) % n]);
            const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
            let nx = -(B[1] - A[1]), ny = B[0] - A[0];
            const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
            if (nx * (Cp[0] - mx) + ny * (Cp[1] - my) > 0) { nx = -nx; ny = -ny; }
            const nm = it.lenRef && it.lenRef[i];
            const linked = !!nm && refValue(nm, params, 'length') !== undefined;
            label(linked ? `${nm} ${fmt(edgeLen(it.pts, i))}` : fmt(edgeLen(it.pts, i)), mx + nx * 14, my + ny * 14, linked);
          });
        }
        // dimensions, outside the bottom and left edges
        const out = (q, d) => { const a = toPx(toWorld(f, q)), c = toPx(f.c); const dx = a[0] - c[0], dy = a[1] - c[1], l = Math.hypot(dx, dy) || 1; return [a[0] + (dx / l) * d, a[1] + (dy / l) * d]; };
        const wPx = out([0, -f.hy], 18), hPx = out([-f.hx, 0], 26);
        if (it.type !== 'poly') { // a polygon shows its edge lengths instead
          if (f.hx > 1e-6) label(it.wRef ? `${it.wRef} ${fmt(f.hx * 2)}` : fmt(f.hx * 2), wPx[0], wPx[1], !!it.wRef);
          if (f.hy > 1e-6) label(it.hRef ? `${it.hRef} ${fmt(f.hy * 2)}` : fmt(f.hy * 2), hPx[0], hPx[1], !!it.hRef);
        }
        if (drag && drag.kind === 'rotate' && r) label(`${fmt(drag.deg)}°`, r.px[0], r.px[1] - 18);
      }
      if (draft) {
        ctx.strokeStyle = SEL; ctx.lineWidth = 1.5;
        if (draft.type === 'poly') {
          path([...draft.pts, ...(cursor ? [cursor] : [])], false); ctx.stroke();
          for (const p of draft.pts) { const q = toPx(p); ctx.fillStyle = SEL; ctx.beginPath(); ctx.arc(q[0], q[1], 3.5, 0, Math.PI * 2); ctx.fill(); }
        } else {
          path(outline(draft)); ctx.stroke();
          const f = frameOf(draft);
          const b = toPx([f.c[0], f.c[1] - f.hy]), l = toPx([f.c[0] - f.hx, f.c[1]]);
          if (f.hx > 0.05) label(fmt(f.hx * 2), b[0], b[1] + 18);
          if (draft.type === 'rect' && f.hy > 0.05) label(fmt(f.hy * 2), l[0] - 26, l[1]);
        }
      }
      // constraint symbols, by the middle of each constrained edge or at the point
      const glyphAt = (ref, text, shift) => {
        const ci = byUid(ref.uid);
        if (!ci || ci.type !== 'poly' || ref.i >= ci.pts.length) return;
        let q;
        if (ref.kind === 'edge') { const a = toPx(ci.pts[ref.i]), b = toPx(ci.pts[(ref.i + 1) % ci.pts.length]); q = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
        else q = toPx(ci.pts[ref.i]);
        const c = ci.pts.reduce((acc, v) => [acc[0] + v[0] / ci.pts.length, acc[1] + v[1] / ci.pts.length], [0, 0]);
        const cq = toPx(c), dx = cq[0] - q[0], dy = cq[1] - q[1], l = Math.hypot(dx, dy) || 1;
        smallTag(text, q[0] + (dx / l) * (14 + shift), q[1] + (dy / l) * (14 + shift));
      };
      const count = new Map();
      const slot = (ref) => { const k = ref.uid + ref.kind + ref.i; const n = count.get(k) || 0; count.set(k, n + 1); return n * 16; };
      constraints.forEach((c, n) => {
        const sym = { horizontal: 'H', vertical: 'V', parallel: `∥${n + 1}`, perpendicular: `⊥${n + 1}`, online: `⊙${n + 1}` }[c.type];
        glyphAt(c.a, sym, slot(c.a));
        if (c.b) glyphAt(c.b, sym, slot(c.b));
      });
      ctx.fillStyle = css('--muted', '#9aa3b2'); ctx.font = '12px sans-serif';
      if (cursor) ctx.fillText(`${cursor[0].toFixed(1)}, ${cursor[1].toFixed(1)} mm`, 10, H - 10);
      const gtxt = `Grid ${fmt(gridStep)} mm`;
      ctx.fillText(gtxt, W - ctx.measureText(gtxt).width - 10, H - 10);
    }

    const hit = (pt) => { for (let i = items.length - 1; i >= 0; i--) if (inside(pt, outline(items[i]))) return items[i]; return null; };
    const polys = () => items.filter((it) => it.type === 'poly');
    const byUid = (uid) => items.find((it) => it.uid === uid);
    /** Polygon corner under the pointer (within 7 px), topmost first. */
    const pointAt = (px) => {
      for (const it of polys().reverse()) for (let i = 0; i < it.pts.length; i++) { const q = toPx(it.pts[i]); if (Math.hypot(q[0] - px[0], q[1] - px[1]) <= 7) return { it, i }; }
      return null;
    };
    /** Polygon edge under the pointer (within 6 px). */
    const edgeAt = (px) => {
      let best = null, bd = 6;
      for (const it of polys().reverse()) for (let i = 0; i < it.pts.length; i++) {
        const a = toPx(it.pts[i]), b = toPx(it.pts[(i + 1) % it.pts.length]);
        const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
        const t = L > 0 ? Math.min(1, Math.max(0, ((px[0] - a[0]) * dx + (px[1] - a[1]) * dy) / L)) : 0;
        const d = Math.hypot(a[0] + t * dx - px[0], a[1] + t * dy - px[1]);
        if (d < bd) { bd = d; best = { it, i }; }
      }
      return best;
    };
    const samePick = (p, q) => p.uid === q.uid && p.kind === q.kind && p.i === q.i;
    /** Pick an edge or point for constraints; Shift adds to (or removes from) the picks. */
    const pickPart = (pk, add, it) => {
      if (add) picks = picks.some((q) => samePick(q, pk)) ? picks.filter((q) => !samePick(q, pk)) : [...picks, pk];
      else picks = [pk];
      if (!add || !sel()) selected = it.id;
      panel(); draw();
    };
    const pick = (id) => { selected = id; panel(); draw(); };
    const finishPoly = () => {
      if (draft && draft.type === 'poly' && draft.pts.length >= 3) { remember(); const it = { ...draft, uid: newUid(), id: nextId++ }; items.push(it); selected = it.id; setTool('select'); }
      draft = null; panel(); draw();
    };

    // pan: right or middle drag, or Space + drag
    let pan = null, spaceDown = false;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt([(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)], Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        pan = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy };
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      canvas.focus();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const p = toMm(e), px = pxOf(e);
      if (tool === 'select') {
        const cur = sel();
        const hd = cur && handleAt(cur, px);
        if (hd && hd.kind === 'insert') {
          // dragging the '+' adds a point there; a plain click picks the edge, like clicking the edge
          drag = { kind: 'insert', hd, startPx: px, shift: e.shiftKey, uid: cur.uid };
          return;
        }
        if (hd && hd.kind === 'vertex') {
          // a corner of the selected polygon: drag it, or (a click without moving) pick it
          remember();
          drag = { kind: 'vertex', hd, startPx: px, moved: false, shift: e.shiftKey, uid: cur.uid };
          return;
        }
        if (hd) {
          remember();
          drag = { kind: hd.kind, hd, it0: clone(cur), f0: frameOf(cur), start: rawMm(e), deg: 0 };
          if (hd.kind === 'rotate') canvas.style.cursor = 'grabbing';
          draw();
          return;
        }
        const pt = pointAt(px);
        if (pt) { pickPart({ uid: pt.it.uid, kind: 'point', i: pt.i }, e.shiftKey, pt.it); return; }
        const ed = edgeAt(px);
        if (ed) { pickPart({ uid: ed.it.uid, kind: 'edge', i: ed.i }, e.shiftKey, ed.it); return; }
        if (!e.shiftKey) picks = [];
        const it = hit(rawMm(e));
        selected = it ? it.id : null;
        if (it && anyLocked(it)) toastLocked();
        else if (it) { remember(); drag = { kind: 'move', last: p }; }
        panel(); draw();
      } else if (tool === 'poly') {
        if (!draft) draft = { type: 'poly', pts: [p], cut: false };
        else {
          const first = draft.pts[0];
          if (draft.pts.length >= 3 && Math.hypot(first[0] - p[0], first[1] - p[1]) * scale() < 9) { finishPoly(); return; }
          draft.pts.push(p);
        }
        draw();
      } else {
        draft = tool === 'rect' ? { type: 'rect', x: p[0], y: p[1], w: 0, h: 0, rot: 0, cut: false, anchor: p } : { type: 'circle', cx: p[0], cy: p[1], r: 0, cut: false };
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (pan) {
        const r = canvas.getBoundingClientRect();
        view.ox = pan.ox - ((e.clientX - pan.x) * (W / r.width)) / view.k;
        view.oy = pan.oy + ((e.clientY - pan.y) * (H / r.height)) / view.k;
        draw();
        return;
      }
      const p = toMm(e);
      cursor = p;
      const it = sel();
      if (drag && it) {
        if (drag.kind === 'move') { moveItem(it, p[0] - drag.last[0], p[1] - drag.last[1]); drag.last = p; }
        else if (drag.kind === 'insert') {
          const q = pxOf(e);
          if (Math.hypot(q[0] - drag.startPx[0], q[1] - drag.startPx[1]) >= 3) {
            remember();
            const k = drag.hd.i;
            constraints = insertPoint(it, k, p, constraints);
            picks = [];
            drag = { kind: 'vertex', hd: { i: k + 1 }, startPx: drag.startPx, moved: true, shift: false, uid: it.uid, inserted: true };
            solve({ fixed: new Set([it.id + ':' + (k + 1)]) });
            panel();
          }
        }
        else if (drag.kind === 'vertex') {
          const q = pxOf(e);
          if (!drag.moved && Math.hypot(q[0] - drag.startPx[0], q[1] - drag.startPx[1]) >= 3) drag.moved = true;
          if (drag.moved) { it.pts[drag.hd.i] = p; solve({ fixed: new Set([it.id + ':' + drag.hd.i]) }); }
        }
        else if (drag.kind === 'rotate') {
          const c = drag.f0.c, q = rawMm(e);
          let deg = ((Math.atan2(q[1] - c[1], q[0] - c[0]) - Math.atan2(drag.start[1] - c[1], drag.start[0] - c[0])) * 180) / Math.PI;
          deg = ((deg + 540) % 360) - 180;
          if (!e.altKey) deg = Math.round(deg / 15) * 15;
          drag.deg = deg;
          rotateTo(it, drag.it0, deg);
          solve();
        } else {
          // resize in the shape's own frame from where the drag started; the opposite side stays put
          const { sx, sy } = drag.hd, f0 = drag.f0;
          const s = snapStep(e);
          const square = Math.abs(f0.a) < 1e-9;
          const q = toLocal(f0, square ? p : rawMm(e));
          let lx0 = -f0.hx, lx1 = f0.hx, ly0 = -f0.hy, ly1 = f0.hy;
          if (sx > 0) lx1 = Math.max(lx0 + 0.1, q[0]); else if (sx < 0) lx0 = Math.min(lx1 - 0.1, q[0]);
          if (sy > 0) ly1 = Math.max(ly0 + 0.1, q[1]); else if (sy < 0) ly0 = Math.min(ly1 - 0.1, q[1]);
          if (!square && s) { // rotated: snap the size rather than the edge position
            if (sx) { const w = Math.max(s, snapV(lx1 - lx0, s)); if (sx > 0) lx1 = lx0 + w; else lx0 = lx1 - w; }
            if (sy) { const hh = Math.max(s, snapV(ly1 - ly0, s)); if (sy > 0) ly1 = ly0 + hh; else ly0 = ly1 - hh; }
          }
          if (e.shiftKey && sx && sy && f0.hx > 1e-9 && f0.hy > 1e-9) { // keep proportions from the corner
            const k = Math.max((lx1 - lx0) / (2 * f0.hx), (ly1 - ly0) / (2 * f0.hy));
            const w = 2 * f0.hx * k, hh = 2 * f0.hy * k;
            if (sx > 0) lx1 = lx0 + w; else lx0 = lx1 - w;
            if (sy > 0) ly1 = ly0 + hh; else ly0 = ly1 - hh;
          }
          setBox(it, drag.it0, f0, lx0, lx1, ly0, ly1);
          solve(); // named sizes, lengths and constraints hold
        }
        panelNumbers();
      } else if (draft && draft.type === 'rect') {
        draft.x = Math.min(draft.anchor[0], p[0]); draft.y = Math.min(draft.anchor[1], p[1]);
        draft.w = Math.abs(p[0] - draft.anchor[0]); draft.h = Math.abs(p[1] - draft.anchor[1]);
      } else if (draft && draft.type === 'circle') {
        draft.r = Math.hypot(p[0] - draft.cx, p[1] - draft.cy);
      } else if (tool === 'select' && !drag) {
        const px = pxOf(e);
        const hd = it && handleAt(it, px);
        const pt = hd ? null : pointAt(px), ed = hd || pt ? null : edgeAt(px);
        hoverPick = pt ? { uid: pt.it.uid, kind: 'point', i: pt.i } : ed ? { uid: ed.it.uid, kind: 'edge', i: ed.i } : null;
        const over = hd || hoverPick ? null : hit(rawMm(e));
        hover = over ? over.id : null;
        canvas.style.cursor = hd ? cursorFor(hd, it) : hoverPick ? 'pointer' : over ? (anyLocked(over) ? 'not-allowed' : 'move') : 'default';
      }
      draw();
    });

    canvas.addEventListener('pointerup', () => {
      if (pan) { pan = null; canvas.style.cursor = spaceDown ? 'grab' : tool === 'select' ? 'default' : 'crosshair'; return; }
      if (drag) {
        if (drag.kind === 'rotate') canvas.style.cursor = 'grab';
        const d = drag;
        drag = null;
        if (d.kind === 'insert') { pickPart({ uid: d.uid, kind: 'edge', i: d.hd.i }, d.shift, sel()); return; }
        if (d.kind === 'vertex' && d.inserted) { if (!settle({})) { panel(); draw(); return; } pickPart({ uid: d.uid, kind: 'point', i: d.hd.i }, false, sel()); return; }
        if (d.kind === 'vertex' && !d.moved) { undo.pop(); pickPart({ uid: d.uid, kind: 'point', i: d.hd.i }, d.shift, sel()); return; }
        panel(); draw();
        return;
      }
      if (!draft || draft.type === 'poly') return;
      const ok = draft.type === 'rect' ? draft.w > 0.2 && draft.h > 0.2 : draft.r > 0.2;
      if (ok) {
        remember();
        const { anchor, ...it } = draft; void anchor;
        it.id = nextId++;
        it.uid = newUid();
        items.push(it);
        selected = it.id;
        setTool('select'); // ready to adjust, like a shape dropped in the 3D view
      }
      draft = null; panel(); draw();
    });
    canvas.addEventListener('pointerleave', () => { cursor = null; hover = null; draw(); });
    canvas.addEventListener('dblclick', (e) => {
      if (tool === 'poly') { finishPoly(); return; }
      if (tool !== 'select' || pointAt(pxOf(e))) return; // on a point: nothing to add
      const ed = edgeAt(pxOf(e));
      if (!ed) return;
      // the point goes on the edge, at the snapped position nearest the pointer
      const a = ed.it.pts[ed.i], b = ed.it.pts[(ed.i + 1) % ed.it.pts.length], q = toMm(e);
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      const t = L > 0 ? Math.min(0.98, Math.max(0.02, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0.5;
      remember();
      constraints = insertPoint(ed.it, ed.i, [a[0] + dx * t, a[1] + dy * t], constraints);
      selected = ed.it.id;
      picks = [{ uid: ed.it.uid, kind: 'point', i: ed.i + 1 }];
      if (!settle({})) picks = [];
      panel(); draw();
    });

    /** Add a constraint from the picked edges and points, then re-solve (undone if impossible). */
    const addConstraint = (type) => {
      const edges = picks.filter((q) => q.kind === 'edge'), points = picks.filter((q) => q.kind === 'point');
      const c = type === 'online' ? { type, a: points[0], b: edges[0] } : { type, a: edges[0], ...(edges[1] ? { b: edges[1] } : {}) };
      const same = (x, y) => x.type === y.type && samePick(x.a, y.a) && (!x.b || (y.b && samePick(x.b, y.b)));
      if (constraints.some((x) => same(x, c) || (c.b && x.type === c.type && x.b && samePick(x.a, c.b) && samePick(x.b, c.a)))) { toast('That constraint is already there'); return; }
      const opposite = { horizontal: 'vertical', vertical: 'horizontal', parallel: 'perpendicular', perpendicular: 'parallel' }[type];
      const clash = opposite && constraints.find((x) => x.type === opposite && samePick(x.a, c.a) && (!c.b || (x.b && samePick(x.b, c.b))) || (x.type === opposite && c.b && x.b && samePick(x.a, c.b) && samePick(x.b, c.a)));
      if (clash) { toast(`That edge is already ${opposite}`); return; }
      remember();
      constraints.push(c);
      if (settle({})) picks = [];
      panel(); draw();
    };

    /** Remove polygon points (each polygon keeps at least 3), then re-solve (undone if impossible). */
    const removePoints = (list) => {
      const byShape = new Map();
      for (const q of list) { if (!byShape.has(q.uid)) byShape.set(q.uid, []); byShape.get(q.uid).push(q.i); }
      for (const [uid, idx] of byShape) {
        const it = byUid(uid);
        if (!it || it.type !== 'poly') continue;
        if (it.pts.length - new Set(idx).size < 3) { toast('A polygon needs at least 3 points'); return; }
      }
      remember();
      for (const [uid, idx] of byShape) {
        const it = byUid(uid);
        for (const i of [...new Set(idx)].sort((x, y) => y - x)) constraints = removePoint(it, i, constraints) || constraints; // highest first, so the rest keep their numbers
      }
      // a polygon with no area left can't become a shape
      const flat = [...byShape.keys()].map(byUid).some((it) => {
        let area = 0;
        for (let i = 0; i < it.pts.length; i++) { const p = it.pts[i], q = it.pts[(i + 1) % it.pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
        return Math.abs(area) / 2 < 0.01;
      });
      if (flat) { restore(undo.pop()); toast('That would leave the polygon flat'); panel(); draw(); return; }
      picks = [];
      settle({});
      panel(); draw();
    };
    const removePickedPoints = () => removePoints(picks.filter((q) => q.kind === 'point'));

    const removeSelected = () => {
      const it = sel();
      if (!it) return;
      remember();
      items = items.filter((i) => i.id !== selected);
      constraints = constraints.filter((c) => c.a.uid !== it.uid && (!c.b || c.b.uid !== it.uid));
      picks = picks.filter((q) => q.uid !== it.uid);
      selected = null; panel(); draw();
    };
    const duplicate = () => {
      const it = sel();
      if (!it) return;
      remember();
      const c = { ...clone(it), uid: newUid(), id: nextId++ };
      delete c.lock; // the copy is placed beside the original, so its points can't stay locked
      moveItem(c, snap || 1, -(snap || 1));
      items.push(c); selected = c.id; panel(); draw();
    };
    const undoOnce = () => { const s = undo.pop(); if (s) { restore(s); if (!sel()) selected = null; panel(); draw(); } };

    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (!document.body.contains(canvas)) return;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === ' ') { stop(); if (!spaceDown) { spaceDown = true; if (!pan) canvas.style.cursor = 'grab'; } return; }
      if (!ctrl && (e.key === '+' || e.key === '=')) { stop(); zoomAt([W / 2, H / 2], 1.25); return; }
      if (!ctrl && (e.key === '-' || e.key === '_')) { stop(); zoomAt([W / 2, H / 2], 0.8); return; }
      if (!ctrl && (e.key === 'f' || e.key === 'F')) { stop(); fit(); return; }
      if (e.key === 'Enter' && draft && draft.type === 'poly') { stop(); finishPoly(); }
      else if (e.key === 'Escape' && (draft || selected || picks.length)) { stop(); if (draft) draft = null; else if (picks.length) { picks = []; panel(); } else { selected = null; panel(); } draw(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && picks.some((q) => q.kind === 'point')) { stop(); removePickedPoints(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { stop(); removeSelected(); }
      else if (ctrl && e.key.toLowerCase() === 'z') { stop(); undoOnce(); }
      else if (ctrl && e.key.toLowerCase() === 'd') { stop(); duplicate(); }
      else if (e.key.startsWith('Arrow') && sel()) {
        stop();
        if (anyLocked(sel())) { toastLocked(); return; }
        const d = (snap || 1) * (e.shiftKey ? 10 : 1);
        if (!e.repeat) remember();
        moveItem(sel(), e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowDown' ? -d : e.key === 'ArrowUp' ? d : 0);
        panelNumbers(); draw();
      }
    };
    // on window, so it runs before the dialog's own Escape (which would close the sketch)
    window.addEventListener('keydown', onKey, true);
    const onKeyUp = (e) => { if (e.key === ' ' && spaceDown) { spaceDown = false; if (!pan) canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair'; } };
    window.addEventListener('keyup', onKeyUp, true);

    // ---- side panel: inspector-style properties of the selected shape
    const side = h('div', { class: 'sketch-side inspector-like' });
    let fields = [];
    const numField = (get, set, { min = -10000 } = {}) => {
      const input = h('input', { class: 'input', type: 'number', step: 0.1, min, value: fmt(get()) });
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (isFinite(v) && v >= min) { remember(); set(v); draw(); panelNumbers(); } else input.value = fmt(get());
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      fields.push({ input, get });
      return input;
    };
    const panelNumbers = () => { for (const f of fields) if (document.activeElement !== f.input) f.input.value = f.raw ? f.get() : fmt(f.get()); };

    /** Names used by any shape; unused names are dropped. */
    const usedNames = () => {
      const u = new Set();
      for (const it of items) for (const ref of [...(it.angleRef || []), ...(it.lenRef || []), it.wRef, it.hRef]) if (ref) namesIn(ref).forEach((nm) => u.add(nm));
      // and the names those use in their own formulas
      for (let grew = true; grew;) {
        grew = false;
        for (const nm of [...u]) if (params[nm] && params[nm].expr) for (const dep of namesIn(params[nm].expr)) if (!u.has(dep)) { u.add(dep); grew = true; }
      }
      return u;
    };
    const prune = () => { const u = usedNames(); for (const k of Object.keys(params)) if (!u.has(k)) delete params[k]; };
    const refArray = (it, key, i, name) => {
      const arr = it[key] ? [...it[key]] : new Array(it.pts.length).fill(null);
      arr[i] = name || null;
      if (arr.some(Boolean)) it[key] = arr; else delete it[key];
    };
    const unitOf = (kind) => (kind === 'angle' ? '°' : 'mm');

    /**
     * A dimension box. It takes a number (a one-off change), a name like A (labels this
     * dimension, or links it to an existing A), A=45 (sets A and links), a formula like L*2
     * (links to it) or B=L*2 (names the formula and links). Linked boxes show "A = 45".
     * holdFor(v) applies a one-off value and returns what the solver should keep, or false.
     */
    const dimField = ({ kind, get, getRef, setRef, holdFor, valid }) => {
      const show = () => { const ref = getRef(); const v = ref ? refValue(ref, params, kind) : undefined; return v !== undefined ? `${ref} = ${fmt(v)}` : fmt(get()); };
      const eg = kind === 'angle' ? 'A' : 'L';
      const input = h('input', { class: 'input dim', type: 'text', value: show(), spellcheck: false, title: `A number, a name to label it (${eg}), ${eg}=value, or a formula (${eg}*2, ${eg}/2+1)` });
      input.classList.toggle('linked', !!(getRef() && refValue(getRef(), params, kind) !== undefined));
      input.addEventListener('focus', () => input.select());
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); else if (e.key === 'Escape') { input.value = show(); input.blur(); } });
      input.addEventListener('change', () => {
        const d = parseDim(input.value);
        const fail = (msg) => { toast(msg); input.value = show(); };
        const bad = kind === 'angle' ? 'Angle must be between 0 and 360°' : 'Length must be more than 0';
        if (d.error) return fail('Type a number, a name (like A), name=value or a formula');
        if (d.value !== undefined && !valid(d.value)) return fail(bad);
        remember();
        const back = (msg) => { restore(undo.pop()); return fail(msg); };
        try {
          if (d.name) {
            const pm = params[d.name];
            if (pm && pm.kind !== kind) return back(`${d.name} is ${pm.kind === 'angle' ? 'an angle' : 'a length'}`);
            if (d.expr !== undefined) params[d.name] = { kind, expr: d.expr, value: 0 };
            else if (!pm) params[d.name] = { kind, value: d.value ?? Math.round(get() * 1000) / 1000 };
            else if (d.value !== undefined) { pm.value = d.value; delete pm.expr; }
            if (!valid(paramValue(d.name, params, kind))) return back(bad);
            setRef(d.name);
          } else if (d.expr !== undefined) {
            if (!valid(evalExpr(d.expr, params, kind))) return back(bad);
            setRef(d.expr.replace(/\s+/g, ''));
          } else {
            setRef(undefined);
            prune();
            const hold = holdFor(d.value);
            if (hold === false) return back('Both neighbouring points are locked');
            settle(hold);
            panel(); draw();
            return undefined;
          }
        } catch (err) {
          return back(err.message);
        }
        prune();
        settle({});
        panel(); draw();
        return undefined;
      });
      fields.push({ input, get: show, raw: true });
      return input;
    };
    const section = (title, rows, open = true) => h('details', { class: 'insp-section', open }, h('summary', {}, title), ...rows);

    function panel() {
      clear(side);
      fields = [];
      const it = sel();
      if (!it) {
        side.append(h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, 'Sketch')));
      } else {
        side.append(h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, kindName(it)),
          button({ icon: 'duplicate', title: 'Duplicate (Ctrl+D)', onClick: duplicate }),
          button({ icon: 'trash', title: 'Delete (Del)', onClick: removeSelected })));
        const kind = (cut, labelText, swatchCls) => {
          const b = h('button', { class: 'kind-btn' + (!!it.cut === cut ? ' active' : ''), type: 'button', title: cut ? 'Hole: cuts this shape out' : 'Solid: adds material' },
            h('span', { class: 'swatch ' + swatchCls }), labelText);
          b.addEventListener('click', () => { if (!!it.cut !== cut) { remember(); it.cut = cut; panel(); draw(); } });
          return b;
        };
        side.append(h('div', { class: 'insp-kind' }, kind(false, 'Solid', 'swatch-sketch'), kind(true, 'Hole', 'swatch-hole')));

        const f = () => frameOf(it);
        const setCentre = (axis, v) => { const c = f().c; moveItem(it, axis === 0 ? v - c[0] : 0, axis === 1 ? v - c[1] : 0); };
        const setSize = (axis, v) => {
          const f0 = f(), it0 = clone(it);
          const hx = axis === 0 ? v / 2 : f0.hx, hy = axis === 1 ? v / 2 : f0.hy;
          setBox(it, it0, f0, -hx, hx, -hy, hy);
        };
        const rotIn = h('input', { class: 'input', type: 'text', placeholder: '0°', title: 'Type an angle and press Enter to rotate by it' });
        rotIn.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { const v = parseFloat(rotIn.value); rotIn.value = ''; if (isFinite(v) && v) { remember(); rotateTo(it, clone(it), v); draw(); panelNumbers(); } }
        });
        const rows = [
          h('div', { class: 'xyz xy' }, h('span', {}, ''), h('span', {}, 'X'), h('span', {}, 'Y')),
          h('div', { class: 'xyz xy' }, h('span', {}, 'Centre'), numField(() => f().c[0], (v) => setCentre(0, v)), numField(() => f().c[1], (v) => setCentre(1, v))),
          h('div', { class: 'xyz xy' }, h('span', {}, 'Size'), ...(it.type === 'poly'
            ? [numField(() => f().hx * 2, (v) => { setSize(0, v); settle({}); }, { min: 0.1 }), numField(() => f().hy * 2, (v) => { setSize(1, v); settle({}); }, { min: 0.1 })]
            : [0, 1].map((axis) => dimField({
              kind: 'length', valid: (v) => v > 0,
              get: () => (axis ? f().hy : f().hx) * 2,
              getRef: () => (axis ? it.hRef : it.wRef),
              setRef: (nm) => { const key = axis ? 'hRef' : 'wRef'; if (nm) it[key] = nm; else delete it[key]; },
              holdFor: (v) => { setSize(axis, v); return {}; },
            })))),
          h('div', { class: 'xyz xy' }, h('span', {}, 'Rotate'), rotIn, h('span', { class: 'sketch-angle' }, it.type === 'poly' ? '' : `${fmt(it.rot || 0)}°`)),
        ];
        if (anyLocked(it)) for (const el of rows.flatMap((r) => [...r.querySelectorAll('input')])) { el.disabled = true; el.title = 'Locked points pin this shape'; }
        side.append(section('Position & size', rows));
        if (it.type === 'poly') {
          const list = h('div', { class: 'sketch-points' },
            h('div', { class: 'xyz xya' }, h('span', {}, ''), h('span', {}, 'X'), h('span', {}, 'Y'), h('span', {}, 'Angle'), h('span', {}, 'Edge'), h('span', {}, ''), h('span', {}, '')));
          const n = it.pts.length;
          it.pts.forEach((p, i) => {
            const locked = isLocked(it, i);
            const next = (i + 1) % n, prev = (i - 1 + n) % n;
            const mover = !isLocked(it, next) ? next : !isLocked(it, prev) ? prev : -1;
            const ang = dimField({
              kind: 'angle', valid: (v) => v > 0 && v < 360,
              get: () => interiorAngles(it.pts)[i],
              getRef: () => it.angleRef && it.angleRef[i],
              setRef: (nm) => refArray(it, 'angleRef', i, nm),
              holdFor: (v) => (setInteriorAngle(it, i, v) === true ? { cons: [{ it, type: 'angle', i, value: v }] } : false),
            });
            if (mover < 0 && !(it.angleRef && it.angleRef[i])) ang.disabled = true;
            const len = dimField({
              kind: 'length', valid: (v) => v > 0,
              get: () => edgeLen(it.pts, i),
              getRef: () => it.lenRef && it.lenRef[i],
              setRef: (nm) => refArray(it, 'lenRef', i, nm),
              holdFor: (v) => (setEdgeLength(it, i, v) === true ? { cons: [{ it, type: 'len', i, value: v }] } : false),
            });
            len.title = `Edge ${i + 1} to ${next + 1}. ${len.title}`;
            const hold = { fixed: new Set([it.id + ':' + i]) };
            const x = numField(() => it.pts[i][0], (v) => { it.pts[i] = [v, it.pts[i][1]]; settle(hold); });
            const y = numField(() => it.pts[i][1], (v) => { it.pts[i] = [it.pts[i][0], v]; settle(hold); });
            if (locked) { x.disabled = true; y.disabled = true; }
            const lockBtn = button({ icon: locked ? 'lock' : 'unlock', title: locked ? `Unlock point ${i + 1}` : `Lock point ${i + 1}`, cls: 'btn-ghost sketch-lock' + (locked ? ' active' : ''), onClick: () => {
              remember();
              const lock = it.lock ? [...it.lock] : new Array(n).fill(false);
              lock[i] = !lock[i];
              if (lock.some(Boolean)) it.lock = lock; else delete it.lock;
              panel(); draw();
            } });
            const delBtn = button({ icon: 'close', title: n <= 3 ? 'A polygon needs at least 3 points' : `Remove point ${i + 1} (or pick it and press Delete)`, cls: 'btn-ghost sketch-lock', onClick: () => removePoints([{ uid: it.uid, kind: 'point', i }]) });
            if (n <= 3) delBtn.disabled = true;
            list.append(h('div', { class: 'xyz xya' }, h('span', {}, String(i + 1)), x, y, ang, len, lockBtn, delBtn));
          });
          side.append(section('Points', [list]));
        }
      }
      const live = constraints.filter((c) => byUid(c.a.uid) && (!c.b || byUid(c.b.uid)));
      if (picks.length || live.length) {
        const edges = picks.filter((q) => q.kind === 'edge'), points = picks.filter((q) => q.kind === 'point');
        const can = {
          horizontal: edges.length === 1 && !points.length,
          vertical: edges.length === 1 && !points.length,
          parallel: edges.length === 2 && !points.length,
          perpendicular: edges.length === 2 && !points.length,
          online: edges.length === 1 && points.length === 1,
        };
        const tips = { horizontal: 'Horizontal (pick 1 edge)', vertical: 'Vertical (pick 1 edge)', parallel: 'Parallel (pick 2 edges)', perpendicular: 'Perpendicular (pick 2 edges)', online: 'Point on line (pick a point and an edge)' };
        const icons = { horizontal: 'horizontal', vertical: 'vertical', parallel: 'parallel', perpendicular: 'perpendicular', online: 'pointline' };
        const btns = Object.keys(can).map((type) => {
          const b = button({ icon: icons[type], title: tips[type], cls: 'btn-outline btn-icon', onClick: () => addConstraint(type) });
          b.disabled = !can[type];
          return b;
        });
        const polyName = (uid) => `P${polys().findIndex((q) => q.uid === uid) + 1}`;
        const part = (ref) => (ref.kind === 'edge'
          ? `${polyName(ref.uid)} edge ${ref.i + 1}–${(ref.i + 1) % byUid(ref.uid).pts.length + 1}`
          : `${polyName(ref.uid)} point ${ref.i + 1}`);
        const what = picks.length ? `${picks.length} picked: ${picks.map(part).join(', ')}` : '';
        const rows = live.map((c) => {
          const n = constraints.indexOf(c) + 1;
          const text = c.type === 'horizontal' ? `H  ${part(c.a)}` : c.type === 'vertical' ? `V  ${part(c.a)}`
            : c.type === 'parallel' ? `∥${n}  ${part(c.a)} and ${part(c.b)}`
              : c.type === 'perpendicular' ? `⊥${n}  ${part(c.a)} and ${part(c.b)}` : `⊙${n}  ${part(c.a)} on ${part(c.b)}`;
          return h('div', { class: 'con-row' }, h('span', {}, text), button({ icon: 'trash', title: 'Remove this constraint', cls: 'btn-ghost sketch-lock', onClick: () => { remember(); constraints = constraints.filter((x) => x !== c); panel(); draw(); } }));
        });
        side.append(section('Constraints', [h('div', { class: 'insp-row-btns con-btns' }, ...btns), ...(what ? [h('div', { class: 'insp-note' }, what)] : []), ...rows]));
      }
      const names = Object.keys(params).sort();
      if (names.length) {
        const rows = names.map((nm) => {
          const pm = params[nm];
          let val;
          try { val = paramValue(nm, params); } catch { val = undefined; }
          const box = h('input', { class: 'input dim' + (pm.expr ? ' linked' : ''), type: 'text', value: pm.expr ?? fmt(pm.value), spellcheck: false, title: 'A value, or a formula using other names' });
          box.addEventListener('focus', () => box.select());
          box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') box.blur(); });
          box.addEventListener('change', () => {
            const t = stripUnit(box.value);
            remember();
            try {
              if (t !== '' && isFinite(Number(t))) { pm.value = Number(t); delete pm.expr; } else { pm.expr = t.replace(/\s+/g, ''); }
              const v = paramValue(nm, params);
              if (pm.kind === 'angle' ? !(v > 0 && v < 360) : !(v > 0)) throw new Error(pm.kind === 'angle' ? 'Angle must be between 0 and 360°' : 'Length must be more than 0');
            } catch (err) { restore(undo.pop()); toast(err.message); panel(); return; }
            prune();
            settle({});
            panel(); draw();
          });
          const del = button({ icon: 'trash', title: `Remove ${nm} (what uses it keeps its current value)`, cls: 'btn-ghost sketch-lock', onClick: () => {
            remember();
            const num = String(Math.round((val ?? 0) * 1e4) / 1e4);
            const swap = (ref) => (ref === nm ? null : ref && namesIn(ref).includes(nm) ? ref.replace(new RegExp(`\\b${nm}\\b`, 'g'), num) : ref);
            for (const it of items) {
              for (const key of ['angleRef', 'lenRef']) if (it[key]) { it[key] = it[key].map(swap); if (!it[key].some(Boolean)) delete it[key]; }
              for (const key of ['wRef', 'hRef']) if (it[key]) { const r = swap(it[key]); if (r) it[key] = r; else delete it[key]; }
            }
            for (const other of Object.values(params)) if (other.expr) other.expr = swap(other.expr) || num;
            delete params[nm];
            prune();
            panel(); draw();
          } });
          const shown = val === undefined ? '?' : pm.expr ? `${fmt(val)}${unitOf(pm.kind) === '°' ? '°' : ''}` : unitOf(pm.kind);
          return h('div', { class: 'xyz dimrow' }, h('span', { class: 'dim-name' }, nm), box, h('span', { title: pm.expr ? `= ${fmt(val)} ${unitOf(pm.kind)}` : '' }, shown), del);
        });
        side.append(section('Dimensions', rows));
      }
      side.append(section('Pull up', [h('div', { class: 'xyz xy' }, h('span', {}, 'Height'), numField(() => depth, (v) => { depth = v; }, { min: 0.2 }), h('span', {}, 'mm'))]));
    }

    // ---- toolbar: icon buttons, like the main view
    const tools = [['select', 'select', 'Select, move and resize (V)'], ['rect', 'lrect', 'Rectangle (R)'], ['circle', 'lellipse', 'Circle (C)'], ['poly', 'lpolygon', 'Polygon (P): click each corner, then the first point again or Enter']];
    const toolBtns = tools.map(([id, ic, title]) => button({ icon: ic, title, cls: 'btn-outline btn-icon' + (id === tool ? ' active' : ''), onClick: () => setTool(id) }));
    function setTool(id) {
      tool = id; draft = null;
      toolBtns.forEach((b, i) => b.classList.toggle('active', tools[i][0] === id));
      canvas.style.cursor = id === 'select' ? 'default' : 'crosshair';
      draw();
    }
    const zoomBtns = [
      button({ icon: 'plus', title: 'Zoom in (wheel, or +)', cls: 'btn-outline btn-icon', onClick: () => zoomAt([W / 2, H / 2], 1.25) }),
      button({ icon: 'minus', title: 'Zoom out (wheel, or -)', cls: 'btn-outline btn-icon', onClick: () => zoomAt([W / 2, H / 2], 0.8) }),
      button({ icon: 'fit', title: 'Fit the drawing (F). Pan with right or middle drag, or Space + drag', cls: 'btn-outline btn-icon', onClick: () => fit() }),
    ];
    const snapSel = h('select', { class: 'input', title: 'Grid snap (hold Alt for free placement)' }, ...[[0, 'Snap off'], [0.5, 'Snap 0.5 mm'], [1, 'Snap 1 mm'], [5, 'Snap 5 mm']].map(([v, l]) => h('option', { value: v }, l)));
    snapSel.value = String(snap);
    snapSel.addEventListener('change', () => { snap = +snapSel.value; });
    // tool shortcuts while the canvas has focus
    canvas.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const map = { v: 'select', r: 'rect', c: 'circle', p: 'poly' };
      const id = map[e.key.toLowerCase()];
      if (id) { e.preventDefault(); e.stopPropagation(); setTool(id); }
    });

    const done = () => {
      if (draft && draft.type === 'poly') finishPoly();
      const polys = sketchPolys(items);
      if (!polys) { toast(items.length ? 'The holes remove everything' : 'Draw something first'); return; }
      const used = usedNames();
      const keep = Object.fromEntries(Object.entries(params).filter(([k]) => used.has(k)));
      result = { polys, depth, sketch: { items: items.map(({ id, ...rest }) => { void id; return rest; }), depth, sheet: Math.round(W / view.k), ...(Object.keys(keep).length ? { params: keep } : {}), ...(constraints.length ? { constraints } : {}) } };
      m.close();
    };

    m.body.append(
      h('div', { class: 'scribble-bar sketch-bar' }, ...toolBtns, h('span', { class: 'sep' }),
        button({ icon: 'duplicate', title: 'Duplicate (Ctrl+D)', cls: 'btn-outline btn-icon', onClick: duplicate }),
        button({ icon: 'trash', title: 'Delete (Del)', cls: 'btn-outline btn-icon', onClick: removeSelected }),
        button({ icon: 'undo', title: 'Undo (Ctrl+Z)', cls: 'btn-outline btn-icon', onClick: undoOnce }),
        h('span', { style: { flex: 1 } }), snapSel, h('span', { class: 'sep' }), ...zoomBtns),
      h('div', { class: 'sketch-main' }, canvas, side),
      h('div', { class: 'modal-actions' },
        button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
        button({ label: 'Make 3D shape', cls: 'btn-primary', onClick: done })));
    if (!items.length) setTool('rect'); else { setTool('select'); fit(); }
    panel(); draw();
    // exposed for automated checks
    m.el.__sketch = { add: (it) => { items.push({ ...it, uid: newUid(), id: nextId++ }); panel(); draw(); }, done, items: () => items, select: (i) => pick(items[i] && items[i].id), toPx, frameOf, handles: () => (sel() ? handles(sel()) : []), angles: () => (sel() && sel().pts ? interiorAngles(sel().pts) : null), lengths: () => (sel() && sel().pts ? sel().pts.map((_, i) => edgeLen(sel().pts, i)) : null), params: () => params, constraints: () => constraints, picks: () => picks, removePoints: (list) => removePoints(list), pickPart: (i, kind, k, add = false) => { const it = items[i]; pickPart({ uid: it.uid, kind, i: k }, add, it); } };
  });
}
