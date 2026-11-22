// Presets for the three scopes (printer, filament, process) and the working state on top of them.
//
// Each scope has its own preset: a set of overrides to Cura's defaults for the settings that belong
// to that scope. Choosing a preset replaces that scope's overrides; editing a setting afterwards
// marks it as modified against the preset, and the preset can be saved under a new name.
import { SCOPE_ORDER } from './taxonomy.js';

const MARLIN = 'RepRap (Marlin/Sprinter)';
const HEAD = [[-20, 10], [10, 10], [10, -10], [-20, -10]];

const START = 'G90 ; absolute positioning\nM82 ; absolute extrusion\nG28 ; home all axes\nG92 E0\nG1 Z2.0 F3000\nG1 X5 Y10 Z0.3 F5000 ; move to the prime line\nG1 X5 Y110 Z0.3 F1500 E15 ; prime line\nG92 E0\nG1 Z2.0 F3000';
const END = 'M104 S0 ; hot end off\nM140 S0 ; bed off\nG91 ; relative positioning\nG1 E-2 F2700 ; retract\nG1 Z10 F3000 ; lift\nG90 ; absolute positioning\nG1 X0 Y{machine_depth} F3000 ; present the print\nM106 S0 ; fan off\nM84 ; motors off';

function cartesian(w, d, h, extra = {}) {
  return {
    machine_width: w, machine_depth: d, machine_height: h, machine_shape: 'rectangular', machine_center_is_zero: false,
    machine_heated_bed: true, machine_gcode_flavor: MARLIN, machine_nozzle_size: 0.4,
    machine_start_gcode: START, machine_end_gcode: END,
    machine_head_with_fans_polygon: HEAD, gantry_height: 30,
    retraction_enable: true, retraction_amount: 5, retraction_speed: 45, ...extra,
  };
}

