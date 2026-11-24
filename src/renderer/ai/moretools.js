// More AI tools for the 3D design: edges (round, chamfer), split, moving faces / edges / corners,
// the workplane and the view, lock / hide / transparent / multicolour, group modes, notes, and
// importing attached files or exporting the design. Same rules as tools.js: design units, on the
// current workplane, each edit one undo step, locked shapes refused.

import * as THREE from 'three';
import { nodeEdgeData, edgeRoundIndex, nodeShapeEdits, getGeometry } from '../core/geometry.js';
import { importFiles, EXPORT_FORMATS } from '../core/io.js';
import { kindName } from '../core/shapes.js';
import { ToolError, helpers } from './tools.js';

const { nodesFor, focus, out, inn, num, str, ids, vec, obj, nodeInfo, placeNodes } = helpers;
const one = (description = 'Id of one shape (from the design summary or list_nodes).') => ({ type: 'string', description });
const r3 = (v) => Math.round(v * 1000) / 1000;

/** A world point (mm) as design units on the current workplane. */
const pt = (ed, w) => { const p = w.clone().applyMatrix4(ed.frameInv); return { x: out(ed, p.x), y: out(ed, p.y), z: out(ed, p.z) }; };
/** A world direction as a unit vector on the current workplane. */
const dir = (ed, w) => { const v = w.clone().transformDirection(ed.frameInv); return { x: r3(v.x), y: r3(v.y), z: r3(v.z) }; };
const nodeWorld = (ed, node) => { const m = ed.meshes.get(node.id); if (m) { m.updateMatrixWorld(true); return m.matrixWorld; } return new THREE.Matrix4().fromArray(node.matrix); };

function topLevel(ed, node) {
  if (!ed.doc.nodes.includes(node)) throw new ToolError('Only top-level shapes and groups can be edited this way (ungroup first).');
}

// ------------------------------------------------------------------ edges
/** The node's edges in workplane coordinates (mm), with what they look like now. */
function edgeList(ed, node) {
  const d = nodeEdgeData(node);
  const idx = edgeRoundIndex(node);
  const W = nodeWorld(ed, node);
  return d.lines.map((pts, i) => {
    const P = pts.map((p) => p.clone().applyMatrix4(W).applyMatrix4(ed.frameInv));
    const ch = d.chains[i];
    let len = 0;
    for (let k = 1; k < P.length; k++) len += P[k].distanceTo(P[k - 1]);
    if (ch.closed && P.length > 2) len += P[0].distanceTo(P[P.length - 1]);
    const a = P[0], b = P[P.length - 1];
    const straight = !ch.closed && P.every((p) => { const t = b.clone().sub(a); const l = t.length(); if (l < 1e-9) return true; return p.clone().sub(a).cross(t).length() / l < 1e-3 * Math.max(1, l); });
    const zs = P.map((p) => p.z);
    const k = idx[i];
    const style = k === undefined ? { type: 'sharp' } : { type: node.edgeRounds[k].t === 'chamfer' ? 'chamfer' : 'round', size: out(ed, node.edgeRounds[k].r) };
    return { i, P, closed: !!ch.closed, convex: !!ch.convex, straight, len, zmin: Math.min(...zs), zmax: Math.max(...zs), style };
  });
}

function edgeView(ed, e) {
  const c = e.P.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(e.P.length);
  const o = { edge: e.i, length: out(ed, e.len), convex: e.convex, style: e.style };
  const u = (p) => ({ x: out(ed, p.x), y: out(ed, p.y), z: out(ed, p.z) });
  if (e.closed) { o.loop = true; o.centre = u(c); o.z = e.zmax - e.zmin < 1e-3 ? out(ed, e.zmin) : undefined; }
  else { o.from = u(e.P[0]); o.to = u(e.P[e.P.length - 1]); if (!e.straight) o.curved = true; }
  return o;
}

const EDGE_SETS = ['all', 'outside', 'inside', 'top', 'bottom', 'vertical', 'horizontal'];

