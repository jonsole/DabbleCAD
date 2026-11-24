// Agent tools for the in-app AI chat: what the chat model may read and change in a 3D design.
//
// Every tool is { name, description, inputSchema, kind: 'read' | 'edit', run(ctx, input) }.
// Edit tools work through the Editor's own commands (so snapping, locks, outlines and undo behave
// exactly as for the user) and the chat wraps each call in one undo step labelled "AI: …".
// Nothing here touches the DOM, so the same tools could later be served over MCP.
//
// Coordinates and sizes are in the design's units (mm, inches or bricks of 8 mm) on the current
// workplane: x to the right, y away from the viewer, z up. A shape's "position" is the middle of
// its footprint (x, y) and its bottom (z).

import * as THREE from 'three';
import { CATALOG, CATEGORIES, KINDS, kindName, nodeFromCatalog } from '../core/shapes.js';
import { getGeometry } from '../core/geometry.js';
import { checkSchema } from './schema.js';

export class ToolError extends Error {}

// ------------------------------------------------------------------ units and geometry helpers
const UNIT = { mm: 1, in: 25.4, brick: 8 };
const unitName = { mm: 'mm', in: 'inches', brick: 'bricks (8 mm)' };
const factor = (ed) => UNIT[ed.units] || 1;
const out = (ed, mm) => Math.round((mm / factor(ed)) * 1000) / 1000;       // mm -> design units
const inn = (ed, v) => v * factor(ed);                                    // design units -> mm

function box(ed, nodes) {
  const b = ed.bounds(nodes);
  if (b.isEmpty()) return null;
  return {
    min: [out(ed, b.min.x), out(ed, b.min.y), out(ed, b.min.z)],
    max: [out(ed, b.max.x), out(ed, b.max.y), out(ed, b.max.z)],
    size: [out(ed, b.max.x - b.min.x), out(ed, b.max.y - b.min.y), out(ed, b.max.z - b.min.z)],
  };
}

function nodeInfo(ed, n, { detail = false } = {}) {
  const info = {
    id: n.id,
    name: n.name || kindName(n),
    kind: n.type === 'group' ? `group:${n.mode || 'union'}` : n.kind,
    color: n.color,
    hole: !!n.hole,
  };
  if (n.locked) info.locked = true;
  if (n.hidden) info.hidden = true;
  const b = box(ed, [n]);
  if (b) info.bounds = { min: b.min, max: b.max };
  if (detail) {
    if (b) info.size = b.size;
    if (n.type === 'shape') info.params = { ...n.params };
    if (n.type === 'group') info.children = n.children.map((c) => ({ id: c.id, name: c.name || kindName(c), kind: c.type === 'group' ? 'group' : c.kind, hole: !!c.hole }));
    info.matrix = n.matrix.map((v) => Math.round(v * 1e5) / 1e5);
  }
  return info;
}

/** The nodes named by ids: every id must exist; for edits none may be locked. */
function nodesFor(ed, ids, { edit = true } = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) throw new ToolError('No ids given.');
  return list.map((id) => {
    const n = ed.node(id);
    if (!n) throw new ToolError(`There's no shape with id "${id}". Use list_nodes to see the ids.`);
    if (edit && n.locked) throw new ToolError(`"${n.name || kindName(n)}" (${id}) is locked; the user has to unlock it first.`);
    return n;
  });
}

/** Select exactly these ids (Editor commands act on the selection). */
const focus = (ed, nodes) => ed.select(nodes.map((n) => n.id));

