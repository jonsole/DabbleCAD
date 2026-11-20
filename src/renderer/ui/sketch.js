// Sketch: draw a precise 2D outline (rectangles, circles / ellipses, polygons) and pull it up
// into a 3D shape. Shapes are edited the way 3D shapes are in the main view: drag to move,
// handles to resize and rotate, dimensions shown on the shape, and an inspector-style panel.
// Items can add material (Solid) or cut it away (Hole).
import { h, modal, button, toast, clear, icon } from './dom.js';
import { regionPolys } from '../core/solid.js';

const W = 760, H = 460;
const SHEETS = [60, 120, 240, 480];
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
/** "12.5" -> { value }, "A" -> { name }, "A=45" -> { name, value }, anything else -> { error } */
function parseDim(text) {
  const t = String(text).trim().replace(/\s*(°|deg|mm)$/i, '');
  if (!t) return { error: true };
  if (isFinite(Number(t))) return { value: Number(t) };
  const m = /^([^=\s]+)\s*(?:=\s*(.+))?$/.exec(t);
  if (!m || !NAME.test(m[1])) return { error: true };
  if (m[2] === undefined) return { name: m[1] };
  const v = Number(String(m[2]).trim().replace(/\s*(°|deg|mm)$/i, ''));
  return isFinite(v) ? { name: m[1], value: v } : { error: true };
}

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
function solveSketch(items, params, hold = {}) {
  for (const it of items) {
    if (it.type !== 'rect' && it.type !== 'circle') continue;
    const w = it.wRef && params[it.wRef], hh = it.hRef && params[it.hRef];
    if (!w && !hh) continue;
    const f0 = frameOf(it);
    const hx = w ? w.value / 2 : f0.hx, hy = hh ? hh.value / 2 : f0.hy;
    setBox(it, clone(it), f0, -hx, hx, -hy, hy);
  }
  const cons = [];
  for (const it of items) {
    if (it.type !== 'poly') continue;
    (it.angleRef || []).forEach((nm, i) => { if (nm && params[nm]) cons.push({ it, type: 'angle', i, value: params[nm].value }); });
    (it.lenRef || []).forEach((nm, i) => { if (nm && params[nm]) cons.push({ it, type: 'len', i, value: params[nm].value }); });
  }
  cons.push(...(hold.cons || []));
  if (!cons.length) return true;
  const polys = [...new Set(cons.map((c) => c.it))];
  const fixed = hold.fixed || new Set();
  const vars = [];
  for (const it of polys) it.pts.forEach((_, i) => { if (!isLocked(it, i) && !fixed.has(it.id + ':' + i)) vars.push({ it, i }); });
  const scale = new Map(polys.map((it) => [it, Math.max(1, it.pts.reduce((t, _, i) => t + edgeLen(it.pts, i), 0) / it.pts.length)]));
  const resid = () => cons.map((c) => (c.type === 'angle'
    ? rad(angleDiff(interiorAngles(c.it.pts)[c.i], c.value)) * scale.get(c.it)
    : edgeLen(c.it.pts, c.i) - c.value));
  const norm = (r) => r.reduce((t, v) => t + v * v, 0);
  let r = resid(), f = norm(r);
  const ok = () => Math.sqrt(f) < 1e-3;
  if (!vars.length || ok()) return ok();
  const n = vars.length * 2;
  let x = vars.flatMap((v) => v.it.pts[v.i]);
  const put = (xs) => vars.forEach((v, k) => { v.it.pts[v.i] = [xs[2 * k], xs[2 * k + 1]]; });
  let mu = 1e-4;
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
  r = resid(); f = norm(r);
  return ok();
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
    const m = modal({ title: 'Sketch', width: W + 380, onClose: () => { window.removeEventListener('keydown', onKey, true); resolve(result); } });
    const canvas = h('canvas', { class: 'sketch-canvas', width: W, height: H, tabindex: 0, 'aria-label': 'Sketch drawing area' });
    const ctx = canvas.getContext('2d');
    let items = existing && existing.items ? existing.items.map((i) => ({ ...clone(i), id: nextId++ })) : [];
    let depth = existing && existing.depth ? existing.depth : 10;
    let sheet = existing && existing.sheet ? existing.sheet : 120;
    let tool = 'select', snap = 1, selected = null, draft = null, drag = null, cursor = null, hover = null;
    let params = existing && existing.params ? JSON.parse(JSON.stringify(existing.params)) : {};
    const undo = [];
    const snapshot = () => JSON.stringify({ items, params });
    const restore = (str) => { const st = JSON.parse(str); items = st.items; params = st.params || {}; };
    const remember = () => { undo.push(snapshot()); if (undo.length > 50) undo.shift(); };
    /** Re-solve after an edit; if the named dimensions can't all be met, put things back. */
    const settle = (hold, { revert = true } = {}) => {
      if (solveSketch(items, params, hold)) return true;
      if (revert && undo.length) { restore(undo.pop()); toast('That can\'t be done while keeping the named dimensions and locked points'); }
      return false;
    };
    const sel = () => items.find((i) => i.id === selected) || null;
    const toastLocked = () => toast('This shape has locked points, so it can\'t be moved, resized or rotated. Unlock them in Points.');

    const scale = () => W / sheet; // px per mm
    const toPx = (p) => [W / 2 + p[0] * scale(), H / 2 - p[1] * scale()];
    const rawMm = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) * (W / r.width) - W / 2) / scale(), -((e.clientY - r.top) * (H / r.height) - H / 2) / scale()];
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
      if (it.type === 'poly') it.pts.forEach((p, i) => out.push({ kind: 'vertex', i, locked: isLocked(it, i), px: toPx(p) }));
      return out;
    }
    const handleAt = (it, px) => {
      const list = handles(it);
      // vertices first (they sit on the outline), then rotate, then size handles
      const order = [...list.filter((x) => x.kind === 'vertex'), ...list.filter((x) => x.kind === 'rotate'), ...list.filter((x) => x.kind === 'size')];
      return order.find((hd) => !hd.locked && Math.hypot(hd.px[0] - px[0], hd.px[1] - px[1]) <= (hd.kind === 'rotate' ? 9 : HANDLE + 3)) || null;
    };
    const cursorFor = (hd, it) => {
      if (!hd) return '';
      if (hd.kind === 'rotate') return 'grab';
      if (hd.kind === 'vertex') return 'crosshair';
      // pick the resize cursor nearest the handle's direction on screen
      const f = frameOf(it);
      const d = rot([hd.sx, hd.sy], f.a);
      const ang = ((Math.atan2(-d[1], d[0]) * 180) / Math.PI + 360) % 180;
      return ang < 22.5 || ang >= 157.5 ? 'ew-resize' : ang < 67.5 ? 'nesw-resize' : ang < 112.5 ? 'ns-resize' : 'nwse-resize';
    };

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
      const step = sheet <= 60 ? 1 : sheet <= 120 ? 5 : 10;
      ctx.lineWidth = 1;
      for (let v = -Math.ceil(sheet / step) * step; v <= sheet; v += step) {
        const major = Math.round(v / step) % 2 === 0;
        ctx.strokeStyle = v === 0 ? 'rgba(120,160,255,0.55)' : major ? 'rgba(128,140,160,0.22)' : 'rgba(128,140,160,0.1)';
        const x = Math.round(W / 2 + v * k) + 0.5, y = Math.round(H / 2 - v * k) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
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
            label(nm ? `${nm} ${fmt(angs[i])}°` : `${fmt(angs[i])}°`, P[0] + bx * 26, P[1] + by * 26, !!nm);
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
            label(nm ? `${nm} ${fmt(edgeLen(it.pts, i))}` : fmt(edgeLen(it.pts, i)), mx + nx * 14, my + ny * 14, !!nm);
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
      ctx.fillStyle = css('--muted', '#9aa3b2'); ctx.font = '12px sans-serif';
      if (cursor) ctx.fillText(`${cursor[0].toFixed(1)}, ${cursor[1].toFixed(1)} mm`, 10, H - 10);
      ctx.fillText(`${sheet} mm wide`, W - 86, H - 10);
    }

    const hit = (pt) => { for (let i = items.length - 1; i >= 0; i--) if (inside(pt, outline(items[i]))) return items[i]; return null; };
    const pick = (id) => { selected = id; panel(); draw(); };
    const finishPoly = () => {
      if (draft && draft.type === 'poly' && draft.pts.length >= 3) { remember(); const it = { ...draft, id: nextId++ }; items.push(it); selected = it.id; setTool('select'); }
      draft = null; panel(); draw();
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.focus();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const p = toMm(e), px = pxOf(e);
      if (tool === 'select') {
        const cur = sel();
        const hd = cur && handleAt(cur, px);
        if (hd) {
          remember();
          drag = { kind: hd.kind, hd, it0: clone(cur), f0: frameOf(cur), start: rawMm(e), deg: 0 };
          if (hd.kind === 'rotate') canvas.style.cursor = 'grabbing';
          draw();
          return;
        }
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
      const p = toMm(e);
      cursor = p;
      const it = sel();
      if (drag && it) {
        if (drag.kind === 'move') { moveItem(it, p[0] - drag.last[0], p[1] - drag.last[1]); drag.last = p; }
        else if (drag.kind === 'vertex') { it.pts[drag.hd.i] = p; solveSketch(items, params, { fixed: new Set([it.id + ':' + drag.hd.i]) }); }
        else if (drag.kind === 'rotate') {
          const c = drag.f0.c, q = rawMm(e);
          let deg = ((Math.atan2(q[1] - c[1], q[0] - c[0]) - Math.atan2(drag.start[1] - c[1], drag.start[0] - c[0])) * 180) / Math.PI;
          deg = ((deg + 540) % 360) - 180;
          if (!e.altKey) deg = Math.round(deg / 15) * 15;
          drag.deg = deg;
          rotateTo(it, drag.it0, deg);
          solveSketch(items, params);
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
          solveSketch(items, params); // named sizes and lengths hold
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
        const over = hd ? null : hit(rawMm(e));
        hover = over ? over.id : null;
        canvas.style.cursor = hd ? cursorFor(hd, it) : over ? (anyLocked(over) ? 'not-allowed' : 'move') : 'default';
      }
      draw();
    });

    canvas.addEventListener('pointerup', () => {
      if (drag) {
        if (drag.kind === 'rotate') canvas.style.cursor = 'grab';
        drag = null; panel(); draw();
        return;
      }
      if (!draft || draft.type === 'poly') return;
      const ok = draft.type === 'rect' ? draft.w > 0.2 && draft.h > 0.2 : draft.r > 0.2;
      if (ok) {
        remember();
        const { anchor, ...it } = draft; void anchor;
        it.id = nextId++;
        items.push(it);
        selected = it.id;
        setTool('select'); // ready to adjust, like a shape dropped in the 3D view
      }
      draft = null; panel(); draw();
    });
    canvas.addEventListener('pointerleave', () => { cursor = null; hover = null; draw(); });
    canvas.addEventListener('dblclick', () => { if (tool === 'poly') finishPoly(); });

    const removeSelected = () => { if (!sel()) return; remember(); items = items.filter((i) => i.id !== selected); selected = null; panel(); draw(); };
    const duplicate = () => {
      const it = sel();
      if (!it) return;
      remember();
      const c = { ...clone(it), id: nextId++ };
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
      if (e.key === 'Enter' && draft && draft.type === 'poly') { stop(); finishPoly(); }
      else if (e.key === 'Escape' && (draft || selected)) { stop(); if (draft) draft = null; else { selected = null; panel(); } draw(); }
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
      for (const it of items) for (const nm of [...(it.angleRef || []), ...(it.lenRef || []), it.wRef, it.hRef]) if (nm) u.add(nm);
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
     * A dimension box: takes a number (a one-off change), a name like A (labels this dimension,
     * or links it to an existing A) or A=45 (sets A and links). Linked boxes show "A = 45".
     * holdFor(v) applies a one-off value and returns what the solver should keep, or false.
     */
    const dimField = ({ kind, get, getRef, setRef, holdFor, valid }) => {
      const show = () => { const nm = getRef(); return nm && params[nm] ? `${nm} = ${fmt(params[nm].value)}` : fmt(get()); };
      const input = h('input', { class: 'input dim', type: 'text', value: show(), spellcheck: false, title: `A number, a name to label it (like ${kind === 'angle' ? 'A' : 'L'}), or name=value` });
      input.classList.toggle('linked', !!(getRef() && params[getRef()]));
      input.addEventListener('focus', () => input.select());
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); else if (e.key === 'Escape') { input.value = show(); input.blur(); } });
      input.addEventListener('change', () => {
        const d = parseDim(input.value);
        const fail = (msg) => { toast(msg); input.value = show(); };
        if (d.error) return fail('Type a number, a name (like A), or name=value');
        if (d.value !== undefined && !valid(d.value)) return fail(kind === 'angle' ? 'Angle must be between 0 and 360°' : 'Length must be more than 0');
        remember();
        if (d.name) {
          const pm = params[d.name];
          if (pm && pm.kind !== kind) { undo.pop(); return fail(`${d.name} is ${pm.kind === 'angle' ? 'an angle' : 'a length'}`); }
          if (!pm) params[d.name] = { kind, value: d.value ?? Math.round(get() * 1000) / 1000 };
          else if (d.value !== undefined) pm.value = d.value;
          setRef(d.name);
          prune();
          settle({});
        } else {
          setRef(undefined);
          prune();
          const hold = holdFor(d.value);
          if (hold === false) { undo.pop(); return fail('Both neighbouring points are locked'); }
          settle(hold);
        }
        panel(); draw();
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
            h('div', { class: 'xyz xya' }, h('span', {}, ''), h('span', {}, 'X'), h('span', {}, 'Y'), h('span', {}, 'Angle'), h('span', {}, 'Edge'), h('span', {}, '')));
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
            list.append(h('div', { class: 'xyz xya' }, h('span', {}, String(i + 1)), x, y, ang, len, lockBtn));
          });
          side.append(section('Points', [list]));
        }
      }
      const names = Object.keys(params).sort();
      if (names.length) {
        const rows = names.map((nm) => {
          const pm = params[nm];
          const v = numField(() => pm.value, (val) => {
            if (pm.kind === 'angle' ? !(val > 0 && val < 360) : !(val > 0)) { undo.pop(); toast(pm.kind === 'angle' ? 'Angle must be between 0 and 360°' : 'Length must be more than 0'); return; }
            pm.value = val;
            settle({});
            panel();
          }, { min: 0.001 });
          const del = button({ icon: 'trash', title: `Remove ${nm} (the dimensions keep their current values)`, cls: 'btn-ghost sketch-lock', onClick: () => {
            remember();
            for (const it of items) {
              for (const key of ['angleRef', 'lenRef']) if (it[key]) { it[key] = it[key].map((x) => (x === nm ? null : x)); if (!it[key].some(Boolean)) delete it[key]; }
              if (it.wRef === nm) delete it.wRef;
              if (it.hRef === nm) delete it.hRef;
            }
            delete params[nm];
            panel(); draw();
          } });
          return h('div', { class: 'xyz dimrow' }, h('span', { class: 'dim-name' }, nm), v, h('span', {}, unitOf(pm.kind)), del);
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
    const sheetSel = h('select', { class: 'input', title: 'How much area the drawing sheet shows' }, ...SHEETS.map((s) => h('option', { value: s }, `${s} mm sheet`)));
    sheetSel.value = String(sheet);
    sheetSel.addEventListener('change', () => { sheet = +sheetSel.value; draw(); });
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
      result = { polys, depth, sketch: { items: items.map(({ id, ...rest }) => { void id; return rest; }), depth, sheet, ...(Object.keys(keep).length ? { params: keep } : {}) } };
      m.close();
    };

    m.body.append(
      h('div', { class: 'scribble-bar sketch-bar' }, ...toolBtns, h('span', { class: 'sep' }),
        button({ icon: 'duplicate', title: 'Duplicate (Ctrl+D)', cls: 'btn-outline btn-icon', onClick: duplicate }),
        button({ icon: 'trash', title: 'Delete (Del)', cls: 'btn-outline btn-icon', onClick: removeSelected }),
        button({ icon: 'undo', title: 'Undo (Ctrl+Z)', cls: 'btn-outline btn-icon', onClick: undoOnce }),
        h('span', { style: { flex: 1 } }), snapSel, sheetSel),
      h('div', { class: 'sketch-main' }, canvas, side),
      h('div', { class: 'modal-actions' },
        button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
        button({ label: 'Make 3D shape', cls: 'btn-primary', onClick: done })));
    if (!items.length) setTool('rect'); else setTool('select');
    panel(); draw();
    // exposed for automated checks
    m.el.__sketch = { add: (it) => { items.push({ ...it, id: nextId++ }); panel(); draw(); }, done, items: () => items, select: (i) => pick(items[i] && items[i].id), toPx, frameOf, handles: () => (sel() ? handles(sel()) : []), angles: () => (sel() && sel().pts ? interiorAngles(sel().pts) : null), lengths: () => (sel() && sel().pts ? sel().pts.map((_, i) => edgeLen(sel().pts, i)) : null), params: () => params };
  });
}
