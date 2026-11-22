// Read the printer, material and quality settings out of a Cura project (.3mf). Cura stores them next to
// the models, in a Cura/ folder of .inst.cfg (settings) and .xml.fdm_material (material) files.
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';

/** Lowest first: later kinds override earlier ones, as in Cura's own stack. */
const ORDER = ['definition_changes', 'variant', 'material', 'quality', 'quality_changes', 'user'];

function parseIni(text) {
  const out = {};
  let section = null, lastKey = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*[#;]/.test(raw)) continue;
    const sec = raw.match(/^\[(.+)\]\s*$/);
    if (sec) { section = out[sec[1]] = out[sec[1]] || {}; lastKey = null; continue; }
    if (!section) continue;
    if (/^\s/.test(raw) && lastKey) { section[lastKey] += '\n' + raw.trim(); continue; }   // wrapped value
    const i = raw.search(/[=:]/);
    if (i < 0) continue;
    lastKey = raw.slice(0, i).trim();
    section[lastKey] = raw.slice(i + 1).trim();
  }
  return out;
}

const unescape = (v) => v.replace(/\\n/g, '\n').replace(/%%/g, '%');

/** Convert Cura's text value to what the settings store expects. Returns undefined to skip it. */
function typed(def, raw) {
  const v = unescape(raw);
  if (v.startsWith('=')) return undefined;                 // a formula that depends on other settings
  switch (def.type) {
    case 'float': { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; }
    case 'int': { const n = parseInt(v, 10); return Number.isFinite(n) ? n : undefined; }
    case 'bool': return /^true$/i.test(v);
    case 'polygon': case 'polygons': try { return JSON.parse(v); } catch { return undefined; }
    case 'float_list': case 'list': try { return JSON.parse(v); } catch { return v; }
    default: return v;
  }
}

/** Material file: the few temperatures and sizes we can take from it (lowest priority). */
function readMaterial(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const text = (sel) => { const e = doc.querySelector(sel); return e ? e.textContent.trim() : ''; };
  const vals = {};
  const setting = (name, key) => { const e = [...doc.querySelectorAll('settings > setting')].find((s) => s.getAttribute('key') === name); if (e) vals[key] = e.textContent.trim(); };
  setting('print temperature', 'material_print_temperature');
  setting('heated bed temperature', 'material_bed_temperature');
  setting('standby temperature', 'material_standby_temperature');
  setting('retraction amount', 'retraction_amount');
  setting('flow', 'material_flow');
  const d = text('properties > diameter');
  if (d) vals.material_diameter = d;
  return { name: [text('metadata > name > brand'), text('metadata > name > material'), text('metadata > name > color')].filter(Boolean).join(' '), values: vals, density: parseFloat(text('properties > density')) || null };
}

/**
 * @param bytes Uint8Array of the .3mf   @param defs Map key -> definition ({type})
 * @param scopeOf (key) -> 'printer' | 'filament' | 'process' | null
 * @returns { presets: [{scope, name, overrides}], skipped: [string], machine: string }
 */
export function readCuraProject(bytes, defs, scopeOf) {
  const files = unzipSync(bytes);
  const all = Object.keys(files);
  const names = all.filter((n) => /(^|\/)cura\//i.test(n));
  if (!names.length) throw new Error('This 3MF has no Cura settings in it. In Cura use File → Save Project…');
  const seen = [];
  const kinds = {};            // kind -> merged raw values
  let machine = '', quality = '', materialInfo = null;
  for (const n of names) {
    if (/\.(inst|extruder|global)?\.?cfg$/i.test(n) && !/preferences\.cfg$/i.test(n)) {
      const ini = parseIni(strFromU8(files[n]));
      if (!ini.values) {                                        // a machine / extruder stack, not a settings container
        if (ini.general && ini.general.name && /global/i.test(n) && !machine) machine = ini.general.name;
        continue;
      }
      const kind = (ini.metadata && ini.metadata.type) || (/_user\b|user_/.test(n) ? 'user' : /changes/i.test(n) ? 'quality_changes' : '');
      seen.push(`${n} (${kind || 'unknown type'}, ${Object.keys(ini.values).length} values)`);
      if (!ORDER.includes(kind)) continue;
      Object.assign((kinds[kind] = kinds[kind] || {}), ini.values || {});
      if (kind === 'quality_changes' && ini.general && ini.general.name && !quality) quality = ini.general.name;
    } else if (/\.global\.cfg$/i.test(n)) {
      const ini = parseIni(strFromU8(files[n]));
      if (ini.general && ini.general.name) machine = ini.general.name;
    } else if (/\.fdm_material$/i.test(n) && !materialInfo) {
      try { materialInfo = readMaterial(strFromU8(files[n])); } catch { /* optional */ }
    }
  }
  if (materialInfo) kinds.material = { ...materialInfo.values, ...(kinds.material || {}) };
  const merged = {};
  for (const k of ORDER) Object.assign(merged, kinds[k] || {});
  const by = { printer: {}, filament: {}, process: {} };
  const skipped = [];
  for (const [key, raw] of Object.entries(merged)) {
    const def = defs.get(key);
    const scope = def && scopeOf(key);
    if (!def || !scope) { skipped.push(key); continue; }
    const v = typed(def, String(raw));
    if (v === undefined) { skipped.push(key); continue; }
    by[scope][key] = v;
  }
  if (!Object.keys(merged).length || (skipped.length && !Object.values(by).some((o) => Object.keys(o).length))) {
    console.warn('Cura import found:', { files: all, containers: seen, skipped });
    throw new Error(`No settings found. ${seen.length ? `Read ${seen.length} Cura containers but none matched this slicer's settings` : `The project has ${names.length} Cura files but no settings containers`} (details in the browser console).`);
  }
  const label = machine || 'Cura';
  const presets = [];
  if (Object.keys(by.printer).length) presets.push({ scope: 'printer', name: label, overrides: by.printer });
  if (Object.keys(by.filament).length) presets.push({ scope: 'filament', name: (materialInfo && materialInfo.name) || `${label} material`, overrides: by.filament });
  if (Object.keys(by.process).length) presets.push({ scope: 'process', name: quality || `${label} settings`, overrides: by.process });
  return { presets, skipped, machine: label };
}
