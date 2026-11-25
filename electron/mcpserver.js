// DabbleCAD Plus MCP server: lets AI apps (MCP clients) read and edit the open design, and slice
// and print it. See issue #8 and the design doc.
//
// This file is used in two ways:
//   - the desktop app's main process requires it and serves the endpoint itself, passing each
//     call to the editor window over IPC;
//   - on its own it is the helper for the web version (`node dabblecad-mcp.cjs`): it serves the
//     same endpoint and passes calls to the open DabbleCAD Plus tab over a WebSocket.
// Either way the tools themselves live in the editor (src/renderer/mcp/), so both routes behave the
// same. This file only speaks the protocol and guards the door.
//
// Protocol: MCP "Streamable HTTP" (JSON-RPC 2.0 over HTTP POST to /mcp), answering with plain
// JSON (no server-sent events). No dependencies, so the helper is a single file.
//
// Security: listens on 127.0.0.1 only; every request needs the bearer token; the Host header must
// name this machine (stops DNS rebinding); requests that carry a web page's Origin are refused,
// and the WebSocket bridge only accepts DabbleCAD Plus's own pages.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PORT = 7787;
const MAX_BODY = 20 * 1024 * 1024;
const CALL_TIMEOUT = 10 * 60 * 1000; // slicing can take a while
const OTHER_TIMEOUT = 30 * 1000;
const NOT_CONNECTED = 'DabbleCAD Plus is not connected. Open it and turn on Settings → AI connection.';

const INSTRUCTIONS = [
  'DabbleCAD Plus is a 3D design app (Tinkercad-style: shapes, holes, groups) with a built-in slicer.',
  'Units are always millimetres and degrees. X is right, Y is back, Z is up; the workplane is Z = 0.',
  'Objects are addressed by id (get_design lists them). Every change is one undo step the person can undo.',
  'After building or changing something, take a screenshot to check it before telling the person it is done.',
  'Holes are objects with hole: true; group them with solids to cut them out.',
  'For printing: slicer_add_to_plate, slicer_list_settings / slicer_set_settings, slicer_slice, then printer_send.',
].join('\n');

const tokensEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const newToken = () => crypto.randomBytes(24).toString('base64url');

// ------------------------------------------------------------------ the bridge to the editor
/**
 * A bridge passes MCP requests to the editor and returns its answers. The desktop app makes one
 * over IPC (createCallbackBridge); the helper accepts the browser tab over a WebSocket (createWsBridge).
 */
function createCallbackBridge(send) {
  const pending = new Map();
  let next = 1, connected = false, info = null;
  return {
    get connected() { return connected; },
    get info() { return info; },
    setConnected(on, hello = null) { connected = on; if (hello) info = hello; if (!on) for (const p of pending.values()) p.reject(new Error(NOT_CONNECTED)); if (!on) pending.clear(); },
    request(method, params, timeout) {
      if (!connected) return Promise.reject(new Error(NOT_CONNECTED));
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DabbleCAD Plus did not answer in ${Math.round(timeout / 1000)} s`)); }, timeout);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        send({ type: 'request', id, method, params });
      });
    },
    /** The editor's answer to request `id`. */
    respond(msg) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'Failed'), { code: msg.error.code }));
      else p.resolve(msg.result);
    },
  };
}

// --- a minimal WebSocket server (RFC 6455), enough for one browser tab
function wsAccept(key) { return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); }

function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, data]);
}

function wsSocket(socket, onText, onClose) {
  let buf = Buffer.alloc(0), parts = [], closed = false;
  const close = () => { if (closed) return; closed = true; try { socket.end(wsFrame(0x8, Buffer.alloc(0))); } catch { /* gone */ } onClose(); };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_BODY) { close(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mask = buf.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]; }
      buf = buf.subarray(need);
      if (op === 0x8) { close(); return; }
      if (op === 0x9) { socket.write(wsFrame(0xA, data)); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x0) {
        parts.push(data);
        if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; try { onText(text); } catch { /* bad message */ } }
      }
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; onClose(); } });
  socket.on('error', () => { if (!closed) { closed = true; onClose(); } });
  return { send: (obj) => { if (!closed) socket.write(wsFrame(0x1, JSON.stringify(obj))); }, close };
}

/** The helper's bridge: the DabbleCAD Plus tab connects to ws://127.0.0.1:<port>/bridge. */
function createWsBridge({ allowedOrigins, describe }) {
  let tab = null;
  const bridge = createCallbackBridge((msg) => { if (tab) tab.send(msg); });
  bridge.handleUpgrade = (req, socket, checkHost) => {
    const origin = req.headers.origin || '';
    const ok = checkHost(req) && allowedOrigins.some((o) => origin === o) && /websocket/i.test(req.headers.upgrade || '') && req.headers['sec-websocket-key'];
    if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}`, '', ''].join('\r\n'));
    const previous = tab;
    const me = wsSocket(socket, (text) => {
      const msg = JSON.parse(text);
      if (msg.type === 'hello') { bridge.setConnected(true, msg); me.send({ type: 'info', ...describe() }); }
      else if (msg.type === 'response') bridge.respond(msg);
    }, () => { if (tab === me) { tab = null; bridge.setConnected(false); } });
    tab = me;
    if (previous) { previous.send({ type: 'replaced' }); previous.close(); }
  };
  return bridge;
}

