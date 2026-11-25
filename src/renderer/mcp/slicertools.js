// Slicer and printer tools for the MCP server: the plate, the Printer / Filament / Process presets
// and every setting under them, slicing, and sending to the printer set up in the Printer preset.
//
// A printer is a hot, moving machine, so the AI gets less freedom here than in the design:
//   - it never sees the printer's password or API key;
//   - printer settings (including start/end G-code) are read-only unless the person allows them;
//   - values outside Cura's limits are refused, outside its warning range only when asked;
//   - out-of-date G-code is never sent, nor anything while a print is running;
//   - starting a print asks the person first unless they allow it.
import * as THREE from 'three';
import { ToolError } from './errors.js';
import { SCOPES, SCOPE_ORDER } from '../slicer/taxonomy.js';
import { fitProblem, arrange } from '../slicer/model.js';
import { sendGcode, openStatus, testConnection, KINDS } from '../slicer/printerlink.js';
import { formatTime } from '../slicer/engine.js';
import { FILAMENT_DENSITY } from '../slicer/profiles.js';
import { confirmDialog } from '../ui/dom.js';

const r2 = (v) => Math.round(v * 100) / 100;
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SCOPE = { type: 'string', enum: SCOPE_ORDER, description: 'printer (the machine), filament (the material) or process (how it is printed)' };

/** The Slicer workspace, loaded (without switching the person's view to it). */
async function slicer(app) {
  const ws = app.slicer;
  if (!ws.ready) ws.ready = ws._init().catch((err) => { console.error(err); ws._showGate(err); return false; });
  if (!(await ws.ready)) throw new ToolError('not_available', 'The slicing engine could not be loaded. The person can check the engine address in the Slicer workspace.');
  return ws;
}

const refreshPanel = (ws) => { if (ws.panel) { ws.panel._renderChrome(); ws.panel._renderBody(); } };
const plateChanged = (ws) => { ws._afterModelsChanged(); if (ws._renderModels) ws._renderModels(); ws._checkpoint(); };

// ------------------------------------------------------------------ settings as the AI sees them
function source(ws, key) {
  const s = ws.store, d = ws.defs.get(key);
  if (s.isOverridden(key)) return ws.profiles.isModified(key) ? 'override' : 'preset';
  return typeof d.value === 'string' ? 'formula' : 'default';
}

function settingOut(ws, key, { brief = false } = {}) {
  const s = ws.store, d = ws.defs.get(key), n = ws.info.get(key);
  const out = { key, label: d.label, scope: n.scope, page: n.page, type: d.type, value: s.get(key), source: source(ws, key) };
  if (d.unit) out.unit = d.unit;
  if (!s.isEnabled(key)) out.enabled = false;
  if (ws.profiles.isModified(key)) out.modified = true;
  if (brief) return out;
  const base = ws.profiles.baseline(key);
  if (base !== undefined) out.preset_value = base;
  if (d.default !== undefined) out.default = d.default;
  if (typeof d.value === 'string') out.formula = d.value;
  const l = s.limits(key);
  for (const [k, v] of [['min', l.min], ['max', l.max], ['min_warning', l.minWarn], ['max_warning', l.maxWarn]]) if (typeof v === 'number' && isFinite(v)) out[k] = r2(v);
  if (d.options) out.options = d.options;
  if (typeof d.enabled === 'string' && !s.isEnabled(key)) out.used_when = d.enabled;
  if (d.description) out.description = d.description;
  return out;
}

function settingKeys(ws) { return [...ws.info.keys()]; }

