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
