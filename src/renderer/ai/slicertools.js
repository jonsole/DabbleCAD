// AI tools for the Slicer workspace: look at the plate and the print settings, arrange, orient,
// scale and place models, pick presets, change settings, slice, and read the slice's results.
//
// SAFETY: there is deliberately no tool that sends G-code to a printer, starts, pauses or stops a
// print, saves G-code, watches the printer or changes how the printer is reached. The machine's
// start / end G-code can be read but not changed. Sending stays with the user.

import { SIMPLE, SCOPES, SCOPE_ORDER } from '../slicer/taxonomy.js';
import { fitProblem } from '../slicer/model.js';
import { formatTime } from '../slicer/engine.js';
import { FILAMENT_DENSITY } from '../slicer/profiles.js';
import { ToolError } from './tools.js';

const r2 = (v) => Math.round(v * 100) / 100;
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const modelIds = (d = 'Plate model ids (from get_plate).') => ({ type: 'array', items: { type: 'integer' }, minItems: 1, description: d });
const SCOPE = { type: 'string', enum: SCOPE_ORDER };
// settings the AI may read but never change: they are G-code the printer runs
const READ_ONLY = (key) => /gcode/i.test(key);

function modelView(ws, m) {
  const s = m.size;
  const o = {
    id: m.id, name: m.name, x: r2(m.x), y: r2(m.y),
    rotation: { x: r2(m.rx), y: r2(m.ry), z: r2(m.rz) },
    scale: m.sx === m.sy && m.sy === m.sz ? r2(m.sx) : { x: r2(m.sx), y: r2(m.sy), z: r2(m.sz) },
    size: { x: r2(s.x), y: r2(s.y), z: r2(s.z) },
  };
  if (m.locked) o.locked = true;
  if (m.hidden) o.hidden = true;
  const p = !m.hidden && fitProblem(m, ws.volume);
  if (p) o.problem = p;
  return o;
}

function sliceView(ws) {
  if (ws.controller) return { state: 'slicing' };
  if (!ws.result) return { state: 'not sliced' };
  const r = ws.result.summary || {};
  const st = ws.store;
  const grams = r.filamentM ? Math.PI * Math.pow(st.get('material_diameter') / 2, 2) * r.filamentM * (FILAMENT_DENSITY[ws.profiles.current('filament').id] ?? 1.24) : null;
  return {
    state: ws.dirty ? 'out of date (the plate or settings changed since)' : 'sliced',
    ...(r.seconds ? { print_time: formatTime(r.seconds), seconds: r.seconds } : {}),
    ...(r.filamentM ? { filament_m: r2(r.filamentM) } : {}),
    ...(grams ? { filament_g: Math.round(grams) } : {}),
    ...(r.layers ? { layers: r.layers } : {}),
  };
}

export function plateSummary(ctx) {
  const ws = ctx.slicer;
  if (!ws.scene) return { workspace: 'slicer', note: 'The slicer is still loading.' };
  const v = ws.volume;
  return {
    workspace: 'slicer',
    units: 'mm',
    coordinates: 'x, y: the model footprint centre on the bed, measured from the bed centre',
    printer: ws.profiles.current('printer')?.name, filament: ws.profiles.current('filament')?.name, process: ws.profiles.current('process')?.name,
    bed: { width: v.width, depth: v.depth, height: v.height, shape: v.shape },
    key_settings: Object.fromEntries(['layer_height', 'infill_sparse_density', 'wall_line_count', 'support_enable', 'adhesion_type', 'material_print_temperature', 'material_bed_temperature'].map((k) => [k, ws.store.get(k)])),
    models: ws.models.map((m) => modelView(ws, m)),
    selected: ws.selected,
    slice: sliceView(ws),
    view: ws.monitoring ? 'monitor' : ws.mode,
  };
}

