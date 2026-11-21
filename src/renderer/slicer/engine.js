// Runs CuraEngine (WebAssembly) in a Web Worker: builds the command line from the settings store
// and the models on the plate, slices, and returns the G-code.

/** Binary STL for triangles given as flat position arrays (already in bed coordinates, mm). */
export function writeBinaryStl(positionArrays) {
  let tris = 0;
  for (const p of positionArrays) tris += Math.floor(p.length / 9);
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const header = 'DabbleCAD slicer';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris, true);
  let o = 84;
  for (const p of positionArrays) {
    for (let i = 0; i + 8 < p.length; i += 9) {
      const ax = p[i], ay = p[i + 1], az = p[i + 2], bx = p[i + 3], by = p[i + 4], bz = p[i + 5], cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) { dv.setFloat32(o, v, true); o += 4; }
      o += 2;
    }
  }
  return buf;
}

/**
 * The CuraEngine command line.
 * `settings` is { key: string } from SettingsStore.engineSettings(); `files` are the model file
 * names already written for the worker. Model positions are baked into the files (origin = bed
 * centre, which is what the engine expects), so no per-mesh position settings are needed.
 */
export function buildArgs(settings, files, { oneAtATime = false } = {}) {
  const pairs = Object.entries(settings);
  const args = ['slice', '-v', '-p', '-j', 'fdmprinter.def.json'];
  for (const [k, v] of pairs) args.push('-s', `${k}=${v}`);
  args.push('-o', 'output.gcode', '-e0', '-j', 'fdmextruder.def.json', '-e0');
  // The same settings again on the extruder: the engine reads some of them (nozzle, temperatures,
  // retraction) from the extruder train and others from the global settings.
  for (const [k, v] of pairs) args.push('-s', `${k}=${v}`);
  for (const f of files) {
    if (oneAtATime) args.push('-g');
    args.push('-l', f);
    if (oneAtATime) args.push('--next');
  }
  return args;
}

/**
 * Slice. `files` is [{ name, data: ArrayBuffer }]. Resolves with the G-code bytes.
 * `signal` (AbortSignal) cancels by terminating the worker.
 */
export function runEngine(files, args, { onProgress, onLog, signal, workerUrl } = {}) {
  const url = workerUrl || new URL('curaengine/slicer-worker.js', document.baseURI).href;
  return new Promise((resolve, reject) => {
    const worker = new Worker(url);
    const onAbort = () => finish(reject, new DOMException('Slicing cancelled', 'AbortError'));
    const finish = (fn, v) => { worker.terminate(); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.cmd === 'progress') onProgress && onProgress(d.value);
      else if (d.cmd === 'log') onLog && onLog(d.str);
      else if (d.cmd === 'done') finish(resolve, d.gcode);
      else if (d.cmd === 'error') finish(reject, new Error(d.error));
    };
    worker.onerror = (e) => finish(reject, new Error(e.message || 'The slicing engine failed to start'));
    worker.postMessage({ cmd: 'slice', jobId: 1, files, args }, files.map((f) => f.data));
  });
}

/** Print time, filament and layer count from the comments CuraEngine writes at the top of the G-code. */
export function gcodeSummary(gcode) {
  const head = new TextDecoder().decode(gcode.subarray(0, Math.min(gcode.length, 4096)));
  const time = /;TIME:(\d+)/.exec(head);
  const filament = /;Filament used: ([\d.]+)m/.exec(head);
  const layers = /;LAYER_COUNT:(\d+)/.exec(head);
  return { seconds: time ? parseInt(time[1], 10) : null, filamentM: filament ? parseFloat(filament[1]) : null, layers: layers ? parseInt(layers[1], 10) : null };
}

export function formatTime(s) {
  if (s == null) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