// ------------------------------------------------------------------ the MCP endpoint
function createMcpServer({ name = 'dabblecad', version = '0', bridge, getToken, port = DEFAULT_PORT, log = () => {} }) {
  const sessions = new Set();
  let server = null, listening = 0;
  const upgraded = new Set();   // WebSocket connections: server.close() does not end them

  const hostOk = (req) => {
    const host = String(req.headers.host || '').toLowerCase();
    return [`127.0.0.1:${listening}`, `localhost:${listening}`, `[::1]:${listening}`].includes(host);
  };

  async function forward(method, params, fallback) {
    if (!bridge.connected) { if (fallback !== undefined) return fallback; throw Object.assign(new Error(NOT_CONNECTED), { code: -32000 }); }
    return bridge.request(method, params, method === 'tools/call' ? CALL_TIMEOUT : OTHER_TIMEOUT);
  }

  async function dispatch(msg) {
    const { method, params = {} } = msg;
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name, title: 'DabbleCAD Plus', version },
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping': return {};
      case 'tools/list': return forward(method, params, { tools: (bridge.info && bridge.info.tools) || [] });
      case 'tools/call':
        if (!bridge.connected) return { content: [{ type: 'text', text: NOT_CONNECTED }], isError: true };
        try { return await forward(method, params); } catch (e) { return { content: [{ type: 'text', text: e.message || String(e) }], isError: true }; }
      case 'resources/list': return forward(method, params, { resources: [] });
      case 'resources/templates/list': return forward(method, params, { resourceTemplates: [] });
      case 'resources/read': return forward(method, params);
      case 'prompts/list': return forward(method, params, { prompts: [] });
      case 'prompts/get': return forward(method, params);
      case 'logging/setLevel': return {};
      default: throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  async function answer(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && msg.id !== undefined ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid request' } } : null;
    }
    if (msg.id === undefined || msg.id === null) return null; // a notification: nothing to say
    try {
      return { jsonrpc: '2.0', id: msg.id, result: await dispatch(msg) };
    } catch (e) {
      return { jsonrpc: '2.0', id: msg.id, error: { code: typeof e.code === 'number' ? e.code : -32603, message: e.message || String(e) } };
    }
  }

  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  async function onRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!hostOk(req)) return reply(res, 403, { error: 'Host not allowed' });
    // a web page must never drive the app through this door (the tab uses the bridge instead)
    if (req.headers.origin) return reply(res, 403, { error: 'Requests from web pages are not allowed' });
    if (url.pathname !== '/mcp') return reply(res, 404, { error: 'Not found. The MCP endpoint is /mcp' });
    const auth = String(req.headers.authorization || '');
    if (!tokensEqual(auth.replace(/^Bearer\s+/i, ''), getToken())) {
      return reply(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or wrong token. Copy it from DabbleCAD Plus: Settings → AI connection.' } }, { 'WWW-Authenticate': 'Bearer realm="DabbleCAD Plus"' });
    }
    if (req.method === 'GET') return reply(res, 405, { error: 'This server does not stream; use POST' }, { Allow: 'POST, DELETE' });
    const sid = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') { if (sid) sessions.delete(sid); return reply(res, 200); }
    if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST' }, { Allow: 'POST, DELETE' });

    let size = 0;
    const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return reply(res, 413, { error: 'Too large' }); chunks.push(c); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(body) ? body : [body];
    const init = batch.some((m) => m && m.method === 'initialize');
    if (!init && sid && !sessions.has(sid)) return reply(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session expired: initialize again' } });
    const answers = (await Promise.all(batch.map(answer))).filter(Boolean);
    const headers = {};
    if (init) { const id = crypto.randomUUID(); sessions.add(id); headers['Mcp-Session-Id'] = id; }
    if (!answers.length) return reply(res, 202, undefined, headers);
    log(`MCP ${batch.map((m) => (m && m.method) + (m && m.params && m.params.name ? ' ' + m.params.name : '')).join(', ')}`);
    return reply(res, 200, Array.isArray(body) ? answers : answers[0], headers);
  }

  return {
    get port() { return listening; },
    get url() { return `http://127.0.0.1:${listening}/mcp`; },
    /** Start listening; tries the next few ports if this one is taken. Resolves with the port. */
    start() {
      return new Promise((resolve, reject) => {
        let p = port;
        const tryPort = () => {
          server = http.createServer((req, res) => { onRequest(req, res).catch((e) => { try { reply(res, 500, { error: e.message }); } catch { /* closed */ } }); });
          if (bridge.handleUpgrade) server.on('upgrade', (req, socket) => {
            if (new URL(req.url, 'http://x').pathname !== '/bridge') { socket.destroy(); return; }
            upgraded.add(socket); socket.on('close', () => upgraded.delete(socket));
            bridge.handleUpgrade(req, socket, hostOk);
          });
          server.once('error', (e) => {
            if (e.code === 'EADDRINUSE' && p < port + 9) { p++; tryPort(); } else reject(e);
          });
          server.listen(p, '127.0.0.1', () => { listening = p; resolve(p); });
        };
        tryPort();
      });
    },
    stop() { return new Promise((resolve) => { if (!server) return resolve(); server.close(() => resolve()); server.closeAllConnections && server.closeAllConnections(); for (const s of upgraded) s.destroy(); upgraded.clear(); if (bridge.handleUpgrade) bridge.setConnected(false); server = null; listening = 0; }); },
  };
}