function pickEdges(ed, node, list, which) {
  const b = ed.bounds([node]);
  const tol = Math.max(0.01, (b.max.z - b.min.z) * 1e-3);
  const test = {
    all: () => true,
    outside: (e) => e.convex,
    inside: (e) => !e.convex,
    top: (e) => e.zmin > b.max.z - tol,
    bottom: (e) => e.zmax < b.min.z + tol,
    horizontal: (e) => e.zmax - e.zmin < tol,
    vertical: (e) => e.straight && (() => { const t = e.P[e.P.length - 1].clone().sub(e.P[0]).normalize(); return Math.abs(t.z) > 0.999; })(),
  }[which];
  return list.filter(test).map((e) => e.i);
}

// ------------------------------------------------------------------ faces, edges and corners (shape edits)
function partsInfo(ed, node) {
  topLevel(ed, node);
  if (node.type !== 'shape' || !nodeShapeEdits(node)) throw new ToolError(`The faces and corners of "${node.name || kindName(node)}" can't be moved (only single shapes with flat faces; groups and imported meshes can't).`);
  const I = ed.parts.info(node);
  if (!I) throw new ToolError('That shape is not shown, so its parts can\'t be worked out.');
  return I;
}

function target(ed, node, I, kind, items) {
  const t = { node, I, kind, items, edits: node.shapeEdits ? [...node.shapeEdits] : [] };
  return t;
}

