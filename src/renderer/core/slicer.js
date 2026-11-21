// In-browser slicing with CuraEngine (WebAssembly). The engine and its worker live in
// public/curaengine/ and are served as plain static files; nothing here talks to a server.
//
// CuraEngine only reads default values from its definition files. Cura's own front end works
// out the "derived" settings (line widths, layer counts, infill spacing...) and passes them
// on the command line, so this module does the same for the handful of settings it exposes.
// Everything else keeps CuraEngine's defaults.

export const SLICE_DEFAULTS = {
  layerHeight: 0.2,      // mm
  firstLayerHeight: 0.3, // mm
  nozzle: 0.4,           // mm
  filament: 1.75,        // mm
  walls: 3,              // perimeter count
  topBottomMm: 0.8,      // thickness of the solid top and bottom skin
  infill: 20,            // percent
  support: 'none',       // 'none' | 'touching' | 'everywhere'
  adhesion: 'skirt',     // 'none' | 'skirt' | 'brim' | 'raft'
  nozzleTemp: 205,       // °C
  bedTemp: 60,           // °C, 0 = unheated bed
  speed: 50,             // mm/s
  retraction: 5,         // mm, 0 = off
};

export const SLICE_LIMITS = {
  layerHeight: [0.04, 0.6], nozzle: [0.1, 2], walls: [1, 10], infill: [0, 100],
  nozzleTemp: [150, 350], bedTemp: [0, 120], speed: [10, 300], retraction: [0, 15],
};

const START_GCODE = 'G90\nM82\nG28 ; home all axes\nG92 E0';
const END_GCODE = 'M104 S0\nM140 S0\nG91\nG1 E-2 F300\nG1 Z+0.5 E-5 X-20 Y-20 F6000\nG90\nG28 X0 Y0\nM84';

function clamp(v, [lo, hi]) { return Math.min(hi, Math.max(lo, v)); }

function sanitize(raw = {}) {
  const o = { ...SLICE_DEFAULTS };
  for (const k of Object.keys(SLICE_DEFAULTS)) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === '') continue;
    o[k] = typeof SLICE_DEFAULTS[k] === 'number' ? Number(raw[k]) : String(raw[k]);
    if (typeof o[k] === 'number' && !Number.isFinite(o[k])) o[k] = SLICE_DEFAULTS[k];
    if (SLICE_LIMITS[k]) o[k] = clamp(o[k], SLICE_LIMITS[k]);
  }
  if (!['none', 'touching', 'everywhere'].includes(o.support)) o.support = 'none';
  if (!['none', 'skirt', 'brim', 'raft'].includes(o.adhesion)) o.adhesion = 'skirt';
  o.firstLayerHeight = Math.max(o.layerHeight, Math.min(o.firstLayerHeight, o.nozzle * 0.9));
  return o;
}

/** The `-s key=value` settings for one slice. Returns a plain { key: string } object. */
export function curaSettings(raw, bed) {
  const o = sanitize(raw);
  const lw = o.nozzle; // line width follows the nozzle
  const solidInfill = o.infill >= 100;
  const pattern = solidInfill ? 'lines' : 'grid';
  const infillDistance = o.infill <= 0 ? 0 : (lw * 100 / o.infill) * (pattern === 'grid' ? 2 : 1);
  const layers = Math.max(2, Math.ceil(o.topBottomMm / o.layerHeight - 1e-6));
  const s = {
    machine_width: bed.x, machine_depth: bed.y, machine_height: bed.z,
    machine_center_is_zero: false, machine_heated_bed: o.bedTemp > 0,
    machine_gcode_flavor: 'RepRap (Marlin/Sprinter)',
    machine_nozzle_size: lw, material_diameter: o.filament,
    machine_start_gcode: START_GCODE, machine_end_gcode: END_GCODE,
    layer_height: o.layerHeight, layer_height_0: o.firstLayerHeight, infill_sparse_thickness: o.layerHeight,
    line_width: lw, wall_line_width: lw, wall_line_width_0: lw, wall_line_width_x: lw,
    skin_line_width: lw, infill_line_width: lw, skirt_brim_line_width: lw, support_line_width: lw,
    support_interface_line_width: lw, support_roof_line_width: lw, support_bottom_line_width: lw,
    wall_line_count: Math.round(o.walls), wall_thickness: lw * Math.round(o.walls),
    top_bottom_thickness: layers * o.layerHeight, top_thickness: layers * o.layerHeight, bottom_thickness: layers * o.layerHeight,
    top_layers: layers, bottom_layers: layers,
    infill_sparse_density: o.infill, infill_pattern: pattern, infill_line_distance: infillDistance,
    material_print_temperature: o.nozzleTemp, material_print_temperature_layer_0: o.nozzleTemp,
    material_initial_print_temperature: o.nozzleTemp, material_final_print_temperature: o.nozzleTemp,
    default_material_print_temperature: o.nozzleTemp,
    material_bed_temperature: o.bedTemp, material_bed_temperature_layer_0: o.bedTemp,
    speed_print: o.speed, speed_infill: o.speed, speed_wall: o.speed / 2, speed_wall_0: o.speed / 2, speed_wall_x: o.speed,
    speed_topbottom: o.speed / 2, speed_support: o.speed, speed_support_infill: o.speed, speed_layer_0: Math.min(20, o.speed),
    speed_print_layer_0: Math.min(20, o.speed), speed_travel: Math.min(150, o.speed * 3), speed_travel_layer_0: Math.min(60, o.speed * 2),
    retraction_enable: o.retraction > 0, retraction_amount: o.retraction, retraction_speed: 45,
    retraction_retract_speed: 45, retraction_prime_speed: 45,
    support_enable: o.support !== 'none', support_type: o.support === 'everywhere' ? 'everywhere' : 'buildplate', support_angle: 50,
    adhesion_type: o.adhesion,
  };
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)]));
}

