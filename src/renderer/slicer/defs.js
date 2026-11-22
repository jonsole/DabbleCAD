// Cura setting definitions: loads fdmprinter.def.json / fdmextruder.def.json and flattens them into
// a lookup of settings plus a category tree for the UI.

export const SETTING_TYPES = ['float', 'int', 'bool', 'enum', 'str', '[int]', 'extruder', 'optional_extruder', 'polygon', 'polygons', 'vec2'];

// Keys from the extruder definition that the printer definition does not have; they are shown in the
// Machine category next to the nozzle settings.
const EXTRUDER_ONLY_CATEGORY = 'machine_settings';

export class Definitions {
  constructor(printerDef, extruderDef) {
    this.byKey = new Map();
    this.categories = [];
    for (const [key, raw] of Object.entries(printerDef.settings)) this.categories.push(this._add(key, raw, null, key));
    if (extruderDef) this._mergeExtruder(extruderDef);
  }

  _add(key, raw, parent, category) {
    const children = [];
    const s = {
      key, category, parent,
      label: raw.label || key,
      description: raw.description || '',
      type: raw.type,
      unit: raw.unit || '',
      default: raw.default_value,
      value: raw.value,
      enabled: raw.enabled,
      min: raw.minimum_value, max: raw.maximum_value,
      minWarn: raw.minimum_value_warning, maxWarn: raw.maximum_value_warning,
      options: raw.options || null,
      icon: raw.icon || null,
      perExtruder: !!raw.settable_per_extruder,
      perMesh: !!raw.settable_per_mesh,
      children,
    };
    this.byKey.set(key, s);
    for (const [ck, cr] of Object.entries(raw.children || {})) children.push(this._add(ck, cr, key, category));
    return s;
  }

  _mergeExtruder(def) {
    const machine = this.byKey.get(EXTRUDER_ONLY_CATEGORY);
    const walk = (settings) => {
      for (const [key, raw] of Object.entries(settings)) {
        if (raw.type === 'category') { walk(raw.children || {}); continue; }
        if (this.byKey.has(key)) continue;
        // the extruder number is plumbing, not something to configure
        if (key === 'extruder_nr') continue;
        machine.children.push(this._add(key, raw, EXTRUDER_ONLY_CATEGORY, EXTRUDER_ONLY_CATEGORY));
      }
    };
    walk(def.settings);
  }

  get(key) { return this.byKey.get(key); }
  /** Every setting that holds a value (not a category). */
  *settings() { for (const s of this.byKey.values()) if (s.type !== 'category') yield s; }
}

/** Fetch and parse both definition files. `base` is the folder that serves them. */
export async function loadDefinitions(base) {
  const get = async (name) => {
    const res = await fetch(new URL(name, base).href);
    if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
    return res.json();
  };
  const [printer, extruder] = await Promise.all([get('fdmprinter.def.json'), get('fdmextruder.def.json')]);
  return new Definitions(printer, extruder);
}