export const BUILTIN = {
  printer: [
    { id: 'generic220', name: 'Generic Marlin 220 × 220 × 250', note: 'A common size. Check the start G-code suits your machine.', overrides: cartesian(220, 220, 250) },
    { id: 'ender3', name: 'Creality Ender-3 (220 × 220 × 250)', note: 'Bed size only; check the start G-code and retraction for your setup.', overrides: cartesian(220, 220, 250) },
    { id: 'cr10', name: 'Creality CR-10 (300 × 300 × 400)', note: 'Bed size only; check the start G-code and retraction for your setup.', overrides: cartesian(300, 300, 400) },
    { id: 'mk3s', name: 'Prusa i3 MK3S+ (250 × 210 × 210)', note: 'Bed size only; Prusa printers want their own start G-code.', overrides: cartesian(250, 210, 210) },
    { id: 'mini', name: 'Prusa MINI+ (180 × 180 × 180)', note: 'Bed size only; Prusa printers want their own start G-code.', overrides: cartesian(180, 180, 180) },
    {
      id: 'voron350', name: 'Voron 2.4 350 (Klipper)', note: 'Assumes your printer.cfg has PRINT_START and PRINT_END macros.',
      overrides: cartesian(350, 350, 330, {
        machine_start_gcode: 'PRINT_START BED_TEMP={material_bed_temperature_layer_0} EXTRUDER_TEMP={material_print_temperature_layer_0}',
        machine_end_gcode: 'PRINT_END', retraction_amount: 0.5, retraction_speed: 40,
      }),
    },
    {
      id: 'delta200', name: 'Generic delta (round 200 × 300)', note: 'A round bed whose origin is its centre.',
      overrides: cartesian(200, 200, 300, {
        machine_shape: 'elliptic', machine_center_is_zero: true,
        machine_start_gcode: 'G90\nM82\nG28\nG92 E0', machine_end_gcode: 'M104 S0\nM140 S0\nG91\nG1 E-2 F2700\nG1 Z10 F3000\nG90\nG28 X0 Y0\nM84',
      }),
    },
  ],
  filament: [
    { id: 'pla', name: 'Generic PLA', overrides: { material_diameter: 1.75, material_print_temperature: 205, material_print_temperature_layer_0: 210, material_bed_temperature: 60, material_bed_temperature_layer_0: 60, cool_fan_enabled: true, cool_fan_speed: 100 } },
    { id: 'petg', name: 'Generic PETG', overrides: { material_diameter: 1.75, material_print_temperature: 235, material_print_temperature_layer_0: 240, material_bed_temperature: 80, material_bed_temperature_layer_0: 80, cool_fan_enabled: true, cool_fan_speed: 50 } },
    { id: 'abs', name: 'Generic ABS', overrides: { material_diameter: 1.75, material_print_temperature: 245, material_print_temperature_layer_0: 245, material_bed_temperature: 100, material_bed_temperature_layer_0: 100, cool_fan_enabled: false } },
    { id: 'asa', name: 'Generic ASA', overrides: { material_diameter: 1.75, material_print_temperature: 250, material_print_temperature_layer_0: 250, material_bed_temperature: 100, material_bed_temperature_layer_0: 100, cool_fan_enabled: true, cool_fan_speed: 20 } },
    { id: 'tpu', name: 'Generic TPU', overrides: { material_diameter: 1.75, material_print_temperature: 225, material_print_temperature_layer_0: 225, material_bed_temperature: 50, material_bed_temperature_layer_0: 50, cool_fan_enabled: true, cool_fan_speed: 60 } },
  ],
  process: [
    { id: 'standard', name: '0.20 mm Standard', overrides: { layer_height: 0.2, wall_thickness: 1.2, infill_sparse_density: 20, speed_print: 50, speed_travel: 150 } },
    { id: 'draft', name: '0.28 mm Draft', overrides: { layer_height: 0.28, wall_thickness: 1.2, infill_sparse_density: 10, speed_print: 60, speed_travel: 150 } },
    { id: 'fine', name: '0.12 mm Fine', overrides: { layer_height: 0.12, wall_thickness: 1.2, top_bottom_thickness: 1.0, infill_sparse_density: 20, speed_print: 40, speed_travel: 150 } },
    { id: 'strong', name: '0.20 mm Strong', overrides: { layer_height: 0.2, wall_thickness: 1.6, top_bottom_thickness: 1.2, infill_sparse_density: 40, speed_print: 45, speed_travel: 150 } },
    { id: 'cura', name: 'Cura defaults', overrides: {} },
  ],
};

export const DEFAULT_SELECTION = { printer: 'generic220', filament: 'pla', process: 'standard' };

export class Profiles {
  /**
   * @param store SettingsStore
   * @param info  Map key -> { scope } from taxonomy.buildIndex
   * @param saved previously persisted state (or undefined)
   * @param persist callback(state) to save it
   */
  constructor(store, info, saved, persist) {
    this.store = store; this.info = info; this.persist = persist || (() => {});
    const s = saved || {};
    this.user = { printer: [], filament: [], process: [], ...(s.user || {}) };
    this.selected = { ...DEFAULT_SELECTION, ...(s.selected || {}) };
    for (const sc of SCOPE_ORDER) if (!this.find(sc, this.selected[sc])) this.selected[sc] = DEFAULT_SELECTION[sc];
    if (s.overrides) store.setOverrides(s.overrides);
    else for (const sc of SCOPE_ORDER) this._apply(sc, this.find(sc, this.selected[sc]));
    this.level = s.level || 'simple';
    store.onChange(() => this.save());
  }

  save() {
    this.persist({ user: this.user, selected: this.selected, overrides: this.store.overrides, level: this.level });
  }

  list(scope) { return [...BUILTIN[scope].map((p) => ({ ...p, builtin: true })), ...this.user[scope]]; }
  find(scope, id) { return this.list(scope).find((p) => p.id === id); }
  current(scope) { return this.find(scope, this.selected[scope]); }

  keysOf(scope) { return [...this.info].filter(([, n]) => n.scope === scope).map(([k]) => k); }

  _apply(scope, preset) {
    const next = { ...this.store.overrides };
    for (const k of this.keysOf(scope)) delete next[k];
    for (const [k, v] of Object.entries((preset && preset.overrides) || {})) next[k] = v;
    this.store.setOverrides(next);
  }

