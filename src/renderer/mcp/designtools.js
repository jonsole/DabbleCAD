// Design tools for the MCP server: read the design, build and change shapes, group, shape edges
// and faces, look at the result, and manage design files. Units are mm and degrees, in world
// axes (X right, Y back, Z up, the workplane at Z = 0); objects are named by their node ids.
import * as THREE from 'three';
import { ToolError } from './errors.js';
import { makeShape, cloneNode, mat4 } from '../core/doc.js';
import { KINDS, CATALOG, CATEGORIES, defaultParams, kindName } from '../core/shapes.js';
import { getGeometry, nodeEdgeData, edgeRoundIndex, nodeShapeEdits, stats as geoStats } from '../core/geometry.js';
import { exportModel } from '../core/io.js';
import { platform } from '../platform.js';

const DEG = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;
const v3 = (v) => [r2(v.x), r2(v.y), r2(v.z)];
const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const about = (c, m) => T(c.x, c.y, c.z).multiply(m).multiply(T(-c.x, -c.y, -c.z));
const AXES = ['x', 'y', 'z'];

// ------------------------------------------------------------------ schema helpers
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const vec = (description) => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description });
const ids = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Object ids, from get_design' };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PICK = {
  description: 'Which parts: {"side": "top"|"bottom"|"left"|"right"|"front"|"back"} (the ones furthest that way), {"near": [x, y, z]} (the one closest to a point, mm), or {"all": true}',
  type: 'object', properties: { side: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'front', 'back'] }, near: vec('A point in mm'), all: { type: 'boolean' } },
};
const SIDES = { top: [0, 0, 1], bottom: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], back: [0, 1, 0], front: [0, -1, 0] };

// ------------------------------------------------------------------ describing objects
function nodeOf(ed, id) {
  const n = typeof id === 'string' && ed.node(id);
  if (!n) throw new ToolError('not_found', `No object with id ${JSON.stringify(id)}. Call get_design for the ids.`);
  return n;
}
function writable(ed, id) {
  const n = nodeOf(ed, id);
  if (n.locked) throw new ToolError('locked', `${label(n)} is locked. Ask the person to unlock it, or pick another object.`);
  return n;
}
const label = (n) => `"${n.name || kindName(n)}" (${n.id})`;

const worldBox = (ed, n) => ed.bounds([n], true);

/** Rotation of a node in degrees (X, Y, Z order), ignoring its scale. */
function rotationOf(n) {
  const q = new THREE.Quaternion();
  mat4(n.matrix).decompose(new THREE.Vector3(), q, new THREE.Vector3());
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [r2(e.x / DEG), r2(e.y / DEG), r2(e.z / DEG)].map((a) => (Math.abs(a) < 0.005 ? 0 : a));
}

function describe(ed, n, { full = false } = {}) {
  const b = worldBox(ed, n);
  const out = {
    id: n.id, name: n.name || kindName(n), type: n.type, kind: n.type === 'group' ? n.mode : n.kind,
    solid: !n.hole, color: n.color, locked: !!n.locked, hidden: !!n.hidden,
    size: b.isEmpty() ? [0, 0, 0] : v3(b.getSize(new THREE.Vector3())),
    position: b.isEmpty() ? [0, 0, 0] : v3(b.min),
    rotation: rotationOf(n),
  };
  if (n.type === 'shape') out.params = paramsOut(n);
  if (n.edgeRounds && n.edgeRounds.length) out.edges = { rounded: n.edgeRounds.filter((e) => e.t !== 'chamfer').length, chamfered: n.edgeRounds.filter((e) => e.t === 'chamfer').length };
  if (n.round > 0) out.edges = { ...(out.edges || {}), all_edges_radius: n.round };
  if (n.shapeEdits && n.shapeEdits.length) out.moves = n.shapeEdits.length;
  if (n.type === 'group') {
    out.children = full ? n.children.map((c) => ({ id: c.id, name: c.name || kindName(c), kind: c.type === 'group' ? c.mode : c.kind, solid: !c.hole })) : n.children.map((c) => c.id);
    out.multicolor = !!n.multicolor;
  }
  if (full) {
    const d = nodeEdgeData(n);
    out.parts = { edges: d.chains.length };
    const st = nodeShapeEdits(n);
    if (st) { out.parts.flat_faces = st.A.faces.length; out.parts.corners = st.A.corners.length; }
  }
  return out;
}

