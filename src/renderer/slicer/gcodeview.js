// Parses CuraEngine G-code into line segments for the layer preview.
// Handles G0/G1 with absolute or relative extrusion (M82/M83), G90/G91, G92 E, and the
// ;LAYER: / ;TYPE: comments CuraEngine writes. Long files are parsed in slices so the UI stays alive.

export const TYPE_COLORS = {
  'WALL-OUTER': [0.94, 0.27, 0.27],
  'WALL-INNER': [0.30, 0.78, 0.40],
  SKIN: [0.98, 0.84, 0.30],
  FILL: [0.96, 0.58, 0.22],
  SUPPORT: [0.30, 0.78, 0.86],
  'SUPPORT-INTERFACE': [0.35, 0.55, 0.95],
  SKIRT: [0.55, 0.85, 0.75],
  'PRIME-TOWER': [0.75, 0.55, 0.90],
  DEFAULT: [0.7, 0.7, 0.72],
};
export const TYPE_LABELS = {
  'WALL-OUTER': 'Outer wall', 'WALL-INNER': 'Inner wall', SKIN: 'Top / bottom', FILL: 'Infill',
  SUPPORT: 'Support', 'SUPPORT-INTERFACE': 'Support interface', SKIRT: 'Skirt / brim / raft', 'PRIME-TOWER': 'Prime tower',
};

export const typeHex = (t, overrides = {}) => {
  if (overrides[t]) return overrides[t];
  const c = TYPE_COLORS[t] || TYPE_COLORS.DEFAULT;
  return '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
};

class Growable {
  constructor(n) { this.a = new Float32Array(n); this.n = 0; }
  push6(a, b, c, d, e, f) {
    if (this.n + 6 > this.a.length) { const g = new Float32Array(this.a.length * 2); g.set(this.a); this.a = g; }
    const x = this.a, i = this.n;
    x[i] = a; x[i + 1] = b; x[i + 2] = c; x[i + 3] = d; x[i + 4] = e; x[i + 5] = f;
    this.n += 6;
  }
  /** One extruded segment: from, to, line width, layer height, layer number. */
  push9(a, b, c, d, e, f, w, h, l) {
    if (this.n + 9 > this.a.length) { const g = new Float32Array(this.a.length * 2); g.set(this.a); this.a = g; }
    const x = this.a, i = this.n;
    x[i] = a; x[i + 1] = b; x[i + 2] = c; x[i + 3] = d; x[i + 4] = e; x[i + 5] = f; x[i + 6] = w; x[i + 7] = h; x[i + 8] = l;
    this.n += 9;
  }
  done() { return this.a.slice(0, this.n); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @returns {Promise<{layers:number, layerZ:number[], types:Map<string,{pos:Float32Array,off:Uint32Array}>, travel:{pos,off}, bounds}>}
 * Extruded segments are grouped by feature type. In each group `off[i]` is the first segment of
 * layer i and `off[layers]` the total, so the layers a..b are segments off[a] .. off[b + 1].
 */
export async function parseGcode(bytes, { onProgress, signal, filamentDiameter = 1.75 } = {}) {
  const filArea = Math.PI * (filamentDiameter / 2) ** 2;
  const text = new TextDecoder().decode(bytes);
  const buckets = new Map(); // type -> { g: Growable, off: number[] }
  const tr = new Growable(1 << 18), trOff = [], layerZ = [];
  let bucket = null;
  const bucketFor = (t) => {
    let b = buckets.get(t);
    if (!b) { b = { g: new Growable(1 << 16), off: new Array(layerIdx + 1).fill(0) }; buckets.set(t, b); }
    return b;
  };
  let x = 0, y = 0, z = 0, e = 0;
  let absE = true, absPos = true, type = 'DEFAULT'; void type;
  let layerIdx = -1; // index of the current layer in order of appearance (raft layers are numbered below zero)
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];

  let pos = 0, lines = 0;
  const len = text.length;
  while (pos < len) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = len;
    const c0 = text.charCodeAt(pos);
    if (c0 === 59 /* ; */) {
      if (text.startsWith(';LAYER:', pos)) {
        layerIdx++;
        for (const b of buckets.values()) b.off.push(b.g.n / 9);
        trOff.push(tr.n / 6); layerZ.push(z);
      } else if (text.startsWith(';TYPE:', pos)) {
        type = text.slice(pos + 6, end).trim();
        bucket = null;
      }
    } else if (c0 === 71 /* G */ || c0 === 77 /* M */) {
      const line = text.slice(pos, end);
      const code = /^[GM]\d+/.exec(line);
      const c = code ? code[0] : '';
      if (c === 'G0' || c === 'G1') {
        let nx = x, ny = y, nz = z, ne = null;
        const re = /([XYZE])(-?\d*\.?\d+)/g;
        let m;
        while ((m = re.exec(line))) {
          const v = parseFloat(m[2]);
          if (m[1] === 'X') nx = absPos ? v : x + v;
          else if (m[1] === 'Y') ny = absPos ? v : y + v;
          else if (m[1] === 'Z') nz = absPos ? v : z + v;
          else ne = v;
        }
        const moved = nx !== x || ny !== y;
        const extruding = moved && ne !== null && (absE ? ne > e + 1e-6 : ne > 1e-6);
        const de = ne === null ? 0 : absE ? ne - e : ne;
        if (ne !== null) e = absE ? ne : e + ne;
        if (layerIdx >= 0 && moved) {
          if (extruding) {
            if (!bucket) bucket = bucketFor(type in TYPE_COLORS ? type : 'DEFAULT');
            // line size from the layer thickness and the filament that was pushed through
            const length = Math.hypot(nx - x, ny - y), h = Math.max(0.05, Math.min(1.2, nz - (layerIdx > 0 && layerZ[layerIdx - 1] !== undefined ? layerZ[layerIdx - 1] : 0) || 0.2));
            const w = Math.max(0.2, Math.min(2.2, (de * filArea) / (length * h) + (1 - Math.PI / 4) * h));
            bucket.g.push9(x, y, z, nx, ny, nz, w, h, layerIdx);
            if (nx < min[0]) min[0] = nx; if (ny < min[1]) min[1] = ny; if (nz < min[2]) min[2] = nz;
            if (nx > max[0]) max[0] = nx; if (ny > max[1]) max[1] = ny; if (nz > max[2]) max[2] = nz;
            layerZ[layerIdx] = nz;
          } else tr.push6(x, y, z, nx, ny, nz);
        }
        x = nx; y = ny; z = nz;
      } else if (c === 'G90') absPos = true;
      else if (c === 'G91') absPos = false;
      else if (c === 'G92') { const m = /E(-?\d*\.?\d+)/.exec(line); if (m) e = parseFloat(m[1]); }
      else if (c === 'M82') absE = true;
      else if (c === 'M83') absE = false;
    }
    pos = end + 1;
    if (++lines % 60000 === 0) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (onProgress) onProgress(pos / len);
      await tick();
    }
  }
  const layers = layerZ.length;
  const types = new Map();
  for (const [t, b] of buckets) { b.off.push(b.g.n / 9); types.set(t, { pos: b.g.done(), off: Uint32Array.from(b.off) }); }
  trOff.push(tr.n / 6);
  return { layers, layerZ, types, travel: { pos: tr.done(), off: Uint32Array.from(trOff) }, bounds: { min, max } };
}
