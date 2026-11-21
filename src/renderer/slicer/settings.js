// Setting values: the user's overrides layered on top of Cura's defaults and formulas.
//
// A setting's value is the user's override when there is one; otherwise its `value` formula
// (which usually refers to other settings, so changing layer height ripples through to line
// widths, layer counts and so on); otherwise its default.
//
// Only a single extruder is modelled for now: extruderValue(n, key) and friends all read the one
// extruder, so the multi-extruder formulas in the definitions still evaluate.
import { compile, evaluate } from './pyexpr.js';

const ENGINE_ALWAYS = new Set(['machine_start_gcode', 'machine_end_gcode']);

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class SettingsStore {
  constructor(defs, overrides = {}) {
    this.defs = defs;
    this.overrides = { ...overrides };
    this.listeners = new Set();
    this._memo = new Map();
    this._enabled = new Map();
    this._stack = new Set();
    this._scope = {
      get: (name) => this.get(name),
      fns: {
        resolveOrValue: (k) => this.get(k),
        extruderValue: (_n, k) => this.get(k),
        extruderValues: (k) => [this.get(k)],
        defaultExtruderPosition: () => '0',
      },
    };
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _invalidate() { this._memo.clear(); this._enabled.clear(); for (const fn of this.listeners) fn(); }

  /** Replace every override at once (loading a profile). */
  setOverrides(overrides) {
    this.overrides = {};
    for (const [k, v] of Object.entries(overrides || {})) if (this.defs.get(k)) this.overrides[k] = v;
    this._invalidate();
  }
  /** Merge overrides (applying a preset on top of the current ones). */
  patch(overrides) {
    for (const [k, v] of Object.entries(overrides)) if (this.defs.get(k)) this.overrides[k] = v;
    this._invalidate();
  }

  isOverridden(key) { return Object.prototype.hasOwnProperty.call(this.overrides, key); }

  set(key, value) {
    const d = this.defs.get(key);
    if (!d) return;
    this.overrides[key] = this.coerce(d, value);
    this._invalidate();
  }
  reset(key) { if (this.isOverridden(key)) { delete this.overrides[key]; this._invalidate(); } }

  coerce(d, value) {
    switch (d.type) {
      case 'float': { const v = parseFloat(value); return Number.isFinite(v) ? v : d.default; }
      case 'int': { const v = parseInt(value, 10); return Number.isFinite(v) ? v : d.default; }
      case 'bool': return value === true || value === 'true';
      case 'extruder': case 'optional_extruder': return String(value);
      default: return value;
    }
  }

  /** Current value of a setting. */
  get(key) {
    if (this._memo.has(key)) return this._memo.get(key);
    const d = this.defs.get(key);
    if (!d) throw new Error('Unknown setting ' + key);
    let v;
    if (this.isOverridden(key)) v = this.overrides[key];
    else if (typeof d.value === 'string' && !this._stack.has(key)) {
      this._stack.add(key);
      try { v = this._coerceResult(d, evaluate(compile(d.value), this._scope)); } catch (err) { console.warn(`Formula for ${key} failed: ${err.message}`); v = d.default; } finally { this._stack.delete(key); }
    } else if (d.value !== undefined && typeof d.value !== 'string') v = d.value;
    else v = d.default;
    this._memo.set(key, v);
    return v;
  }

  _coerceResult(d, v) {
    if (d.type === 'float' || d.type === 'int') { if (typeof v === 'boolean') return v ? 1 : 0; if (d.type === 'int' && typeof v === 'number') return Math.round(v); return typeof v === 'number' ? v : parseFloat(v); }
    if (d.type === 'extruder' || d.type === 'optional_extruder') return String(v);
    return v;
  }

  _expr(raw, fallback) {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== 'string') return raw;
    try { return evaluate(compile(raw), this._scope); } catch { return fallback; }
  }

  /** Whether Cura would show / use this setting given the current values. */
  isEnabled(key) {
    if (this._enabled.has(key)) return this._enabled.get(key);
    const d = this.defs.get(key);
    let on = d.enabled === undefined ? true : !!this._expr(d.enabled, true);
    // a child is only relevant when its parent is
    this._enabled.set(key, on);
    return on;
  }

  limits(key) {
    const d = this.defs.get(key);
    return {
      min: this._expr(d.min, undefined), max: this._expr(d.max, undefined),
      minWarn: this._expr(d.minWarn, undefined), maxWarn: this._expr(d.maxWarn, undefined),
    };
  }

  /** 'ok' | 'warn' | 'error' for the current value against its limits. */
  check(key) {
    const d = this.defs.get(key);
    if (d.type !== 'float' && d.type !== 'int') return 'ok';
    const v = this.get(key), l = this.limits(key);
    if ((l.min !== undefined && v < l.min) || (l.max !== undefined && v > l.max)) return 'error';
    if ((l.minWarn !== undefined && v < l.minWarn) || (l.maxWarn !== undefined && v > l.maxWarn)) return 'warn';
    return 'ok';
  }

  /** Keys whose current value differs from Cura's default (or that the user set). */
  asEngineString(key) {
    const d = this.defs.get(key), v = this.get(key);
    if (v === undefined || v === null) return '';
    return Array.isArray(v) ? JSON.stringify(v) : String(v);
  }

  /**
   * The `-s key=value` pairs CuraEngine needs. The engine only knows each setting's default, so
   * anything that differs from the default has to be passed. Settings that are switched off by
   * other settings are left out, as Cura's own front end does.
   */
  engineSettings() {
    const out = {};
    const subst = (text) => String(text).replace(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g, (all, k) => (this.defs.get(k) ? this.asEngineString(k) : all));
    for (const d of this.defs.settings()) {
      if (d.type === 'category' || d.key === 'extruder_nr') continue;
      const str = this.asEngineString(d.key);
      const def = Array.isArray(d.default) ? JSON.stringify(d.default) : String(d.default);
      if (str === '' || (str === def && !ENGINE_ALWAYS.has(d.key))) continue;
      if (!this.isEnabled(d.key) && !this.isOverridden(d.key)) continue;
      out[d.key] = str;
    }
    // Cura fills {setting} placeholders in the start and end G-code itself, and stops the engine
    // adding its own heating commands when the script heats the printer.
    const start = String(this.get('machine_start_gcode'));
    for (const key of ['machine_start_gcode', 'machine_end_gcode']) out[key] = subst(this.get(key));
    if (/\{material_print_temperature/.test(start)) out.material_print_temp_prepend = 'false';
    if (/\{material_bed_temperature/.test(start)) out.material_bed_temp_prepend = 'false';
    return out;
  }
}

export { sameValue };