/** Shape parameters without heavy payloads (meshes, outlines). */
function paramsOut(n) {
  const spec = KINDS[n.kind];
  if (!spec) return {};
  const out = {};
  for (const p of spec.params) out[p.key] = n.params[p.key];
  return out;
}

// ------------------------------------------------------------------ placing and transforming
/** Apply a world-space change to a node's matrix. */
const applyWorld = (n, m) => { mat4(n.matrix).premultiply(m).toArray(n.matrix); };

function checkParams(kind, params = {}) {
  const spec = KINDS[kind];
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    const p = spec.params.find((x) => x.key === k);
    if (!p) throw new ToolError('invalid_args', `${spec.name} has no parameter "${k}". It has: ${spec.params.map((x) => x.key).join(', ') || 'none'}.`);
    if (p.type === 'range') {
      if (typeof v !== 'number' || !isFinite(v)) throw new ToolError('invalid_args', `${k} must be a number`);
      if (v < p.min || v > p.max) throw new ToolError('out_of_range', `${k} must be between ${p.min} and ${p.max}`);
    } else if (p.type === 'select' && !p.options.includes(v)) throw new ToolError('invalid_args', `${k} must be one of ${p.options.join(', ')}`);
    out[k] = v;
  }
  return out;
}

/** Set a node's size, rotation and position (world bounding box), in that order. */
function place(ed, n, { size, rotation, position, move_by, rotate_by }, { fresh = false } = {}) {
  if (rotation) {
    if (!Array.isArray(rotation) || rotation.length !== 3) throw new ToolError('invalid_args', 'rotation is [x, y, z] in degrees');
    const c = worldBox(ed, n).getCenter(new THREE.Vector3());
    const q0 = new THREE.Quaternion();
    mat4(n.matrix).decompose(new THREE.Vector3(), q0, new THREE.Vector3());
    const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, 'XYZ'));
    applyWorld(n, about(c, new THREE.Matrix4().makeRotationFromQuaternion(q1.multiply(q0.invert()))));
  }
  if (rotate_by) {
    const c = worldBox(ed, n).getCenter(new THREE.Vector3());
    const r = new THREE.Matrix4().makeRotationX(rotate_by[0] * DEG).premultiply(new THREE.Matrix4().makeRotationY(rotate_by[1] * DEG)).premultiply(new THREE.Matrix4().makeRotationZ(rotate_by[2] * DEG));
    applyWorld(n, about(c, r));
  }
  if (size) {
    if (!Array.isArray(size) || size.length !== 3 || size.some((s) => !(s > 0))) throw new ToolError('invalid_args', 'size is [x, y, z] in mm, each above 0');
    const b = worldBox(ed, n), s = b.getSize(new THREE.Vector3());
    const f = AXES.map((a, i) => (s[a] > 1e-6 ? size[i] / s[a] : 1));
    applyWorld(n, about(b.min, new THREE.Matrix4().makeScale(f[0], f[1], f[2])));
  }
  if (position) {
    if (!Array.isArray(position) || position.length !== 3) throw new ToolError('invalid_args', 'position is [x, y, z]: the corner of the bounding box nearest the origin, in mm');
    const b = worldBox(ed, n);
    applyWorld(n, T(position[0] - b.min.x, position[1] - b.min.y, position[2] - b.min.z));
  } else if (fresh) {
    // new objects stand on the workplane, at the middle of the view
    const c = ed.viewCenterPoint();
    const b = worldBox(ed, n), mid = b.getCenter(new THREE.Vector3());
    applyWorld(n, T(c.x - mid.x, c.y - mid.y, -b.min.z));
  }
  if (move_by) applyWorld(n, T(move_by[0] || 0, move_by[1] || 0, move_by[2] || 0));
}

// ------------------------------------------------------------------ picking faces, edges and corners
function pickIndices(points, pick, what) {
  if (!pick || typeof pick !== 'object') throw new ToolError('invalid_args', `Say which ${what}: {"side": "top"}, {"near": [x, y, z]} or {"all": true}`);
  if (!points.length) throw new ToolError('not_found', `This object has no ${what} that can be picked`);
  if (pick.all) return points.map((_, i) => i);
  if (pick.near) {
    const p = new THREE.Vector3().fromArray(pick.near);
    let best = 0;
    points.forEach((q, i) => { if (q.distanceTo(p) < points[best].distanceTo(p)) best = i; });
    return [best];
  }
  const dir = SIDES[pick.side];
  if (!dir) throw new ToolError('invalid_args', 'side must be top, bottom, left, right, front or back');
  const d = new THREE.Vector3().fromArray(dir);
  const far = Math.max(...points.map((q) => q.dot(d)));
  return points.map((q, i) => (q.dot(d) > far - 0.05 ? i : -1)).filter((i) => i >= 0);
}

