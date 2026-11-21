// The slicer's 3D view: print bed, build volume, models you can drag around, and the G-code preview.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TYPE_COLORS } from './gcodeview.js';

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export class SlicerScene {
  constructor(container) {
    this.container = container;
    this.models = new Map();      // model id -> { model, mesh }
    this.selected = new Set();
    this.problems = new Set();
    this.volume = { width: 220, depth: 220, height: 250, shape: 'rectangular' };
    this.mode = 'model';
    this.onPick = () => {};
    this.onMove = () => {};
    this.onMoveEnd = () => {};
    this.preview = null;          // { group, types: Map, travel, layers, origin }
    this._raf = 0;
    this._disposed = false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.dom = this.renderer.domElement;
    this.dom.className = 'sl-canvas';
    container.append(this.dom);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.dom);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-200, -300, 500);
    this.scene.add(sun);

    this.bedGroup = new THREE.Group();
    this.modelGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.scene.add(this.bedGroup, this.modelGroup, this.previewGroup);

    this.ray = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.dom.addEventListener('pointerdown', (e) => this._down(e), true);
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.themeObserver = new MutationObserver(() => { this._applyTheme(); this.requestRender(); });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    this.setVolume(this.volume);
    this.home();
    this.resize();
  }

  // ------------------------------------------------------------------ theme
  _applyTheme() {
    const bg = css('--bg', '#16181d');
    this.scene.background = new THREE.Color(bg);
    this.accent = new THREE.Color(css('--accent', '#4f8cff'));
    this.gridColor = new THREE.Color(css('--border', '#323845'));
    this.bedColor = new THREE.Color(css('--panel-2', '#262a33'));
    this._rebuildBed();
    for (const { model, mesh } of this.models.values()) this._paint(mesh, model);
  }

  // ------------------------------------------------------------------ bed and volume
  setVolume(v) {
    this.volume = { ...this.volume, ...v };
    this._applyTheme();
    this._applyPreviewOrigin();
    this.requestRender();
  }

  _rebuildBed() {
    const { width: w, depth: d, height: hgt, shape } = this.volume;
    for (const c of [...this.bedGroup.children]) { this.bedGroup.remove(c); c.geometry && c.geometry.dispose(); if (c.material && c.material.map) c.material.map.dispose(); if (c.material) c.material.dispose(); }
    const round = shape === 'elliptic';

    let plate;
    if (round) { plate = new THREE.Mesh(new THREE.CircleGeometry(0.5, 96), new THREE.MeshBasicMaterial({ color: this.bedColor })); plate.scale.set(w, d, 1); }
    else plate = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: this.bedColor }));
    plate.position.z = -0.05;
    this.bedGroup.add(plate);

    const pts = [];
    const clipY = (x) => (round ? (d / 2) * Math.sqrt(Math.max(0, 1 - (x / (w / 2)) ** 2)) : d / 2);
    const clipX = (y) => (round ? (w / 2) * Math.sqrt(Math.max(0, 1 - (y / (d / 2)) ** 2)) : w / 2);
    for (let x = Math.ceil(-w / 20) * 10; x <= w / 2; x += 10) { const yy = clipY(x); if (yy > 0) pts.push(x, -yy, 0, x, yy, 0); }
    for (let y = Math.ceil(-d / 20) * 10; y <= d / 2; y += 10) { const xx = clipX(y); if (xx > 0) pts.push(-xx, y, 0, xx, y, 0); }
    const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), new THREE.LineBasicMaterial({ color: this.gridColor }));
    this.bedGroup.add(grid);

    // outline + build volume
    const edge = [];
    const ring = (z) => { const n = 96; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2; edge.push((w / 2) * Math.cos(a), (d / 2) * Math.sin(a), z, (w / 2) * Math.cos(b), (d / 2) * Math.sin(b), z); } };
    const rect = (z) => { const x = w / 2, y = d / 2; edge.push(-x, -y, z, x, -y, z, x, -y, z, x, y, z, x, y, z, -x, y, z, -x, y, z, -x, -y, z); };
    (round ? ring : rect)(0); (round ? ring : rect)(hgt);
    const post = round ? [[w / 2, 0], [-w / 2, 0], [0, d / 2], [0, -d / 2]] : [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
    for (const [x, y] of post) edge.push(x, y, 0, x, y, hgt);
    const box = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(edge, 3)), new THREE.LineBasicMaterial({ color: this.accent, transparent: true, opacity: 0.55 }));
    this.bedGroup.add(box);

    // origin marker at the front-left corner and a FRONT label
    const ox = round ? 0 : -w / 2, oy = round ? -d / 2 : -d / 2;
    const axes = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([ox, oy, 0.1, ox + 25, oy, 0.1, ox, oy, 0.1, ox, oy + 25, 0.1, ox, oy, 0, ox, oy, 25], 3)),
      new THREE.LineBasicMaterial({ vertexColors: true }));
    axes.geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, .3, .3, 1, .3, .3, .3, .9, .3, .3, .9, .3, .35, .6, 1, .35, .6, 1], 3));
    this.bedGroup.add(axes);
    this.bedGroup.add(this._label('FRONT', 0, -d / 2 - 14));
  }

  _label(text, x, y) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = css('--muted', '#98a2b3'); g.font = '600 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    spr.scale.set(60, 15, 1); spr.position.set(x, y, 0.5);
    return spr;
  }

  // ------------------------------------------------------------------ models
  setModels(list) {
    const keep = new Set(list.map((m) => m.id));
    for (const [id, e] of this.models) {
      if (!keep.has(id)) { this.modelGroup.remove(e.mesh); e.mesh.material.dispose(); this.models.delete(id); }
    }
    for (const m of list) {
      let e = this.models.get(m.id);
      if (!e) {
        const mesh = new THREE.Mesh(m.geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05 }));
        mesh.matrixAutoUpdate = false;
        mesh.userData.modelId = m.id;
        this.modelGroup.add(mesh);
        e = { model: m, mesh };
        this.models.set(m.id, e);
      }
      e.mesh.matrix.copy(m.matrix);
      e.mesh.matrixWorldNeedsUpdate = true;
      this._paint(e.mesh, m);
    }
    this.requestRender();
  }

  /** Re-read a model's transform after the user changed it. */
  refreshModel(m) {
    const e = this.models.get(m.id);
    if (!e) return;
    e.mesh.matrix.copy(m.matrix);
    e.mesh.matrixWorldNeedsUpdate = true;
    this._paint(e.mesh, m);
    this.requestRender();
  }

  _paint(mesh, model) {
    const bad = this.problems.has(model.id), sel = this.selected.has(model.id);
    const base = bad ? new THREE.Color(0xef5350) : (this.accent || new THREE.Color(0x4f8cff)).clone().lerp(new THREE.Color(0xffffff), 0.35);
    mesh.material.color.copy(base);
    mesh.material.emissive.copy(sel ? (this.accent || new THREE.Color(0x4f8cff)) : new THREE.Color(0x000000)).multiplyScalar(sel ? 0.35 : 0);
    mesh.material.opacity = bad ? 0.85 : 1;
    mesh.material.transparent = bad;
  }

  setSelection(ids) {
    this.selected = new Set(ids);
    for (const { model, mesh } of this.models.values()) this._paint(mesh, model);
    this.requestRender();
  }
  setProblems(ids) {
    this.problems = new Set(ids);
    for (const { model, mesh } of this.models.values()) this._paint(mesh, model);
    this.requestRender();
  }

  // ------------------------------------------------------------------ picking and dragging
  _ndc(e) {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  _groundPoint(e) {
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.plane, p) ? p : null;
  }
  _down(e) {
    if (e.button !== 0 || this.mode !== 'model') { this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; return; }
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const hits = this.ray.intersectObjects([...this.models.values()].map((m) => m.mesh), false);
    if (!hits.length) { this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; this.onPick(null, e); return; }
    this.controls.mouseButtons.LEFT = null; // the model takes this drag, not the camera
    const model = this.models.get(hits[0].object.userData.modelId).model;
    this.onPick(model.id, e);
    const g = this._groundPoint(e);
    this.drag = g ? { model, dx: g.x - model.x, dy: g.y - model.y, moved: false } : null;
  }
  _move(e) {
    if (!this.drag) return;
    const g = this._groundPoint(e);
    if (!g) return;
    const m = this.drag.model;
    m.x = g.x - this.drag.dx; m.y = g.y - this.drag.dy;
    this.drag.moved = true;
    this.refreshModel(m);
    this.onMove(m);
  }
  _up() {
    if (!this.drag) return;
    const d = this.drag; this.drag = null;
    if (d.moved) this.onMoveEnd(d.model);
  }

  // ------------------------------------------------------------------ preview
  setMode(mode) {
    this.mode = mode;
    this.modelGroup.visible = mode === 'model';
    this.previewGroup.visible = mode === 'preview';
    this.requestRender();
  }

  clearPreview() {
    for (const c of [...this.previewGroup.children]) { this.previewGroup.remove(c); c.geometry && c.geometry.dispose(); c.material && c.material.dispose(); }
    this.preview = null;
  }

  /** `parsed` is the result of parseGcode(); `centerIsZero` says what the G-code origin means. */
  showPreview(parsed, centerIsZero) {
    this.clearPreview();
    const types = new Map();
    for (const [t, b] of parsed.types) {
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
      const c = TYPE_COLORS[t] || TYPE_COLORS.DEFAULT;
      const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(c[0], c[1], c[2]) }));
      line.frustumCulled = false;
      this.previewGroup.add(line);
      types.set(t, { line, off: b.off });
    }
    const tgeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(parsed.travel.pos, 3));
    const travel = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({ color: 0x8892a6, transparent: true, opacity: 0.35 }));
    travel.visible = false; travel.frustumCulled = false;
    this.previewGroup.add(travel);
    this.preview = { types, travel: { line: travel, off: parsed.travel.off }, layers: parsed.layers, layerZ: parsed.layerZ, centerIsZero, hidden: new Set() };
    this._applyPreviewOrigin();
    this.setLayerRange(0, parsed.layers - 1);
  }

  _applyPreviewOrigin() {
    if (!this.preview) return;
    // G-code coordinates start at the front-left corner unless the machine's origin is its centre
    this.previewGroup.position.set(this.preview.centerIsZero ? 0 : -this.volume.width / 2, this.preview.centerIsZero ? 0 : -this.volume.depth / 2, 0);
  }

  setLayerRange(lo, hi) {
    const p = this.preview;
    if (!p) return;
    const apply = (line, off) => {
      const a = off[Math.min(lo, off.length - 1)], b = off[Math.min(hi + 1, off.length - 1)];
      line.geometry.setDrawRange(a * 2, Math.max(0, b - a) * 2);
    };
    for (const t of p.types.values()) apply(t.line, t.off);
    // travel moves are only worth showing for the layers being inspected
    apply(p.travel.line, p.travel.off);
    this.requestRender();
  }
  setTypeVisible(type, on) { const t = this.preview && this.preview.types.get(type); if (t) { t.line.visible = on; this.requestRender(); } }
  setTravelVisible(on) { if (this.preview) { this.preview.travel.line.visible = on; this.requestRender(); } }

  // ------------------------------------------------------------------ camera
  home() { this._view(new THREE.Vector3(0, 0, this.volume.height / 6), new THREE.Vector3(-0.55, -1, 0.75).normalize(), 1.0); }
  top() { this._view(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.001, 1).normalize(), 1.0); }
  front() { this._view(new THREE.Vector3(0, 0, this.volume.height / 3), new THREE.Vector3(0, -1, 0.05).normalize(), 1.0); }
  _view(target, dir, k) {
    const size = Math.max(this.volume.width, this.volume.depth, this.volume.height * 0.8);
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, (size * 2.6) / k);
    this.camera.near = Math.max(1, size / 200); this.camera.far = size * 20; this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  // ------------------------------------------------------------------ rendering
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.dom.style.width = '100%'; this.dom.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }
  requestRender() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  render() { this.renderer.render(this.scene, this.camera); }

  dispose() {
    this._disposed = true;
    this.ro.disconnect(); this.themeObserver.disconnect();
    this.clearPreview();
    this.renderer.dispose();
    this.dom.remove();
  }
}
