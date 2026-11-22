// Send G-code to a printer over the network. Three kinds of firmware are supported:
//   moonraker - Klipper (RatRig, Voron, ...): the Moonraker web API; a password is an API key
//   octoprint - OctoPrint: its REST API; the password is the API key
//   duet      - RepRapFirmware (Duet boards), standalone (rr_ calls) or SBC (/machine) mode
// In the desktop app the requests are made by its main process (no browser restrictions). In a browser
// they are ordinary fetch calls, so the printer has to allow it (CORS), and a page served over https
// can't call a printer on plain http.

export const KINDS = {
  moonraker: { label: 'Klipper (Moonraker)', secret: 'API key', hint: 'The address of Mainsail / Fluidd, e.g. http://ratrig.local', cors: 'Moonraker: add the address of this page to cors_domains in moonraker.conf.' },
  octoprint: { label: 'OctoPrint', secret: 'API key', hint: 'e.g. http://octopi.local', cors: 'OctoPrint: enable cross-origin access (Settings → API → Allow Cross Origin Resource Sharing).' },
  duet: { label: 'RepRapFirmware (Duet)', secret: 'Password', hint: 'e.g. http://duet3.local', cors: 'Duet: send M586 C"*" to allow requests from other pages.' },
};

const bytes = (s) => new TextEncoder().encode(s);

