// AI tools for the Laser workspace: read the drawing and its layers, add simple shapes, change
// layer cut settings and arrange shapes on the bed.
//
// SAFETY: there is deliberately no tool here (or anywhere in the AI layer) that connects to,
// starts, pauses, frames, homes or jogs a laser, or sends G-code. Those stay with the user.
//
// Bed coordinates are millimetres from the bed's top-left corner, x to the right and y down,
// the same as the Laser workspace's rulers.

import { layerOf, boundsOf, deep, makeRect, makeEllipse, makePolygon, makeText, LAYER_NAMES, isToolLayer } from '../laser/model.js';
import { usedLayers } from '../laser/gcode.js';
import { ToolError } from './tools.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const ids = () => ({ type: 'array', items: { type: 'string' }, minItems: 1, description: 'Shape ids (from the laser summary).' });
const layerNo = { type: 'integer', minimum: 1, maximum: 30, description: 'Layer number 1 to 30, as the Laser workspace shows it.' };

const speedOut = (ws, v) => (ws.machine.speedUnits === 'mm/min' ? Math.round(v * 60) : r3(v));
const speedIn = (ws, v) => (ws.machine.speedUnits === 'mm/min' ? v / 60 : v);

function shapeInfo(ws, s) {
  const b = boundsOf([s]);
  return {
    id: s.id, type: s.type, layer: s.layer + 1,
    ...(s.type === 'text' ? { text: s.text } : {}),
    ...(s.locked ? { locked: true } : {}),
    bounds: b ? { x: r3(b.x0), y: r3(b.y0), w: r3(b.w), h: r3(b.h) } : null,
  };
}

function layerInfo(ws, i) {
  const L = layerOf(ws.doc, i);
  return {
    layer: i + 1, name: LAYER_NAMES[i], mode: L.mode, speed: speedOut(ws, L.speed), power_max: L.powerMax, power_min: L.powerMin,
    passes: L.passes, interval: L.interval, output: L.output, show: L.show,
  };
}

export function laserSummary(ctx, { limit = 200 } = {}) {
  const ws = ctx.laser;
  const shapes = ws.doc.shapes;
  const s = {
    workspace: 'laser',
    units: 'mm',
    coordinates: 'x from the bed\'s left edge, y down from its top edge',
    bed: { w: ws.machine.bedW, h: ws.machine.bedH },
    speed_units: ws.machine.speedUnits || 'mm/s',
    count: shapes.length,
    shapes: shapes.slice(0, limit).map((x) => shapeInfo(ws, x)),
    layers_in_use: [...new Set(shapes.map((x) => x.layer))].sort((a, b) => a - b).map((i) => i + 1),
    selection: [...ws.sel],
  };
  if (shapes.length > limit) s.note = `Only the first ${limit} of ${shapes.length} shapes are listed.`;
  return s;
}

function shapesFor(ws, list, { edit = true } = {}) {
  const out = [];
  for (const id of list) {
    const s = ws.doc.shapes.find((x) => x.id === id);
    if (!s) throw new ToolError(`There's no laser shape with id "${id}".`);
    if (edit && s.locked) throw new ToolError(`"${id}" is locked by the user; leave it alone or ask them to unlock it.`);
    out.push(s);
  }
  return out;
}

function checkLayer(i) {
  if (isToolLayer(i)) throw new ToolError('Tool layers (GA, GB) are not for cutting.');
}

/**
 * The context for laser tools: { laser, transaction }. Each edit is one Laser undo step.
 * (A failed tool puts the drawing back as it was.)
 */
export function laserContext(app) {
  const ws = app.laser;
  return {
    laser: ws,
    workspace: () => 'laser',
    async transaction(label, fn) {
      const before = ws._snapshot();
      const sel = [...ws.sel];
      try {
        const out = await fn();
        ws.commit();
        return out;
      } catch (e) {
        ws.doc.shapes = before.shapes; ws.doc.layers = before.layers; ws.doc.layerOrder = before.layerOrder;
        ws.sel = sel;
        ws.refresh();
        throw e;
      }
    },
    history: {
      current: () => ws.history[ws.hIndex],
      has: (s) => ws.history.includes(s),
      undo: () => ws.undo(),
      canUndo: () => ws.hIndex > 0,
      restore: (s) => { ws.doc.shapes = deep(s.shapes); ws.doc.layers = deep(s.layers); ws.doc.layerOrder = deep(s.layerOrder); ws.commit(); },
    },
  };
}