/** Check one new value against the setting's type and limits. Returns the value to store. */
function checkValue(ws, key, value, allowOut) {
  const d = ws.defs.get(key);
  const bad = (m) => { throw new ToolError('invalid_args', `${key}: ${m}`); };
  let v = value;
  switch (d.type) {
    case 'float': case 'int':
      if (typeof v === 'string' && v.trim() !== '') v = Number(v);
      if (typeof v !== 'number' || !isFinite(v)) bad('must be a number');
      if (d.type === 'int' && !Number.isInteger(v)) bad('must be a whole number');
      break;
    case 'bool': if (typeof v !== 'boolean') bad('must be true or false'); break;
    case 'enum': if (!d.options || !(v in d.options)) bad(`must be one of ${Object.keys(d.options || {}).join(', ')}`); break;
    case 'str': if (typeof v !== 'string') bad('must be text'); break;
    default: break;
  }
  if (d.type === 'float' || d.type === 'int') {
    const l = ws.store.limits(key);
    if ((l.min !== undefined && v < l.min) || (l.max !== undefined && v > l.max)) throw new ToolError('out_of_range', `${key} = ${v} is outside what Cura allows (${l.min ?? '…'} to ${l.max ?? '…'} ${d.unit || ''})`.trim());
    const warn = (l.minWarn !== undefined && v < l.minWarn) || (l.maxWarn !== undefined && v > l.maxWarn);
    if (warn && !allowOut) throw new ToolError('out_of_range', `${key} = ${v} is outside the usual range (${l.minWarn ?? '…'} to ${l.maxWarn ?? '…'} ${d.unit || ''}). Send allow_out_of_range: true if you really mean it.`.trim());
  }
  return v;
}

// ------------------------------------------------------------------ the plate
function modelOut(ws, m) {
  const s = m.size;
  return { id: String(m.id), name: m.name, position: [r2(m.x), r2(m.y)], rotation: [r2(m.rx), r2(m.ry), r2(m.rz)], scale: [r2(m.sx), r2(m.sy), r2(m.sz)], size: [r2(s.x), r2(s.y), r2(s.z)], locked: !!m.locked, hidden: !!m.hidden, fits: !fitProblem(m, ws.volume) || undefined, problem: fitProblem(m, ws.volume) || undefined };
}
function modelsOf(ws, ids) {
  return ids.map((id) => {
    const m = ws.models.find((x) => String(x.id) === String(id));
    if (!m) throw new ToolError('not_found', `No plate object with id ${id}. Call slicer_get_state for the ids.`);
    return m;
  });
}

function sliceOut(ws) {
  const r = ws.result;
  if (!r) return null;
  const s = r.summary;
  const dia = ws.store.get('material_diameter') || 1.75;
  const grams = s.filamentM != null ? (Math.PI * (dia / 2) ** 2 * s.filamentM * 1000) / 1000 * (FILAMENT_DENSITY[ws.profiles.selected.filament] || 1.24) : null;
  return { up_to_date: !ws.dirty, time: formatTime(s.seconds), seconds: s.seconds, filament_m: s.filamentM != null ? r2(s.filamentM) : null, filament_g: grams != null ? r2(grams) : null, layers: s.layers ?? r.parsed.layers, gcode_kb: Math.round(r.gcode.length / 1024) };
}

function connectionOut(ws) {
  const c = ws.profiles.connection();
  if (!c.url) return null;
  let address = c.url;
  try { const u = new URL(c.url); u.username = ''; u.password = ''; address = u.href.replace(/\/$/, ''); } catch { /* not a full URL: shown as typed */ }
  return { kind: c.kind, firmware: (KINDS[c.kind] || {}).label, address };
}