  select(scope, id) {
    const p = this.find(scope, id);
    if (!p) return;
    this.selected[scope] = id;
    this._apply(scope, p);
    this.save();
  }

  /** Overrides belonging to one scope in the working state. */
  scopeOverrides(scope) {
    const out = {};
    for (const k of this.keysOf(scope)) if (this.store.isOverridden(k)) out[k] = this.store.overrides[k];
    return out;
  }

  /** The value a setting has in the selected preset (undefined when the preset leaves it at Cura's default). */
  baseline(key) {
    const n = this.info.get(key);
    const p = n && this.current(n.scope);
    return p ? p.overrides[key] : undefined;
  }

  /** Is this setting different from the selected preset? */
  isModified(key) {
    const base = this.baseline(key);
    const has = this.store.isOverridden(key);
    if (!has) return base !== undefined;
    return base === undefined || JSON.stringify(base) !== JSON.stringify(this.store.overrides[key]);
  }

  modifiedKeys(scope) { return this.keysOf(scope).filter((k) => this.isModified(k)); }

  /** Put one setting back to what the preset says. */
  resetKey(key) {
    const base = this.baseline(key);
    if (base === undefined) this.store.reset(key); else this.store.set(key, base);
  }
  resetScope(scope) { this._apply(scope, this.current(scope)); this.save(); }

  /** Add a ready-made preset (e.g. read from a Cura project) and select it. */
  addPreset(scope, name, overrides) {
    const keys = new Set(this.keysOf(scope));
    const id = 'user-' + Date.now().toString(36) + '-' + scope;
    this.user[scope].push({ id, name, overrides: Object.fromEntries(Object.entries(overrides).filter(([k]) => keys.has(k))) });
    this.select(scope, id);
    return id;
  }

  saveAs(scope, name) {
    const id = 'user-' + Date.now().toString(36);
    this.user[scope].push({ id, name, overrides: this.scopeOverrides(scope) });
    this.selected[scope] = id;
    this.save();
    return id;
  }
  /** Overwrite the selected user preset with the current values. */
  update(scope) {
    const p = this.current(scope);
    if (!p || p.builtin) return false;
    p.overrides = this.scopeOverrides(scope);
    this.save();
    return true;
  }
  rename(scope, name) { const p = this.current(scope); if (p && !p.builtin) { p.name = name; this.save(); } }
  remove(scope) {
    const p = this.current(scope);
    if (!p || p.builtin) return false;
    this.user[scope] = this.user[scope].filter((x) => x.id !== p.id);
    this.selected[scope] = DEFAULT_SELECTION[scope];
    this._apply(scope, this.find(scope, this.selected[scope]));
    this.save();
    return true;
  }

  setLevel(level) { this.level = level; this.save(); }

  /** One scope as JSON text, for sharing or backup. */
  exportScope(scope) {
    const p = this.current(scope);
    return JSON.stringify({ format: 'dabblecad-slicer-preset', scope, name: p ? p.name : scope, overrides: this.scopeOverrides(scope) }, null, 2);
  }
  importScope(text) {
    const d = JSON.parse(text);
    if (d.format !== 'dabblecad-slicer-preset' || !SCOPE_ORDER.includes(d.scope) || typeof d.overrides !== 'object') throw new Error('This is not a DabbleCAD slicer preset');
    const keys = new Set(this.keysOf(d.scope));
    const overrides = Object.fromEntries(Object.entries(d.overrides).filter(([k]) => keys.has(k)));
    const id = 'user-' + Date.now().toString(36);
    this.user[d.scope].push({ id, name: String(d.name || 'Imported'), overrides });
    this.select(d.scope, id);
    return d.scope;
  }
}

/** g/cm³, to estimate the weight of the filament a print uses (user presets assume PLA). */
export const FILAMENT_DENSITY = { pla: 1.24, petg: 1.27, abs: 1.04, asa: 1.07, tpu: 1.21 };