function nearMiss(points, what) {
  return `Nearest ${what}: ${points.slice(0, 6).map((p) => `[${v3(p).join(', ')}]`).join(', ')}`;
}

// ------------------------------------------------------------------ pictures
const VIEWS = {
  iso: [-68, 60], front: [-90, 90], back: [90, 90], left: [180, 90], right: [0, 90], top: [-90, 0.05], bottom: [-90, 179.9],
};

/** A picture of the 3D view from a named angle, framed on the given nodes. The person's view is put back. */
export function screenshotView(app, { view = 'iso', theta, phi, nodes, size = 768 }) {
  const vp = app.viewport, ed = app.editor;
  const saved = { theta: vp.theta, phi: vp.phi, radius: vp.radius, target: vp.target.clone() };
  const anim = vp._anim;
  vp._anim = null;
  try {
    const [t0, p0] = VIEWS[view] || VIEWS.iso;
    vp.theta = (theta ?? t0) * DEG;
    vp.phi = Math.min(Math.PI - 0.0006, Math.max(0.0006, (phi ?? p0) * DEG));
    const box = ed.worldBounds(nodes && nodes.length ? nodes : undefined);
    if (box.isEmpty()) { vp.target.set(0, 0, 0); vp.radius = Math.max(vp.workplane.width, vp.workplane.length) * 1.4; }
    else {
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      vp.target.copy(sphere.center);
      vp.radius = (Math.max(sphere.radius, 2) / Math.sin(22.5 * DEG)) * 1.08;
    }
    const w = Math.max(256, Math.min(1024, size | 0)), h = Math.round(w * 0.75);
    const url = vp.snapshot(w, h, 'image/png');
    return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png' };
  } finally {
    Object.assign(vp, { theta: saved.theta, phi: saved.phi, radius: saved.radius });
    vp.target.copy(saved.target);
    vp._anim = anim;
    vp.requestRender();
  }
}

/** Run fn with the selection set to ids, putting the person's selection back afterwards. */
async function withSelection(ed, idList, fn) {
  const before = [...ed.selection];
  ed.selection = new Set(idList);
  try { return await fn(); } finally {
    const live = new Set(ed.doc.nodes.map((n) => n.id));
    ed.selection = new Set(before.filter((id) => live.has(id)));
    ed.refreshOutlines();
    ed.emit('selection');
  }
}

const lookIf = (args, app, nodes) => (args.look ? [screenshotView(app, { nodes })] : []);
const LOOK = { type: 'boolean', description: 'Also return a screenshot of the result' };