/** The full CuraEngine command line. The model is expected to be centred on the bed already. */
export function buildCuraArgs(raw, bed, modelFile = 'model.stl') {
  const settings = Object.entries(curaSettings(raw, bed));
  const args = ['slice', '-v', '-p', '-j', 'fdmprinter.def.json'];
  for (const [k, v] of settings) args.push('-s', `${k}=${v}`);
  args.push('-o', 'output.gcode', '-e0', '-j', 'fdmextruder.def.json', '-e0');
  // the same settings again on the extruder: CuraEngine reads some of them (nozzle, temperatures,
  // retraction) from the extruder train and others from the global settings
  for (const [k, v] of settings) args.push('-s', `${k}=${v}`);
  args.push('-l', modelFile);
  return args;
}

/**
 * Move a binary STL so it sits in the middle of the bed with its lowest point on the plate
 * (CuraEngine's origin is the bed centre). Returns { stl, size: {x,y,z} }.
 */
export function centerStl(data) {
  const src = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const count = dv.getUint32(80, true);
  if (!count || 84 + count * 50 > src.byteLength) throw new Error('There is no solid geometry to slice');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    for (let v = 0; v < 3; v++) {
      const o = 84 + t * 50 + 12 + v * 12;
      for (let a = 0; a < 3; a++) {
        const x = dv.getFloat32(o + a * 4, true);
        if (x < min[a]) min[a] = x;
        if (x > max[a]) max[a] = x;
      }
    }
  }
  const shift = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  const od = new DataView(out.buffer);
  for (let t = 0; t < count; t++) {
    for (let v = 0; v < 3; v++) {
      const o = 84 + t * 50 + 12 + v * 12;
      for (let a = 0; a < 3; a++) od.setFloat32(o + a * 4, dv.getFloat32(o + a * 4, true) + shift[a], true);
    }
  }
  return { stl: out.buffer, size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] } };
}

/**
 * Slice a binary STL. Resolves with { gcode: Uint8Array, size }. `onProgress(0..1)` is optional,
 * `signal` (AbortSignal) cancels by terminating the worker.
 */
export function sliceStl(stlData, raw, bed, { onProgress, onLog, signal, workerUrl } = {}) {
  const { stl, size } = centerStl(stlData);
  if (size.x > bed.x + 0.01 || size.y > bed.y + 0.01 || size.z > bed.z + 0.01) {
    return Promise.reject(new Error(`The model is ${size.x.toFixed(0)} × ${size.y.toFixed(0)} × ${size.z.toFixed(0)} mm, which does not fit the ${bed.x} × ${bed.y} × ${bed.z} mm printer bed`));
  }
  const url = workerUrl || new URL('curaengine/slicer-worker.js', document.baseURI).href;
  return new Promise((resolve, reject) => {
    const worker = new Worker(url);
    const finish = (fn, v) => { worker.terminate(); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const onAbort = () => finish(reject, new DOMException('Slicing cancelled', 'AbortError'));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.cmd === 'progress') onProgress && onProgress(d.value);
      else if (d.cmd === 'log') onLog && onLog(d.str);
      else if (d.cmd === 'done') finish(resolve, { gcode: d.gcode, size });
      else if (d.cmd === 'error') finish(reject, new Error(d.error));
    };
    worker.onerror = (e) => finish(reject, new Error(e.message || 'The slicing engine failed to start'));
    worker.postMessage({ cmd: 'slice', jobId: 1, stl, args: buildCuraArgs(raw, bed) }, [stl]);
  });
}

/** Pull the print time and filament use out of the comments CuraEngine writes at the top of the G-code. */
export function gcodeSummary(gcode) {
  const head = new TextDecoder().decode(gcode.subarray(0, Math.min(gcode.length, 2048)));
  const time = /;TIME:(\d+)/.exec(head), filament = /;Filament used: ([\d.]+)m/.exec(head) || /;Filament used: ([\d.]+)/.exec(head);
  const layers = /;LAYER_COUNT:(\d+)/.exec(head);
  return { seconds: time ? parseInt(time[1], 10) : null, filamentM: filament ? parseFloat(filament[1]) : null, layers: layers ? parseInt(layers[1], 10) : null };
}
