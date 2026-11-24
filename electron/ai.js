// AI chat, desktop side. API keys live only here: encrypted on disk with the system keychain
// (safeStorage) and never sent to the window. The window's provider SDKs make their requests
// through ai:fetch, which checks the address, adds the key and streams the reply back as
// ai:event messages ({ id, chunk } ... { id, end } or { id, error }).
//
// There is deliberately nothing here that talks to printers or lasers.

const { safeStorage, net, app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ANTHROPIC = 'https://api.anthropic.com';
const store = () => path.join(app.getPath('userData'), 'ai-keys.bin');

let keys = null;   // { anthropic: { key }, local: { key, baseURL } }
let memoryOnly = false;

function load() {
  if (keys) return keys;
  keys = {};
  try {
    const raw = fs.readFileSync(store());
    if (safeStorage.isEncryptionAvailable()) keys = JSON.parse(safeStorage.decryptString(raw)) || {};
  } catch { /* none saved yet */ }
  return keys;
}

function save() {
  memoryOnly = !safeStorage.isEncryptionAvailable();
  if (memoryOnly) return;
  try { fs.writeFileSync(store(), safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 }); } catch { memoryOnly = true; }
}

const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };

/** Which stored key (if any) may go to this address, and how. */
function authFor(provider, url) {
  const k = load()[provider];
  if (provider === 'anthropic') {
    if (origin(url) !== ANTHROPIC) return { refuse: 'Anthropic requests can only go to api.anthropic.com.' };
    return k && k.key ? { headers: { 'x-api-key': k.key } } : { headers: {} };
  }
  if (provider === 'local') {
    if (!/^https?:\/\//i.test(url)) return { refuse: 'Not a web address.' };
    // the local key only goes to the server it was saved for
    if (k && k.key && k.baseURL && url.startsWith(k.baseURL.replace(/\/$/, '') + '/')) return { headers: { authorization: `Bearer ${k.key}` } };
    return { headers: {} };
  }
  return { refuse: 'Unknown AI provider.' };
}

function registerAi(ipcMain, getWin, { testAllow = null } = {}) {
  allowForTest = testAllow ? new URL(testAllow).origin : null;
  const running = new Map();   // request id -> AbortController

  ipcMain.handle('ai:set-key', (_e, provider, key, baseURL) => {
    load();
    if (!['anthropic', 'local'].includes(provider)) return { error: 'Unknown AI provider.' };
    // key null: keep the saved key and only change the server it may go to
    const old = keys[provider] || {};
    keys[provider] = { key: key == null ? old.key || '' : String(key).trim(), baseURL: baseURL || undefined };
    save();
    return { ok: true, memoryOnly };
  });
  ipcMain.handle('ai:has-key', (_e, provider) => !!(load()[provider] && load()[provider].key));
  ipcMain.handle('ai:clear-key', (_e, provider) => { load(); delete keys[provider]; save(); return true; });

  // One HTTP request for a provider SDK. Resolves with the status and headers once they arrive;
  // the body follows as ai:event chunks.
  ipcMain.handle('ai:fetch', async (e, id, provider, url, init = {}) => {
    const auth = authFor(provider, url);
    if (auth.refuse) return { error: auth.refuse };
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) {
      const lk = k.toLowerCase();
      if (lk === 'x-api-key' || lk === 'authorization') continue;   // the window only has a placeholder
      headers[k] = v;
    }
    Object.assign(headers, auth.headers);
    const ac = new AbortController();
    running.set(id, ac);
    let res;
    try {
      res = await net.fetch(url, { method: init.method || 'GET', headers, body: init.body || undefined, signal: ac.signal });
    } catch (err) {
      running.delete(id);
      return { error: (err && err.message) || String(err), aborted: ac.signal.aborted };
    }
    const sender = e.sender;
    const send = (msg) => { if (!sender.isDestroyed()) sender.send('ai:event', { id, ...msg }); };
    (async () => {
      try {
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            send({ chunk: value });
          }
        }
        send({ end: true });
      } catch (err) {
        send({ error: (err && err.message) || String(err), aborted: ac.signal.aborted });
      } finally { running.delete(id); }
    })();
    return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()) };
  });

  registerWebFetch(ipcMain);

  ipcMain.handle('ai:cancel', (_e, id) => {
    const ac = running.get(id);
    if (ac) ac.abort();
    return !!ac;
  });
}

module.exports = { registerAi };

// ------------------------------------------------------------------ fetch_page (desktop only)
// Lets the AI read a public web page. Only public internet addresses: anything on this computer
// or the local network (printers, lasers, routers) is refused, checked when connecting (so a
// name that resolves to a local address, or a redirect to one, is refused too). GET only.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const zlib = require('node:zlib');
const net2 = require('node:net');

const MAX_BYTES = 3 * 1024 * 1024;
let allowForTest = null;   // smoke tests only: the fake server's own address

function privateIp(ip) {
  if (net2.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => privateIp(a.address));
    if (bad || !addrs.length) return cb(Object.assign(new Error('That address is on this computer or the local network, which the AI may not reach.'), { code: 'LOCAL' }));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function getOnce(url, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Only http and https pages can be fetched.'));
    const testing = allowForTest && u.origin === allowForTest;
    if (!testing && net2.isIP(u.hostname.replace(/^\[|\]$/g, '')) && privateIp(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('That address is on this computer or the local network, which the AI may not reach.'));
    if (!testing && /^(localhost|.*\.local|.*\.localhost|.*\.internal|.*\.lan|.*\.home)$/i.test(u.hostname)) return reject(new Error('That address is on this computer or the local network, which the AI may not reach.'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      ...(testing ? {} : { lookup: safeLookup }), signal, timeout: 15000,
      headers: { 'user-agent': 'Mozilla/5.0 (DabbleCAD Plus AI page reader)', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, u).toString() });
      }
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = [];
      let size = 0, cut = false;
      stream.on('data', (c) => {
        if (cut) return;
        size += c.length;
        if (size > MAX_BYTES) { cut = true; chunks.push(c.subarray(0, c.length - (size - MAX_BYTES))); req.destroy(); stream.emit('end'); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8'), truncated: cut, url: u.toString() }));
      stream.on('error', (e) => { if (!cut) reject(e); });
    });
    req.on('timeout', () => req.destroy(new Error('The page took too long to answer.')));
    req.on('error', reject);
  });
}

async function fetchPage(url, signal) {
  let at = url;
  for (let hop = 0; hop < 6; hop++) {
    const r = await getOnce(at, signal);
    if (!r.redirect) return r;
    at = r.redirect;
  }
  throw new Error('Too many redirects.');
}

function registerWebFetch(ipcMain) {
  ipcMain.handle('ai:web-fetch', async (_e, url) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30000);
    try {
      const r = await fetchPage(String(url), ac.signal);
      return r;
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    } finally { clearTimeout(t); }
  });
}

module.exports.registerWebFetch = registerWebFetch;
module.exports.privateIp = privateIp;