// ------------------------------------------------------------------ pictures
const VIEWS = { iso: [-60, 55], front: [-90, 80], top: [-90, 0.5], left: [180, 70], right: [0, 70] };
function slicerShot(ws, { view = 'iso', size = 768, layers, preview, frame }) {
  const sc = ws.scene;
  const w = Math.max(256, Math.min(1024, size | 0)), h = Math.round(w * 0.75);
  const cam = sc.persp;
  const saved = { pos: cam.position.clone(), target: sc.controls.target.clone(), aspect: cam.aspect, near: cam.near, far: cam.far, size: sc.renderer.getSize(new THREE.Vector2()), mode: sc.mode, camera: sc.camera };
  const showPreview = preview !== false && ws.result && !ws.dirty;
  try {
    sc.renderer.setSize(w, h, false);
    cam.aspect = w / h;
    sc.camera = cam;
    sc.setMode(showPreview ? 'preview' : 'model');
    if (showPreview && layers) sc.setLayerRange(Math.max(0, layers[0]), Math.min(ws.result.parsed.layers - 1, layers[1]));
    const v = ws.volume;
    const [t, p] = (VIEWS[view] || VIEWS.iso).map((a) => (a * Math.PI) / 180);
    const dir = new THREE.Vector3(Math.sin(p) * Math.cos(t), Math.sin(p) * Math.sin(t), Math.cos(p));
    // frame the objects on the plate (or the whole bed when there are none, or when asked)
    const shown = frame === 'bed' ? [] : ws._active();
    let target, dist;
    if (shown.length) {
      const b = shown.map((m) => m.bounds);
      const lo = [Math.min(...b.map((q) => q.minX)), Math.min(...b.map((q) => q.minY))], hi = [Math.max(...b.map((q) => q.maxX)), Math.max(...b.map((q) => q.maxY))];
      const zt = Math.max(...b.map((q) => q.height));
      target = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, zt / 2);
      const radius = Math.max(20, 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], zt));
      dist = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.15;
    } else {
      target = new THREE.Vector3(0, 0, Math.min(v.height, 60) / 3);
      dist = Math.max(v.width, v.depth) * 1.9;
    }
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.near = Math.max(0.5, dist / 200); cam.far = dist * 20;
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    sc.controls.target.copy(target);
    sc._aimHeadlight();
    sc.renderer.render(sc.scene, cam);
    const url = sc.renderer.domElement.toDataURL('image/png');
    return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png' };
  } finally {
    sc.renderer.setSize(saved.size.x, saved.size.y, false);
    cam.aspect = saved.aspect; cam.near = saved.near; cam.far = saved.far; cam.position.copy(saved.pos); cam.updateProjectionMatrix();
    sc.controls.target.copy(saved.target); sc.controls.update();
    sc.camera = saved.camera;
    sc.setMode(saved.mode);
    if (showPreview && layers) sc.setLayerRange(0, ws.result.parsed.layers - 1);
    sc.requestRender();
  }
}

const LOOK = { type: 'boolean', description: 'Also return a picture of the plate (or the sliced preview)' };

