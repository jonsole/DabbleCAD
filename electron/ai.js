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

function registerAi(ipcMain, getWin) {
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

  ipcMain.handle('ai:cancel', (_e, id) => {
    const ac = running.get(id);
    if (ac) ac.abort();
    return !!ac;
  });
}

module.exports = { registerAi };