function settingView(ws, key, { detail = false } = {}) {
  const d = ws.store.defs.get(key);
  if (!d) return null;
  const n = ws.info.get(key);
  const o = { key, label: d.label, value: ws.store.get(key) };
  if (d.unit) o.unit = d.unit;
  if (n) o.scope = n.scope;
  if (ws.profiles.isModified(key)) o.changed_from_preset = true;
  if (READ_ONLY(key)) o.read_only = true;
  if (!ws.store.isEnabled(key)) o.not_used_now = true;
  if (detail) {
    o.type = d.type;
    if (d.description) o.description = d.description.slice(0, 400);
    if (d.options) o.options = Object.keys(d.options);
    const l = ws.store.limits(key);
    for (const k of ['min', 'max', 'minWarn', 'maxWarn']) if (l[k] !== undefined && Number.isFinite(Number(l[k]))) o[k] = l[k];
  }
  if (typeof o.value === 'string' && o.value.length > 1500) o.value = o.value.slice(0, 1500) + '…';
  return o;
}

function modelsFor(ws, list, { edit = true } = {}) {
  return list.map((id) => {
    const m = ws.models.find((x) => x.id === id);
    if (!m) throw new ToolError(`There's no model ${id} on the plate. Use get_plate.`);
    if (edit && m.locked) throw new ToolError(`"${m.name}" is locked; the user has to unlock it first.`);
    return m;
  });
}

/** After changing models: redraw, mark the slice stale, check the fit. */
function changed(ws) {
  ws.scene.setModels(ws.models);
  ws.scene.setSelection(ws.selected ? [ws.selected] : []);
  ws._markDirty(); ws._checkFit(); ws._renderTransform(); ws._updateBar();
}

/** The context for slicer tools. Each plate edit is one Slicer undo step. */
export function slicerContext(app) {
  const ws = app.slicer;
  const hist = () => ws._hist || (ws._checkpoint(), ws._hist);
  return {
    slicer: ws,
    app,
    workspace: () => 'slicer',
    async transaction(_label, fn) {
      if (!ws.scene) throw new ToolError('The slicer is still loading.');
      // gather the tool's changes into one plate undo step
      ws._checkpoint();
      const cp = ws._checkpoint;
      ws._checkpoint = () => {};
      try { return await fn(); } finally { delete ws._checkpoint; if (ws._checkpoint !== cp) ws._checkpoint = cp; ws._checkpoint(); ws._syncTools(); }
    },
    history: {
      current: () => { const h = hist(); return h && h.stack[h.i]; },
      has: (s) => { const h = hist(); return !!h && h.stack.includes(s); },
      canUndo: () => { const h = hist(); return !!h && h.i > 0; },
      undo: () => ws.undo(),
      restore: (s) => { ws._restore(s); ws._checkpoint(); },
    },
  };
}