// ------------------------------------------------------------------ tools
export const MORE_TOOLS = [
  // ---- edges
  {
    name: 'list_edges', kind: 'read',
    description: 'The sharp edges of one shape or group, numbered, with where they are (workplane coordinates, design units), whether they are outside (convex) or inside edges, and their current style (sharp, round or chamfer with a size). Use the numbers with set_edges.',
    inputSchema: obj({ id: one(), limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['id']),
    run: ({ editor: ed }, i) => {
      const [node] = nodesFor(ed, i.id, { edit: false });
      topLevel(ed, node);
      const list = edgeList(ed, node);
      const lim = i.limit || 150;
      return { id: node.id, count: list.length, edges: list.slice(0, lim).map((e) => edgeView(ed, e)), ...(list.length > lim ? { note: `Only the first ${lim} are listed.` } : {}) };
    },
  },
  {
    name: 'set_edges',
    kind: 'edit',
    description: 'Round (fillet) or chamfer edges of a shape or group, or make them sharp again. Choose edges by number (from list_edges) or by set: all, outside (convex), inside, top (on the top of the shape), bottom, vertical, horizontal. size is the radius or chamfer size in design units. The shape stays editable; a size too big for the shape can fail (you are told).',
    inputSchema: obj({
      id: one(),
      edges: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, description: 'Edge numbers from list_edges.' },
      set: { type: 'string', enum: EDGE_SETS, description: 'A set of edges instead of numbers (edges and set together: both).' },
      style: { type: 'string', enum: ['round', 'chamfer', 'sharp'] },
      size: num('Radius or chamfer size, design units (not needed for sharp).', { minimum: 0 }),
    }, ['id', 'style']),
    summary: (i) => `${i.style === 'sharp' ? 'sharpen' : i.style} ${i.set ? i.set + ' ' : ''}edges`,
    run: async ({ editor: ed }, i) => {
      const [node] = nodesFor(ed, i.id);
      topLevel(ed, node);
      if (!i.edges && !i.set) throw new ToolError('Give edges (numbers from list_edges) or a set (e.g. "top" or "all").');
      if (i.style !== 'sharp' && !(i.size > 0)) throw new ToolError('Rounding or chamfering needs a size more than 0.');
      const list = edgeList(ed, node);
      if (!list.length) throw new ToolError('This shape has no sharp edges to shape.');
      const chosen = new Set();
      for (const n of i.edges || []) { if (n >= list.length) throw new ToolError(`There is no edge ${n}: the shape has ${list.length} (0 to ${list.length - 1}).`); chosen.add(n); }
      if (i.set) for (const n of pickEdges(ed, node, list, i.set)) chosen.add(n);
      if (!chosen.size) throw new ToolError(`No edges are in the "${i.set}" set on this shape. Use list_edges to see them.`);
      const res = await ed.setEdgeStyle(node, [...chosen], i.style, i.style === 'sharp' ? 0 : inn(ed, i.size));
      focus(ed, [node]);
      const r = { id: node.id, edges: [...chosen].sort((a, b) => a - b), style: i.style };
      const bb = ed.bounds([node]);
      const cap = Math.min(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) / 2 - 0.05;
      if (i.style !== 'sharp' && inn(ed, i.size) > cap) r.note = `That size is more than the shape allows, so it was made about ${out(ed, cap)} (half the shape's smallest side).`;
      if (res.count) r.warning = res.count >= res.added ? 'None of those edges could be shaped: try a smaller size.' : `${res.count} of the edges could not be shaped (too big for them).`;
      return r;
    },
  },
  {
    name: 'apply_edges',
    kind: 'edit',
    description: 'Bake a shape\'s rounded and chamfered edges into it, making it a plain mesh shape (its own settings can then no longer be changed; a group can no longer be ungrouped). Only needed before rounding edges that only exist after rounding, or when the user asks.',
    inputSchema: obj({ id: one() }, ['id']),
    summary: () => 'apply edges',
    run: async ({ editor: ed }, i) => {
      const [node] = nodesFor(ed, i.id);
      topLevel(ed, node);
      if (!ed.hasShapedEdges(node)) throw new ToolError('This shape has no rounded or chamfered edges to apply.');
      await ed.applyEdges(node);
      return nodeInfo(ed, ed.node(node.id));
    },
  },
  // ---- split
  {
    name: 'split',
    kind: 'edit',
    description: 'Cut shapes in two with a flat plane. Give the plane as axis + at (a plane square to the x, y or z axis at that coordinate, e.g. axis z, at 10 cuts horizontally 10 up), or as point + normal for a tilted plane. Each cut shape becomes two groups ("part 1" on the normal\'s side and "part 2"), each the original with a hole box, so ungrouping a piece gives the original back. Shapes the plane misses are left alone.',
    inputSchema: obj({
      ids: ids(),
      axis: { type: 'string', enum: ['x', 'y', 'z'] },
      at: num('Where the plane crosses that axis, design units.'),
      point: vec('A point on the plane, design units.'),
      normal: vec('The plane\'s direction (it need not be unit length).'),
    }, ['ids']),
    summary: (i) => `split ${i.ids.length === 1 ? 'shape' : i.ids.length + ' shapes'}`,
    run: async ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids);
      nodes.forEach((n) => topLevel(ed, n));
      let n, p;
      if (i.axis) {
        if (i.at == null) throw new ToolError('With axis, give at (the coordinate to cut at).');
        n = new THREE.Vector3(i.axis === 'x' ? 1 : 0, i.axis === 'y' ? 1 : 0, i.axis === 'z' ? 1 : 0);
        p = new THREE.Vector3(); p[i.axis] = inn(ed, i.at);
      } else if (i.point && i.normal) {
        n = new THREE.Vector3(i.normal.x || 0, i.normal.y || 0, i.normal.z || 0);
        if (n.lengthSq() < 1e-12) throw new ToolError('normal must not be zero.');
        n.normalize();
        p = new THREE.Vector3(inn(ed, i.point.x || 0), inn(ed, i.point.y || 0), inn(ed, i.point.z || 0));
      } else throw new ToolError('Give axis and at, or point and normal.');
      focus(ed, nodes);
      if (!ed._startSplit()) throw new ToolError('Those shapes can\'t be split.');
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      ed.setSplit({ q, offset: p.clone().sub(ed.split.c).dot(n) });
      if (!ed.splitTargets().length) { ed.split = null; throw new ToolError('The plane doesn\'t pass through any of those shapes.'); }
      await ed.applySplit();
      return { pieces: ed.selectedNodes().map((x) => nodeInfo(ed, x)) };
    },
  },
  // ---- faces, edges, corners
  {
    name: 'list_parts',
    kind: 'read',
    description: 'The flat faces or the corners of one shape, numbered, for move_parts: each face with its centre and outward direction, each corner with its position (workplane coordinates, design units), and how far it has been moved already. (For edges, use list_edges: the same numbers work in move_parts.)',
    inputSchema: obj({ id: one(), kind: { type: 'string', enum: ['faces', 'corners'] } }, ['id', 'kind']),
    run: ({ editor: ed }, i) => {
      const [node] = nodesFor(ed, i.id, { edit: false });
      const I = partsInfo(ed, node);
      if (i.kind === 'faces') {
        const items = I.A.faces.map((_, j) => ({ j }));
        const moved = ed.parts.values(target(ed, node, I, 'f', items));
        return { id: node.id, faces: items.slice(0, 200).map(({ j }, k) => { const fs = ed.parts.faceShape(I, j); return { face: j, centre: pt(ed, I.toWorld(fs.c)), outward: dir(ed, I.normalToWorld(fs.n)), moved: out(ed, moved[k]) }; }) };
      }
      const items = I.A.corners.map((_, j) => ({ j }));
      const moved = ed.parts.values(target(ed, node, I, 'c', items));
      return { id: node.id, corners: items.slice(0, 300).map(({ j }, k) => ({ corner: j, at: pt(ed, I.toWorld(I.vert(I.A.corners[j].v))), moved: { x: out(ed, moved[k].x), y: out(ed, moved[k].y), z: out(ed, moved[k].z) } })) };
    },
  },
  {
    name: 'move_parts',
    kind: 'edit',
    description: 'Reshape one shape by moving some of its faces, edges or corners, as the Face / Edge / Corner modes do (the shape keeps its own settings). faces: by is a distance along each face\'s outward direction (negative pulls it in), e.g. to taper or lengthen one side. edges and corners: by is { x, y, z } on the workplane. Numbers come from list_parts (faces, corners) or list_edges (edges). reset: true puts the given parts (or, with no parts given, the whole shape) back.',
    inputSchema: obj({
      id: one(),
      kind: { type: 'string', enum: ['faces', 'edges', 'corners'] },
      parts: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1 },
      by: { anyOf: [{ type: 'number' }, vec('Move on the workplane, design units.')], description: 'faces: a distance; edges / corners: { x, y, z }.' },
      reset: { type: 'boolean' },
    }, ['id', 'kind']),
    summary: (i) => (i.reset ? `reset ${i.kind}` : `move ${i.parts ? i.parts.length : ''} ${i.kind}`.replace('  ', ' ')),
    run: ({ editor: ed }, i) => {
      const [node] = nodesFor(ed, i.id);
      const I = partsInfo(ed, node);
      if (i.reset && !i.parts) { ed.parts.resetAll(node); focus(ed, [node]); return nodeInfo(ed, node, { detail: true }); }
      if (!i.parts) throw new ToolError('Give parts (numbers from list_parts or list_edges).');
      const kind = i.kind === 'faces' ? 'f' : i.kind === 'edges' ? 'e' : 'c';
      let items;
      if (kind === 'e') {
        const d = nodeEdgeData(node);
        const base = ed.parts.baseChains(node, I, d);
        items = i.parts.map((n) => {
          if (n >= d.chains.length) throw new ToolError(`There is no edge ${n}.`);
          if (base[n] === undefined) throw new ToolError(`Edge ${n} can't be moved (it isn't an edge of the shape itself, e.g. one made by rounding).`);
          return { j: base[n] };
        });
      } else {
        const max = kind === 'f' ? I.A.faces.length : I.A.corners.length;
        items = i.parts.map((n) => { if (n >= max) throw new ToolError(`There is no ${kind === 'f' ? 'face' : 'corner'} ${n} (0 to ${max - 1}).`); return { j: n }; });
      }
      const t = target(ed, node, I, kind, items);
      let vals;
      if (i.reset) vals = items.map(() => (kind === 'f' ? 0 : new THREE.Vector3()));
      else {
        if (i.by == null) throw new ToolError('Give by (how far to move them).');
        const cur = ed.parts.values(t);
        if (kind === 'f') {
          if (typeof i.by !== 'number') throw new ToolError('For faces, by is one number: the distance along the face\'s outward direction.');
          vals = cur.map((v) => v + inn(ed, i.by));
        } else {
          if (typeof i.by !== 'object') throw new ToolError('For edges and corners, by is { x, y, z }.');
          const d = new THREE.Vector3(inn(ed, i.by.x || 0), inn(ed, i.by.y || 0), inn(ed, i.by.z || 0));
          vals = cur.map((v) => v.clone().add(d));
        }
      }
      ed.parts.commitEdits(node, ed.parts.editsWith(t, vals));
      focus(ed, [node]);
      const st = nodeShapeEdits(node);
      const r = nodeInfo(ed, node, { detail: true });
      if (st && st.failed) r.warning = `${st.failed} move${st.failed > 1 ? 's' : ''} could not be made: it would turn the shape inside out.`;
      return r;
    },
  },
  // ---- workplane and view
  {
    name: 'set_workplane',
    kind: 'ui',
    description: 'Change the workplane that coordinates are measured on (and new shapes sit on). main: the normal workplane. on_top: a temporary workplane on top of the given shapes. on_face: a temporary workplane on one flat face of a shape (face number from list_parts), so you can build on a side or a slope. After this, every coordinate you read or write is on the new workplane until it is changed back. Not an undo step.',
    inputSchema: obj({ to: { type: 'string', enum: ['main', 'on_top', 'on_face'] }, ids: ids('on_top: the shapes.'), id: one('on_face: the shape.'), face: { type: 'integer', minimum: 0 } }, ['to']),
    run: ({ editor: ed }, i) => {
      if (i.to === 'main') ed.setFrame(null);
      else if (i.to === 'on_top') {
        if (!i.ids) throw new ToolError('on_top needs ids.');
        focus(ed, nodesFor(ed, i.ids, { edit: false }));
        ed.workplaneAtSelection();
      } else {
        if (!i.id || i.face == null) throw new ToolError('on_face needs id and face.');
        const [node] = nodesFor(ed, i.id, { edit: false });
        const I = partsInfo(ed, node);
        if (i.face >= I.A.faces.length) throw new ToolError(`There is no face ${i.face}.`);
        const fs = ed.parts.faceShape(I, i.face);
        ed.setFrame(ed._faceFrame({ point: I.toWorld(fs.c), normal: I.normalToWorld(fs.n) }));
      }
      return { workplane: ed.hasFrame ? 'temporary' : 'main', note: ed.hasFrame ? 'Coordinates are now on this workplane: x, y along it, z out of it.' : 'Back on the main workplane.' };
    },
  },
  {
    name: 'set_workplane_size',
    kind: 'ui',
    description: 'Change the size of the main workplane (the grid), in design units, or the design\'s units (mm, in, brick). Changing units changes how every number you read and write is measured. Not an undo step.',
    inputSchema: obj({ width: num('Width, design units.', { minimum: 1 }), length: num('Length (front to back), design units.', { minimum: 1 }), units: { type: 'string', enum: ['mm', 'in', 'brick'] } }),
    run: ({ editor: ed }, i) => {
      const patch = {};
      if (i.width) patch.width = inn(ed, i.width);
      if (i.length) patch.length = inn(ed, i.length);
      if (i.units) patch.units = i.units;
      if (!Object.keys(patch).length) throw new ToolError('Give width, length or units.');
      ed.setWorkplane(patch);
      return { width: out(ed, ed.doc.workplane.width), length: out(ed, ed.doc.workplane.length), units: ed.units };
    },
  },
  {
    name: 'set_view',
    kind: 'ui',
    description: 'Move the camera so the user can see something: fit (zoom to the given shapes, or the whole design with no ids), or look from a side: top, bottom, front, back, left, right, or iso (a 3D view from the front-right).',
    inputSchema: obj({ view: { type: 'string', enum: ['fit', 'top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] }, ids: { type: 'array', items: { type: 'string' } } }, ['view']),
    run: ({ editor: ed }, i) => {
      const D = Math.PI / 180;
      const views = { top: [-90 * D, 0], bottom: [-90 * D, Math.PI], front: [-90 * D, 90 * D], back: [90 * D, 90 * D], right: [0, 90 * D], left: [180 * D, 90 * D], iso: [-55 * D, 58 * D] };
      if (i.view === 'fit') {
        if (i.ids && i.ids.length) focus(ed, nodesFor(ed, i.ids, { edit: false }));
        else ed.clearSelection();
        ed.fitView();
      } else ed.viewport.viewFrom(...views[i.view]);
      return { view: i.view };
    },
  },
  // ---- lock, hide, transparent, multicolour, group mode
  {
    name: 'set_flags',
    kind: 'edit',
    description: 'Lock shapes (so nothing moves them by accident), hide or show them, make them see-through (transparent), or let a group show its parts\' own colours (multicolor). You can lock shapes but not unlock them: only the user can unlock.',
    inputSchema: obj({ ids: ids(), locked: { type: 'boolean', enum: [true] }, hidden: { type: 'boolean' }, transparent: { type: 'boolean' }, multicolor: { type: 'boolean' } }, ['ids']),
    summary: (i) => Object.entries(i).filter(([k]) => k !== 'ids').map(([k, v]) => (k === 'hidden' ? (v ? 'hide' : 'show') : k === 'locked' ? 'lock' : `${v ? '' : 'not '}${k}`)).join(', ') || 'flags',
    run: ({ editor: ed }, i) => {
      if (i.locked == null && i.hidden == null && i.transparent == null && i.multicolor == null) throw new ToolError('Give locked, hidden, transparent or multicolor.');
      // hiding or showing a locked shape is fine; changing how it looks is not
      const nodes = nodesFor(ed, i.ids, { edit: i.transparent != null || i.multicolor != null });
      if (i.multicolor != null && nodes.some((n) => n.type !== 'group')) throw new ToolError('multicolor is only for groups.');
      for (const n of nodes) {
        if (i.locked) n.locked = true;
        if (i.hidden != null) n.hidden = i.hidden;
        if (i.transparent != null) n.transparent = i.transparent;
        if (i.multicolor != null) n.multicolor = i.multicolor;
      }
      ed.selection = new Set(nodes.filter((n) => !n.hidden).map((n) => n.id));
      ed.sync();
      ed.commit();
      ed.emit('selection');
      return nodes.map((n) => nodeInfo(ed, n));
    },
  },
  {
    name: 'set_group_mode',
    kind: 'edit',
    description: 'Change how an existing group combines its parts: union (holes cut the solids), intersect (only where all overlap), bundle (kept together, not combined).',
    inputSchema: obj({ id: one('The group.'), mode: { type: 'string', enum: ['union', 'intersect', 'bundle'] } }, ['id', 'mode']),
    summary: (i) => `group mode ${i.mode}`,
    run: async ({ editor: ed }, i) => {
      const [g] = nodesFor(ed, i.id);
      if (g.type !== 'group') throw new ToolError('That isn\'t a group.');
      g.mode = i.mode;
      await ed._busy(() => getGeometry(g));
      ed.sync();
      ed.commit();
      focus(ed, [g]);
      const empty = !getGeometry(g).attributes.position.count;
      return { ...nodeInfo(ed, g), ...(empty ? { warning: 'The result is empty.' } : {}) };
    },
  },
  // ---- notes
  {
    name: 'list_notes', kind: 'read',
    description: 'The notes pinned in the design: id, text and position (workplane coordinates, design units).',
    inputSchema: obj({}),
    run: ({ editor: ed }) => ed.doc.notes.map((n) => ({ id: n.id, text: n.text, at: pt(ed, new THREE.Vector3().fromArray(n.pos)) })),
  },
  {
    name: 'note',
    kind: 'edit',
    description: 'Add, change or remove a note pinned in the design (a label the user sees in 3D). add: text and at (a point, design units). edit: id and text. remove: id.',
    inputSchema: obj({ action: { type: 'string', enum: ['add', 'edit', 'remove'] }, id: str('The note (edit, remove).'), text: str('The note text.', { minLength: 1, maxLength: 1000 }), at: vec('Where to pin it (add).') }, ['action']),
    summary: (i) => `${i.action} note`,
    run: ({ editor: ed }, i) => {
      if (i.action === 'add') {
        if (!i.text || !i.at) throw new ToolError('add needs text and at.');
        const w = new THREE.Vector3(inn(ed, i.at.x || 0), inn(ed, i.at.y || 0), inn(ed, i.at.z || 0)).applyMatrix4(ed.frame);
        ed.addNote(w, i.text);
        const n = ed.doc.notes[ed.doc.notes.length - 1];
        return { id: n.id, text: n.text };
      }
      const n = ed.doc.notes.find((x) => x.id === i.id);
      if (!n) throw new ToolError(`There's no note "${i.id}". Use list_notes.`);
      if (i.action === 'edit') { if (!i.text) throw new ToolError('edit needs text.'); ed.updateNote(n.id, i.text); return { id: n.id, text: i.text }; }
      ed.removeNote(n.id);
      return { removed: n.id };
    },
  },
  // ---- import and export
  {
    name: 'list_attachments', kind: 'read',
    description: 'Files the user has attached to the chat for importing (3D models, SVG, images, .dabble designs), with their names and sizes.',
    inputSchema: obj({}),
    run: (ctx) => (ctx.attachments ? ctx.attachments() : []).map((f) => ({ name: f.name, size_kb: Math.round(f.data.byteLength / 102.4) / 10 })),
  },
  {
    name: 'import_file',
    kind: 'edit',
    description: 'Import a file the user attached to the chat (STL, OBJ, 3MF, PLY, GLB, SVG, PNG/JPG or a .dabble design) into the design. Models too big for the workplane are scaled down to fit. Optionally place it (footprint middle x, y and bottom z) or size it (keeps proportions, by its largest side). The new shapes are selected.',
    inputSchema: obj({ name: str('The attachment\'s file name.'), position: vec('Where to put it, design units (optional).'), largest_side: num('Scale so its largest side is this long, design units (optional).', { minimum: 0.01 }) }, ['name']),
    summary: (i) => `import ${i.name}`,
    run: async (ctx, i) => {
      const ed = ctx.editor;
      const files = ctx.attachments ? ctx.attachments() : [];
      const f = files.find((x) => x.name === i.name) || files.find((x) => x.name.toLowerCase() === String(i.name).toLowerCase());
      if (!f) throw new ToolError(files.length ? `No attachment called "${i.name}". Attached: ${files.map((x) => x.name).join(', ')}.` : 'No files are attached to the chat. Ask the user to attach one with the paperclip button.');
      const res = await ed._busy(() => importFiles([{ name: f.name, data: f.data }], { fitTo: Math.max(ed.doc.workplane.width, ed.doc.workplane.length) }));
      if (!res.nodes.length) throw new ToolError(res.messages.join(' ') || 'Nothing could be imported from that file.');
      const c = ed.viewCenterPoint();
      const fromDesign = /\.dabble$/i.test(f.name);
      for (const n of res.nodes) { if (!fromDesign) ed.placeAt(n, c.x, c.y); ed.addNode(n, { select: false, commit: false }); }
      ed.selection = new Set(res.nodes.map((n) => n.id));
      ed.sync();
      const nodes = ed.selectedNodes();
      if (i.largest_side) {
        const b = ed.bounds(nodes);
        const s = b.getSize(new THREE.Vector3());
        const big = ['x', 'y', 'z'].reduce((a, k) => (s[k] > s[a] ? k : a), 'x');
        ed.setSize(big, inn(ed, i.largest_side), true);
      }
      if (i.position) placeNodes(ed, nodes, i.position);
      else if (!fromDesign) { focus(ed, nodes); ed.dropToWorkplane && ed.dropToWorkplane(); }
      ed.commit();
      ed.emit('selection');
      return { imported: ed.selectedNodes().map((n) => nodeInfo(ed, n)), ...(res.messages.length ? { notes: res.messages } : {}) };
    },
  },
  {
    name: 'export_design',
    kind: 'ui',
    description: `Export the design (or only the given shapes) as a file for 3D printing or sharing. The user chooses where it goes (a save dialog, or a download in the browser). Formats: ${EXPORT_FORMATS.map((f) => `${f.id} (${f.hint})`).join('; ')}.`,
    inputSchema: obj({ format: { type: 'string', enum: EXPORT_FORMATS.map((f) => f.id) }, ids: { type: 'array', items: { type: 'string' }, description: 'Only these shapes (optional).' } }, ['format']),
    run: async (ctx, i) => {
      const ed = ctx.editor;
      if (!ctx.app) throw new ToolError('Exporting isn\'t available here.');
      const only = !!(i.ids && i.ids.length);
      if (only) focus(ed, nodesFor(ed, i.ids, { edit: false }));
      const path = await ctx.app.exportAs(i.format, only);
      return path ? { exported: path } : { exported: false, note: 'The user cancelled, or the export failed (a message was shown).' };
    },
  },
];
