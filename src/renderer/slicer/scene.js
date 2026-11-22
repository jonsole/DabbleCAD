// The slicer's 3D view: print bed, build volume, models you can drag around, and the G-code preview.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TYPE_COLORS, typeHex } from './gcodeview.js';
import { getEdges } from '../core/geometry.js';

// the same outline colour 3D Design uses for selected shapes; the body turns Cura-yellow
const SEL_COLOR = 0x29c5ff, SEL_FILL = 0xf5c542;
const selLineMat = new THREE.LineBasicMaterial({ color: SEL_COLOR });

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * Each extruded segment is drawn as a short hexagonal bar, so layers show up as separate lit beads like
 * in Cura. One instance per segment: from, to, [width, height, layer].
 */
const PROFILE = [[-0.5, 0], [-0.3, 0.5], [0.3, 0.5], [0.5, 0], [0.3, -0.5], [-0.3, -0.5]];   // (side, up) in units of width / height
function extrusionGeometry(data) {
  const base = new THREE.InstancedBufferGeometry();
  const pos = [], nor = [], idx = [];
  for (let k = 0; k < 6; k++) {
    const p0 = PROFILE[k], p1 = PROFILE[(k + 1) % 6];
    // normal of the face for a typical 0.45 x 0.2 mm bead
    const ex = (p1[0] - p0[0]) * 0.45, ey = (p1[1] - p0[1]) * 0.2, l = Math.hypot(ex, ey);
    const nx = -ey / l, ny = ex / l;
    const o = pos.length / 3;
    for (const t of [0, 1]) for (const p of [p0, p1]) { pos.push(t, p[0], p[1]); nor.push(nx, ny, 0); }
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  base.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  base.setIndex(idx);
  const buf = new THREE.InstancedInterleavedBuffer(data, 10, 1);
  base.setAttribute('iA', new THREE.InterleavedBufferAttribute(buf, 3, 0));
  base.setAttribute('iB', new THREE.InterleavedBufferAttribute(buf, 3, 3));
  base.setAttribute('iDim', new THREE.InterleavedBufferAttribute(buf, 3, 6));
  base.setAttribute('iSeq', new THREE.InterleavedBufferAttribute(buf, 1, 9));
  base.instanceCount = data.length / 10;
  return base;
}
function extrusionMaterial(hex, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uColor: { value: new THREE.Color(hex) } },
    vertexShader: `
      attribute vec3 iA; attribute vec3 iB; attribute vec3 iDim; attribute float iSeq;
      uniform float uLo; uniform float uHi; uniform float uDone; uniform float uHideRest;
      varying vec3 vN; varying float vY; varying float vL; varying float vLayer;
      void main() {
        vY = position.z; vL = iSeq; vLayer = iDim.z;
        bool hide = uHideRest > 0.5 && iSeq >= uDone;   // Monitor 'progress': only what is printed so far
        if (hide || iDim.z < uLo || iDim.z > uHi) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec3 d = iB - iA; float len = length(d);
        vec3 dir = len > 1e-5 ? d / len : vec3(1.0, 0.0, 0.0);
        vec3 side = normalize(vec3(-dir.y, dir.x, 0.0));
        float t = position.x;
        vec3 p = iA + d * t + dir * (t * 2.0 - 1.0) * iDim.x * 0.3 + side * position.y * iDim.x + vec3(0.0, 0.0, position.z * iDim.y - iDim.y * 0.5);
        vN = mat3(modelViewMatrix) * (side * normal.x + vec3(0.0, 0.0, normal.y));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uDone; uniform float uActive; varying vec3 vN; varying float vY; varying float vL; varying float vLayer;
      void main() {
        vec3 n = normalize(vN);
        float l = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
        float edge = 0.55 + 0.45 * smoothstep(0.0, 0.75, n.z * 0.5 + 0.5);   // darker towards the sides of each bead
        float seam = 1.0 - 0.6 * smoothstep(0.28, 0.5, abs(vY));    // dark line where one layer meets the next
        vec3 col = vL >= uDone ? vec3(0.42, 0.44, 0.48) : uColor;   // uDone: the first move not printed yet
        if (uActive >= 0.0 && vL < uDone && vLayer < uActive - 0.5) col *= 0.45;   // finished layers darker than the one being printed   // Monitor 'whole print': layers still to print are grey
        gl_FragColor = vec4(col * (0.35 + 0.8 * l) * edge * seam, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
}

export class SlicerScene {
  constructor(container) {
    this.container = container;
    this.models = new Map();      // model id -> { model, mesh }
    this.selected = new Set();
    this.problems = new Set();
    this.volume = { width: 220, depth: 220, height: 250, shape: 'rectangular' };
    this.mode = 'model';
    this.typeColors = {};
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
    this.persp = this.camera;
    this.ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, -20000, 20000);
    this.ortho.up.set(0, 0, 1);
    this.renderListeners = [];
    this._anim = null;
    this.controls = new OrbitControls(this.camera, this.dom);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => this.requestRender());

    // the same rig as the 3D Design viewport: sky fill, a headlight that follows the camera, a fixed sun
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8d939c, 1.25);
    hemi.position.set(0, 0, 1);
    this.head = new THREE.DirectionalLight(0xffffff, 1.55);
    const sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(-120, -160, 320);
    this.scene.add(hemi, this.head, this.head.target, sun);

    this.bedGroup = new THREE.Group();
    this.modelGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.scene.add(this.bedGroup, this.modelGroup, this.previewGroup);

    this.ray = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.dom.addEventListener('pointerdown', (e) => this._down(e), true);
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    this.dom.addEventListener('pointerdown', (e) => { if (e.button === 2) this._rc = { x: e.clientX, y: e.clientY }; }, true);
    this.dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const d = this._rc && Math.hypot(e.clientX - this._rc.x, e.clientY - this._rc.y);
      if (d > 4) return; // the right button was used to pan, not to open a menu
      this.ray.setFromCamera(this._ndc(e), this.camera);
      const hits = this.mode === 'model'
        ? this.ray.intersectObjects([...this.models.values()].filter((m) => !m.model.hidden).map((m) => m.mesh), false) : [];
      this.onContext(hits.length ? hits[0].object.userData.modelId : null, e);
    });

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
        const mesh = new THREE.Mesh(m.geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.05 }));
        mesh.matrixAutoUpdate = false;
        mesh.userData.modelId = m.id;
        this.modelGroup.add(mesh);
        e = { model: m, mesh };
        this.models.set(m.id, e);
      }
      e.mesh.matrix.copy(m.matrix);
      e.mesh.matrixWorldNeedsUpdate = true;
      e.mesh.visible = !m.hidden;
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
    mesh.material.color.copy(sel && !bad ? new THREE.Color(SEL_FILL) : base);
    mesh.material.emissive.set(0x000000);
    let line = mesh.userData.line;
    if (sel) {
      const eg = getEdges(model.geometry);
      if (eg && !line) { line = new THREE.LineSegments(eg, selLineMat); line.raycast = () => {}; mesh.add(line); mesh.userData.line = line; }
    } else if (line) { mesh.remove(line); mesh.userData.line = null; }
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
  onContext() {}
  _down(e) {
    if (e.button !== 0 || this.mode !== 'model') { this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; return; }
    this.ray.setFromCamera(this._ndc(e), this.camera);
    const hits = this.ray.intersectObjects([...this.models.values()].filter((m) => !m.model.hidden).map((m) => m.mesh), false);
    if (!hits.length) { this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; this.onPick(null, e); return; }
    this.controls.mouseButtons.LEFT = null; // the model takes this drag, not the camera
    const model = this.models.get(hits[0].object.userData.modelId).model;
    this.onPick(model.id, e);
    const g = this._groundPoint(e);
    this.drag = g && !model.locked ? { model, dx: g.x - model.x, dy: g.y - model.y, moved: false } : null;
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
    for (const c of [...this.previewGroup.children]) { this.previewGroup.remove(c); if (c === this.nozzle) continue; c.geometry && c.geometry.dispose(); c.material && c.material.dispose(); for (const k of c.children || []) k.material && k.material.dispose(); }
    this.preview = null;
  }

  /** `parsed` is the result of parseGcode(); `centerIsZero` says what the G-code origin means. */
  showPreview(parsed, centerIsZero) {
    this.clearPreview();
    const types = new Map();
    this.previewUniforms = { uLo: { value: 0 }, uHi: { value: parsed.layers }, uDone: { value: 1e9 }, uHideRest: { value: 0 }, uActive: { value: -1 } };
    for (const [t, b] of parsed.types) {
      const geo = extrusionGeometry(b.pos);
      const mesh = new THREE.Mesh(geo, extrusionMaterial(typeHex(t, this.typeColors), this.previewUniforms));
      mesh.frustumCulled = false;
      this.previewGroup.add(mesh);
      types.set(t, { line: mesh, off: b.off });
    }
    const tgeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(parsed.travel.pos, 3));
    const travel = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({ color: 0x8892a6, transparent: true, opacity: 0.35 }));
    travel.visible = false; travel.frustumCulled = false;
    this.previewGroup.add(travel);
    this.preview = { layerPath: parsed.layerPath, types, travel: { line: travel, off: parsed.travel.off }, layers: parsed.layers, layerZ: parsed.layerZ, centerIsZero, hidden: new Set() };
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
    // extrusions are instanced boxes drawn up to the top layer; the lower layers are cut in the shader
    this.previewUniforms.uLo.value = lo; this.previewUniforms.uHi.value = hi;
    for (const t of p.types.values()) t.line.geometry.instanceCount = t.off[Math.min(hi + 1, t.off.length - 1)];
    // travel moves are only worth showing for the layers being inspected
    apply(p.travel.line, p.travel.off);
    this.requestRender();
  }
  /** Show the printer's nozzle at a G-code position ({x,y,z}), or hide it (null). */
  setNozzle(p, { smooth = 0 } = {}) {
    if (!this.nozzle) {
      // a brass MK8-style nozzle without its thread: conical tip and a 7 mm hex, tip at the origin
      const brass = { color: 0xd9b45a, emissive: 0x2a1c00, roughness: 0.28, metalness: 0.55, depthTest: false, transparent: true, opacity: 0.97 };
      const tipMat = new THREE.MeshStandardMaterial(brass);
      const hexMat = new THREE.MeshStandardMaterial({ ...brass, flatShading: true });
      const V = (r, y) => new THREE.Vector2(r, y);
      const tip = new THREE.Mesh(new THREE.LatheGeometry([V(0, 0), V(0.22, 0), V(0.5, 0.12), V(0.62, 0.45), V(3.5, 3.4), V(3.5, 3.6), V(0, 3.6)], 40), tipMat);
      const hex = new THREE.Mesh(new THREE.CylinderGeometry(4.04, 4.04, 4.4, 6), hexMat);
      hex.position.y = 3.4 + 2.2;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, 0.5, 6), hexMat);   // the small chamfer where the thread starts
      top.position.y = 3.4 + 4.4 + 0.25;
      this.nozzle = new THREE.Group();
      const body = new THREE.Group(); body.add(tip, hex, top);
      body.rotation.x = Math.PI / 2;                                 // built Y-up; the scene is Z-up
      this.nozzle.add(body);
      for (const o of [tip, hex, top]) o.renderOrder = 10;
      this.previewGroup.add(this.nozzle);
    }
    if (this.nozzle.parent !== this.previewGroup) this.previewGroup.add(this.nozzle);   // after a new preview
    cancelAnimationFrame(this._nozzleAnim);
    const wasVisible = this.nozzle.visible;
    this.nozzle.visible = !!p;
    if (!p) { this.requestRender(); return; }
    const to = new THREE.Vector3(p.x, p.y, p.z);
    if (!smooth || !wasVisible) { this.nozzle.position.copy(to); this.requestRender(); return; }
    // glide to the new spot over about one polling interval, so the marker moves instead of jumping
    const from = this.nozzle.position.clone(), t0 = performance.now();
    const step = () => {
      const f = Math.min(1, (performance.now() - t0) / smooth);
      this.nozzle.position.lerpVectors(from, to, f);
      this.render();
      if (f < 1) this._nozzleAnim = requestAnimationFrame(step);
    };
    this._nozzleAnim = requestAnimationFrame(step);
  }
  /**
   * Moves before number `n` (in file order) are printed (null: show everything normally).
   * style 'whole': the rest in grey; 'progress': the rest not drawn at all.
   */
  setPrinted(n, style = 'whole') {
    if (!this.preview) return;
    this.previewUniforms.uDone.value = n == null ? 1e9 : n;
    // the layer being printed: the last one starting at or before move n
    let active = -1;
    const lp = this.preview.layerPath;
    if (n != null && lp && lp.length) { let lo = 0, hi = lp.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lp[mid] <= n) lo = mid; else hi = mid - 1; } active = lo; }
    this.previewUniforms.uActive.value = active;
    this.previewUniforms.uHideRest.value = n != null && style === 'progress' ? 1 : 0;
    this.requestRender();
  }
  /** Extrusion segments per layer boundary, summed over feature types: lets a print fraction be turned into a layer. */
  layerForFraction(f) {
    const p = this.preview;
    if (!p) return null;
    const cum = (l) => { let n = 0; for (const t of p.types.values()) n += t.off[Math.min(l, t.off.length - 1)]; return n; };
    const total = cum(p.layers), want = f * total;
    let lo = 0, hi = p.layers;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum(mid + 1) < want) lo = mid + 1; else hi = mid; }
    return Math.min(p.layers, lo + 1);   // the layer being printed counts as started
  }
  /** Change the preview colour of one feature type (or back to its default with null). */
  setTypeColor(type, hex) {
    this.typeColors = { ...this.typeColors };
    if (hex) this.typeColors[type] = hex; else delete this.typeColors[type];
    const t = this.preview && this.preview.types.get(type);
    if (t) { t.line.material.uniforms.uColor.value.set(typeHex(type, this.typeColors)); this.requestRender(); }
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
    if (this.isOrtho) { this.camera.zoom = 1; this._orthoHalf = ((size * 2.6) / k) * Math.tan((this.persp.fov * Math.PI) / 360); this._fitOrtho(); }
    else { this.camera.near = Math.max(1, size / 200); this.camera.far = size * 20; this.camera.updateProjectionMatrix(); }
    this.controls.update();
    this.requestRender();
  }

  // ------------------------------------------------------------------ rendering
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.dom.style.width = '100%'; this.dom.style.height = '100%';
    this._aspect = w / h;
    this.persp.aspect = this._aspect;
    this.persp.updateProjectionMatrix();
    this._fitOrtho();
    this.requestRender();
  }
  requestRender() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  _aimHeadlight() {
    const cam = this.camera, t = this.controls.target;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const dir = new THREE.Vector3().subVectors(cam.position, t).normalize();
    this.head.position.copy(t).addScaledVector(dir, 1000).addScaledVector(right, -450).addScaledVector(up, 520);
    this.head.target.position.copy(t);
    this.head.target.updateMatrixWorld();
  }
  render() {
    this._aimHeadlight();
    this.renderer.render(this.scene, this.camera);
    for (const fn of this.renderListeners) fn();
  }

  // ------------------------------------------------------------------ the same camera API as the 3D Design viewport
  // (the view cube and the zoom column are shared with it). theta/phi are spherical angles around
  // the orbit target with Z up, exactly as in the 3D Design viewport.
  onRender(fn) { this.renderListeners.push(fn); }
  get isOrtho() { return this.camera === this.ortho; }
  _offset() { return this.camera.position.clone().sub(this.controls.target); }
  get theta() { const d = this._offset(); return Math.atan2(d.y, d.x); }
  get phi() { const d = this._offset(); return Math.acos(Math.max(-1, Math.min(1, d.z / (d.length() || 1)))); }
  set theta(v) { this._setSph({ theta: v }); }
  set phi(v) { this._setSph({ phi: v }); }
  _setSph({ theta, phi, radius }) {
    const d = this._offset(), r = radius ?? (d.length() || 1);
    const t = theta ?? Math.atan2(d.y, d.x), f = phi ?? Math.acos(Math.max(-1, Math.min(1, d.z / (d.length() || 1))));
    const sp = Math.sin(f);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(sp * Math.cos(t), sp * Math.sin(t), Math.cos(f)).multiplyScalar(r));
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.requestRender();
  }
  _animateTo(to, ms = 240) {
    const from = { theta: this.theta, phi: this.phi, radius: this._offset().length(), zoom: this.camera.zoom };
    let dTheta = (to.theta ?? from.theta) - from.theta;
    dTheta = ((dTheta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;   // the short way round
    const start = performance.now(), token = {};
    this._anim = token;
    const step = (now) => {
      if (this._anim !== token || this._disposed) return;
      const k = Math.min(1, (now - start) / ms), e = 1 - Math.pow(1 - k, 3);
      this._setSph({ theta: from.theta + dTheta * e, phi: from.phi + ((to.phi ?? from.phi) - from.phi) * e, radius: from.radius + ((to.radius ?? from.radius) - from.radius) * e });
      if (to.zoom != null) { this.camera.zoom = from.zoom + (to.zoom - from.zoom) * e; this.camera.updateProjectionMatrix(); }
      if (k < 1) requestAnimationFrame(step); else this._anim = null;
    };
    requestAnimationFrame(step);
  }
  viewFrom(theta, phi) { this._animateTo({ theta, phi: Math.min(Math.PI - 0.0006, Math.max(0.0006, phi)) }); }
  zoomBy(factor) {
    if (this.isOrtho) this._animateTo({ zoom: Math.min(50, Math.max(0.05, this.camera.zoom / factor)) }, 160);
    else this._animateTo({ radius: Math.min(20000, Math.max(5, this._offset().length() * factor)) }, 160);
  }
  setProjection(mode) {
    const toOrtho = mode === 'orthographic';
    if (toOrtho === this.isOrtho) return;
    const from = this.camera, to = toOrtho ? this.ortho : this.persp;
    to.position.copy(from.position); to.quaternion.copy(from.quaternion); to.up.copy(from.up);
    if (toOrtho) { to.zoom = 1; this._orthoHalf = Math.max(1, this._offset().length() * Math.tan((this.persp.fov * Math.PI) / 360)); }
    this.camera = to; this.controls.object = to;
    this._fitOrtho();
    this.controls.update();
    this.requestRender();
  }
  _fitOrtho() {
    const half = this._orthoHalf || 100, a = this._aspect || 1;
    this.ortho.left = -half * a; this.ortho.right = half * a; this.ortho.top = half; this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
  }

  dispose() {
    this._disposed = true;
    this.ro.disconnect(); this.themeObserver.disconnect();
    this.clearPreview();
    this.renderer.dispose();
    this.dom.remove();
  }
}
