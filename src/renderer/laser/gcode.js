// Job planning (cut order, fills, image rasters) and G-code output for GRBL-style controllers.
import { flatten, layerOf, pointInPoly, boundsOf, mul, isToolLayer } from './model.js';
import { offsetPolys, processImage } from './ops.js';

export const DEFAULT_MACHINE = {
  name: 'GRBL laser', flavor: 'grbl', bedW: 400, bedH: 400, origin: 'bl', sMax: 1000, rapid: 6000,
  speedUnits: 'mm/s', returnTo: 'origin', baud: 115200, framePower: 0, gridSnap: 1, showGrid: true,
};

export const FLAVORS = [
  ['grbl', 'GRBL (M4 dynamic power)'], ['grbl-m3', 'GRBL (M3 constant power)'], ['marlin', 'Marlin (inline power, S 0-255)'], ['smoothie', 'Smoothieware (S 0-1)'],
];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Layers that have shapes, in cut order. */
export function usedLayers(doc) {
  const used = new Set();
  const visit = (list) => { for (const s of list) { if (s.type === 'group') visit(s.children); else used.add(s.layer); } };
  visit(doc.shapes);
  const order = (doc.layerOrder || []).filter((i) => used.has(i));
  for (const i of [...used].sort((a, b) => a - b)) if (!order.includes(i)) order.push(i);
  return order;
}

function pathLength(pts, closed) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += dist(pts[i], pts[i + 1]);
  if (closed && pts.length > 1) len += dist(pts[pts.length - 1], pts[0]);
  return len;
}

/** Cut a closed outline into open pieces, leaving `count` uncut tabs of `size` mm. */
function applyTabs(pts, count, size) {
  const ring = [...pts, pts[0]];
  const total = pathLength(ring, false);
  if (count < 1 || size <= 0 || total <= count * size * 1.5) return [{ pts, closed: true }];
  const gaps = [];
  for (let k = 0; k < count; k++) { const c = ((k + 0.5) / count) * total; gaps.push([c - size / 2, c + size / 2]); }
  const pieces = [];
  let cur = [], d = 0, gi = 0;
  const inGap = (t) => gi < gaps.length && t >= gaps[gi][0] && t < gaps[gi][1];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1], seg = dist(a, b);
    if (seg < 1e-9) continue;
    const cuts = [0];
    for (const g of gaps) for (const t of g) if (t > d && t < d + seg) cuts.push(t - d);
    cuts.push(seg);
    cuts.sort((x, y) => x - y);
    for (let c = 0; c < cuts.length - 1; c++) {
      const t0 = cuts[c], t1 = cuts[c + 1];
      if (t1 - t0 < 1e-9) continue;
      while (gi < gaps.length && d + t0 >= gaps[gi][1] - 1e-9) gi++;
      const p0 = [a[0] + ((b[0] - a[0]) * t0) / seg, a[1] + ((b[1] - a[1]) * t0) / seg];
      const p1 = [a[0] + ((b[0] - a[0]) * t1) / seg, a[1] + ((b[1] - a[1]) * t1) / seg];
      if (inGap(d + (t0 + t1) / 2)) { if (cur.length > 1) pieces.push({ pts: cur, closed: false }); cur = []; }
      else { if (!cur.length) cur.push(p0); cur.push(p1); }
    }
    d += seg;
  }
  if (cur.length > 1) pieces.push({ pts: cur, closed: false });
  return pieces;
}

