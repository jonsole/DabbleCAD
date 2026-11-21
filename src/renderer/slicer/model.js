// Models on the build plate. Coordinates are millimetres, Z up, origin at the bed centre.
import * as THREE from 'three';

let nextId = 1;

/** Re-centre a triangle soup so its footprint is centred on the origin and it rests on Z = 0. */
function normalized(geometry) {
  let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g.boundsTree = undefined;
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  g.computeBoundingBox();
  g.computeVertexNormals();
  return g;
}

export class PlateModel {
  constructor(name, geometry) {
    this.id = nextId++;
    this.name = name;
    this.geometry = normalized(geometry);
    this.x = 0; this.y = 0;           // footprint centre on the bed
    this.rx = 0; this.ry = 0; this.rz = 0; // rotation, degrees
    this.sx = 100; this.sy = 100; this.sz = 100; // scale, percent
    this.zFloat = null;               // while rotating by hand: the height of the bbox centre (null = rest on the plate)
    this._key = null;
    this._fit = null;
  }

  get triangles() { return this.geometry.attributes.position.count / 3; }

  _rotation() {
    return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(this.rx), THREE.MathUtils.degToRad(this.ry), THREE.MathUtils.degToRad(this.rz), 'XYZ'));
  }
  _linear() {
    return this._rotation().multiply(new THREE.Matrix4().makeScale(this.sx / 100, this.sy / 100, this.sz / 100));
  }

  /** Where the rotated and scaled mesh sits relative to its own origin (tight bounds, cached). */
  _fitInfo() {
    const key = [this.rx, this.ry, this.rz, this.sx, this.sy, this.sz].join(',');
    if (this._key === key) return this._fit;
    const m = this._linear();
    const p = this.geometry.attributes.position;
    const v = new THREE.Vector3();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); min.min(v); max.max(v); }
    this._key = key;
    this._fit = { min, max, size: max.clone().sub(min), cx: (min.x + max.x) / 2, cy: (min.y + max.y) / 2 };
    return this._fit;
  }

  get size() { return this._fitInfo().size; }

  /** Model -> bed matrix: scale, rotate, drop to the plate, centre the footprint on (x, y). */
  get matrix() {
    const f = this._fitInfo();
    const dz = this.zFloat == null ? -f.min.z : this.zFloat - (f.min.z + f.max.z) / 2;
    return new THREE.Matrix4().makeTranslation(this.x - f.cx, this.y - f.cy, dz).multiply(this._linear());
  }

  /** Axis-aligned bounds on the bed. */
  get bounds() {
    const s = this.size;
    return { minX: this.x - s.x / 2, maxX: this.x + s.x / 2, minY: this.y - s.y / 2, maxY: this.y + s.y / 2, height: s.z };
  }

  /** Triangle positions in bed coordinates, ready for the slicer. */
  worldPositions() {
    const g = this.geometry.clone();
    g.applyMatrix4(this.matrix);
    // a mirroring scale turns the triangles inside out
    if (this._linear().determinant() < 0) {
      const a = g.attributes.position.array;
      for (let i = 0; i + 8 < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
    }
    return g.attributes.position.array;
  }

  setUniformScale(percent) { this.sx = this.sy = this.sz = percent; }
}

/** Does the model sit inside the build volume? Returns '' when fine, otherwise the reason. */
export function fitProblem(model, volume) {
  const b = model.bounds, hw = volume.width / 2, hd = volume.depth / 2;
  if (b.height > volume.height + 0.01) return 'taller than the printer can print';
  if (volume.shape === 'elliptic') {
    const corners = [[b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.minY], [b.maxX, b.maxY]];
    // the footprint's bounding box is a safe, slightly strict test on a round bed
    if (corners.some(([x, y]) => (x / hw) ** 2 + (y / hd) ** 2 > 1.0001)) return 'outside the round print bed';
    return '';
  }
  if (b.minX < -hw - 0.01 || b.maxX > hw + 0.01 || b.minY < -hd - 0.01 || b.maxY > hd + 0.01) return 'outside the print bed';
  return '';
}

/** Lay models out in rows on the bed, largest first. Returns false when they do not all fit. */
export function arrange(models, volume, gap = 6) {
  const order = [...models].sort((a, b) => b.size.y - a.size.y);
  const hw = volume.width / 2, hd = volume.depth / 2;
  let x = -hw + gap, y = -hd + gap, rowH = 0, ok = true;
  for (const m of order) {
    const s = m.size;
    if (x + s.x > hw - gap + 0.01) { x = -hw + gap; y += rowH + gap; rowH = 0; }
    m.x = x + s.x / 2; m.y = y + s.y / 2;
    x += s.x + gap; rowH = Math.max(rowH, s.y);
    if (y + s.y > hd - gap + 0.01) ok = false;
  }
  if (ok) {
    // centre the whole group
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const m of models) { const b = m.bounds; minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX); minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY); }
    const dx = -(minX + maxX) / 2, dy = -(minY + maxY) / 2;
    for (const m of models) { m.x += dx; m.y += dy; }
  }
  return ok;
}
