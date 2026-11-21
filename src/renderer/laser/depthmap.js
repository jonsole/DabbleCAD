// Depth Map Studio: turn an STL model, an image or the current 3D design into a height map
// (grayscale relief) with adjustable levels, then engrave it or export it.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { zipSync, zlibSync } from 'three/examples/jsm/libs/fflate.module.js';
import { h, modal, button, toast, clear } from '../ui/dom.js';
import { platform } from '../platform.js';
import { bakedWorldGeometry, getGeometry } from '../core/geometry.js';
import { makeImage, makeGroup, layerOf } from './model.js';

const VIEWS = {
  top: { u: [1, 0, 0], v: [0, 1, 0], d: [0, 0, 1], label: 'Top' },
  bottom: { u: [-1, 0, 0], v: [0, 1, 0], d: [0, 0, -1], label: 'Bottom' },
  front: { u: [1, 0, 0], v: [0, 0, 1], d: [0, -1, 0], label: 'Front' },
  back: { u: [-1, 0, 0], v: [0, 0, 1], d: [0, 1, 0], label: 'Back' },
  right: { u: [0, 1, 0], v: [0, 0, 1], d: [1, 0, 0], label: 'Right' },
  left: { u: [0, -1, 0], v: [0, 0, 1], d: [-1, 0, 0], label: 'Left' },
};

/**
 * Rasterise triangles (flat xyz array) into a height field seen from `view`.
 * Returns { w, h, data (0..1, 1 = nearest the viewer), mask, widthMM, heightMM, depthMM }.
 */
export function heightFromTriangles(pos, viewName = 'top', res = 800) {
  const V = VIEWS[viewName] || VIEWS.top;
  const n = pos.length / 3;
  const U = new Float32Array(n), W = new Float32Array(n), D = new Float32Array(n);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, d0 = Infinity, d1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const u = x * V.u[0] + y * V.u[1] + z * V.u[2], v = x * V.v[0] + y * V.v[1] + z * V.v[2], d = x * V.d[0] + y * V.d[1] + z * V.d[2];
    U[i] = u; W[i] = v; D[i] = d;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; if (d < d0) d0 = d; if (d > d1) d1 = d;
  }
  if (!isFinite(u0)) throw new Error('The model has no triangles');
  const du = Math.max(1e-6, u1 - u0), dv = Math.max(1e-6, v1 - v0), dd = Math.max(1e-6, d1 - d0);
  const s = (res - 1) / Math.max(du, dv);
  const w = Math.max(2, Math.round(du * s) + 1), hgt = Math.max(2, Math.round(dv * s) + 1);
  const data = new Float32Array(w * hgt), mask = new Uint8Array(w * hgt);
  for (let t = 0; t < n; t += 3) {
    const ax = (U[t] - u0) * s, ay = (v1 - W[t]) * s, bx = (U[t + 1] - u0) * s, by = (v1 - W[t + 1]) * s, cx = (U[t + 2] - u0) * s, cy = (v1 - W[t + 2]) * s;
    const az = (D[t] - d0) / dd, bz = (D[t + 1] - d0) / dd, cz = (D[t + 2] - d0) / dd;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(hgt - 1, Math.ceil(Math.max(ay, by, cy)));
    const eps = -1e-4;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
        const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < eps || w1 < eps || w2 < eps) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const i = y * w + x;
        if (!mask[i] || z > data[i]) { data[i] = z; mask[i] = 1; }
      }
    }
  }
  return { w, h: hgt, data, mask, widthMM: du, heightMM: dv, depthMM: dd };
}