/** Shape parameters checked against the kind's own ranges and options. */
function checkParams(kind, params) {
  const defs = (KINDS[kind] && KINDS[kind].params) || [];
  const clean = {};
  for (const [k, v] of Object.entries(params || {})) {
    const d = defs.find((p) => p.key === k);
    if (!d) throw new ToolError(`A ${KINDS[kind] ? KINDS[kind].name : kind} has no "${k}" setting. It has: ${defs.map((p) => p.key).join(', ') || 'none'}.`);
    if (d.type === 'range') {
      if (typeof v !== 'number' || !isFinite(v)) throw new ToolError(`"${k}" should be a number.`);
      if (v < d.min || v > d.max) throw new ToolError(`"${k}" should be between ${d.min} and ${d.max} (got ${v}).`);
    } else if (d.type === 'select') {
      if (!d.options.includes(v)) throw new ToolError(`"${k}" should be one of ${d.options.join(', ')}.`);
    } else if (typeof v !== 'string') throw new ToolError(`"${k}" should be text.`);
    clean[k] = v;
  }
  return clean;
}

function paramList(kind) {
  return ((KINDS[kind] && KINDS[kind].params) || []).map((p) => (p.type === 'range'
    ? { key: p.key, label: p.label, min: p.min, max: p.max, default: p.def }
    : p.type === 'select' ? { key: p.key, label: p.label, options: p.options, default: p.def } : { key: p.key, label: p.label, type: 'text', default: p.def }));
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const AX = ['x', 'y', 'z'];

/** Move nodes so their footprint middle is at x, y and their bottom at z (design units; each optional). */
function placeNodes(ed, nodes, pos) {
  const b = ed.bounds(nodes);
  if (b.isEmpty()) return;
  const cur = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.min.z };
  focus(ed, nodes);
  for (const a of AX) if (pos[a] != null) ed.setPosition(a, b.min[a] + inn(ed, pos[a]) - cur[a]);
}

function sizeNodes(ed, nodes, size, uniform) {
  focus(ed, nodes);
  for (const a of AX) {
    if (size[a] == null) continue;
    if (!(size[a] > 0)) throw new ToolError(`size.${a} should be more than 0.`);
    const b = ed.bounds(nodes);
    if (b.max[a] - b.min[a] < 1e-6) throw new ToolError(`It has no ${a} size to scale (it's flat along ${a}).`);
    ed.setSize(a, inn(ed, size[a]), !!uniform);
    if (uniform) break;
  }
}

// ------------------------------------------------------------------ schema pieces
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const ids = (description = 'Ids of the shapes or groups (from the design summary or list_nodes).') => ({ type: 'array', items: { type: 'string' }, minItems: 1, description });
const vec = (description, extra = {}) => ({ type: 'object', additionalProperties: false, description, properties: { x: num('x'), y: num('y'), z: num('z') }, ...extra });
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });

// ------------------------------------------------------------------ design summary
/** The compact design summary sent with each chat turn (about 200 nodes at most). */
export function designSummary(ctx, { limit = 200 } = {}) {
  const ed = ctx.editor;
  const nodes = ed.doc.nodes;
  const s = {
    design: ed.doc.name || 'Untitled',
    workspace: ctx.workspace ? ctx.workspace() : '3d',
    units: unitName[ed.units] || ed.units,
    up: 'z',
    workplane: ed.hasFrame
      ? { temporary: true, note: 'A temporary workplane is active: coordinates are on it (x, y along it, z out of it).', matrix: ed.frame.toArray().map((v) => Math.round(v * 1e4) / 1e4) }
      : { temporary: false, size: [out(ed, ed.doc.workplane.width), out(ed, ed.doc.workplane.length)], snap: ed.snap > 0 ? out(ed, ed.snap) : 0 },
    count: nodes.length,
    nodes: nodes.slice(0, limit).map((n) => nodeInfo(ed, n)),
    selection: [...ed.selection],
  };
  if (nodes.length > limit) s.note = `Only the first ${limit} of ${nodes.length} shapes are listed: use list_nodes for the rest.`;
  return s;
}