/** A multipart/form-data body, built by hand so it can also cross into the desktop app's main process. */
function multipart(fields, file) {
  const boundary = '----dabble' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(bytes(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(file.data, bytes(`\r\n--${boundary}--\r\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { body: out, type: `multipart/form-data; boundary=${boundary}` };
}

const base = (url) => {
  let u = String(url || '').trim();
  if (!u) throw new Error('Enter the printer address first (Printer settings → Printer connection).');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
};

/** One HTTP request: through the desktop app when there is one, otherwise the browser's fetch. */
async function request(cfg, path, { method = 'GET', headers = {}, body } = {}) {
  const h = { ...headers };
  // a username means an HTTP login (e.g. a reverse proxy in front of the printer); without one the password is the API key
  if (cfg.user) h.Authorization = 'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.user}:${cfg.password || ''}`)));
  const url = base(cfg.url) + path;
  const native = typeof window !== 'undefined' && window.dabbleNative && window.dabbleNative.printerFetch;
  if (native) {
    const r = await native(url, { method, headers: h, body });
    if (r.error) throw new Error(r.error);
    return r;
  }
  let res;
  try { res = await fetch(url, { method, headers: h, body, cache: 'no-store' }); } catch (e) {
    const mixed = location.protocol === 'https:' && /^http:/i.test(url);
    throw new Error(mixed
      ? `The browser won't let this https page talk to an http printer. Use the desktop app, or open DabbleCAD over http. (${KINDS[cfg.kind].cors})`
      : `Couldn't reach ${base(cfg.url)}. Check the address and that the printer is on. If it is, the printer must allow this page: ${KINDS[cfg.kind].cors}`);
  }
  return { status: res.status, ok: res.ok, text: await res.text() };
}

const fail = (r, what) => { throw new Error(`${what} (${r.status}${r.text ? ': ' + String(r.text).replace(/<[^>]+>/g, ' ').trim().slice(0, 120) : ''})`); };
const key = (cfg) => (cfg.password && !cfg.user ? { 'X-Api-Key': cfg.password } : {});

// ------------------------------------------------------------------ Duet
async function duetConnect(cfg) {
  const pw = encodeURIComponent(cfg.password || 'reprap');
  let r = await request(cfg, `/rr_connect?password=${pw}&time=${encodeURIComponent(new Date().toISOString().slice(0, 19))}`);
  if (r.ok) {
    let d = {}; try { d = JSON.parse(r.text); } catch { /* not JSON */ }
    if (d.err === 1) throw new Error('The Duet rejected the password.');
    if (d.err === 2) throw new Error('The Duet has no free sessions: close another web control page and try again.');
    return { mode: 'rr' };
  }
  if (r.status === 404 || r.status === 405) {                 // SBC mode: Duet Software Framework
    r = await request(cfg, `/machine/connect?password=${pw}`);
    if (r.ok) { let d = {}; try { d = JSON.parse(r.text); } catch { /* ignore */ } return { mode: 'sbc', session: d.sessionKey }; }
    if (r.status === 403) throw new Error('The Duet rejected the password.');
  }
  return fail(r, 'The Duet did not accept the connection');
}
async function duetDisconnect(cfg, c) {
  try { await request(cfg, c.mode === 'rr' ? '/rr_disconnect' : '/machine/disconnect', { method: c.mode === 'rr' ? 'GET' : 'GET', headers: c.session ? { 'X-Session-Key': c.session } : {} }); } catch { /* best effort */ }
}

// ------------------------------------------------------------------ public API
/** Check the address and credentials. Returns a short description of what answered. */
export async function testConnection(cfg) {
  if (cfg.kind === 'moonraker') {
    const r = await request(cfg, '/server/info', { headers: key(cfg) });
    if (r.status === 401 || r.status === 403) throw new Error('Moonraker wants an API key (or the address is behind a login).');
    if (!r.ok) fail(r, 'No Moonraker answer');
    let d = {}; try { d = JSON.parse(r.text).result || {}; } catch { /* ignore */ }
    return `Connected to Moonraker${d.klippy_state ? ` (Klipper ${d.klippy_state})` : ''}`;
  }
  if (cfg.kind === 'octoprint') {
    const r = await request(cfg, '/api/version', { headers: key(cfg) });
    if (r.status === 401 || r.status === 403) throw new Error('OctoPrint rejected the API key.');
    if (!r.ok) fail(r, 'No OctoPrint answer');
    let d = {}; try { d = JSON.parse(r.text); } catch { /* ignore */ }
    return `Connected to OctoPrint ${d.server || ''}`.trim();
  }
  const c = await duetConnect(cfg);
  await duetDisconnect(cfg, c);
  return c.mode === 'sbc' ? 'Connected to a Duet (SBC mode)' : 'Connected to a Duet';
}

/** Upload G-code and optionally start it. `file` is { name, data: Uint8Array }. */
export async function sendGcode(cfg, file, { start = false } = {}) {
  if (cfg.kind === 'moonraker') {
    const m = multipart({ root: 'gcodes', print: start ? 'true' : 'false' }, file);
    const r = await request(cfg, '/server/files/upload', { method: 'POST', headers: { 'Content-Type': m.type, ...key(cfg) }, body: m.body });
    if (!r.ok) fail(r, 'Moonraker refused the file');
    return start ? 'Sent and started' : 'Sent to the printer';
  }
  if (cfg.kind === 'octoprint') {
    const m = multipart({ print: start ? 'true' : 'false', select: 'true' }, file);
    const r = await request(cfg, '/api/files/local', { method: 'POST', headers: { 'Content-Type': m.type, ...key(cfg) }, body: m.body });
    if (!r.ok) fail(r, 'OctoPrint refused the file');
    return start ? 'Sent and started' : 'Sent to the printer';
  }
  const c = await duetConnect(cfg);
  try {
    const path = `0:/gcodes/${file.name}`;
    const sh = c.session ? { 'X-Session-Key': c.session } : {};
    let r;
    if (c.mode === 'rr') r = await request(cfg, `/rr_upload?name=${encodeURIComponent(path)}&time=${encodeURIComponent(new Date().toISOString().slice(0, 19))}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file.data });
    else r = await request(cfg, `/machine/file/${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...sh }, body: file.data });
    if (!r.ok) fail(r, 'The Duet refused the file');
    if (c.mode === 'rr') { let d = {}; try { d = JSON.parse(r.text); } catch { /* ignore */ } if (d.err) throw new Error('The Duet could not store the file (is there an SD card?).'); }
    if (start) {
      const code = `M32 "${path}"`;
      r = c.mode === 'rr' ? await request(cfg, `/rr_gcode?gcode=${encodeURIComponent(code)}`) : await request(cfg, '/machine/code', { method: 'POST', headers: { 'Content-Type': 'text/plain', ...sh }, body: code });
      if (!r.ok) fail(r, 'The Duet did not start the print');
    }
    return start ? 'Sent and started' : 'Sent to the printer';
  } finally { await duetDisconnect(cfg, c); }
}