/** Image -> height field (bright = high). Transparent pixels are background. */
export function heightFromImage(img, res = 800) {
  const k = Math.min(1, res / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(2, Math.round((img.naturalWidth || img.width) * k)), hgt = Math.max(2, Math.round((img.naturalHeight || img.height) * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = hgt;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, hgt);
  const px = ctx.getImageData(0, 0, w, hgt).data;
  const data = new Float32Array(w * hgt), mask = new Uint8Array(w * hgt);
  for (let i = 0; i < w * hgt; i++) {
    data[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    mask[i] = px[i * 4 + 3] > 8 ? 1 : 0;
  }
  return { w, h: hgt, data, mask, widthMM: (w / hgt) >= 1 ? 50 : 50 * (w / hgt), heightMM: (w / hgt) >= 1 ? 50 / (w / hgt) : 50, depthMM: 1 };
}

function blur(src, w, hgt, radius) {
  if (radius < 1) return src;
  let a = src, b = new Float32Array(src.length);
  const r = Math.round(radius);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < hgt; y++) { // horizontal
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += a[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { b[y * w + x] = sum / (2 * r + 1); sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) { // vertical
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += b[Math.min(hgt - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < hgt; y++) { a[y * w + x] = sum / (2 * r + 1); sum += b[Math.min(hgt - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]; }
    }
  }
  return a;
}

/** Apply levels and friends. Returns Float32Array 0..1 (background pixels get opts.background). */
export function processHeight(src, o) {
  const { w, h: hgt, data, mask } = src;
  let out = new Float32Array(data);
  if (o.smooth > 0) out = blur(out, w, hgt, o.smooth);
  const black = o.black / 100, white = Math.max(black + 0.001, o.white / 100), g = 1 / Math.max(0.05, o.gamma);
  const lo = o.outMin / 100, hi = o.outMax / 100;
  const bg = o.background === 'high' ? 1 : 0;
  const steps = o.posterize ? Math.max(2, o.slices) : 0;
  for (let i = 0; i < out.length; i++) {
    if (!mask[i]) { out[i] = bg; continue; }
    let v = (out[i] - black) / (white - black);
    v = v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, g);
    if (o.invert) v = 1 - v;
    if (steps) v = Math.min(steps - 1, Math.floor(v * steps)) / (steps - 1);
    out[i] = lo + (hi - lo) * v;
  }
  return out;
}

// ---------------------------------------------------------------- PNG output
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Grayscale PNG, 8 or 16 bits per pixel, from 0..1 floats. */
export function encodeGrayPNG(values, w, hgt, bits = 16, dither = false) {
  const bpp = bits === 16 ? 2 : 1, max = bits === 16 ? 65535 : 255;
  const raw = new Uint8Array((w * bpp + 1) * hgt);
  let o = 0;
  for (let y = 0; y < hgt; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      let v = values[y * w + x] * max;
      if (dither) { const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; v += n - Math.floor(n) - 0.5; } // sub-step noise hides banding
      v = Math.max(0, Math.min(max, Math.round(v)));
      if (bpp === 2) { raw[o++] = v >> 8; raw[o++] = v & 255; } else raw[o++] = v;
    }
  }
  const chunk = (type, body) => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, hgt); ihdr[8] = bits; ihdr[9] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0), png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}

function bytesToDataUrl(bytes, mime) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

const METALS = { Brass: 0xd9b45a, Copper: 0xc97b4a, Steel: 0xb9bec6, Aluminium: 0xd5d9de, Titanium: 0x8e8f96, Wood: 0xb98a5a, Slate: 0x4b5058 };

// ---------------------------------------------------------------- studio dialog
export function depthMapStudio(ws) {
  const m = modal({ title: 'Depth Map Studio', width: 1080, onClose: () => { alive = false; if (renderer) { renderer.dispose(); renderer = null; } } });
  m.body.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  let alive = true, source = null, processed = null, raw = null, sourceImage = null, renderer = null, tab = 'map';
  const o = { view: 'top', res: 800, black: 0, white: 100, gamma: 1, outMin: 0, outMax: 100, invert: false, smooth: 0, background: 'low', slices: 24, posterize: false, dither: true, widthMM: 50, depthMM: 1, perPass: 0.05, spot: 0.05, metal: 'Brass', relief: 12 };

  const view2d = h('canvas', { class: 'dm-canvas' });
  const view3d = h('div', { class: 'dm-3d' });
  const hist = h('canvas', { class: 'dm-hist', width: 512, height: 70 });
  const info = h('div', { class: 'insp-note' }, 'Load an STL model or an image, or use the current 3D design.');
  const advice = h('div', { class: 'dm-advice' });
  const tabs = h('div', { class: 'segmented' });
  const tabBtn = (id, label) => { const b = button({ label, cls: id === tab ? 'active' : '', onClick: () => { tab = id; [...tabs.children].forEach((c) => c.classList.toggle('active', c === b)); o.posterize = id === 'slices'; update(); } }); return b; };
  tabs.append(tabBtn('map', 'Depth map'), tabBtn('slices', 'Slices'), tabBtn('3d', '3D preview'));

  const controls = h('div', { class: 'dm-controls' });
  const slider = (label, key, min, max, step, fmt = (v) => v) => {
    const input = h('input', { type: 'range', min, max, step, value: o[key] });
    const num = h('span', { class: 'dm-val' }, fmt(o[key]));
    input.addEventListener('input', () => { o[key] = parseFloat(input.value); num.textContent = fmt(o[key]); schedule(); });
    return h('label', { class: 'dm-row' }, h('span', {}, label), input, num);
  };
  const number = (label, key, step, min, suffix) => {
    const input = h('input', { class: 'input', type: 'number', step, min, value: o[key] });
    input.addEventListener('change', () => { const v = parseFloat(input.value); if (isFinite(v)) { o[key] = Math.max(min, v); schedule(); } });
    return h('label', { class: 'dm-row' }, h('span', {}, label), input, h('span', { class: 'dm-val' }, suffix));
  };
  const check = (label, key, rebuild) => { const cb = h('input', { type: 'checkbox', checked: o[key] }); cb.addEventListener('change', () => { o[key] = cb.checked; if (rebuild) rebuildSource(); else schedule(); }); return h('label', { class: 'check' }, cb, label); };
  const select = (label, key, options, rebuild) => {
    const sel = h('select', { class: 'select' }, options.map(([v, n]) => h('option', { value: v }, n)));
    sel.value = o[key];
    sel.addEventListener('change', () => { o[key] = sel.value; if (rebuild) rebuildSource(); else schedule(); });
    return h('label', { class: 'dm-row' }, h('span', {}, label), sel, h('span'));
  };
  const widthField = number('Width', 'widthMM', 1, 1, 'mm');
  const viewRow = select('View from', 'view', Object.entries(VIEWS).map(([k, v]) => [k, v.label]), true);
  const resRow = select('Resolution', 'res', [[400, '400 px'], [800, '800 px'], [1200, '1200 px'], [1600, '1600 px'], [2400, '2400 px']], true);
  controls.append(
    h('div', { class: 'dm-group' }, h('h4', {}, 'Source'),
      h('div', { class: 'lz-row' },
        button({ label: 'Open STL or image', icon: 'import', cls: 'btn-outline', onClick: () => openFile() }),
        button({ label: 'Use 3D design', icon: 'cube', cls: 'btn-outline', title: 'Build the depth map from the shapes in the 3D workspace', onClick: () => useDesign() })),
      viewRow, resRow),
    h('div', { class: 'dm-group' }, h('h4', {}, 'Levels'),
      slider('Black point', 'black', 0, 99, 0.1, (v) => v + '%'), slider('White point', 'white', 1, 100, 0.1, (v) => v + '%'),
      slider('Midtones (gamma)', 'gamma', 0.2, 4, 0.02, (v) => v.toFixed(2)),
      slider('Output low', 'outMin', 0, 100, 1, (v) => v + '%'), slider('Output high', 'outMax', 0, 100, 1, (v) => v + '%'),
      slider('Smoothing', 'smooth', 0, 12, 1, (v) => (v ? v + ' px' : 'off')),
      check('Invert (swap high and low)', 'invert'),
      select('Background', 'background', [['low', 'Lowest (black)'], ['high', 'Highest (white)']]),
      button({ label: 'Auto levels', cls: 'btn-outline', title: 'Stretch the used range to full black and white', onClick: () => autoLevels() })),
    h('div', { class: 'dm-group' }, h('h4', {}, 'Engraving'),
      widthField, number('Total depth', 'depthMM', 0.05, 0.01, 'mm'), number('Depth per pass', 'perPass', 0.005, 0.001, 'mm'), number('Laser spot size', 'spot', 0.005, 0.005, 'mm'),
      slider('Slices', 'slices', 2, 256, 1, (v) => v), check('Anti-band dithering on 8-bit output', 'dither'), advice),
    h('div', { class: 'dm-group' }, h('h4', {}, '3D preview'),
      select('Material', 'metal', Object.keys(METALS).map((k) => [k, k])), slider('Relief height', 'relief', 1, 40, 1, (v) => v + '%')));

  m.body.append(h('div', { class: 'dm-layout' },
    h('div', { class: 'dm-left' }, h('div', { class: 'row' }, tabs, h('span', { style: { flex: 1 } }), info), h('div', { class: 'dm-stage' }, view2d, view3d), hist),
    controls),
  h('div', { class: 'modal-actions' },
    button({ label: 'Export 16-bit PNG', cls: 'btn-outline', onClick: () => exportPng(16) }),
    button({ label: 'Export 8-bit PNG', cls: 'btn-outline', onClick: () => exportPng(8) }),
    button({ label: 'Export slice masks (.zip)', cls: 'btn-outline', onClick: () => exportSlices() }),
    h('span', { style: { flex: 1 } }),
    button({ label: 'Close', cls: 'btn-outline', onClick: () => m.close() }),
    button({ label: 'Add as slice passes', cls: 'btn-outline', title: 'Place one mask per slice on its own layer, so the laser cuts the relief pass by pass', onClick: () => addSlicesToLaser() }),
    button({ label: 'Add to laser workspace', cls: 'btn-primary', title: 'Place the depth map on the bed as a grayscale engraving', onClick: () => addToLaser() })));

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 40); };

  function setSource(src, label) {
    source = src;
    if (src.widthMM) { o.widthMM = +src.widthMM.toFixed(2); widthField.querySelector('input').value = o.widthMM; }
    info.textContent = `${label} · ${src.w} × ${src.h} px`;
    update();
  }

  function rebuildSource() {
    try {
      if (raw) { const s = heightFromTriangles(raw.positions, o.view, +o.res); setSource(s, raw.label); }
      else if (sourceImage) setSource(heightFromImage(sourceImage.img, +o.res), sourceImage.label);
    } catch (err) { toast(err.message || String(err), 'warn'); }
  }

  async function openFile() {
    const files = await platform.openDialog({ title: 'Open STL or image', filters: [{ name: 'STL models and images', extensions: ['stl', 'png', 'jpg', 'jpeg', 'bmp', 'webp'] }] });
    if (files.length) loadFile(files[0]);
  }

  async function loadFile(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    try {
      if (ext === 'stl') {
        const geo = new STLLoader().parse(f.data);
        const g = geo.index ? geo.toNonIndexed() : geo;
        raw = { positions: g.attributes.position.array, label: f.name };
        sourceImage = null;
        viewRow.style.display = '';
      } else {
        const blobUrl = URL.createObjectURL(new Blob([f.data]));
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('That image could not be read')); img.src = blobUrl; });
        URL.revokeObjectURL(blobUrl);
        sourceImage = { img, label: f.name };
        raw = null;
        viewRow.style.display = 'none';
      }
      rebuildSource();
    } catch (err) { toast(`Could not open ${f.name}: ${err.message || err}`, 'warn', 5000); }
  }

  function useDesign() {
    const ed = ws.app.editor;
    const nodes = ed.doc.nodes.filter((nd) => !nd.hidden && !nd.hole && getGeometry(nd).attributes.position.count > 0);
    if (!nodes.length) return toast('The 3D design is empty. Add some shapes in the 3D workspace first.', 'warn');
    let total = 0;
    const parts = nodes.map((nd) => { const g = bakedWorldGeometry(nd, false); total += g.attributes.position.count * 3; return g.attributes.position.array; });
    const positions = new Float32Array(total);
    let at = 0;
    for (const p of parts) { positions.set(p.subarray(0, p.length), at); at += p.length; }
    raw = { positions, label: '3D design' };
    sourceImage = null;
    viewRow.style.display = '';
    rebuildSource();
  }

  function autoLevels() {
    if (!source) return;
    let lo = 1, hi = 0;
    for (let i = 0; i < source.data.length; i++) if (source.mask[i]) { const v = source.data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi <= lo) return;
    o.black = Math.floor(lo * 1000) / 10; o.white = Math.ceil(hi * 1000) / 10; o.gamma = 1;
    const ranges = controls.querySelectorAll('input[type=range]');
    ranges[0].value = o.black; ranges[1].value = o.white; ranges[2].value = 1;
    for (const r of [ranges[0], ranges[1], ranges[2]]) r.dispatchEvent(new Event('input'));
  }

  function update() {
    if (!alive) return;
    view2d.style.display = tab === '3d' ? 'none' : '';
    view3d.style.display = tab === '3d' ? '' : 'none';
    if (!source) { advice.textContent = ''; return; }
    processed = processHeight(source, o);
    const { w, h: hgt } = source;
    if (tab !== '3d') {
      view2d.width = w; view2d.height = hgt;
      const ctx = view2d.getContext('2d'), im = ctx.createImageData(w, hgt);
      for (let i = 0; i < w * hgt; i++) { const v = Math.round(processed[i] * 255); im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
      ctx.putImageData(im, 0, 0);
    } else draw3d();
    // histogram of the processed relief
    const bins = new Uint32Array(256);
    let peak = 1;
    for (let i = 0; i < processed.length; i++) if (source.mask[i]) { const b = Math.min(255, Math.round(processed[i] * 255)); bins[b] += 1; }
    for (let i = 1; i < 255; i++) if (bins[i] > peak) peak = bins[i];
    const hc = hist.getContext('2d');
    hc.clearRect(0, 0, 512, 70);
    hc.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#4f8cff';
    for (let i = 0; i < 256; i++) { const bh = Math.min(68, Math.sqrt(bins[i] / peak) * 68); hc.fillRect(i * 2, 70 - bh, 2, bh); }
    // advice: slice count from depth, and beam-spot check
    const suggested = Math.max(2, Math.min(256, Math.round(o.depthMM / o.perPass)));
    const pxMM = o.widthMM / w;
    const notes = [`Suggested slices: ${suggested} (${o.depthMM} mm deep at ${o.perPass} mm per pass).`];
    if (pxMM < o.spot * 0.5) notes.push(`Pixels are ${pxMM.toFixed(3)} mm, much finer than the ${o.spot} mm spot: detail below the spot size will not engrave. About ${Math.round(o.widthMM / o.spot)} px across is enough.`);
    else if (pxMM > o.spot * 2) notes.push(`Pixels are ${pxMM.toFixed(3)} mm, coarser than the ${o.spot} mm spot: raise the resolution for a smoother relief.`);
    else notes.push(`Pixel size ${pxMM.toFixed(3)} mm suits a ${o.spot} mm spot.`);
    clear(advice).append(...notes.map((t) => h('div', {}, t)),
      button({ label: `Use ${suggested} slices`, cls: 'btn-outline', onClick: () => { o.slices = suggested; const r = [...controls.querySelectorAll('input[type=range]')].find((x) => +x.max === 256); r.value = suggested; r.dispatchEvent(new Event('input')); } }));
  }

  // ---- 3D relief preview
  let scene, camera, mesh, rot = { a: -0.5, b: 0.95 };
  function draw3d() {
    const W = view3d.clientWidth || 640, H = view3d.clientHeight || 460;
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      view3d.append(renderer.domElement);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
      camera.up.set(0, 0, 1);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.1));
      const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(-2, -3, 4); scene.add(key);
      const rim = new THREE.DirectionalLight(0xffffff, 1.1); rim.position.set(3, 2, 1.5); scene.add(rim);
      mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ metalness: 0.55, roughness: 0.38 }));
      scene.add(mesh);
      let drag = null;
      renderer.domElement.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; });
      window.addEventListener('pointermove', (e) => { if (!drag || !alive) return; rot.a -= (e.clientX - drag[0]) * 0.008; rot.b = Math.max(0.1, Math.min(1.55, rot.b - (e.clientY - drag[1]) * 0.008)); drag = [e.clientX, e.clientY]; render3d(); });
      window.addEventListener('pointerup', () => { drag = null; });
    }
    renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const { w, h: hgt } = source;
    const k = Math.max(1, Math.ceil(Math.max(w, hgt) / 320)), gw = Math.floor((w - 1) / k) + 1, gh = Math.floor((hgt - 1) / k) + 1;
    const aspect = hgt / w, sx = 2, sy = 2 * aspect, relief = (o.relief / 100) * 2;
    const posArr = new Float32Array(gw * gh * 3);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const v = processed[Math.min(hgt - 1, y * k) * w + Math.min(w - 1, x * k)], i = (y * gw + x) * 3;
      posArr[i] = (x / (gw - 1) - 0.5) * sx; posArr[i + 1] = (0.5 - y / (gh - 1)) * sy; posArr[i + 2] = v * relief;
    }
    const idx = new Uint32Array((gw - 1) * (gh - 1) * 6);
    let q = 0;
    for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) { const a = y * gw + x, b = a + 1, c = a + gw, d = c + 1; idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }
    mesh.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    mesh.geometry = g;
    mesh.material.color.setHex(METALS[o.metal] || METALS.Brass);
    mesh.material.metalness = o.metal === 'Wood' || o.metal === 'Slate' ? 0.05 : 0.55;
    mesh.material.roughness = o.metal === 'Wood' ? 0.8 : 0.38;
    render3d();
  }
  function render3d() {
    if (!renderer || !alive) return;
    const r = 4.4;
    camera.position.set(r * Math.sin(rot.b) * Math.sin(rot.a), -r * Math.sin(rot.b) * Math.cos(rot.a), r * Math.cos(rot.b));
    camera.lookAt(0, 0, 0.1);
    renderer.render(scene, camera);
  }

  // ---- outputs
  const need = () => { if (processed) return true; toast('Load an STL or an image first'); return false; };
  async function exportPng(bits) {
    if (!need()) return;
    const png = encodeGrayPNG(processed, source.w, source.h, bits, bits === 8 && o.dither);
    const path = await platform.saveDialog({ title: `Export ${bits}-bit depth map`, defaultName: `depth-map-${bits}bit.png`, filters: [{ name: 'PNG image', extensions: ['png'] }], data: png });
    if (path) toast('Saved ' + path);
  }
  async function exportSlices() {
    if (!need()) return;
    const N = Math.max(2, Math.round(o.slices)), { w, h: hgt } = source, files = {};
    const plain = processHeight(source, { ...o, posterize: false });
    for (let s = 1; s < N; s++) {
      // pass s engraves everything that must end up deeper than level s (dark = deep)
      const cut = new Float32Array(w * hgt), level = 1 - s / N;
      for (let i = 0; i < cut.length; i++) cut[i] = plain[i] < level ? 0 : 1;
      files[`slice-${String(s).padStart(3, '0')}.png`] = encodeGrayPNG(cut, w, hgt, 8, false);
    }
    files['readme.txt'] = new TextEncoder().encode(`DabbleCAD Plus depth map slices\r\n${N - 1} masks, black = engrave on that pass.\r\nRun slice-001 first. Each pass removes about ${(o.depthMM / (N - 1)).toFixed(4)} mm.\r\nWidth ${o.widthMM} mm, ${w} x ${hgt} px.\r\n`);
    const path = await platform.saveDialog({ title: 'Export slice masks', defaultName: 'depth-map-slices.zip', filters: [{ name: 'Zip archive', extensions: ['zip'] }], data: zipSync(files) });
    if (path) toast('Saved ' + path);
  }
  async function addToLaser() {
    if (!need()) return;
    const { w, h: hgt } = source;
    const src = bytesToDataUrl(encodeGrayPNG(processed, w, hgt, 8, o.dither), 'image/png');
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.src = src; });
    const widthMM = Math.max(1, o.widthMM), heightMM = (widthMM * hgt) / w;
    const L = ws.doc.currentLayer, layer = layerOf(ws.doc, L);
    const shape = makeImage(L, ws.machine.bedW / 2 - widthMM / 2, ws.machine.bedH / 2 - heightMM / 2, widthMM, heightMM, src, w, hgt);
    ws.images.set(shape.id, img);
    layer.image.mode = 'grayscale';
    layer.interval = Math.max(0.02, +Math.max(o.spot, widthMM / w).toFixed(3));
    m.close();
    ws.add([shape]);
    ws.setTool('select');
    toast(`Added as a grayscale engraving on layer ${String(L + 1).padStart(2, '0')}. Darker areas engrave deeper; set passes and power on that layer.`, 'info', 7000);
  }

  // One black-and-white mask per slice, each on its own layer, engraved in order: every
  // pass removes one step of depth wherever the relief has to end up deeper than that step.
  async function addSlicesToLaser() {
    if (!need()) return;
    const N = Math.max(2, Math.round(o.slices)), passes = N - 1, { w, h: hgt } = source;
    const used = new Set();
    const visit = (list) => { for (const s of list) { if (s.children) visit(s.children); else used.add(s.layer); } };
    visit(ws.doc.shapes);
    const free = [];
    for (let i = 0; i < 30 && free.length < passes; i++) if (!used.has(i)) free.push(i);
    if (free.length < passes) { toast(`${passes} passes need ${passes} unused layers, but only ${free.length} are free. Lower the slice count to ${free.length + 1} or fewer.`, 'warn', 7000); return; }
    const plain = processHeight(source, { ...o, posterize: false });
    const widthMM = Math.max(1, o.widthMM), heightMM = (widthMM * hgt) / w;
    const x = ws.machine.bedW / 2 - widthMM / 2, y = ws.machine.bedH / 2 - heightMM / 2;
    const template = { ...layerOf(ws.doc, ws.doc.currentLayer) };
    const shapes = [];
    for (let s = 1; s <= passes; s++) {
      const cut = new Float32Array(w * hgt), level = 1 - s / N;
      for (let i = 0; i < cut.length; i++) cut[i] = plain[i] < level ? 0 : 1;
      const src = bytesToDataUrl(encodeGrayPNG(cut, w, hgt, 8, false), 'image/png');
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.src = src; });
      const li = free[s - 1], layer = layerOf(ws.doc, li);
      Object.assign(layer, { mode: 'fill', speed: template.speed, powerMax: template.powerMax, powerMin: template.powerMin, passes: 1, bidirectional: true, overscan: template.overscan, air: template.air, output: true, show: true,
        interval: Math.max(0.02, +Math.max(o.spot, widthMM / w).toFixed(3)) });
      layer.image = { ...layer.image, mode: 'threshold', negative: false, brightness: 0, contrast: 0, gamma: 1 };
      const shape = makeImage(li, x, y, widthMM, heightMM, src, w, hgt);
      shape.name = `Slice ${s} of ${passes}`;
      ws.images.set(shape.id, img);
      shapes.push(shape);
    }
    const group = makeGroup(shapes);
    group.name = 'Depth map slices';
    m.close();
    ws.add([group]);
    ws.setTool('select');
    toast(`Added ${passes} slice passes on layers ${String(free[0] + 1).padStart(2, '0')}–${String(free[passes - 1] + 1).padStart(2, '0')}. They run in layer order; each removes about ${(o.depthMM / passes).toFixed(3)} mm. Set speed and power on those layers from a test piece.`, 'info', 9000);
  }

  // drag and drop a file onto the studio
  m.el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  m.el.addEventListener('drop', async (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f) loadFile({ name: f.name, data: await f.arrayBuffer() }); });
  update();
  return { loadFile, useDesign, options: o, getProcessed: () => processed, getSource: () => source, addSlices: addSlicesToLaser, setTab: (t) => { tab = t; o.posterize = t === 'slices'; update(); }, close: () => m.close() };
}