// ------------------------------------------------------------------ the tools
export const TOOLS = [
  {
    name: 'get_design_summary', kind: 'read',
    description: 'The open design: name, units, workplane, every top-level shape (id, name, kind, colour, hole, locked, hidden, bounding box) and the selection.',
    inputSchema: obj({}),
    run: (ctx) => designSummary(ctx),
  },
  {
    name: 'list_nodes', kind: 'read',
    description: 'List top-level shapes and groups, optionally only those whose name or kind contains the filter text, or only holes / only solids.',
    inputSchema: obj({ filter: str('Text to look for in the name or kind (optional).'), holes: { type: 'boolean', description: 'true: only holes; false: only solids (optional).' } }),
    run: ({ editor: ed }, { filter, holes }) => {
      const f = (filter || '').toLowerCase();
      return ed.doc.nodes
        .filter((n) => !f || (n.name || '').toLowerCase().includes(f) || kindName(n).toLowerCase().includes(f) || String(n.kind || n.mode || '').includes(f))
        .filter((n) => holes == null || !!n.hole === holes)
        .map((n) => nodeInfo(ed, n));
    },
  },
  {
    name: 'get_node', kind: 'read',
    description: 'Everything about one shape or group: parameters, size, bounding box, 4x4 matrix (column-major, mm) and, for groups, its children.',
    inputSchema: obj({ id: str('The shape or group id.') }, ['id']),
    run: ({ editor: ed }, { id }) => nodeInfo(ed, nodesFor(ed, id, { edit: false })[0], { detail: true }),
  },
  {
    name: 'list_shape_catalog', kind: 'read',
    description: 'Shapes that add_shape can make: catalog ids, names, categories and their settings (with ranges and defaults). Filter by category id or by a word in the name.',
    inputSchema: obj({ category: str(`Category id (optional): ${CATEGORIES.filter((c) => c.id !== 'all' && c.id !== 'mine').map((c) => c.id).join(', ')}.`), query: str('A word to look for in the shape name (optional).') }),
    run: (ctx, { category, query }) => {
      const q = (query || '').toLowerCase();
      const list = CATALOG.filter((e) => (!category || e.cat === category) && (!q || e.name.toLowerCase().includes(q) || e.id.includes(q)));
      return list.slice(0, 80).map((e) => ({
        catalogId: e.id, name: e.name, category: e.cat, hole: !!e.hole,
        settings: e.starter ? 'a ready-made group' : paramList(e.kind),
        presets: Object.keys(e.params || {}).length && !e.starter ? e.params : undefined,
      })).concat(list.length > 80 ? [{ note: `${list.length - 80} more: narrow the search.` }] : []);
    },
  },
  {
    name: 'measure', kind: 'read',
    description: 'Size of one shape, or the gaps and distance between two (gap per axis: negative means they overlap on that axis).',
    inputSchema: obj({ idA: str('First shape id.'), idB: str('Second shape id (optional).') }, ['idA']),
    run: ({ editor: ed }, { idA, idB }) => {
      const [a] = nodesFor(ed, idA, { edit: false });
      const ba = box(ed, [a]);
      if (!idB) return { id: idA, ...ba };
      const [b] = nodesFor(ed, idB, { edit: false });
      const bb = box(ed, [b]);
      const gap = AX.map((_, i) => Math.round(Math.max(bb.min[i] - ba.max[i], ba.min[i] - bb.max[i]) * 1000) / 1000);
      const ca = ba.min.map((v, i) => (v + ba.max[i]) / 2), cb = bb.min.map((v, i) => (v + bb.max[i]) / 2);
      return { a: { id: idA, ...ba }, b: { id: idB, ...bb }, gap: { x: gap[0], y: gap[1], z: gap[2] }, centreDistance: Math.round(Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) * 1000) / 1000 };
    },
  },

  // ---------------------------------------------------------------- edits
  {
    name: 'add_shape', kind: 'edit',
    description: 'Add a shape from the catalog (see list_shape_catalog). Optional: settings, size (bounding box), position (middle of the footprint in x and y, bottom in z), rotation in degrees about x then y then z, colour, hole, name. It is left selected.',
    inputSchema: obj({
      catalogId: str('Catalog id, e.g. "box", "cylinder", "box-hole", "sphere".'),
      params: { type: 'object', description: 'Shape settings to change, e.g. {"radius": 2} for a box (see list_shape_catalog).', additionalProperties: { type: ['number', 'string'] } },
      size: vec('Bounding-box size in design units; give any of x, y, z.'),
      position: vec('x, y: the middle of its footprint; z: its bottom (design units). Default: the middle of the workplane, standing on it.'),
      rotation: vec('Degrees about x, then y, then z, turned about its middle.'),
      color: str('Colour as #rrggbb (optional).'),
      hole: { type: 'boolean', description: 'true makes it a hole (it cuts the shapes it is grouped with).' },
      name: str('A name (optional).'),
    }, ['catalogId']),
    summary: (i) => `add ${i.name || i.catalogId}`,
    run: ({ editor: ed }, i) => {
      const entry = CATALOG.find((e) => e.id === i.catalogId);
      if (!entry) throw new ToolError(`There's no catalog shape "${i.catalogId}". Use list_shape_catalog.`);
      if (i.params && entry.starter) throw new ToolError(`"${entry.name}" is a ready-made group: it has no settings.`);
      const params = i.params ? checkParams(entry.kind, i.params) : null;
      if (i.color != null && !COLOR.test(i.color)) throw new ToolError('color should look like #ff8800.');
      const node = nodeFromCatalog(entry);
      if (params) node.params = { ...node.params, ...params };
      if (i.name) node.name = i.name;
      if (i.color) node.color = i.color;
      if (i.hole != null) node.hole = !!i.hole;
      ed.placeAt(node, 0, 0);
      ed.addNode(node);
      if (i.size) sizeNodes(ed, [node], i.size, false);
      if (i.rotation) for (const a of AX) if (i.rotation[a]) { focus(ed, [node]); ed.rotateSelection(a, i.rotation[a]); }
      if (i.rotation || i.size) { focus(ed, [node]); ed.dropToWorkplane(); }
      placeNodes(ed, [node], { x: 0, y: 0, z: 0, ...(i.position || {}) });
      focus(ed, [node]);
      return { added: nodeInfo(ed, node) };
    },
  },
  {
    name: 'set_params', kind: 'edit',
    description: "Change a shape's own settings (e.g. radius, sides, text). Only plain shapes have them, not groups.",
    inputSchema: obj({ id: str('Shape id.'), params: { type: 'object', description: 'Settings to change.', additionalProperties: { type: ['number', 'string'] } } }, ['id', 'params']),
    summary: (i) => `change ${Object.keys(i.params || {}).join(', ')}`,
    run: ({ editor: ed }, { id, params }) => {
      const [n] = nodesFor(ed, id);
      if (n.type !== 'shape') throw new ToolError('Groups have no settings: change the shapes inside, or ungroup.');
      const clean = checkParams(n.kind, params);
      for (const [k, v] of Object.entries(clean)) ed.setParam(k, v, true, [n.id]);
      focus(ed, [n]);
      return nodeInfo(ed, n, { detail: true });
    },
  },
  {
    name: 'set_size', kind: 'edit',
    description: 'Resize shapes (together, as one bounding box) to an exact size in design units. Give any of x, y, z; uniform scales all three keeping proportions (from the first axis given). The bottom-left-front corner stays put.',
    inputSchema: obj({ ids: ids(), x: num('Size along x (optional).'), y: num('Size along y (optional).'), z: num('Size along z (optional).'), uniform: { type: 'boolean', description: 'Keep proportions.' } }, ['ids']),
    summary: (i) => `resize ${AX.filter((a) => i[a] != null).map((a) => `${a}=${i[a]}`).join(' ')}`,
    run: ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids);
      if (AX.every((a) => i[a] == null)) throw new ToolError('Give at least one of x, y, z.');
      sizeNodes(ed, nodes, i, i.uniform);
      return box(ed, nodes);
    },
  },
  {
    name: 'set_position', kind: 'edit',
    description: 'Move shapes (together) so the middle of their footprint is at x, y and their bottom at z (design units). Give any of x, y, z.',
    inputSchema: obj({ ids: ids(), x: num('Footprint middle x (optional).'), y: num('Footprint middle y (optional).'), z: num('Bottom z (optional).') }, ['ids']),
    summary: (i) => `move to ${AX.filter((a) => i[a] != null).map((a) => `${a}=${i[a]}`).join(' ')}`,
    run: ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids);
      if (AX.every((a) => i[a] == null)) throw new ToolError('Give at least one of x, y, z.');
      placeNodes(ed, nodes, i);
      return box(ed, nodes);
    },
  },
  {
    name: 'rotate', kind: 'edit',
    description: 'Turn shapes (together) about their middle by a number of degrees about the x, y or z axis (positive: anticlockwise looking down the axis).',
    inputSchema: obj({ ids: ids(), axis: { type: 'string', enum: AX }, degrees: num('Degrees.') }, ['ids', 'axis', 'degrees']),
    summary: (i) => `rotate ${i.degrees}° about ${i.axis}`,
    run: ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids);
      focus(ed, nodes);
      ed.rotateSelection(i.axis, i.degrees);
      return box(ed, nodes);
    },
  },
  {
    name: 'nudge', kind: 'edit',
    description: 'Move shapes by an offset in design units.',
    inputSchema: obj({ ids: ids(), dx: num('Along x.'), dy: num('Along y.'), dz: num('Along z.') }, ['ids']),
    summary: (i) => `move by ${[i.dx || 0, i.dy || 0, i.dz || 0].join(', ')}`,
    run: ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids);
      focus(ed, nodes);
      const T = new THREE.Matrix4().makeTranslation(inn(ed, i.dx || 0), inn(ed, i.dy || 0), inn(ed, i.dz || 0));
      ed.transformSelection(T, nodes);
      return box(ed, nodes);
    },
  },
  {
    name: 'drop_to_workplane', kind: 'edit',
    description: 'Lower (or raise) each shape so it stands on the workplane.',
    inputSchema: obj({ ids: ids() }, ['ids']),
    summary: () => 'drop to the workplane',
    run: ({ editor: ed }, i) => { const nodes = nodesFor(ed, i.ids); focus(ed, nodes); ed.dropToWorkplane(); return nodes.map((n) => nodeInfo(ed, n)); },
  },
  {
    name: 'set_color', kind: 'edit',
    description: 'Colour shapes (#rrggbb). This also makes holes solid again.',
    inputSchema: obj({ ids: ids(), color: str('#rrggbb') }, ['ids', 'color']),
    summary: (i) => `colour ${i.color}`,
    run: ({ editor: ed }, i) => {
      if (!COLOR.test(i.color)) throw new ToolError('color should look like #ff8800.');
      const nodes = nodesFor(ed, i.ids); focus(ed, nodes); ed.setColor(i.color);
      return nodes.map((n) => nodeInfo(ed, n));
    },
  },
  {
    name: 'set_hole', kind: 'edit',
    description: 'Make shapes holes (true) or solids (false). A hole cuts the solids it is grouped with.',
    inputSchema: obj({ ids: ids(), hole: { type: 'boolean' } }, ['ids', 'hole']),
    summary: (i) => (i.hole ? 'make hole' : 'make solid'),
    run: ({ editor: ed }, i) => { const nodes = nodesFor(ed, i.ids); focus(ed, nodes); ed.setHole(!!i.hole); return nodes.map((n) => nodeInfo(ed, n)); },
  },
  {
    name: 'rename', kind: 'edit',
    description: 'Give a shape or group a name.',
    inputSchema: obj({ id: str('Id.'), name: str('New name.', { minLength: 1, maxLength: 80 }) }, ['id', 'name']),
    summary: (i) => `rename to "${i.name}"`,
    run: ({ editor: ed }, i) => { const [n] = nodesFor(ed, i.id); ed.rename(n.id, i.name); focus(ed, [n]); return nodeInfo(ed, n); },
  },
  {
    name: 'group', kind: 'edit',
    description: 'Group two or more shapes into one. union: combine them, and holes cut the solids; intersect: keep only where they all overlap; bundle: keep them together without combining. Returns the new group (its id is new).',
    inputSchema: obj({ ids: ids('At least two ids.'), mode: { type: 'string', enum: ['union', 'intersect', 'bundle'] }, name: str('A name for the group (optional).') }, ['ids', 'mode']),
    summary: (i) => `${i.mode === 'union' ? 'group' : i.mode} ${i.ids.length} shapes`,
    run: async ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids);
      if (nodes.length < 2) throw new ToolError('Grouping needs at least two shapes.');
      focus(ed, nodes);
      await ed.group(i.mode);
      const g = ed.selectedNodes()[0];
      if (!g || g.type !== 'group') throw new ToolError('The group could not be made.');
      if (i.name) ed.rename(g.id, i.name);
      const empty = !getGeometry(g).attributes.position.count;
      return { group: nodeInfo(ed, g), ...(empty ? { warning: 'The result is empty: the holes removed everything.' } : {}) };
    },
  },
  {
    name: 'ungroup', kind: 'edit',
    description: 'Split a group back into its parts (they get new ids).',
    inputSchema: obj({ id: str('Group id.') }, ['id']),
    summary: () => 'ungroup',
    run: ({ editor: ed }, i) => {
      const [g] = nodesFor(ed, i.id);
      if (g.type !== 'group') throw new ToolError('That is not a group.');
      focus(ed, [g]); ed.ungroup();
      return { parts: ed.selectedNodes().map((n) => nodeInfo(ed, n)) };
    },
  },
  {
    name: 'align', kind: 'edit',
    description: 'Line shapes up along an axis: min (left / front / bottom sides), center, or max (right / back / top sides), relative to their combined bounding box. With anchorId, they line up with that shape instead (it does not move).',
    inputSchema: obj({ ids: ids('At least two ids.'), axis: { type: 'string', enum: AX }, mode: { type: 'string', enum: ['min', 'center', 'max'] }, anchorId: str('Shape to line up with (optional; must be one of ids).') }, ['ids', 'axis', 'mode']),
    summary: (i) => `align ${i.axis} ${i.mode}`,
    run: ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids);
      if (nodes.length < 2) throw new ToolError('Aligning needs at least two shapes.');
      if (i.anchorId && !i.ids.includes(i.anchorId)) throw new ToolError('anchorId must be one of ids.');
      focus(ed, nodes);
      ed.alignAnchor = i.anchorId || null;
      ed.align(i.axis, i.mode);
      ed.alignAnchor = null;
      return nodes.map((n) => nodeInfo(ed, n));
    },
  },
  {
    name: 'mirror', kind: 'edit',
    description: 'Mirror shapes (together) across their middle along an axis (x: left-right, y: front-back, z: upside down).',
    inputSchema: obj({ ids: ids(), axis: { type: 'string', enum: AX } }, ['ids', 'axis']),
    summary: (i) => `mirror ${i.axis}`,
    run: ({ editor: ed }, i) => { const nodes = nodesFor(ed, i.ids); focus(ed, nodes); ed.mirror(i.axis); return nodes.map((n) => nodeInfo(ed, n)); },
  },
  {
    name: 'duplicate', kind: 'edit',
    description: 'Copy shapes in place (the copies get new ids and are left selected); move them afterwards.',
    inputSchema: obj({ ids: ids() }, ['ids']),
    summary: (i) => `duplicate ${i.ids.length}`,
    run: ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids, { edit: false });
      focus(ed, nodes); ed.dupState = null; ed.duplicate();
      return { copies: ed.selectedNodes().map((n) => nodeInfo(ed, n)) };
    },
  },
  {
    name: 'pattern', kind: 'edit',
    description: 'Repeat shapes. linear: count copies in total (including the originals), each shifted by dx, dy, dz (design units) from the previous. circular: count copies around the workplane origin\'s z axis over angle degrees (360 = full circle). New copies are selected along with the originals.',
    inputSchema: obj({ ids: ids(), type: { type: 'string', enum: ['linear', 'circular'] }, count: { type: 'integer', minimum: 2, maximum: 200, description: 'Total number, 2 to 200.' }, dx: num('linear step x'), dy: num('linear step y'), dz: num('linear step z'), angle: num('circular: degrees covered (default 360)') }, ['ids', 'type', 'count']),
    summary: (i) => `${i.type} pattern ×${i.count}`,
    run: ({ editor: ed }, i) => {
      const nodes = nodesFor(ed, i.ids, { edit: false });
      if (i.type === 'linear' && !(i.dx || i.dy || i.dz)) throw new ToolError('A linear pattern needs dx, dy or dz.');
      focus(ed, nodes);
      ed.pattern({ type: i.type, count: i.count, dx: inn(ed, i.dx || 0), dy: inn(ed, i.dy || 0), dz: inn(ed, i.dz || 0), angle: i.angle ?? 360 });
      return { shapes: ed.selectedNodes().map((n) => n.id) };
    },
  },
  {
    name: 'delete', kind: 'edit',
    description: 'Delete shapes.',
    inputSchema: obj({ ids: ids() }, ['ids']),
    summary: (i) => `delete ${i.ids.length}`,
    run: ({ editor: ed }, i) => { const nodes = nodesFor(ed, i.ids); focus(ed, nodes); ed.deleteSelection(); return { deleted: nodes.map((n) => n.id) }; },
  },
  {
    name: 'select', kind: 'ui',
    description: 'Select shapes in the editor so the user can see or keep working on them (no undo step). An empty list clears the selection.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, description: 'Ids to select.' } }, ['ids']),
    run: ({ editor: ed }, i) => { const nodes = i.ids.length ? nodesFor(ed, i.ids, { edit: false }) : []; focus(ed, nodes); return { selected: i.ids }; },
  },
];