export const LASER_TOOLS = [
  {
    name: 'get_laser_summary', kind: 'read',
    description: 'The laser drawing: bed size, every shape with its id, type, layer and bounds (x, y, w, h in mm; y is down from the top edge), and the selection.',
    inputSchema: obj({}),
    run: (ctx) => laserSummary(ctx),
  },
  {
    name: 'list_laser_layers', kind: 'read',
    description: 'The cut settings of the layers in use (or all 30 with all: true): mode (line = cut or score along the outline, fill = engrave the area, offset = engrave with offset passes), speed, power_max / power_min (%), passes, fill line interval (mm), whether the layer is sent to the laser (output) and shown.',
    inputSchema: obj({ all: { type: 'boolean' } }),
    run: (ctx, i) => {
      const ws = ctx.laser;
      const list = i.all ? [...Array(30).keys()] : usedLayers(ws.doc).filter((x) => !isToolLayer(x));
      return { speed_units: ws.machine.speedUnits || 'mm/s', layers: list.map((x) => layerInfo(ws, x)) };
    },
  },
  {
    name: 'set_laser_layer', kind: 'edit',
    description: 'Change a layer\'s cut settings. Only the given settings change. Speed is in the units list_laser_layers reports. This only changes settings: it never runs the laser.',
    inputSchema: obj({
      layer: layerNo,
      mode: { type: 'string', enum: ['line', 'fill', 'offset'] },
      speed: num('Speed, more than 0.', { minimum: 0.1 }),
      power_max: num('Maximum power %.', { minimum: 0, maximum: 100 }),
      power_min: num('Minimum power %.', { minimum: 0, maximum: 100 }),
      passes: { type: 'integer', minimum: 1, maximum: 50 },
      interval: num('Fill line spacing in mm.', { minimum: 0.01, maximum: 5 }),
      output: { type: 'boolean', description: 'Send this layer to the laser.' },
      show: { type: 'boolean' },
    }, ['layer']),
    summary: (i) => `layer ${i.layer} settings`,
    run: (ctx, i) => {
      const ws = ctx.laser, li = i.layer - 1;
      checkLayer(li);
      const L = layerOf(ws.doc, li);
      if (i.mode) L.mode = i.mode;
      if (i.speed != null) L.speed = speedIn(ws, i.speed);
      if (i.power_max != null) L.powerMax = i.power_max;
      if (i.power_min != null) L.powerMin = i.power_min;
      if (L.powerMin > L.powerMax) throw new ToolError('power_min should not be more than power_max.');
      if (i.passes != null) L.passes = i.passes;
      if (i.interval != null) L.interval = i.interval;
      if (i.output != null) L.output = i.output;
      if (i.show != null) L.show = i.show;
      return layerInfo(ws, li);
    },
  },
  {
    name: 'add_laser_shape', kind: 'edit',
    description: 'Add a rectangle, ellipse, polygon or text to the laser drawing on a layer. x, y is the top-left corner in mm (y down from the bed\'s top edge). Text uses size as the letter height in mm. The new shape is selected.',
    inputSchema: obj({
      type: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'text'] },
      x: num('Left edge, mm.'), y: num('Top edge, mm.'),
      w: num('Width, mm (not for text).', { minimum: 0.01 }), h: num('Height, mm (not for text).', { minimum: 0.01 }),
      radius: num('rect: corner radius, mm.', { minimum: 0 }),
      sides: { type: 'integer', minimum: 3, maximum: 64, description: 'polygon: number of sides.' },
      text: { type: 'string', minLength: 1, maxLength: 500 },
      size: num('text: letter height, mm.', { minimum: 0.5, maximum: 500 }),
      layer: layerNo,
    }, ['type', 'x', 'y']),
    summary: (i) => `add ${i.type === 'text' ? `text "${String(i.text || '').slice(0, 20)}"` : i.type}`,
    run: (ctx, i) => {
      const ws = ctx.laser;
      const li = i.layer ? i.layer - 1 : ws.doc.currentLayer || 0;
      checkLayer(li);
      let s;
      if (i.type === 'text') {
        if (!i.text) throw new ToolError('Text needs text.');
        s = makeText(li, i.x, i.y, i.text, 'Sans Bold', i.size || 10);
      } else {
        if (!(i.w > 0 && i.h > 0)) throw new ToolError(`A ${i.type} needs w and h.`);
        s = i.type === 'rect' ? makeRect(li, i.x, i.y, i.w, i.h, i.radius || 0)
          : i.type === 'ellipse' ? makeEllipse(li, i.x, i.y, i.w, i.h)
            : makePolygon(li, i.x, i.y, i.w, i.h, i.sides || 6);
      }
      layerOf(ws.doc, li);
      ws.doc.shapes.push(s);
      ws.sel = [s.id];
      return shapeInfo(ws, s);
    },
  },
  {
    name: 'arrange_laser', kind: 'edit',
    description: 'Arrange laser shapes. align_*: line them up with each other (or with the bed, for one shape). distribute_x / distribute_y: even spacing (three or more). move: shift by dx, dy mm. place: put their combined box at x, y (top-left, mm). to_bed: snap their box to one of 9 bed spots (0 top-left … 4 middle … 8 bottom-right). set_layer: move them to another layer. delete: remove them.',
    inputSchema: obj({
      ids: ids(),
      action: { type: 'string', enum: ['align_left', 'align_center_x', 'align_right', 'align_top', 'align_center_y', 'align_bottom', 'distribute_x', 'distribute_y', 'move', 'place', 'to_bed', 'set_layer', 'delete'] },
      dx: num('move: mm right.'), dy: num('move: mm down.'),
      x: num('place: left edge, mm.'), y: num('place: top edge, mm.'),
      spot: { type: 'integer', minimum: 0, maximum: 8 },
      layer: layerNo,
    }, ['ids', 'action']),
    summary: (i) => `${i.action.replace(/_/g, ' ')} ${i.ids.length}`,
    run: (ctx, i) => {
      const ws = ctx.laser;
      const shapes = shapesFor(ws, i.ids);
      ws.sel = shapes.map((s) => s.id);
      const mv = (dx, dy) => { for (const s of shapes) s.m = [s.m[0], s.m[1], s.m[2], s.m[3], s.m[4] + dx, s.m[5] + dy]; };
      const b = boundsOf(shapes);
      const al = { align_left: ['x', 0], align_center_x: ['x', 0.5], align_right: ['x', 1], align_top: ['y', 0], align_center_y: ['y', 0.5], align_bottom: ['y', 1] }[i.action];
      if (al) alignShapes(ws, shapes, al[0], al[1]);
      else if (i.action === 'distribute_x' || i.action === 'distribute_y') {
        if (shapes.length < 3) throw new ToolError('Distributing needs three or more shapes.');
        const c = i.action === 'distribute_x' ? 'cx' : 'cy';
        const items = shapes.map((s) => ({ s, b: boundsOf([s]) })).filter((x) => x.b).sort((p, q) => p.b[c] - q.b[c]);
        const first = items[0].b[c], last = items[items.length - 1].b[c];
        items.forEach((it, k) => {
          const d = first + ((last - first) * k) / (items.length - 1) - it.b[c];
          it.s.m = [...it.s.m.slice(0, 4), it.s.m[4] + (c === 'cx' ? d : 0), it.s.m[5] + (c === 'cy' ? d : 0)];
        });
      } else if (i.action === 'move') {
        if (!(i.dx || i.dy)) throw new ToolError('move needs dx or dy.');
        mv(i.dx || 0, i.dy || 0);
      } else if (i.action === 'place') {
        if (i.x == null && i.y == null) throw new ToolError('place needs x or y.');
        if (b) mv(i.x != null ? i.x - b.x0 : 0, i.y != null ? i.y - b.y0 : 0);
      } else if (i.action === 'to_bed') {
        if (i.spot == null) throw new ToolError('to_bed needs spot (0 to 8).');
        const fx = (i.spot % 3) / 2, fy = Math.floor(i.spot / 3) / 2;
        if (b) mv(ws.machine.bedW * fx - (b.x0 + b.w * fx), ws.machine.bedH * fy - (b.y0 + b.h * fy));
      } else if (i.action === 'set_layer') {
        if (!i.layer) throw new ToolError('set_layer needs layer.');
        checkLayer(i.layer - 1);
        layerOf(ws.doc, i.layer - 1);
        const walk = (s) => { if (s.type === 'group') s.children.forEach(walk); else s.layer = i.layer - 1; };
        shapes.forEach(walk);
      } else if (i.action === 'delete') {
        const gone = new Set(shapes.map((s) => s.id));
        ws.doc.shapes = ws.doc.shapes.filter((s) => !gone.has(s.id));
        ws.sel = [];
        return { deleted: [...gone] };
      }
      return shapes.map((s) => shapeInfo(ws, s));
    },
  },
  {
    name: 'select_laser', kind: 'ui',
    description: 'Select laser shapes so the user can see them (no undo step). An empty list clears the selection.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
    run: (ctx, i) => { const ws = ctx.laser; const shapes = i.ids.length ? shapesFor(ws, i.ids, { edit: false }) : []; ws.select(shapes.map((s) => s.id)); return { selected: i.ids }; },
  },
];

function alignShapes(ws, shapes, axis, f) {
  const ref = shapes.length > 1 ? boundsOf(shapes) : { x0: 0, y0: 0, w: ws.machine.bedW, h: ws.machine.bedH };
  for (const s of shapes) {
    const b = boundsOf([s]);
    if (!b) continue;
    const d = axis === 'x' ? ref.x0 + ref.w * f - (b.x0 + b.w * f) : ref.y0 + ref.h * f - (b.y0 + b.h * f);
    s.m = [...s.m.slice(0, 4), s.m[4] + (axis === 'x' ? d : 0), s.m[5] + (axis === 'y' ? d : 0)];
  }
}
