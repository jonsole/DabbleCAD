// Which settings belong to the printer, the filament or the print process, and on which page.
//
// Cura files its settings by *topic* (a "Machine" category that also holds filament diameter,
// a "Travel" category that holds retraction, ...), which makes it hard to tell what a setting
// belongs to. This follows OrcaSlicer's model instead: three presets that you pick and edit
// separately.
//
//   Printer   the machine itself: bed, G-code flavour, start/end G-code, nozzle, retraction, motion limits
//   Filament  the material: temperatures, flow, cooling
//   Process   how the part is printed: layers, walls, infill, speed, support, adhesion
//
// Every setting lands in exactly one scope and page, or is hidden because it only matters for
// several extruders (which the workspace does not support yet).

export const SCOPES = {
  printer: {
    label: 'Printer', color: '#2bb3a3',
    blurb: 'Your machine: bed, G-code, nozzle and retraction, motion limits.',
    pages: [
      ['basic', 'Basic information'], ['gcode', 'Machine G-code'], ['extruder', 'Extruder & retraction'],
      ['motion', 'Motion ability'],
    ],
  },
  filament: {
    label: 'Filament', color: '#f0883e',
    blurb: 'The material: temperatures, flow and cooling.',
    pages: [['filament', 'Filament'], ['cooling', 'Cooling'], ['advanced', 'Advanced']],
  },
  process: {
    label: 'Process', color: '#4f8cff',
    blurb: 'How the part is printed: layers, walls, infill, speed, support, adhesion.',
    pages: [
      ['quality', 'Quality'], ['strength', 'Strength'], ['speed', 'Speed'], ['travel', 'Travel'],
      ['support', 'Support'], ['adhesion', 'Adhesion'], ['others', 'Others'],
    ],
  },
};
export const SCOPE_ORDER = ['printer', 'filament', 'process'];

// Cura categories that are not offered at all
const HIDDEN_CATEGORIES = new Set(['dual', 'command_line_settings']);
// Plumbing for several extruders, mesh placement and machine identity
const HIDDEN_KEYS = new Set([
  'machine_extruder_count', 'extruders_enabled_count', 'extruder_nr', 'material_guid', 'machine_show_variants',
  'machine_extruders_share_heater', 'machine_extruders_share_nozzle', 'machine_extruders_shared_nozzle_initial_retraction',
  'machine_nozzle_id', 'machine_extruder_cooling_fan_number', 'machine_use_extruder_offset_to_offset_coords',
  'machine_extruder_start_pos_abs', 'machine_extruder_start_pos_x', 'machine_extruder_start_pos_y',
  'machine_extruder_end_pos_abs', 'machine_extruder_end_pos_x', 'machine_extruder_end_pos_y',
  'machine_nozzle_offset_x', 'machine_nozzle_offset_y', 'machine_extruder_start_code', 'machine_extruder_end_code',
  'machine_min_cool_heat_time_window', 'machine_name', 'machine_always_write_active_tool',
]);

const rx = (re) => (k) => re.test(k);
const isMotion = rx(/feedrate|acceleration|jerk|steps_per_mm|endstop|feeder_wheel/);
const isRetraction = rx(/^(retraction_(?!combing)|retract_at_layer_change|limit_support_retractions)/);

/** { scope, page } for a definition, or null when the setting is not offered. */
export function classify(def) {
  const k = def.key, cat = def.category;
  if (def.type === 'category' || HIDDEN_CATEGORIES.has(cat) || HIDDEN_KEYS.has(k)) return null;
  if (def.type === 'extruder' || def.type === 'optional_extruder') return null;

  if (cat === 'machine_settings') {
    if (k === 'material_diameter') return { scope: 'filament', page: 'filament' };
    if (/^material_/.test(k)) return { scope: 'printer', page: 'gcode' }; // heating commands around the start G-code
    if (k === 'machine_start_gcode' || k === 'machine_end_gcode') return { scope: 'printer', page: 'gcode' };
    if (isMotion(k) || k === 'machine_minimum_feedrate') return { scope: 'printer', page: 'motion' };
    if (k === 'nozzle_disallowed_areas') return { scope: 'printer', page: 'basic' };
    if (/nozzle|extruder|heat_zone|filament_park|firmware_retract|prime_pos/.test(k)) return { scope: 'printer', page: 'extruder' };
    if (/^machine_(width|depth|height|shape|buildplate_type|heated_bed|heated_build_volume|center_is_zero|gcode_flavor|disallowed_areas|head_with_fans_polygon)$|^(gantry_height|nozzle_disallowed_areas)$/.test(k)) return { scope: 'printer', page: 'basic' };
    return { scope: 'printer', page: 'advanced' };
  }
  if (k === 'extruder_prime_pos_x' || k === 'extruder_prime_pos_y' || k === 'extruder_prime_pos_z') return { scope: 'printer', page: 'extruder' };

  if (cat === 'travel') return isRetraction(k) ? { scope: 'printer', page: 'extruder' } : { scope: 'process', page: 'travel' };
  if (cat === 'material') {
    if (/^(material_(print_temperature|print_temperature_layer_0|initial_print_temperature|final_print_temperature|bed_temperature|bed_temperature_layer_0|flow|flow_layer_0|standby_temperature)|default_material_(print|bed)_temperature|build_volume_temperature)$/.test(k) || /_material_flow$|^prime_tower_flow$/.test(k)) return { scope: 'filament', page: 'filament' };
    return { scope: 'filament', page: 'advanced' };
  }
  if (cat === 'cooling') return { scope: 'filament', page: 'cooling' };
  const processPage = { resolution: 'quality', shell: 'strength', top_bottom: 'strength', infill: 'strength', speed: 'speed', support: 'support', platform_adhesion: 'adhesion', meshfix: 'others', blackmagic: 'others', experimental: 'others' };
  if (processPage[cat]) return { scope: 'process', page: processPage[cat] };
  return { scope: 'process', page: 'others' };
}

