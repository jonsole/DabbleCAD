// AI settings and API keys. On the desktop, keys go to the main process (encrypted there) and
// every provider request is made by the main process, so the key never reaches this window.
// In a browser, the key stays in memory for this tab, or in this browser's storage when the
// user ticks "Remember on this device".

import { makeProvider, providerInfo, AiError } from './providers.js';

const native = typeof window !== 'undefined' ? window.dabbleNative || null : null;
export const aiOnDesktop = !!(native && native.aiFetch);

export const AI_DEFAULTS = { provider: 'anthropic', model: '', effort: 'medium', temperature: 0.2, baseURL: '', remember: false };
export const aiSettings = (app) => ({ ...AI_DEFAULTS, ...(app.settings.ai || {}) });

const memKeys = {};   // browser: provider -> key, for this tab only
const lsKey = (p) => `dabble.aiKey.${p}`;

export async function setKey(provider, key, { remember = false, baseURL } = {}) {
  if (aiOnDesktop) return native.aiSetKey(provider, key == null ? null : String(key).trim(), baseURL || undefined);
  if (key == null) return { ok: true };
  key = String(key).trim();
  memKeys[provider] = key;
  try {
    if (remember && key) localStorage.setItem(lsKey(provider), key);
    else localStorage.removeItem(lsKey(provider));
  } catch { /* storage blocked */ }
  return { ok: true };
}

export async function hasKey(provider) {
  if (aiOnDesktop) return native.aiHasKey(provider);
  return !!browserKey(provider);
}

export async function clearKey(provider) {
  if (aiOnDesktop) return native.aiClearKey(provider);
  delete memKeys[provider];
  try { localStorage.removeItem(lsKey(provider)); } catch { /* ignore */ }
  return true;
}

function browserKey(provider) {
  if (memKeys[provider]) return memKeys[provider];
  try { return localStorage.getItem(lsKey(provider)) || ''; } catch { return ''; }
}

/** Browser: keep the current key in this browser's storage, or only in memory. */
export function setRemember(provider, on) {
  const k = browserKey(provider);
  if (!k) return;
  memKeys[provider] = k;
  try { if (on) localStorage.setItem(lsKey(provider), k); else localStorage.removeItem(lsKey(provider)); } catch { /* storage blocked */ }
}

/** Remembered in this browser? (So Settings can show the tick.) */
export function keyRemembered(provider) {
  try { return !!localStorage.getItem(lsKey(provider)); } catch { return false; }
}

let seq = 0;
/**
 * A fetch for the provider SDKs that sends the request through the main process, which adds the
 * key. The reply body streams back over ai:event.
 */
export function nativeFetch(provider) {
  return async (url, init = {}) => {
    const id = `ai${Date.now().toString(36)}-${++seq}`;
    const signal = init.signal;
    if (signal && signal.aborted) throw new DOMException('Request was aborted.', 'AbortError');
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    let body = init.body;
    if (body != null && typeof body !== 'string') body = await new Response(body).text();

    // listen before asking, so no chunk is missed
    let ctrl, off;
    const stream = new ReadableStream({
      start(c) { ctrl = c; },
      cancel() { native.aiCancel(id); if (off) off(); },
    });
    off = native.onAiEvent((ev) => {
      if (ev.id !== id) return;
      try {
        if (ev.chunk) ctrl.enqueue(ev.chunk instanceof Uint8Array ? ev.chunk : new Uint8Array(ev.chunk));
        else if (ev.end) { ctrl.close(); off(); }
        else if (ev.error) { ctrl.error(ev.aborted ? new DOMException('Request was aborted.', 'AbortError') : new TypeError(`Network error: ${ev.error}`)); off(); }
      } catch { /* stream already closed */ }
    });
    const onAbort = () => native.aiCancel(id);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const r = await native.aiFetch(id, provider, String(url), { method: init.method || 'GET', headers, body });
    if (r.error) {
      off();
      if (r.aborted || (signal && signal.aborted)) throw new DOMException('Request was aborted.', 'AbortError');
      throw new TypeError(`Connection error: ${r.error}`);
    }
    const nullBody = [101, 204, 205, 304].includes(r.status);
    if (nullBody) off();
    return new Response(nullBody ? null : stream, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
}

/** The provider for the app's current AI settings (throws an AiError when it can't be used yet). */
export async function currentProvider(app) {
  const cfg = aiSettings(app);
  const info = providerInfo(cfg.provider);
  if (info.needsKey && !(await hasKey(cfg.provider))) {
    throw new AiError('auth', `Add your ${info.name} API key in Settings → AI to start.`);
  }
  if (cfg.provider === 'local' && !aiOnDesktop) {
    const base = cfg.baseURL || info.baseURL;
    if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(base)) {
      throw new AiError('other', 'In the browser, a local model must be on this computer (localhost). Use the desktop app for a server elsewhere.');
    }
  }
  return makeProvider(cfg, aiOnDesktop
    ? { fetch: nativeFetch(cfg.provider) }
    : { apiKey: browserKey(cfg.provider) || undefined });
}

/** Same as currentProvider, but for a settings draft (Settings → AI's model list and Test). */
export async function providerFor(cfg) {
  return makeProvider({ ...AI_DEFAULTS, ...cfg }, aiOnDesktop
    ? { fetch: nativeFetch(cfg.provider) }
    : { apiKey: browserKey(cfg.provider) || undefined });
}