// ------------------------------------------------------------------ live status
/**
 * What the printer is doing now, in one shape for every firmware:
 *   { state: 'idle'|'printing'|'paused'|'done'|'busy'|'error', file, progress (0..1 or null), layer (1-based or null),
 *     layers (or null), timeLeft (s or null), elapsed (s or null), temps: [{ name, current, target }] }
 */
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

// Duet object model (the same shape from rr_model and from the SBC's /machine/status)
const DUET_STATES = { idle: 'idle', processing: 'printing', simulating: 'printing', pausing: 'paused', paused: 'paused', resuming: 'printing', cancelling: 'busy', halted: 'error', off: 'error', busy: 'busy', changingTool: 'printing', updating: 'busy', starting: 'busy' };
function duetStatus(m) {
  const st = m.state || {}, job = m.job || {}, heat = m.heat || {};
  const size = num(job.file && job.file.size), pos = num(job.filePosition);
  let progress = size && pos != null ? Math.min(1, pos / size) : null;
  let state = DUET_STATES[st.status] || 'idle';
  if (state === 'idle' && job.lastFileName && progress != null && progress >= 0.999) state = 'done';
  if (state === 'idle') progress = null;
  const temps = [];
  const heaters = heat.heaters || [];
  const bed = (heat.bedHeaters || []).filter((i) => i >= 0)[0];
  if (bed != null && heaters[bed]) temps.push({ name: 'Bed', current: num(heaters[bed].current), target: num(heaters[bed].active) });
  const tools = m.tools || [];
  if (tools.length) tools.forEach((t, i) => { const hi = (t.heaters || [])[0]; if (hi != null && heaters[hi]) temps.push({ name: tools.length > 1 ? `Tool ${t.number != null ? t.number : i}` : 'Nozzle', current: num(heaters[hi].current), target: num((t.active || [])[0]) }); });
  else heaters.forEach((hh, i) => { if (i !== bed) temps.push({ name: i === 1 || heaters.length === 2 ? 'Nozzle' : `Heater ${i}`, current: num(hh.current), target: num(hh.active) }); });
  return { state, file: String((job.file && job.file.fileName) || job.lastFileName || '').replace(/^.*[\\/]/, '') || null, progress, layer: num(job.layer), layers: num(job.file && job.file.numLayers),
    timeLeft: num(job.timesLeft && (job.timesLeft.file != null ? job.timesLeft.file : job.timesLeft.filament)), elapsed: num(job.duration), temps };
}

async function duetModel(cfg, c) {
  const sh = c.session ? { 'X-Session-Key': c.session } : {};
  const get = async (k) => {
    const r = c.mode === 'rr' ? await request(cfg, `/rr_model?key=${k}&flags=d99`) : await request(cfg, `/machine/model?key=${k}&flags=d99`, { headers: sh });
    if (!r.ok) fail(r, 'The Duet did not report its status');
    const d = json(r);
    return d && d.result !== undefined ? d.result : d;
  };
  return { state: await get('state'), job: await get('job'), heat: await get('heat'), tools: await get('tools') };
}
async function duetRrStatusOld(cfg) {            // RepRapFirmware 2.x: rr_status
  const r = await request(cfg, '/rr_status?type=3');
  if (!r.ok) fail(r, 'The Duet did not report its status');
  const d = json(r) || {};
  const st = { I: 'idle', P: 'printing', D: 'paused', S: 'paused', R: 'printing', M: 'printing', B: 'busy', F: 'busy', C: 'busy', H: 'error', O: 'error' }[d.status] || 'idle';
  const temps = [];
  if (d.temps && d.temps.bed) temps.push({ name: 'Bed', current: num(d.temps.bed.current), target: num(d.temps.bed.active) });
  if (d.temps && d.temps.heads) (d.temps.heads.current || []).forEach((cur, i, all) => temps.push({ name: all.length > 1 ? `Tool ${i}` : 'Nozzle', current: num(cur), target: num((d.temps.heads.active || [])[i]) }));
  let file = null, layers = null;
  if (st === 'printing' || st === 'paused') {          // which file is it? (best effort)
    try {
      const f = json(await request(cfg, '/rr_fileinfo')) || {};
      file = String(f.fileName || '').replace(/^.*[\\/]/, '') || null;
      layers = num(f.numLayers) || (num(f.height) && num(f.layerHeight) ? Math.round(f.height / f.layerHeight) : null);
    } catch { /* keep going without it */ }
  }
  return { state: st, file, progress: num(d.fractionPrinted) != null ? d.fractionPrinted / 100 : null, layer: num(d.currentLayer), layers, timeLeft: num(d.timesLeft && d.timesLeft.file), elapsed: num(d.printDuration), temps };
}