// ------------------------------------------------------------------ visibility levels
// Like OrcaSlicer's Simple / Advanced / Develop: Simple shows the settings most people touch,
// Advanced everything but the experimental ones, Expert everything.
export const LEVELS = [['simple', 'Simple'], ['advanced', 'Advanced'], ['expert', 'Expert']];

export const SIMPLE = new Set([
  // printer
  'machine_width', 'machine_depth', 'machine_height', 'machine_shape', 'machine_center_is_zero', 'machine_heated_bed', 'machine_gcode_flavor',
  'machine_start_gcode', 'machine_end_gcode', 'machine_nozzle_size', 'retraction_enable', 'retraction_amount', 'retraction_speed',
  'retraction_hop_enabled', 'retraction_hop', 'machine_head_with_fans_polygon', 'gantry_height',
  // filament
  'material_diameter', 'material_print_temperature', 'material_print_temperature_layer_0', 'material_bed_temperature', 'material_bed_temperature_layer_0',
  'material_flow', 'cool_fan_enabled', 'cool_fan_speed', 'cool_fan_speed_min', 'cool_fan_speed_max', 'cool_fan_full_layer', 'cool_min_layer_time',
  // process
  'layer_height', 'layer_height_0', 'line_width', 'wall_thickness', 'wall_line_count', 'top_bottom_thickness', 'top_thickness', 'top_layers',
  'bottom_thickness', 'bottom_layers', 'infill_sparse_density', 'infill_pattern', 'speed_print', 'speed_infill', 'speed_wall', 'speed_wall_0',
  'speed_wall_x', 'speed_topbottom', 'speed_travel', 'speed_layer_0', 'retraction_combing', 'travel_avoid_other_parts', 'support_enable',
  'support_type', 'support_angle', 'support_pattern', 'support_infill_rate', 'support_z_distance', 'support_xy_distance', 'support_interface_enable',
  'adhesion_type', 'skirt_line_count', 'skirt_gap', 'brim_width', 'raft_margin', 'z_seam_type', 'print_sequence', 'magic_spiralize',
  'magic_mesh_surface_mode', 'ironing_enabled', 'meshfix_union_all', 'meshfix_union_all_remove_holes',
]);

/** 'simple' | 'advanced' | 'expert': the lowest mode that shows this setting. */
export function levelOf(def) {
  if (SIMPLE.has(def.key)) return 'simple';
  if (def.category === 'experimental' || /steps_per_mm|endstop|feeder_wheel/.test(def.key)) return 'expert';
  return 'advanced';
}
export const levelRank = { simple: 0, advanced: 1, expert: 2 };

// ------------------------------------------------------------------ the index the UI walks
/**
 * { scope: { page: [node] } } where node = { def, children: [node] }. Cura nests settings under a
 * parent (e.g. wall line widths under line width); a child is only nested when its parent is on
 * the same page, otherwise it is promoted to the top of the page.
 */
export function buildIndex(defs) {
  const info = new Map();
  for (const d of defs.settings()) { const c = classify(d); if (c) info.set(d.key, { ...c, def: d, children: [] }); }
  const index = {};
  for (const s of SCOPE_ORDER) { index[s] = {}; for (const [p] of SCOPES[s].pages) index[s][p] = []; }
  for (const node of info.values()) {
    const parent = node.def.parent && info.get(node.def.parent);
    if (parent && parent.scope === node.scope && parent.page === node.page) parent.children.push(node);
    else index[node.scope][node.page].push(node);
  }
  return { index, info };
}

export function scopeOfKey(info, key) { const n = info.get(key); return n ? n.scope : null; }