// ------------------------------------------------------------------ the tools
export function slicerTools() {
  const tool = (t) => ({ design: false, ownHistory: true, ...t });
  return [
    tool({
      name: 'slicer_get_state', title: 'Slicer: state', readOnly: true,
      description: 'The Slicer at a glance: the printer, filament and process presets in use (and which settings are changed from them), the build volume, the objects on the plate, the last slice (and whether it is out of date), and the printer connection (firmware and address only).',
      run: async (_a, { app }) => {
        const ws = await slicer(app);
        const p = ws.profiles;
        const presets = {};
        for (const sc of SCOPE_ORDER) { const cur = p.current(sc); presets[sc] = { id: cur.id, name: cur.name, builtin: !!cur.builtin, modified: p.modifiedKeys(sc) }; }
        return { data: {
          presets, build_volume: { ...ws.volume }, plate: ws.models.map((m) => modelOut(ws, m)),
          last_slice: sliceOut(ws), printer_connection: connectionOut(ws),
          permissions: { change_printer_settings: !!app.settings.mcpPrinterSettings, start_prints_without_asking: !!app.settings.mcpStartPrints },
          settings_pages: Object.fromEntries(SCOPE_ORDER.map((sc) => [sc, SCOPES[sc].pages.map(([id, label]) => ({ id, label }))])),
        } };
      },
    }),
    tool({
      name: 'slicer_list_settings', title: 'Slicer: find settings', readOnly: true,
      description: 'Find and read slicer settings (about 600 CuraEngine settings, filed by scope and page as in the Settings panel). Filter by keys, scope, page, words in the name or description, or only the changed ones. Each gives its value, where the value comes from (override, preset, formula, default), units, limits, options and whether it is in use. Use detail: false for short entries when listing many.',
      inputSchema: obj({ keys: { type: 'array', items: { type: 'string' } }, scope: SCOPE, page: { type: 'string' }, query: { type: 'string', description: 'Words to look for, e.g. "infill" or "first layer temperature"' }, modified_only: { type: 'boolean' }, include_unused: { type: 'boolean', description: 'Include settings that do nothing with the current values (default false unless keys are given)' }, detail: { type: 'boolean', description: 'Full detail (default true when 25 or fewer match)' }, limit: { type: 'integer', minimum: 1, maximum: 600 } }),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        let keys = a.keys && a.keys.length ? a.keys : settingKeys(ws);
        const unknown = keys.filter((k) => !ws.info.has(k));
        if (unknown.length) throw new ToolError('not_found', `Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Use query to search.`);
        if (a.scope) keys = keys.filter((k) => ws.info.get(k).scope === a.scope);
        if (a.page) keys = keys.filter((k) => ws.info.get(k).page === a.page);
        if (a.modified_only) keys = keys.filter((k) => ws.profiles.isModified(k));
        if (!(a.keys && a.keys.length) && !a.include_unused) keys = keys.filter((k) => ws.store.isEnabled(k));
        if (a.query) {
          const words = a.query.toLowerCase().split(/\s+/).filter(Boolean);
          keys = keys.filter((k) => { const d = ws.defs.get(k); const hay = `${k} ${d.label} ${d.description}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
        }
        const total = keys.length;
        keys = keys.slice(0, a.limit || 200);
        const detail = a.detail ?? keys.length <= 25;
        return { data: { count: total, shown: keys.length, settings: keys.map((k) => settingOut(ws, k, { brief: !detail })) } };
      },
    }),
    tool({
      name: 'slicer_list_presets', title: 'Slicer: presets', readOnly: true,
      description: 'The printer, filament and process presets (built in and saved), and which are selected.',
      inputSchema: obj({ scope: SCOPE }),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        const out = {};
        for (const sc of a.scope ? [a.scope] : SCOPE_ORDER) out[sc] = ws.profiles.list(sc).map((p) => ({ id: p.id, name: p.name, builtin: !!p.builtin, selected: ws.profiles.selected[sc] === p.id, note: p.note }));
        return { data: out };
      },
    }),
    tool({
      name: 'slicer_set_settings', title: 'Slicer: change settings',
      description: 'Change slicer settings, e.g. {"values": {"infill_sparse_density": 30, "layer_height": 0.16}}. Each value is checked against the setting\'s type and Cura\'s limits. Returns what changed, plus the settings whose formulas followed. Printer settings need the person\'s permission (see slicer_get_state).',
      inputSchema: obj({ values: { type: 'object', description: 'setting key -> new value' }, allow_out_of_range: { type: 'boolean' } }, ['values']),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        const entries = Object.entries(a.values || {});
        if (!entries.length) throw new ToolError('invalid_args', 'values is empty');
        const checked = [];
        for (const [k, v] of entries) {
          const n = ws.info.get(k);
          if (!n) throw new ToolError('not_found', `Unknown setting ${k}. Use slicer_list_settings with query to find it.`);
          if (n.scope === 'printer' && !app.settings.mcpPrinterSettings) throw new ToolError('not_allowed', `${k} is a printer setting. The person has not allowed AI apps to change printer settings (Settings → AI connection).`);
          checked.push([k, checkValue(ws, k, v, !!a.allow_out_of_range)]);
        }
        const watch = settingKeys(ws);
        const before = new Map(watch.map((k) => [k, JSON.stringify(ws.store.get(k))]));
        for (const [k, v] of checked) ws.store.set(k, v);
        const set = new Set(checked.map(([k]) => k));
        const followed = watch.filter((k) => !set.has(k) && before.get(k) !== JSON.stringify(ws.store.get(k)) && ws.store.isEnabled(k));
        refreshPanel(ws);
        const warnings = checked.filter(([k]) => ws.store.check(k) === 'warn').map(([k]) => k);
        return { text: `Changed ${checked.length} setting${checked.length > 1 ? 's' : ''}${followed.length ? `; ${followed.length} more followed through formulas` : ''}.${ws.result ? ' The last slice is now out of date.' : ''}`,
          data: { changed: checked.map(([k]) => settingOut(ws, k, { brief: true })), followed: followed.slice(0, 30).map((k) => ({ key: k, value: ws.store.get(k) })), followed_count: followed.length, outside_usual_range: warnings } };
      },
    }),
    tool({
      name: 'slicer_reset_settings', title: 'Slicer: reset settings',
      description: 'Put settings back to what the selected preset says: some keys, or a whole scope.',
      inputSchema: obj({ keys: { type: 'array', items: { type: 'string' } }, scope: SCOPE }),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        if (a.scope === 'printer' || (a.keys || []).some((k) => ws.info.get(k) && ws.info.get(k).scope === 'printer')) {
          if (!app.settings.mcpPrinterSettings) throw new ToolError('not_allowed', 'Printer settings can only be changed when the person allows it (Settings → AI connection).');
        }
        if (a.keys && a.keys.length) for (const k of a.keys) { if (!ws.info.has(k)) throw new ToolError('not_found', `Unknown setting ${k}`); ws.profiles.resetKey(k); }
        else if (a.scope) ws.profiles.resetScope(a.scope);
        else throw new ToolError('invalid_args', 'Give keys or a scope');
        refreshPanel(ws);
        return { text: 'Back to the preset values.' };
      },
    }),
    tool({
      name: 'slicer_select_preset', title: 'Slicer: choose a preset',
      description: 'Choose a printer, filament or process preset (by id or name). Changes made on top of the previous preset in that scope are dropped.',
      inputSchema: obj({ scope: SCOPE, preset: { type: 'string', description: 'Preset id or name' } }, ['scope', 'preset']),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        if (a.scope === 'printer' && !app.settings.mcpPrinterSettings) throw new ToolError('not_allowed', 'Choosing a printer preset needs the person\'s permission (Settings → AI connection).');
        const list = ws.profiles.list(a.scope);
        const p = list.find((x) => x.id === a.preset) || list.find((x) => x.name.toLowerCase() === String(a.preset).toLowerCase());
        if (!p) throw new ToolError('not_found', `No ${a.scope} preset "${a.preset}". There are: ${list.map((x) => x.name).join(', ')}`);
        ws.profiles.select(a.scope, p.id);
        refreshPanel(ws);
        ws._syncVolume(false);
        return { text: `Using ${a.scope} preset "${p.name}".` };
      },
    }),
    tool({
      name: 'slicer_save_preset', title: 'Slicer: save a preset',
      description: 'Save the current values of one scope as a preset: a new one with this name, or (update: true) over the selected saved preset. Saved presets sync to Google Drive like the ones saved in the panel.',
      inputSchema: obj({ scope: SCOPE, name: { type: 'string' }, update: { type: 'boolean' } }, ['scope']),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        if (a.scope === 'printer' && !app.settings.mcpPrinterSettings) throw new ToolError('not_allowed', 'Saving printer presets needs the person\'s permission (Settings → AI connection).');
        if (a.update) { if (!ws.profiles.update(a.scope)) throw new ToolError('invalid_args', 'The selected preset is built in: give a name to save a new one'); }
        else { if (!a.name || !a.name.trim()) throw new ToolError('invalid_args', 'name is needed for a new preset'); ws.profiles.saveAs(a.scope, a.name.trim()); }
        refreshPanel(ws);
        return { text: `Saved the ${a.scope} preset "${ws.profiles.current(a.scope).name}".` };
      },
    }),
    tool({
      name: 'slicer_add_to_plate', title: 'Slicer: add to the plate',
      description: 'Put objects from the open design on the build plate: all solid objects, or the given design ids. Each object (or group) becomes its own plate object, turned to need the least support and arranged on the bed.',
      inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, description: 'Design object ids (default: everything)' }, clear: { type: 'boolean', description: 'Empty the plate first' }, look: LOOK }),
      run: async (a, { app, editor }) => {
        const ws = await slicer(app);
        if (a.clear) { ws.models = ws.models.filter((m) => m.locked); ws.selected = null; }
        const before = new Set(ws.models.map((m) => m.id));
        const keep = [...editor.selection];
        try {
          if (a.ids && a.ids.length) {
            for (const id of a.ids) if (!editor.node(id)) throw new ToolError('not_found', `No design object with id ${id}`);
            editor.selection = new Set(a.ids);
          }
          await ws.addFromDesign({ selectedOnly: !!(a.ids && a.ids.length), quiet: true });
        } finally { editor.selection = new Set(keep.filter((id) => editor.node(id))); editor.refreshOutlines(); }
        await new Promise((r) => setTimeout(r, 80)); // the best-orientation pass runs just after adding
        const added = ws.models.filter((m) => !before.has(m.id));
        if (!added.length) throw new ToolError('failed', 'Nothing was added: the design has no solid objects (or the ids were holes)');
        plateChanged(ws);
        return { text: `Added ${added.length} object${added.length > 1 ? 's' : ''} to the plate.`, data: { plate: ws.models.map((m) => modelOut(ws, m)) }, images: a.look ? [slicerShot(ws, { preview: false })] : [] };
      },
    }),
    tool({
      name: 'slicer_update_plate_objects', title: 'Slicer: move or turn plate objects',
      description: 'Move a plate object on the bed (position = [x, y] of its footprint centre, mm, 0,0 is the bed centre), rotate it (degrees), scale it (percent) or set its size (mm, keeps proportions unless all three are given). Objects always rest on the bed.',
      inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, minItems: 1 }, position: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }, scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }, size: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }, name: { type: 'string' }, hidden: { type: 'boolean', description: 'Hidden objects are left out of the slice' }, look: LOOK }, ['ids']),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        const list = modelsOf(ws, a.ids);
        for (const m of list) {
          if (m.locked) throw new ToolError('locked', `${m.name} is locked on the plate`);
          if (a.rotation) [m.rx, m.ry, m.rz] = a.rotation;
          if (a.scale) { if (a.scale.some((s) => !(s > 0))) throw new ToolError('invalid_args', 'scale is in percent, above 0'); [m.sx, m.sy, m.sz] = a.scale; }
          if (a.size) {
            if (a.size.some((s) => !(s > 0))) throw new ToolError('invalid_args', 'size is [x, y, z] mm, above 0');
            const s = m.size;
            [m.sx, m.sy, m.sz] = [m.sx * a.size[0] / s.x, m.sy * a.size[1] / s.y, m.sz * a.size[2] / s.z];
          }
          if (a.position) [m.x, m.y] = a.position;
          if (a.name) m.name = a.name;
          if (a.hidden !== undefined) m.hidden = !!a.hidden;
          ws.scene.refreshModel(m);
        }
        plateChanged(ws);
        return { data: { objects: list.map((m) => modelOut(ws, m)) }, images: a.look ? [slicerShot(ws, { preview: false })] : [] };
      },
    }),
    tool({
      name: 'slicer_arrange_plate', title: 'Slicer: arrange the plate',
      description: 'Arrange everything on the bed with a gap between objects; with orient: true, first turn each object to need the least support.',
      inputSchema: obj({ orient: { type: 'boolean' }, look: LOOK }),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        if (!ws.models.length) throw new ToolError('invalid_args', 'The plate is empty');
        if (a.orient) { ws.autoOrient(ws._movable(), { added: true }); await new Promise((r) => setTimeout(r, 80)); }
        const ok = arrange(ws._movable(), ws.volume);
        plateChanged(ws);
        return { text: ok ? 'Arranged.' : "They don't all fit on the bed.", data: { plate: ws.models.map((m) => modelOut(ws, m)) }, images: a.look ? [slicerShot(ws, { preview: false })] : [] };
      },
    }),
    tool({
      name: 'slicer_remove_from_plate', title: 'Slicer: remove from the plate', destructive: true,
      description: 'Take objects off the plate (the design itself is not changed).',
      inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['ids']),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        const list = modelsOf(ws, a.ids);
        for (const m of list) { if (m.locked) throw new ToolError('locked', `${m.name} is locked on the plate`); ws._remove(m); }
        plateChanged(ws);
        return { text: `Removed ${list.length}.`, data: { plate: ws.models.map((m) => modelOut(ws, m)) } };
      },
    }),
    tool({
      name: 'slicer_slice', title: 'Slicer: slice',
      description: 'Slice the plate with the current settings. Returns the print time, filament (m and g), layer count and G-code size; with look: true also a picture of the sliced preview. Objects that do not fit, or settings that make useless G-code, are reported instead.',
      inputSchema: obj({ look: LOOK }),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        const active = ws._active();
        if (!active.length) throw new ToolError('invalid_args', 'The plate is empty: call slicer_add_to_plate first');
        const bad = active.filter((m) => fitProblem(m, ws.volume));
        if (bad.length) throw new ToolError('does_not_fit', bad.map((m) => `${m.name} is ${fitProblem(m, ws.volume)}`).join('; '));
        const block = ws._blockingProblems();
        if (block) throw new ToolError('invalid_settings', block);
        if (ws.controller) throw new ToolError('busy', 'A slice is already running');
        await ws.slice();
        if (!ws.result || ws.dirty) throw new ToolError('failed', `Slicing failed: ${ws.statusSub.textContent || 'see the Slicer workspace'}`);
        const out = sliceOut(ws);
        return { text: `Sliced: ${out.time}, ${out.filament_g ?? '?'} g of filament, ${out.layers} layers.`, data: out, images: a.look ? [slicerShot(ws, { preview: true })] : [] };
      },
    }),
    tool({
      name: 'slicer_screenshot', title: 'Slicer: picture', readOnly: true,
      description: 'A picture of the build plate, or of the sliced preview when the slice is up to date (layers [first, last] to show part of it). The person\'s own view is not changed.',
      inputSchema: obj({ view: { type: 'string', enum: Object.keys(VIEWS) }, frame: { type: 'string', enum: ['objects', 'bed'], description: 'objects (default) or the whole bed' }, layers: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, preview: { type: 'boolean', description: 'false: show the models even when sliced' }, size: { type: 'integer', minimum: 256, maximum: 1024 } }),
      run: async (a, { app }) => { const ws = await slicer(app); return { images: [slicerShot(ws, a)] }; },
    }),
    tool({
      name: 'slicer_export_gcode', title: 'Slicer: G-code', readOnly: true,
      description: 'The last sliced G-code, as a file.',
      run: async (_a, { app }) => {
        const ws = await slicer(app);
        if (!ws.result) throw new ToolError('invalid_args', 'Nothing has been sliced yet');
        const bytes = ws.result.gcode;
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const name = `${app._fileBase()}.gcode`;
        return { text: `${name}: ${Math.round(bytes.length / 1024)} KB${ws.dirty ? ' (out of date: settings or plate changed since)' : ''}`, resources: [{ uri: `dabblecad://gcode/${encodeURIComponent(name)}`, mimeType: 'text/x-gcode', blob: btoa(bin) }] };
      },
    }),
    tool({
      name: 'printer_status', title: 'Printer: status', readOnly: true, openWorld: true,
      description: 'Connect to the printer set up in the Printer preset and report its state (idle, printing, paused, done, error), file, progress, layer, temperatures and time left.',
      run: async (_a, { app }) => {
        const ws = await slicer(app);
        const cfg = ws.profiles.connection();
        if (!cfg.url) throw new ToolError('not_set_up', 'No printer connection is set up. The person sets it in the Slicer: Printer settings → Printer connection.');
        let st;
        try {
          const s = await openStatus(cfg);
          try { st = await s.read(); } finally { if (s.close) await s.close(); }
        } catch (e) {
          // the status call failed: say whether the printer can be reached at all
          try { await testConnection(cfg); } catch (e2) { throw new ToolError('unreachable', e2.message || String(e2)); }
          throw new ToolError('failed', e.message || String(e));
        }
        return { data: { printer: connectionOut(ws), state: st.state, file: st.file, progress: st.progress != null ? r2(st.progress * 100) + '%' : null, layer: st.layer, layers: st.layers, time_left: st.timeLeft != null ? formatTime(st.timeLeft) : null, elapsed: st.elapsed != null ? formatTime(st.elapsed) : null, temperatures: (st.temps || []).map((t) => ({ name: t.name, current: t.current != null ? r2(t.current) : null, target: t.target != null ? r2(t.target) : null })) } };
      },
    }),
    tool({
      name: 'printer_send', title: 'Printer: send', openWorld: true,
      description: 'Upload the sliced G-code to the printer. start: true also starts printing; unless the person has allowed it, they are asked to confirm in the app first. Refused when the slice is out of date or the printer is busy.',
      inputSchema: obj({ start: { type: 'boolean', description: 'Start printing after the upload (default false)' }, name: { type: 'string', description: 'File name on the printer (default: the design name)' } }),
      run: async (a, { app }) => {
        const ws = await slicer(app);
        if (!ws.result) throw new ToolError('invalid_args', 'Nothing has been sliced: call slicer_slice first');
        if (ws.dirty) throw new ToolError('out_of_date', 'The settings or the plate changed since the last slice: slice again first');
        const cfg = ws.profiles.connection();
        if (!cfg.url) throw new ToolError('not_set_up', 'No printer connection is set up. The person sets it in the Slicer: Printer settings → Printer connection.');
        // never send while something is printing
        try {
          const s = await openStatus(cfg);
          try { const st = await s.read(); if (st.state === 'printing' || st.state === 'paused') throw new ToolError('busy', `The printer is ${st.state}${st.file ? ` (${st.file})` : ''}. Wait until it is done.`); } finally { if (s.close) await s.close(); }
        } catch (e) { if (e instanceof ToolError) throw e; throw new ToolError('unreachable', e.message || String(e)); }
        const name = `${(a.name || app._fileBase()).replace(/\.gcode$/i, '').replace(/[^\w .()-]+/g, '_')}.gcode`;
        const sum = sliceOut(ws);
        if (a.start && !app.settings.mcpStartPrints) {
          const ok = await confirmDialog('Start this print?', `An AI app wants to start ${name} on ${cfg.url}: ${sum.time}, about ${sum.filament_g ?? '?'} g of filament. Make sure the bed is clear and the right filament is loaded.`, 'Start printing');
          if (!ok) throw new ToolError('declined', 'The person did not want to start the print now. You can upload it without starting (start: false).');
        }
        const msg = await sendGcode(cfg, { name, data: new Uint8Array(ws.result.gcode) }, { start: !!a.start });
        ws.printJob = { name, gcode: ws.result.gcode, parsed: ws.result.parsed, centerIsZero: ws.store.get('machine_center_is_zero') };
        return { text: `${msg}: ${name}${a.start ? '' : ' (not started)'}.`, data: { file: name, started: !!a.start, ...sum } };
      },
    }),
  ];
}