module.exports = { createMcpServer, createCallbackBridge, createWsBridge, newToken, DEFAULT_PORT };

// ------------------------------------------------------------------ the helper for the web version
if (require.main === module) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
  const cfgFile = path.join(os.homedir(), '.dabblecad-mcp.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* first run */ }
  if (!cfg.token || args.includes('--new-token')) { cfg.token = newToken(); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 }); }
  const origins = ['https://jonsole.github.io', 'http://localhost:5183', 'http://localhost:5184', 'http://127.0.0.1:5183', 'http://127.0.0.1:5184',
    ...String(arg('allow-origin') || '').split(',').filter(Boolean)];
  let mcp = null;
  const bridge = createWsBridge({ allowedOrigins: origins, describe: () => ({ url: mcp.url, token: cfg.token }) });
  mcp = createMcpServer({ name: 'dabblecad', version: '1', bridge, getToken: () => cfg.token, port: Number(arg('port')) || DEFAULT_PORT,
    log: args.includes('--verbose') ? (m) => console.log(m) : () => {} });
  mcp.start().then(() => {
    console.log('DabbleCAD Plus MCP helper is running.\n');
    console.log(`  MCP address:  ${mcp.url}`);
    console.log(`  Token:        ${cfg.token}\n`);
    console.log('In DabbleCAD Plus (web), turn on Settings → AI connection. Then add the server to your AI app, e.g.');
    console.log(`  claude mcp add --transport http dabblecad ${mcp.url} --header "Authorization: Bearer ${cfg.token}"\n`);
    console.log('Leave this window open while you use it. Ctrl+C stops it.');
  }).catch((e) => { console.error('Could not start: ' + e.message); process.exit(1); });
  let was = false;
  setInterval(() => { if (bridge.connected !== was) { was = bridge.connected; console.log(was ? 'DabbleCAD Plus connected.' : 'DabbleCAD Plus disconnected.'); } }, 500);
}
