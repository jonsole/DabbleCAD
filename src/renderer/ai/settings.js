// Settings → AI: provider, API key (with Test connection), model, effort or temperature,
// and the server address for a local model.

import { h, button, clear } from '../ui/dom.js';
import { PROVIDERS, providerInfo } from './providers.js';
import { aiSettings, aiOnDesktop, setKey, hasKey, clearKey, keyRemembered, setRemember, providerFor } from './config.js';

const row = (title, hint, control) => h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, title, hint ? h('small', {}, hint) : null), control);

export function aiSettingsGroup(app) {
  const group = h('div', { class: 'set-group', 'data-sec': 'ai' }, h('h4', {}, 'AI'));
  const body = h('div');
  group.append(body);
  const patch = (p) => { app.patchSettings({ ai: { ...aiSettings(app), ...p } }); if (app.ai) app.ai.sync(); };

  async function render() {
    const cfg = aiSettings(app);
    const info = providerInfo(cfg.provider);
    clear(body);

    const provSel = h('select', { class: 'select' }, PROVIDERS.map((p) => h('option', { value: p.id }, p.name)));
    provSel.value = cfg.provider;
    provSel.addEventListener('change', () => { patch({ provider: provSel.value, model: '' }); render(); });
    body.append(row('Provider', 'Which AI answers in the chat window. Your design summary and tool results are sent to it.', provSel));

    // ---- key
    const saved = await hasKey(cfg.provider);
    const keyIn = h('input', { type: 'password', class: 'input ai-key', placeholder: saved ? 'Saved (type to replace)' : info.keyHint, autocomplete: 'off', spellcheck: 'false' });
    const eye = button({ icon: 'eye', title: 'Show or hide the key', size: 16, onClick: () => { keyIn.type = keyIn.type === 'password' ? 'text' : 'password'; } });
    const status = h('small', { class: 'ai-key-status' });
    let remember = !aiOnDesktop && keyRemembered(cfg.provider);
    const saveKey = async () => {
      if (!keyIn.value.trim()) return;
      await setKey(cfg.provider, keyIn.value, { remember, baseURL: cfg.provider === 'local' ? cfg.baseURL || info.baseURL : undefined });
      keyIn.value = '';
      if (app.ai) app.ai.sync();
      render();
    };
    keyIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') saveKey(); });
    const test = button({ label: 'Test connection', cls: 'btn-outline', onClick: async () => {
      if (keyIn.value.trim()) await saveKey();
      status.textContent = 'Testing…'; status.className = 'ai-key-status';
      try {
        const p = await providerFor(aiSettings(app));
        await p.test();
        status.textContent = 'Connected.'; status.className = 'ai-key-status ok';
        loadModels();
      } catch (e) { status.textContent = e.message; status.className = 'ai-key-status bad'; }
    } });
    const keyCtl = h('div', { class: 'set-btns ai-keyrow' }, keyIn, eye,
      button({ label: 'Save', cls: 'btn-primary', onClick: saveKey }),
      saved ? button({ label: 'Remove', cls: 'btn-ghost', onClick: async () => { await clearKey(cfg.provider); if (app.ai) app.ai.sync(); render(); } }) : null);
    const where = aiOnDesktop
      ? 'Kept encrypted on this computer; it never leaves it except to go to the provider.'
      : remember ? 'Remembered in this browser.' : 'Kept only while this tab is open.';
    body.append(row(cfg.provider === 'local' ? 'API key (optional)' : 'API key', saved ? `A key is saved. ${where}` : `${cfg.provider === 'anthropic' ? 'Get one at console.anthropic.com. ' : ''}${where}`, keyCtl));
    body.append(h('div', { class: 'set-row ai-test' }, h('div', { class: 'set-text' }, status), test));

    if (!aiOnDesktop) {
      const cb = h('input', { type: 'checkbox', checked: remember });
      cb.addEventListener('change', async () => {
        remember = cb.checked;
        setRemember(cfg.provider, remember);
        render();
      });
      body.append(row('Remember on this device', 'Stores the key in this browser so you don\'t have to enter it again. Anyone who can use this browser profile could read it: only tick this on your own computer.', h('label', { class: 'switch' }, cb, h('i'))));
    }

    // ---- server (local)
    if (cfg.provider === 'local') {
      const url = h('input', { type: 'text', class: 'input', value: cfg.baseURL || info.baseURL, spellcheck: 'false' });
      url.addEventListener('keydown', (e) => e.stopPropagation());
      url.addEventListener('change', async () => {
        const v = url.value.trim().replace(/\/$/, '');
        patch({ baseURL: v });
        if (aiOnDesktop && saved) await setKey('local', null, { baseURL: v });
      });
      body.append(row('Server address', aiOnDesktop
        ? 'An OpenAI-compatible server, e.g. Ollama (http://localhost:11434/v1) or LM Studio (http://localhost:1234/v1).'
        : 'An OpenAI-compatible server on this computer, e.g. Ollama (http://localhost:11434/v1). Servers elsewhere need the desktop app.', url));
    }

    // ---- model
    const modelSel = h('select', { class: 'select' });
    const fillModels = (list) => {
      clear(modelSel);
      if (cfg.provider === 'anthropic') modelSel.append(h('option', { value: '' }, `Default (${info.defaultModel})`));
      else modelSel.append(h('option', { value: '' }, list.length ? 'Choose a model…' : 'No models found yet'));
      const ids = new Set();
      for (const m of list) { ids.add(m.id); modelSel.append(h('option', { value: m.id }, m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id)); }
      if (cfg.model && !ids.has(cfg.model)) modelSel.append(h('option', { value: cfg.model }, cfg.model));
      modelSel.value = cfg.model || '';
    };
    fillModels([]);
    modelSel.addEventListener('change', () => patch({ model: modelSel.value }));
    async function loadModels() {
      try {
        const p = await providerFor(aiSettings(app));
        fillModels(await p.listModels());
      } catch { /* keep what's there; Test connection explains problems */ }
    }
    const refresh = button({ icon: 'rotate', title: 'Fetch the model list', size: 16, onClick: loadModels });
    body.append(row('Model', 'The list comes from the provider.', h('div', { class: 'set-btns' }, modelSel, refresh)));
    if (saved || !info.needsKey) loadModels();

    // ---- web access (Anthropic's own web search and fetch)
    if (cfg.provider === 'anthropic') {
      const cb = h('input', { type: 'checkbox', checked: cfg.web !== false });
      cb.addEventListener('change', () => patch({ web: cb.checked }));
      body.append(row('Web access', 'Lets the AI search the web and read pages, e.g. to look up a part\'s dimensions. Anthropic runs the searches ($10 per 1,000 searches, plus the extra text it reads). An admin may need to turn web search on in the Claude Console.', h('label', { class: 'switch' }, cb, h('i'))));
    } else {
      body.append(row('Web access', 'Only with Anthropic: a local model can\'t search the web from here.', h('span')));
    }

    // ---- effort / temperature
    if (cfg.provider === 'anthropic') {
      const seg = h('div', { class: 'segmented' });
      for (const [id, label] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]) {
        const b = button({ label, cls: (cfg.effort || 'medium') === id ? 'active' : '', onClick: () => { patch({ effort: id }); [...seg.children].forEach((c) => c.classList.toggle('active', c === b)); } });
        seg.append(b);
      }
      body.append(row('Effort', 'How hard the model thinks before answering: higher is more careful, but slower and costs more.', seg));
    } else {
      const t = h('input', { type: 'number', class: 'input', min: 0, max: 2, step: 0.1, value: cfg.temperature ?? 0.2, style: { width: '80px' } });
      t.addEventListener('keydown', (e) => e.stopPropagation());
      t.addEventListener('change', () => patch({ temperature: Math.min(2, Math.max(0, parseFloat(t.value) || 0)) }));
      body.append(row('Temperature', 'Lower keeps answers steady; higher is more varied.', t));
    }
  }

  render();
  return group;
}