/** Scan-line fill of closed outlines (even-odd). Returns ordered segments [[p0, p1], ...]. */
export function scanFill(polys, interval, angleDeg, bidirectional) {
  const a = (-angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const rot = polys.map((p) => p.pts.map(([x, y]) => [x * c - y * s, x * s + y * c]));
  let y0 = Infinity, y1 = -Infinity;
  for (const p of rot) for (const q of p) { if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
  const out = [];
  if (y0 === Infinity || interval <= 0) return out;
  let flip = false;
  for (let y = y0 + interval / 2; y < y1; y += interval) {
    const xs = [];
    for (const p of rot) {
      for (let i = 0, n = p.length; i < n; i++) {
        const p0 = p[i], p1 = p[(i + 1) % n];
        if ((p0[1] > y) !== (p1[1] > y)) xs.push(p0[0] + ((y - p0[1]) * (p1[0] - p0[0])) / (p1[1] - p0[1]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((m, n) => m - n);
    const row = [];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) row.push([xs[i], xs[i + 1]]);
    if (!row.length) continue;
    if (flip && bidirectional) { row.reverse(); for (const r of row) r.reverse(); }
    flip = !flip;
    // rotate back
    for (const [xa, xb] of row) out.push([[xa * c + y * s, -xa * s + y * c], [xb * c + y * s, -xb * s + y * c]]);
  }
  return out;
}

function orderPaths(paths, start, opt) {
  // inner shapes first: deeper nesting = earlier (count each enclosing outline once, never the path's own)
  if (opt.innerFirst) {
    for (const p of paths) {
      const rings = new Set();
      for (const q of paths) if (q !== p && q.ring && q.ring !== p.ring && !rings.has(q.ring) && pointInPoly(p.pts[0], q.ring)) rings.add(q.ring);
      p.depth = rings.size;
    }
  }
  const buckets = new Map();
  for (const p of paths) { const d = opt.innerFirst ? p.depth || 0 : 0; (buckets.get(d) || buckets.set(d, []).get(d)).push(p); }
  const out = [];
  let pos = start;
  for (const d of [...buckets.keys()].sort((x, y) => y - x)) {
    const pool = buckets.get(d);
    if (!opt.reduceTravel) { for (const p of pool) { out.push(p); pos = p.closed ? p.pts[0] : p.pts[p.pts.length - 1]; } continue; }
    while (pool.length) {
      let best = 0, bestD = Infinity, bestStart = 0, rev = false;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        if (p.closed) {
          for (let k = 0; k < p.pts.length; k++) { const dd = dist(pos, p.pts[k]); if (dd < bestD) { bestD = dd; best = i; bestStart = k; rev = false; } }
        } else {
          const d0 = dist(pos, p.pts[0]), d1 = dist(pos, p.pts[p.pts.length - 1]);
          if (d0 < bestD) { bestD = d0; best = i; rev = false; }
          if (d1 < bestD) { bestD = d1; best = i; rev = true; }
        }
      }
      const p = pool.splice(best, 1)[0];
      if (p.closed) p.pts = [...p.pts.slice(bestStart), ...p.pts.slice(0, bestStart)];
      else if (rev) p.pts = [...p.pts].reverse();
      out.push(p);
      pos = p.closed ? p.pts[0] : p.pts[p.pts.length - 1];
    }
  }
  return { ordered: out, pos };
}

function rasterImage(entry, layer, getImage, moves, warnings) {
  const s = entry.shape, img = getImage(s);
  if (!img) { warnings.push('An image is still loading and was skipped'); return; }
  let res = 1 / Math.max(0.02, layer.interval);
  const xs = entry.pts.map((p) => p[0]), ys = entry.pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), W = Math.max(...xs) - x0, H = Math.max(...ys) - y0;
  const cap = 6000;
  if (W * res > cap || H * res > cap) { res = cap / Math.max(W, H); warnings.push('A large image was rasterised at reduced resolution'); }
  const pw = Math.max(1, Math.round(W * res)), ph = Math.max(1, Math.round(H * res));
  const cv = document.createElement('canvas');
  cv.width = pw; cv.height = ph;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const m = mul([res, 0, 0, res, -x0 * res, -y0 * res], entry.m);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0, s.w, s.h);
  const burn = processImage(ctx.getImageData(0, 0, pw, ph), layer.image);
  const gray = layer.image.mode === 'grayscale';
  const f = layer.speed * 60, px = 1 / res, over = (layer.speed * layer.overscan) / 100;
  const pMax = (layer.powerMax / 100) * ((s.powerScale ?? 100) / 100), pMin = layer.powerMin / 100;
  let flip = false;
  for (let row = 0; row < ph; row++) {
    const runs = [];
    let x = 0;
    while (x < pw) {
      let v = burn[row * pw + x];
      if (gray) v = Math.round(v / 8) * 8;
      if (!v) { x++; continue; }
      let e = x + 1;
      while (e < pw) { let n = burn[row * pw + e]; if (gray) n = Math.round(n / 8) * 8; if (n !== v) break; e++; }
      runs.push([x, e, gray ? pMin + (pMax - pMin) * (Math.min(255, v) / 255) : pMax]);
      x = e;
    }
    if (!runs.length) continue;
    const y = y0 + (row + 0.5) * px;
    const reverse = flip && layer.bidirectional;
    flip = !flip;
    const first = reverse ? x0 + runs[runs.length - 1][1] * px : x0 + runs[0][0] * px;
    const dir = reverse ? -1 : 1;
    moves.push({ x: first - dir * over, y, rapid: true });
    if (over > 0) moves.push({ x: first, y, s: 0, f });
    const list = reverse ? [...runs].reverse() : runs;
    for (const [a, b, pw2] of list) {
      const xa = x0 + (reverse ? b : a) * px, xb = x0 + (reverse ? a : b) * px;
      const last = moves[moves.length - 1];
      if (Math.abs(last.x - xa) > 1e-9) moves.push({ x: xa, y, s: 0, f });
      moves.push({ x: xb, y, s: pw2, f });
    }
    if (over > 0) moves.push({ x: moves[moves.length - 1].x + dir * over, y, s: 0, f });
  }
}

/**
 * Build the list of machine moves for a document.
 * moves: [{ x, y, rapid } | { x, y, s (0..1), f (mm/min) }] in bed coordinates, plus { air: bool } markers.
 */
export function planJob(doc, machine, getImage, { selectionOnly = null } = {}) {
  const moves = [];
  const warnings = [];
  const opt = doc.optimize || {};
  let pos = [machine.origin.endsWith('r') ? machine.bedW : 0, machine.origin.startsWith('b') ? machine.bedH : 0];
  const shapes = selectionOnly ? doc.shapes.filter((s) => selectionOnly.has(s.id)) : doc.shapes;
  const entries = shapes.flatMap((s) => flatten(s));
  for (const li of usedLayers(doc)) {
    const layer = layerOf(doc, li);
    if (!layer.output || isToolLayer(li)) continue;
    const mine = entries.filter((e) => e.layer === li);
    if (!mine.length) continue;
    const start = moves.length;
    const f = layer.speed * 60;
    const power = (e) => (layer.powerMax / 100) * ((e.shape.powerScale ?? 100) / 100);
    moves.push({ air: !!layer.air, layer: li });
    const images = mine.filter((e) => e.shape.type === 'image');
    const vectors = mine.filter((e) => e.shape.type !== 'image');
    for (let pass = 0; pass < Math.max(1, layer.passes); pass++) {
      for (const e of images) rasterImage(e, layer, getImage, moves, warnings);
      if (!vectors.length) continue;
      if (layer.mode === 'fill') {
        const groups = new Map();
        for (const e of vectors) if (e.closed && e.pts.length > 2) { const k = e.shape.powerScale ?? 100; (groups.get(k) || groups.set(k, []).get(k)).push(e); }
        if (vectors.some((e) => !e.closed)) warnings.push(`Layer ${String(li + 1).padStart(2, '0')}: open shapes cannot be filled and were skipped`);
        const over = (layer.speed * layer.overscan) / 100;
        for (const [scale, list] of groups) {
          const p = (layer.powerMax / 100) * (scale / 100);
          const angles = layer.crosshatch ? [layer.angle, layer.angle + 90] : [layer.angle];
          for (const ang of angles) {
            for (const [a, b] of scanFill(list, layer.interval, ang, layer.bidirectional)) {
              const len = dist(a, b) || 1, ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
              moves.push({ x: a[0] - ux * over, y: a[1] - uy * over, rapid: true });
              if (over > 0) moves.push({ x: a[0], y: a[1], s: 0, f });
              moves.push({ x: b[0], y: b[1], s: p, f });
              if (over > 0) moves.push({ x: b[0] + ux * over, y: b[1] + uy * over, s: 0, f });
            }
          }
        }
      } else {
        let paths = [];
        if (layer.mode === 'offset') {
          const closed = vectors.filter((e) => e.closed && e.pts.length > 2);
          const byScale = new Map();
          for (const e of closed) { const k = e.shape.powerScale ?? 100; (byScale.get(k) || byScale.set(k, []).get(k)).push(e); }
          for (const list of byScale.values()) {
            const p = power(list[0]);
            for (let k = 0; k < 4000; k++) {
              const rings = offsetPolys(list, -(k + 0.5) * layer.interval);
              if (!rings.length) break;
              for (const r of rings) paths.push({ pts: r.pts, closed: true, ring: r.pts, power: p });
            }
          }
        } else {
          let list = vectors.map((e) => ({ pts: e.pts, closed: e.closed, shape: e.shape }));
          if (layer.kerf) {
            const byShape = new Map();
            for (const e of list) (byShape.get(e.shape) || byShape.set(e.shape, []).get(e.shape)).push(e);
            const outlines = list.filter((e) => e.closed && e.pts.length > 2);
            list = [];
            for (const [shape, group] of byShape) {
              const closed = group.filter((e) => e.closed);
              if (closed.length) {
                // a shape nested inside an odd number of other outlines is a hole: offset it inwards
                const depth = outlines.filter((o) => o.shape !== shape && pointInPoly(closed[0].pts[0], o.pts)).length;
                for (const r of offsetPolys(closed, depth % 2 ? -layer.kerf : layer.kerf)) list.push({ pts: r.pts, closed: true, shape });
              }
              for (const e of group) if (!e.closed) list.push(e);
            }
          }
          for (const e of list) {
            if (e.pts.length < 2) continue;
            const p = power(e);
            if (e.closed && layer.tabs > 0) for (const piece of applyTabs(e.pts, layer.tabs, layer.tabSize)) paths.push({ ...piece, ring: e.pts, wasClosed: true, power: p });
            else paths.push({ pts: e.pts, closed: e.closed, ring: e.closed ? e.pts : null, power: p });
          }
        }
        const res = orderPaths(paths, pos, opt);
        for (const p of res.ordered) {
          moves.push({ x: p.pts[0][0], y: p.pts[0][1], rapid: true });
          for (let i = 1; i < p.pts.length; i++) moves.push({ x: p.pts[i][0], y: p.pts[i][1], s: p.power, f });
          if (p.closed) moves.push({ x: p.pts[0][0], y: p.pts[0][1], s: p.power, f });
        }
      }
      const last = [...moves].reverse().find((mv) => mv.x != null);
      if (last) pos = [last.x, last.y];
    }
    for (let i = start; i < moves.length; i++) moves[i].layer = li;
  }
  // statistics
  let cut = 0, rapid = 0, time = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let p = null;
  for (const mv of moves) {
    if (mv.x == null) continue;
    if (p) {
      const d = Math.hypot(mv.x - p.x, mv.y - p.y);
      if (mv.rapid) { rapid += d; time += d / (machine.rapid / 60); } else { cut += d; time += d / (mv.f / 60); }
      if (!mv.rapid && mv.s > 0) for (const q of [p, mv]) { if (q.x < x0) x0 = q.x; if (q.y < y0) y0 = q.y; if (q.x > x1) x1 = q.x; if (q.y > y1) y1 = q.y; }
    }
    p = mv;
  }
  const bounds = x0 === Infinity ? null : { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  if (bounds && (bounds.x0 < -0.01 || bounds.y0 < -0.01 || bounds.x1 > machine.bedW + 0.01 || bounds.y1 > machine.bedH + 0.01)) warnings.push('Part of the job is outside the work area');
  return { moves, warnings, bounds, stats: { cut, rapid, time, count: moves.length } };
}

/** Bed (internal, y-down) -> machine coordinates for the configured origin corner. */
export function toMachine(machine, x, y) {
  const mx = machine.origin.endsWith('r') ? machine.bedW - x : x;
  const my = machine.origin.startsWith('b') ? machine.bedH - y : y;
  return [mx, my];
}

/** The point of the job that maps to the start position for relative start modes (9-dot selector). */
function jobAnchor(doc, plan, machine) {
  const b = plan.bounds;
  if (!b) return [0, 0];
  const i = doc.jobOrigin ?? 6, col = i % 3, row = Math.floor(i / 3);
  return toMachine(machine, b.x0 + (b.w * col) / 2, b.y0 + (b.h * row) / 2);
}

function offsetFor(doc, plan, machine) {
  if (doc.startFrom === 'absolute') return [0, 0];
  const a = jobAnchor(doc, plan, machine);
  if (doc.startFrom === 'user' && doc.userOrigin) return [doc.userOrigin[0] - a[0], doc.userOrigin[1] - a[1]];
  return [-a[0], -a[1]];
}

const n3 = (v) => { const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };

/** Spindle (S) word value for a power fraction 0..1, in the controller's own scale. */
export function sValue(machine, frac) {
  const fl = machine.flavor;
  return fl === 'smoothie' ? n3(frac) : String(Math.round(frac * (fl === 'marlin' ? 255 : machine.sMax)));
}

export function toGcode(plan, doc, machine) {
  const fl = machine.flavor;
  const sVal = (s) => sValue(machine, s);
  // stock Marlin needs the G word on every move (implicit modal motion is an optional build flag)
  const modal = fl !== 'marlin';
  const [ox, oy] = offsetFor(doc, plan, machine);
  const out = [`; DabbleCAD Plus laser job`, `; ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    `; Controller: ${fl}   Bounds: ${plan.bounds ? `${n3(plan.bounds.w)} x ${n3(plan.bounds.h)} mm` : 'empty'}   Est. time: ${formatTime(plan.stats.time)}`,
    'G21', 'G90'];
  if (doc.startFrom === 'current') out.push('G92 X0 Y0 ; job starts at the current position');
  out.push(fl === 'grbl' ? 'M4 S0' : fl === 'grbl-m3' ? 'M3 S0' : fl === 'marlin' ? 'M3 I' : 'M3 S0');
  let lastF = null, lastS = null, air = false, rapidMode = null, layer = null;
  for (const mv of plan.moves) {
    if (mv.x == null) {
      if (mv.air !== air) { out.push(mv.air ? 'M8' : 'M9'); air = mv.air; }
      continue;
    }
    if (mv.layer !== layer) { layer = mv.layer; out.push(`; Layer ${String(layer + 1).padStart(2, '0')}`); }
    const [mx, my] = toMachine(machine, mv.x, mv.y);
    const xy = `X${n3(mx + ox)} Y${n3(my + oy)}`;
    if (mv.rapid) {
      out.push((modal && rapidMode === 'G0' ? '' : 'G0 ') + xy + (fl === 'marlin' ? '' : lastS === '0' ? '' : ' S0'));
      rapidMode = 'G0'; lastS = '0';
    } else {
      const s = sVal(mv.s), f = n3(mv.f);
      out.push((modal && rapidMode === 'G1' ? '' : 'G1 ') + xy + (s !== lastS ? ' S' + s : '') + (f !== lastF ? ' F' + f : ''));
      rapidMode = 'G1'; lastS = s; lastF = f;
    }
  }
  out.push('M5');
  if (air) out.push('M9');
  if (doc.startFrom === 'current') out.push('G0 X0 Y0', 'G92.1');
  else if (machine.returnTo === 'origin' && doc.startFrom === 'absolute') out.push('G0 X0 Y0');
  out.push('M2', '');
  return out.join('\n');
}

function hull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** G-code that traces the job outline with the laser off (or at a low framing power). */
export function frameGcode(plan, doc, machine, rubberBand = false) {
  if (!plan.bounds) return '';
  const b = plan.bounds;
  let ring;
  if (rubberBand) {
    const pts = [];
    let prev = null;
    for (const m of plan.moves) {
      if (m.x == null) continue;
      if (!m.rapid && m.s > 0) { if (prev) pts.push([prev.x, prev.y]); pts.push([m.x, m.y]); }
      prev = m;
    }
    ring = hull(pts);
  } else ring = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
  const [ox, oy] = offsetFor(doc, plan, machine);
  const frac = Math.max(0, Math.min(1, (machine.framePower || 0) / 100));
  const pw = frac > 0 && Number(sValue(machine, frac)) > 0 ? sValue(machine, frac) : null;
  const out = ['G21', 'G90'];
  if (doc.startFrom === 'current') out.push('G92 X0 Y0');
  const pt = (p) => { const [mx, my] = toMachine(machine, p[0], p[1]); return `X${n3(mx + ox)} Y${n3(my + oy)}`; };
  out.push('G0 ' + pt(ring[0]));
  if (pw) out.push('M3 S' + pw);
  for (const p of [...ring.slice(1), ring[0]]) out.push(`G1 ${pt(p)} F${n3(machine.rapid)}` + (pw ? ' S' + pw : ' S0'));
  out.push('M5');
  if (doc.startFrom === 'current') out.push('G0 X0 Y0', 'G92.1');
  return out.join('\n') + '\n';
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec <= 0) return '0:00';
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export { boundsOf };