// ------------------------------------------------------------------ the tools
export function designTools() {
  return [
    {
      name: 'get_status', title: 'Status', readOnly: true,
      description: 'App name and version, the open design, its display units, what the person has selected, and which workspace they are in.',
      run: (_a, { app, editor }) => ({ data: {
        app: 'DabbleCAD Plus', version: app.settings.version, platform: app.settings.platform === 'browser' ? 'web' : 'desktop',
        design: { id: app.designId, name: editor.doc.name, objects: editor.doc.nodes.length, display_units: editor.units, unsaved: !!app.dirty },
        selection: [...editor.selection], workspace: app.viewMode, units: 'mm',
      } }),
    },
    {
      name: 'get_design', title: 'Get the design', readOnly: true,
      description: 'Every top-level object: id, name, kind, solid or hole, colour, size, position (the bounding-box corner nearest the origin), rotation, shape parameters, and group children ids. Also the workplane size.',
      inputSchema: obj({ include_hidden: { type: 'boolean', description: 'Include hidden objects (default true)' } }),
      run: (a, { editor }) => {
        const nodes = editor.doc.nodes.filter((n) => a.include_hidden !== false || !n.hidden);
        const wp = editor.doc.workplane;
        const all = editor.worldBounds(nodes.filter((n) => !n.hidden && !n.hole));
        return { data: {
          name: editor.doc.name, units: 'mm', workplane: { width: wp.width, length: wp.length },
          overall_size: all.isEmpty() ? [0, 0, 0] : v3(all.getSize(new THREE.Vector3())),
          objects: nodes.map((n) => describe(editor, n)),
          notes: editor.doc.notes.map((x) => ({ id: x.id, text: x.text, position: x.pos.map(r2) })),
        } };
      },
    },
    {
      name: 'get_object', title: 'Get one object', readOnly: true,
      description: 'One object in full: as get_design, plus its group members and how many edges, flat faces and corners can be picked on it.',
      inputSchema: obj({ id: { type: 'string', description: 'Object id' } }, ['id']),
      run: (a, { editor }) => ({ data: describe(editor, nodeOf(editor, a.id), { full: true }) }),
    },
    {
      name: 'list_shape_kinds', title: 'Shape catalogue', readOnly: true,
      description: 'Shapes that add_shape can make: kind, name, category and parameters (with ranges and defaults). Every new shape is about 20 mm across until resized.',
      inputSchema: obj({ category: { type: 'string', description: `One of: ${CATEGORIES.filter((c) => !['all', 'mine', 'starters', 'text'].includes(c.id)).map((c) => c.id).join(', ')}` } }),
      run: (a) => {
        const seen = new Set();
        const kinds = [];
        for (const c of CATALOG) {
          if (c.starter || c.special || seen.has(c.kind) || (a.category && c.cat !== a.category) || c.cat === 'text') continue;
          seen.add(c.kind);
          const spec = KINDS[c.kind];
          kinds.push({ kind: c.kind, name: spec.name, category: c.cat, params: spec.params.map((p) => ({ key: p.key, label: p.label, type: p.type, ...(p.type === 'range' ? { min: p.min, max: p.max, default: p.def } : { default: p.def }), ...(p.options ? { options: p.options } : {}) })) });
        }
        return { data: { kinds, note: 'Presets in the catalogue (e.g. "Hexagonal Prism") are the same kinds with different parameters, e.g. polygon with sides: 6.' } };
      },
    },
    {
      name: 'measure', title: 'Measure', readOnly: true,
      description: 'Overall bounding box, volume (cm³), surface area (cm²) and estimated weight of some objects; with two ids, also the gap between their bounding boxes along X, Y and Z.',
      inputSchema: obj({ ids, density: num('g/cm³ for the weight (default 1.24, PLA)') }, ['ids']),
      run: (a, { editor }) => {
        const nodes = a.ids.map((id) => nodeOf(editor, id));
        const m = editor.measureNodes(nodes);
        const b = editor.worldBounds(nodes);
        const out = { size: v3(b.getSize(new THREE.Vector3())), position: v3(b.min), volume_cm3: r2(m.volume / 1000), area_cm2: r2(m.area / 100), weight_g: r2((m.volume / 1000) * (a.density || 1.24)) };
        if (nodes.length === 2) {
          const [p, q] = nodes.map((n) => worldBox(editor, n));
          out.gap = AXES.map((k) => r2(Math.max(q.min[k] - p.max[k], p.min[k] - q.max[k])));
        }
        return { data: out };
      },
    },
    {
      name: 'add_shape', title: 'Add a shape',
      description: 'Add a shape (or a hole, with hole: true). Kinds and parameters come from list_shape_kinds; text is kind "text" with params {"text": "..."}. Without a position it stands on the workplane in the middle of the view.',
      inputSchema: obj({
        kind: { type: 'string', description: 'Shape kind, e.g. box, cylinder, sphere, cone, polygon, text' },
        params: { type: 'object', description: 'Shape parameters, e.g. {"sides": 6}' },
        size: vec('[x, y, z] in mm'), position: vec('Bounding-box corner nearest the origin, mm'), rotation: vec('[x, y, z] in degrees'),
        color: { type: 'string', description: 'CSS colour, e.g. "#e53935"' }, hole: { type: 'boolean' }, name: { type: 'string' }, look: LOOK,
      }, ['kind']),
      run: (a, { app, editor }) => {
        const entry = CATALOG.find((c) => c.kind === a.kind && !c.special && !c.starter);
        if (!KINDS[a.kind] || !entry) throw new ToolError('invalid_args', `Unknown or unsupported kind "${a.kind}". Call list_shape_kinds.`);
        const params = { ...defaultParams(a.kind), ...(entry ? entry.params : {}), ...checkParams(a.kind, a.params) };
        const n = makeShape(a.kind, params, a.color || (entry && entry.color) || '#3fa7a3', a.name || '');
        if (a.hole) n.hole = true;
        place(editor, n, a, { fresh: true });
        editor.addNode(n, { select: false });
        return { text: `Added ${label(n)}.`, data: describe(editor, n), images: lookIf(a, app, [n]) };
      },
    },
    {
      name: 'update_objects', title: 'Change objects',
      description: 'Move, resize, rotate, recolour, rename, switch between solid and hole, lock, hide or change shape parameters. size/position/rotation are absolute (world bounding box); move_by and rotate_by are relative. Several ids get the same change each.',
      inputSchema: obj({
        ids, size: vec('[x, y, z] in mm'), position: vec('Bounding-box corner nearest the origin, mm'), rotation: vec('[x, y, z] degrees, absolute'),
        move_by: vec('[dx, dy, dz] in mm'), rotate_by: vec('[x, y, z] degrees, about the object centre'),
        params: { type: 'object' }, color: { type: 'string' }, hole: { type: 'boolean' }, name: { type: 'string' },
        locked: { type: 'boolean' }, hidden: { type: 'boolean' }, look: LOOK,
      }, ['ids']),
      run: (a, { app, editor }) => {
        const nodes = a.ids.map((id) => (a.locked === false && Object.keys(a).length === 2 ? nodeOf(editor, id) : writable(editor, id)));
        for (const n of nodes) {
          if (a.params) {
            if (n.type !== 'shape') throw new ToolError('invalid_args', `${label(n)} is a group: it has no shape parameters`);
            n.params = { ...n.params, ...checkParams(n.kind, a.params) };
          }
          if (a.color) Object.assign(n, n.type === 'group' ? { color: a.color, multicolor: false } : { color: a.color });
          if (a.hole !== undefined) n.hole = !!a.hole;
          if (a.name !== undefined) n.name = a.name;
          if (a.hidden !== undefined) n.hidden = !!a.hidden;
          place(editor, n, a);
          if (a.locked !== undefined) n.locked = !!a.locked;
        }
        editor.sync(); editor.commit(); editor.emit('selection');
        return { text: `Changed ${nodes.length} object${nodes.length > 1 ? 's' : ''}.`, data: { objects: nodes.map((n) => describe(editor, n)) }, images: lookIf(a, app, nodes) };
      },
    },
    {
      name: 'align_objects', title: 'Align',
      description: 'Line objects up along an axis, like the Align tool: their min sides, centres or max sides meet (on the anchor object if given, otherwise on the box around them all).',
      inputSchema: obj({ ids, axis: { type: 'string', enum: AXES }, to: { type: 'string', enum: ['min', 'center', 'max'] }, anchor: { type: 'string', description: 'Id of an object that stays put' } }, ['ids', 'axis', 'to']),
      run: async (a, { editor }) => {
        a.ids.forEach((id) => writable(editor, id));
        await withSelection(editor, a.ids, () => { editor.alignAnchor = a.anchor || null; editor.align(a.axis, a.to); editor.alignAnchor = null; });
        return { data: { objects: a.ids.map((id) => describe(editor, editor.node(id))) } };
      },
    },
    {
      name: 'duplicate_objects', title: 'Duplicate',
      description: 'Copy objects: once, offset by [dx, dy, dz], or as a pattern (row: count copies each offset further; circle: count copies around the Z axis through the origin).',
      inputSchema: obj({ ids, offset: vec('[dx, dy, dz] in mm between copies (default [10, 10, 0])'), count: { type: 'integer', minimum: 1, maximum: 100, description: 'Copies to make (default 1)' }, circle: { type: 'boolean', description: 'Arrange the copies in a circle instead of a row' }, angle: num('Degrees the circle spans (default 360)') }, ['ids']),
      run: async (a, { editor }) => {
        const src = a.ids.map((id) => nodeOf(editor, id));
        const count = Math.max(1, Math.min(100, a.count || 1));
        const before = new Set(editor.doc.nodes.map((n) => n.id));
        if (a.circle) await withSelection(editor, a.ids, () => editor.pattern({ type: 'circular', count: count + 1, angle: a.angle ?? 360 }));
        else {
          const [dx, dy, dz] = a.offset || [10, 10, 0];
          for (let i = 1; i <= count; i++) for (const n of src) { const c = cloneNode(n, true); c.locked = false; applyWorld(c, T(dx * i, dy * i, dz * i)); editor.doc.nodes.push(c); }
          editor.sync(); editor.commit();
        }
        const made = editor.doc.nodes.filter((n) => !before.has(n.id));
        return { text: `Made ${made.length} cop${made.length === 1 ? 'y' : 'ies'}.`, data: { ids: made.map((n) => n.id) } };
      },
    },
    {
      name: 'delete_objects', title: 'Delete', destructive: true,
      description: 'Delete objects (the person can undo it).',
      inputSchema: obj({ ids }, ['ids']),
      run: (a, { editor }) => {
        const gone = new Set(a.ids.map((id) => writable(editor, id).id));
        editor.doc.nodes = editor.doc.nodes.filter((n) => !gone.has(n.id));
        for (const id of gone) editor.selection.delete(id);
        editor.sync(); editor.commit(); editor.emit('selection');
        return { text: `Deleted ${gone.size} object${gone.size > 1 ? 's' : ''}.` };
      },
    },
    {
      name: 'select_objects', title: 'Select', readOnly: true,
      description: 'Select objects in the app, to show the person what you mean (an empty list clears the selection). Changes nothing in the design.',
      inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
      run: (a, { editor }) => { a.ids.forEach((id) => nodeOf(editor, id)); editor.select(a.ids); return { text: a.ids.length ? `Selected ${a.ids.length}.` : 'Cleared the selection.' }; },
    },
    {
      name: 'group', title: 'Group',
      description: 'Combine objects into one: mode "union" joins solids and cuts holes out of them; "intersect" keeps only where they overlap; "bundle" keeps them separate but moves them together.',
      inputSchema: obj({ ids: { ...ids, minItems: 2 }, mode: { type: 'string', enum: ['union', 'intersect', 'bundle'], description: 'Default union' }, name: { type: 'string' }, look: LOOK }, ['ids']),
      run: async (a, { app, editor }) => {
        a.ids.forEach((id) => writable(editor, id));
        let g;
        await withSelection(editor, a.ids, async () => { await editor.group(a.mode || 'union'); g = editor.selectedNodes()[0]; });
        if (!g || g.type !== 'group') throw new ToolError('failed', 'Could not group those objects');
        if (a.name) g.name = a.name;
        if (!getGeometry(g).attributes.position.count) return { text: `Grouped as ${label(g)}, but the result is empty: the holes removed everything.`, data: describe(editor, g) };
        return { text: `Grouped as ${label(g)}.`, data: describe(editor, g), images: lookIf(a, app, [g]) };
      },
    },
    {
      name: 'ungroup', title: 'Ungroup',
      description: 'Split a group back into its parts.',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
      run: async (a, { editor }) => {
        const g = writable(editor, a.id);
        if (g.type !== 'group') throw new ToolError('invalid_args', `${label(g)} is not a group`);
        let parts = [];
        await withSelection(editor, [g.id], () => { editor.ungroup(); parts = editor.selectedNodes(); });
        return { data: { ids: parts.map((n) => n.id) } };
      },
    },
    {
      name: 'set_edges', title: 'Round or chamfer edges',
      description: 'Round or chamfer edges of an object, or make them sharp again. Edges are picked by side (e.g. all top edges), nearest a point, or all.',
      inputSchema: obj({ id: { type: 'string' }, edges: PICK, style: { type: 'string', enum: ['round', 'chamfer', 'sharp'] }, size: num('Radius or chamfer size in mm'), look: LOOK }, ['id', 'edges', 'style']),
      run: (a, { app, editor }) => {
        const n = writable(editor, a.id);
        if (a.style !== 'sharp' && !(a.size > 0)) throw new ToolError('invalid_args', 'size (mm) is needed to round or chamfer');
        const d = nodeEdgeData(n);
        const m = mat4(n.matrix);
        const mids = d.lines.map((pts) => pts[0].clone().lerp(pts[pts.length - 1], 0.5).applyMatrix4(m));
        const picked = pickIndices(mids, a.edges, 'edges');
        const idx = edgeRoundIndex(n);
        const shape = a.style !== 'sharp';
        const replace = new Map(picked.filter((i) => idx[i] !== undefined).map((i) => [idx[i], i]));
        const next = [];
        (n.edgeRounds || []).forEach((e, k) => { if (!replace.has(k)) next.push(e); else if (shape) next.push({ sig: d.sigs[replace.get(k)], r: a.size, t: a.style }); });
        if (shape) next.push(...picked.filter((i) => idx[i] === undefined).map((i) => ({ sig: d.sigs[i], r: a.size, t: a.style })));
        if (next.length) n.edgeRounds = next; else delete n.edgeRounds;
        editor.sync();
        getGeometry(n);
        const failed = shape ? geoStats.edgeRoundsFailed || 0 : 0;
        editor.commit();
        return { text: `${a.style === 'sharp' ? 'Sharpened' : a.style === 'round' ? 'Rounded' : 'Chamfered'} ${picked.length} edge${picked.length > 1 ? 's' : ''}${failed ? `; ${failed} could not be shaped (try a smaller size)` : ''}.`, data: describe(editor, n), images: lookIf(a, app, [n]) };
      },
    },
    {
      name: 'move_part', title: 'Move a face, edge or corner',
      description: 'Move part of an object, as in Face, Edge and Corner modes. A flat face moves in or out by distance (mm, out is positive) and its neighbours follow; an edge or corner moves by [dx, dy, dz]. The move stays editable; a move that would turn the shape inside out is refused.',
      inputSchema: obj({ id: { type: 'string' }, part: { type: 'string', enum: ['face', 'edge', 'corner'] }, pick: PICK, distance: num('Faces: mm out (+) or in (-)'), move: vec('Edges and corners: [dx, dy, dz] mm'), look: LOOK }, ['id', 'part', 'pick']),
      run: (a, { app, editor }) => {
        const n = writable(editor, a.id);
        const parts = editor.parts;
        const I = parts.info(n);
        if (!I) throw new ToolError('failed', `${label(n)} is too detailed to pick parts on`);
        const A = I.A;
        let kind, points;
        if (a.part === 'face') { kind = 'f'; points = A.faces.map((_, j) => I.toWorld(parts.faceShape(I, j).c)); }
        else if (a.part === 'corner') { kind = 'c'; points = A.corners.map((c) => I.toWorld(I.vert(c.v))); }
        else { kind = 'e'; points = A.chains.map((c) => { const p = c.ids.map((v) => I.vert(v)); return I.toWorld(p[0].clone().lerp(p[p.length - 1], 0.5)); }); }
        const items = pickIndices(points, a.pick, a.part + 's').map((j) => ({ j }));
        if (!items.length) throw new ToolError('not_found', nearMiss(points, a.part + 's'));
        if (kind === 'f' && typeof a.distance !== 'number') throw new ToolError('invalid_args', 'A face moves by distance (mm)');
        if (kind !== 'f' && !Array.isArray(a.move)) throw new ToolError('invalid_args', 'An edge or corner moves by move: [dx, dy, dz]');
        const t = { node: n, I, kind, items, edits: n.shapeEdits ? [...n.shapeEdits] : [] };
        const cur = parts.values(t);
        const vals = cur.map((v) => (kind === 'f' ? v + a.distance : v.clone().add(new THREE.Vector3().fromArray(a.move))));
        const before = (n.shapeEdits || []).length;
        const failedBefore = I.failed || 0;
        const keep = n.shapeEdits ? [...n.shapeEdits] : null;
        parts.applyEdits(n, parts.editsWith(t, vals));
        const st = nodeShapeEdits(n);
        if (st && st.failed > failedBefore) {
          if (keep) n.shapeEdits = keep; else delete n.shapeEdits;
          editor.sync();
          throw new ToolError('would_turn_inside_out', 'That move would turn the shape inside out, so it was not made. Try a smaller move.');
        }
        editor.commit();
        return { text: `Moved ${items.length} ${a.part}${items.length > 1 ? 's' : ''}.`, data: { ...describe(editor, n), moves_before: before }, images: lookIf(a, app, [n]) };
      },
    },
    {
      name: 'reset_moves', title: 'Reset part moves', destructive: true,
      description: 'Remove every face, edge and corner move from an object, and optionally its rounded and chamfered edges too.',
      inputSchema: obj({ id: { type: 'string' }, edges: { type: 'boolean', description: 'Also make every edge sharp' } }, ['id']),
      run: (a, { editor }) => {
        const n = writable(editor, a.id);
        delete n.shapeEdits;
        if (a.edges) { delete n.edgeRounds; n.round = 0; }
        editor.sync(); editor.commit();
        return { data: describe(editor, n) };
      },
    },
    {
      name: 'screenshot', title: 'Screenshot', readOnly: true,
      description: 'A picture of the 3D design from a named view or any angle (theta = degrees around Z from +X, phi = degrees down from straight above), framed on some objects or the whole design. The person\'s own view is not changed. For the slicer, use workspace: "slicer".',
      inputSchema: obj({ view: { type: 'string', enum: Object.keys(VIEWS) }, theta: num('Degrees around Z'), phi: num('Degrees from straight above'), ids: { type: 'array', items: { type: 'string' } }, size: { type: 'integer', minimum: 256, maximum: 1024, description: 'Width in pixels (default 768)' }, workspace: { type: 'string', enum: ['design', 'slicer'] }, layers: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: 'Slicer preview: first and last layer to show' } }),
      run: async (a, ctx) => {
        if (a.workspace === 'slicer') return ctx.tools.tools.get('slicer_screenshot').run(a, ctx);
        const nodes = a.ids && a.ids.length ? a.ids.map((id) => nodeOf(ctx.editor, id)) : null;
        return { images: [screenshotView(ctx.app, { view: a.view, theta: a.theta, phi: a.phi, nodes, size: a.size })] };
      },
    },
    {
      name: 'list_designs', title: 'List designs', readOnly: true,
      description: 'The designs in the library (id, name, last changed), newest first.',
      run: async (_a, { app }) => {
        const list = (await platform.listDesigns()).sort((p, q) => (q.modified || 0) - (p.modified || 0));
        return { data: { open: app.designId, designs: list.map((m) => ({ id: m.id, name: m.name, modified: m.modified ? new Date(m.modified).toISOString() : null, shapes: m.shapes })) } };
      },
    },
    {
      name: 'open_design', title: 'Open a design', design: false, ownHistory: true,
      description: 'Open another design from the library (the current one is saved first).',
      inputSchema: obj({ id: { type: 'string' } }, ['id']),
      run: async (a, { app }) => {
        await app.flushSave();
        if (!(await app.openDesign(a.id))) throw new ToolError('not_found', 'That design could not be opened. Call list_designs for the ids.');
        return { text: `Opened "${app.editor.doc.name}".` };
      },
    },
    {
      name: 'new_design', title: 'New design', design: false, ownHistory: true,
      description: 'Start a new, empty design (the current one is saved first).',
      inputSchema: obj({ name: { type: 'string' } }),
      run: async (a, { app }) => {
        await app.flushSave();
        if (!(await app.newDesign())) throw new ToolError('busy', 'The person kept the current design open');
        if (a.name) { app.editor.doc.name = a.name; app.nameInput.value = a.name; app._markDirty(); }
        return { text: `Started "${app.editor.doc.name}".`, data: { id: app.designId } };
      },
    },
    {
      name: 'save_design', title: 'Save', design: false, ownHistory: true,
      description: 'Save the open design now (designs also save automatically). Optionally rename it.',
      inputSchema: obj({ name: { type: 'string' } }),
      run: async (a, { app }) => {
        if (a.name) { app.editor.doc.name = a.name; app.nameInput.value = a.name; app._title && app._title(); }
        app._markDirty();
        await app.flushSave(true);
        return { text: `Saved "${app.editor.doc.name}".` };
      },
    },
    {
      name: 'export', title: 'Export', readOnly: true,
      description: 'Export the design (or some objects) as STL or 3MF, or the last sliced G-code (format "gcode"), returned as a file.',
      inputSchema: obj({ format: { type: 'string', enum: ['stl', '3mf', 'gcode'] }, ids: { type: 'array', items: { type: 'string' } } }, ['format']),
      run: async (a, ctx) => {
        if (a.format === 'gcode') return ctx.tools.tools.get('slicer_export_gcode').run(a, ctx);
        const { editor, app } = ctx;
        const nodes = a.ids && a.ids.length ? a.ids.map((id) => nodeOf(editor, id)) : null;
        const out = await withSelection(editor, nodes ? nodes.map((n) => n.id) : [...editor.selection], () => exportModel(editor, a.format, { selectedOnly: !!nodes }));
        const bytes = typeof out.data === 'string' ? new TextEncoder().encode(out.data) : new Uint8Array(out.data.buffer || out.data);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const name = `${app._fileBase()}.${out.extension}`;
        return { text: `${name}: ${Math.round(bytes.length / 1024)} KB`, resources: [{ uri: `dabblecad://export/${encodeURIComponent(name)}`, mimeType: a.format === 'stl' ? 'model/stl' : 'model/3mf', blob: btoa(bin) }] };
      },
    },
    {
      name: 'undo', title: 'Undo', design: false, ownHistory: true,
      description: 'Undo the last change (the person\'s or yours), or several.',
      inputSchema: obj({ steps: { type: 'integer', minimum: 1, maximum: 50 } }),
      run: (a, { editor }) => { for (let i = 0; i < (a.steps || 1); i++) editor.undo(); return { text: 'Undone.' }; },
    },
    {
      name: 'redo', title: 'Redo', design: false, ownHistory: true,
      description: 'Redo what was undone.',
      inputSchema: obj({ steps: { type: 'integer', minimum: 1, maximum: 50 } }),
      run: (a, { editor }) => { for (let i = 0; i < (a.steps || 1); i++) editor.redo(); return { text: 'Redone.' }; },
    },
  ];
}

export { describe };