export const SLICER_TOOLS = [
  // ---------------------------------------------------------------- reading
  {
    name: 'get_plate', kind: 'read',
    description: 'The Slicer plate: the chosen printer, filament and process presets, bed size, key settings, every model (id, name, position, rotation, scale, size, any fit problem) and the slice result (print time, filament, layers) if sliced.',
    inputSchema: obj({}),
    run: (ctx) => plateSummary(ctx),
  },
  {
    name: 'find_settings', kind: 'read',
    description: 'Look up print settings (Cura settings): by key, or by a word in the name (e.g. "infill", "support", "temperature"). With no query: the common settings. Shows the value, unit, whether it differs from the preset, and with detail: description, options and limits.',
    inputSchema: obj({ keys: { type: 'array', items: { type: 'string' } }, query: { type: 'string', minLength: 2 }, scope: SCOPE, detail: { type: 'boolean' } }),
    run: (ctx, i) => {
      const ws = ctx.slicer;
      let keys;
      if (i.keys && i.keys.length) keys = i.keys;
      else if (i.query) {
        const q = i.query.toLowerCase();
        keys = [...ws.info.keys()].filter((k) => k.includes(q.replace(/\s+/g, '_')) || (ws.store.defs.get(k)?.label || '').toLowerCase().includes(q));
      } else keys = [...SIMPLE];
      if (i.scope) keys = keys.filter((k) => ws.info.get(k)?.scope === i.scope);
      const out = [];
      for (const k of keys.slice(0, 80)) { const v = settingView(ws, k, { detail: !!i.detail || !!(i.keys && i.keys.length) }); if (v) out.push(v); else out.push({ key: k, error: 'no such setting' }); }
      return { settings: out, ...(keys.length > 80 ? { note: `${keys.length} matched; only 80 shown. Narrow the query.` } : {}) };
    },
  },
  {
    name: 'list_presets', kind: 'read',
    description: 'The printer, filament or process presets the user can choose (built-in and their own), and which is chosen.',
    inputSchema: obj({ scope: SCOPE }, ['scope']),
    run: (ctx, i) => {
      const p = ctx.slicer.profiles;
      return { scope: i.scope, chosen: p.selected[i.scope], presets: p.list(i.scope).map((x) => ({ id: x.id, name: x.name, ...(x.builtin ? { builtin: true } : {}) })) };
    },
  },
  {
    name: 'get_slice_result', kind: 'read',
    description: 'The last slice: print time, filament length and weight, layer count, and whether it is out of date.',
    inputSchema: obj({}),
    run: (ctx) => sliceView(ctx.slicer),
  },

  // ---------------------------------------------------------------- settings (not plate undo steps)
  {
    name: 'choose_preset', kind: 'edit',
    description: 'Choose a printer, filament or process preset (ids from list_presets). This replaces that preset\'s settings, including changes not saved to a preset. Not an undo step: say what you changed.',
    inputSchema: obj({ scope: SCOPE, id: { type: 'string' }, discard_changes: { type: 'boolean', description: 'Needed when the current preset has unsaved changes (ask the user first).' } }, ['scope', 'id']),
    summary: (i) => `${i.scope} preset`,
    run: (ctx, i) => {
      const ws = ctx.slicer;
      const p = ws.profiles.find(i.scope, i.id);
      if (!p) throw new ToolError(`No ${i.scope} preset "${i.id}". Use list_presets.`);
      const mods = ws.profiles.modifiedKeys(i.scope);
      if (mods.length && !i.discard_changes) throw new ToolError(`The ${i.scope} preset has ${mods.length} unsaved change${mods.length > 1 ? 's' : ''} (${mods.slice(0, 6).join(', ')}) that switching would lose. Ask the user; to go ahead anyway, call again with discard_changes: true.`);
      const before = ws.profiles.current(i.scope)?.name;
      ws.profiles.select(i.scope, i.id);
      if (ws.panel) { ws.panel._renderChrome(); if (i.scope === 'printer' && ws.panel.connSync) ws.panel.connSync(); }
      return { scope: i.scope, was: before, now: p.name };
    },
  },
  {
    name: 'set_settings', kind: 'edit',
    description: 'Change print settings: { key: value } (keys from find_settings), e.g. {"infill_sparse_density": 20, "support_enable": true}. Values outside a setting\'s limits are refused; risky ones are allowed with a warning. The printer\'s start / end G-code can\'t be changed. Not an undo step: the result lists the old values.',
    inputSchema: obj({ values: { type: 'object', additionalProperties: { type: ['number', 'string', 'boolean'] }, description: 'Setting key → new value.' } }, ['values']),
    summary: (i) => `set ${Object.keys(i.values || {}).slice(0, 3).join(', ')}${Object.keys(i.values || {}).length > 3 ? '…' : ''}`,
    run: (ctx, i) => {
      const ws = ctx.slicer, st = ws.store;
      const entries = Object.entries(i.values || {});
      if (!entries.length) throw new ToolError('Give at least one setting.');
      const old = {};
      // check everything first, so a bad value changes nothing
      for (const [k, v] of entries) {
        const d = st.defs.get(k);
        if (!d || !ws.info.get(k)) throw new ToolError(`There's no setting "${k}". Use find_settings.`);
        if (READ_ONLY(k)) throw new ToolError(`${k} is G-code the printer runs; only the user can change it.`);
        if (d.type === 'enum' && d.options && !Object.prototype.hasOwnProperty.call(d.options, v)) throw new ToolError(`${k} must be one of: ${Object.keys(d.options).join(', ')}.`);
        if ((d.type === 'float' || d.type === 'int') && !Number.isFinite(Number(v))) throw new ToolError(`${k} must be a number.`);
        if (d.type === 'bool' && typeof v !== 'boolean') throw new ToolError(`${k} must be true or false.`);
        old[k] = st.get(k);
      }
      const prev = { ...st.overrides };
      st.patch(Object.fromEntries(entries.map(([k, v]) => [k, st.defs.get(k).type === 'int' ? Math.round(Number(v)) : st.defs.get(k).type === 'float' ? Number(v) : v])));
      const errors = entries.filter(([k]) => st.check(k) === 'error').map(([k]) => k);
      if (errors.length) {
        st.setOverrides(prev);
        throw new ToolError(`Outside the allowed range: ${errors.map((k) => { const l = st.limits(k); return `${k} (${l.min ?? '…'} to ${l.max ?? '…'})`; }).join(', ')}. Nothing was changed.`);
      }
      const block = ws._blockingProblems();
      if (block) { st.setOverrides(prev); throw new ToolError(`${block} Nothing was changed.`); }
      const warns = entries.filter(([k]) => st.check(k) === 'warn').map(([k]) => k);
      return { changed: entries.map(([k]) => ({ key: k, from: old[k], to: st.get(k) })), ...(warns.length ? { warning: `Unusual values (allowed, but check them): ${warns.join(', ')}.` } : {}) };
    },
  },

  // ---------------------------------------------------------------- the plate
  {
    name: 'add_to_plate', kind: 'edit',
    description: 'Put the 3D design on the plate: every object, or only the shapes selected in 3D Design. Each shape or group becomes its own model, turned to need the least support.',
    inputSchema: obj({ selected_only: { type: 'boolean' } }),
    summary: () => 'add to plate',
    run: async (ctx, i) => {
      const ws = ctx.slicer;
      const n0 = ws.models.length;
      if (i.selected_only && !ctx.app.editor.selection.size) throw new ToolError('Nothing is selected in 3D Design.');
      if (!ctx.app.editor.doc.nodes.length) throw new ToolError('The 3D design is empty.');
      await ws.addFromDesign({ selectedOnly: !!i.selected_only, quiet: true });
      await new Promise((r) => setTimeout(r, 80));   // auto-orient runs just after
      const added = ws.models.slice(n0);
      if (!added.length) throw new ToolError('Nothing was added.');
      return { added: added.map((m) => modelView(ws, m)) };
    },
  },
  {
    name: 'place_models', kind: 'edit',
    description: 'Move, turn or scale plate models. x, y: footprint centre from the bed centre, mm. rotation: degrees about x, y, z (absolute). scale: percent, one number (uniform) or { x, y, z }. Models always rest on the bed.',
    inputSchema: obj({
      ids: modelIds(),
      x: num('mm'), y: num('mm'),
      rotation: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      scale: { anyOf: [{ type: 'number', minimum: 1, maximum: 5000 }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number', minimum: 1 }, y: { type: 'number', minimum: 1 }, z: { type: 'number', minimum: 1 } } }] },
    }, ['ids']),
    summary: (i) => `place ${i.ids.length === 1 ? 'model' : i.ids.length + ' models'}`,
    run: (ctx, i) => {
      const ws = ctx.slicer;
      const ms = modelsFor(ws, i.ids);
      if (i.x == null && i.y == null && !i.rotation && i.scale == null) throw new ToolError('Give x, y, rotation or scale.');
      for (const m of ms) {
        if (i.x != null) m.x = i.x;
        if (i.y != null) m.y = i.y;
        if (i.rotation) for (const a of ['x', 'y', 'z']) if (i.rotation[a] != null) m['r' + a] = ((i.rotation[a] + 180) % 360 + 360) % 360 - 180;
        if (typeof i.scale === 'number') m.setUniformScale(i.scale);
        else if (i.scale) for (const a of ['x', 'y', 'z']) if (i.scale[a] != null) m['s' + a] = i.scale[a];
        m.zFloat = null;
        ws.scene.refreshModel(m);
      }
      changed(ws);
      return ms.map((m) => modelView(ws, m));
    },
  },
  {
    name: 'arrange_plate', kind: 'edit',
    description: 'Spread all unlocked models out on the bed so none overlap.',
    inputSchema: obj({}),
    summary: () => 'arrange plate',
    run: (ctx) => {
      const ws = ctx.slicer;
      if (!ws.models.length) throw new ToolError('The plate is empty.');
      ws.arrange();
      return { models: ws.models.map((m) => modelView(ws, m)) };
    },
  },
  {
    name: 'auto_orient', kind: 'edit',
    description: 'Turn models to the orientation that needs the least support (all unlocked models, or the given ones).',
    inputSchema: obj({ ids: modelIds('Optional: only these.') }),
    summary: () => 'auto-orient',
    run: async (ctx, i) => {
      const ws = ctx.slicer;
      const ms = i.ids ? modelsFor(ws, i.ids) : ws._movable();
      if (!ms.length) throw new ToolError('No unlocked models to orient.');
      ws.autoOrient(ms, { added: true });
      await new Promise((r) => setTimeout(r, 80));
      return ms.map((m) => modelView(ws, m));
    },
  },
  {
    name: 'plate_models', kind: 'edit',
    description: 'duplicate (copies, arranged), remove, hide or show (hidden models are left out of the slice), lock, or select plate models. You can lock but not unlock.',
    inputSchema: obj({ ids: modelIds(), action: { type: 'string', enum: ['duplicate', 'remove', 'hide', 'show', 'lock', 'select'] }, copies: { type: 'integer', minimum: 1, maximum: 50 } }, ['ids', 'action']),
    summary: (i) => `${i.action} ${i.ids.length === 1 ? 'model' : i.ids.length + ' models'}`,
    run: (ctx, i) => {
      const ws = ctx.slicer;
      const ms = modelsFor(ws, i.ids, { edit: !['select', 'lock', 'show', 'hide'].includes(i.action) });
      if (i.action === 'duplicate') for (const m of ms) for (let k = 0; k < (i.copies || 1); k++) ws.duplicate(m.id);
      else if (i.action === 'remove') { for (const m of ms) ws._remove(m); ws._afterModelsChanged(); }
      else if (i.action === 'hide' || i.action === 'show') { for (const m of ms) m.hidden = i.action === 'hide'; if (ms.some((m) => m.id === ws.selected && m.hidden)) ws.selected = null; ws._modelsChanged(); }
      else if (i.action === 'lock') { for (const m of ms) m.locked = true; ws._renderModels(); ws._renderTransform(); }
      else if (i.action === 'select') ws.select(ms[ms.length - 1].id);
      return { models: ws.models.map((m) => modelView(ws, m)) };
    },
  },

  // ---------------------------------------------------------------- slicing
  {
    name: 'slice', kind: 'ui',
    description: 'Slice the plate to G-code (it can take a while for big models) and show the preview. Returns print time, filament and layers. It does not send anything to the printer: the user does that.',
    inputSchema: obj({}),
    run: async (ctx) => {
      const ws = ctx.slicer;
      if (!ws._active().length) throw new ToolError('Nothing on the plate to slice.');
      const bad = ws._active().find((m) => fitProblem(m, ws.volume));
      if (bad) throw new ToolError(`${bad.name} is ${fitProblem(bad, ws.volume)}. Fix that first (place_models, arrange_plate or a smaller scale).`);
      const block = ws._blockingProblems();
      if (block) throw new ToolError(block);
      if (ws.result && !ws.dirty) return { ...sliceView(ws), note: 'Already sliced and up to date.' };
      await ws.slice();
      if (!ws.result || ws.dirty) throw new ToolError(`Slicing failed: ${ws.statusSub ? ws.statusSub.textContent : 'unknown error'}`);
      return sliceView(ws);
    },
  },
  {
    name: 'slicer_view', kind: 'ui',
    description: 'Switch the Slicer between the models (model) and the sliced layers (preview), or zoom to fit the plate.',
    inputSchema: obj({ view: { type: 'string', enum: ['model', 'preview', 'fit'] } }, ['view']),
    run: (ctx, i) => {
      const ws = ctx.slicer;
      if (i.view === 'fit') ws.fit();
      else { if (i.view === 'preview' && !ws.result) throw new ToolError('Slice first.'); ws.setMode(i.view); }
      return { view: i.view };
    },
  },
];

export const SLICER_PROMPT = `
The user is in the Slicer workspace now: models on a 3D printer's bed (mm, x, y from the bed centre), print settings in three presets (printer, filament, process; Cura setting keys), and slicing to G-code. Use the slicer tools (get_plate, find_settings, list_presets, choose_preset, set_settings, add_to_plate, place_models, arrange_plate, auto_orient, plate_models, slice, get_slice_result, slicer_view). Settings changes are not undo steps, so say what you changed. You can't send G-code to the printer, start or stop prints, or change the start/end G-code: the user does that.`;

export { SCOPES };