export const toolByName = (name, list = TOOLS) => list.find((t) => t.name === name);

/**
 * Run one tool. Edit tools become one undo step "AI: <summary>"; a refusal or failure changes
 * nothing. Returns { ok, result } or { ok: false, error }.
 */
export async function runTool(ctx, name, input, list = TOOLS) {
  const tool = toolByName(name, list);
  if (!tool) return { ok: false, error: `There's no tool called "${name}".` };
  const problems = checkSchema(tool.inputSchema, input ?? {});
  if (problems.length) return { ok: false, error: `Invalid input: ${problems.slice(0, 6).join('; ')}.` };
  try {
    if (tool.kind === 'edit') {
      const label = `AI: ${tool.summary ? tool.summary(input) : tool.name.replace(/_/g, ' ')}`;
      const result = await (ctx.transaction || ctx.editor.transaction.bind(ctx.editor))(label, () => tool.run(ctx, input));
      return { ok: true, result, edited: true };
    }
    return { ok: true, result: await tool.run(ctx, input) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: e.message };
    console.error('AI tool', name, e);
    return { ok: false, error: `It went wrong: ${e.message || e}. Nothing was changed.` };
  }
}

// shared with the other tool files (moretools.js)
export const helpers = { nodesFor, focus, box, out, inn, num, str, ids, vec, obj, nodeInfo, placeNodes, sizeNodes, factor };