/** Open a session with the printer for repeated status reads. Returns { read(), close() }. */
export async function openStatus(cfg) {
  if (cfg.kind === 'moonraker') {
    return { async read() {
      const r = await request(cfg, '/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed', { headers: key(cfg) });
      if (!r.ok) fail(r, 'Moonraker did not report its status');
      const s = ((json(r) || {}).result || {}).status || {};
      const ps = s.print_stats || {}, p = s.virtual_sdcard && num(s.virtual_sdcard.progress);
      const state = { printing: 'printing', paused: 'paused', complete: 'done', cancelled: 'idle', standby: 'idle', error: 'error' }[ps.state] || 'idle';
      const el = num(ps.print_duration);
      const temps = [];
      if (s.heater_bed) temps.push({ name: 'Bed', current: num(s.heater_bed.temperature), target: num(s.heater_bed.target) });
      if (s.extruder) temps.push({ name: 'Nozzle', current: num(s.extruder.temperature), target: num(s.extruder.target) });
      return { state, file: ps.filename || null, progress: state === 'done' ? 1 : state === 'idle' ? null : p, layer: num(ps.info && ps.info.current_layer), layers: num(ps.info && ps.info.total_layer),
        timeLeft: el != null && p > 0.01 && state === 'printing' ? el / p - el : null, elapsed: el, temps };
    }, close() {} };
  }
  if (cfg.kind === 'octoprint') {
    return { async read() {
      const r = await request(cfg, '/api/job', { headers: key(cfg) });
      if (r.status === 401 || r.status === 403) throw new Error('OctoPrint rejected the API key.');
      if (!r.ok) fail(r, 'OctoPrint did not report the job');
      const d = json(r) || {};
      const state = /print/i.test(d.state || '') && !/paus/i.test(d.state) ? 'printing' : /paus/i.test(d.state || '') ? 'paused' : /error|offline/i.test(d.state || '') ? 'error' : 'idle';
      const pr = d.progress || {};
      const temps = [];
      const t = await request(cfg, '/api/printer', { headers: key(cfg) });
      if (t.ok) { const tt = (json(t) || {}).temperature || {}; if (tt.bed) temps.push({ name: 'Bed', current: num(tt.bed.actual), target: num(tt.bed.target) }); if (tt.tool0) temps.push({ name: 'Nozzle', current: num(tt.tool0.actual), target: num(tt.tool0.target) }); }
      const comp = num(pr.completion);
      return { state: state === 'idle' && comp === 100 ? 'done' : state, file: (d.job && d.job.file && d.job.file.name) || null, progress: comp != null && state !== 'idle' ? comp / 100 : comp === 100 ? 1 : null, layer: null, layers: null, timeLeft: num(pr.printTimeLeft), elapsed: num(pr.printTime), temps };
    }, close() {} };
  }
  const c = await duetConnect(cfg);
  let old = false;
  return {
    async read() {
      if (old) return duetRrStatusOld(cfg);
      try { return duetStatus(await duetModel(cfg, c)); } catch (e) {
        // firmware without rr_model (RepRapFirmware 2.x answers 'Unknown request'): use the older rr_status
        if (c.mode === 'rr') { old = true; return duetRrStatusOld(cfg); }
        throw e;
      }
    },
    close() { duetDisconnect(cfg, c); },
  };
}
