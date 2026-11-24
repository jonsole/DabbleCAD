// The floating AI chat window: drag it by its header, resize it from the corner; where it is,
// its size and whether it's open are remembered. Available in 3D Design and Laser.

import { h, button, icon, clear, toast, confirmDialog } from '../ui/dom.js';
import { ChatSession, scopeFor } from './chat.js';
import { currentProvider, aiSettings, hasKey } from './config.js';
import { providerInfo } from './providers.js';
import { IMPORT_FILTERS } from '../core/io.js';

const LONG_SIDE = 1024;

/** A small, safe Markdown subset (paragraphs, lists, code, bold, italics) built as DOM nodes. */
export function renderMarkdown(text) {
  const root = h('div', { class: 'ai-md' });
  const inline = (s) => {
    const out = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('`')) out.push(h('code', {}, t.slice(1, -1)));
      else if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
      else out.push(h('em', {}, t.slice(1, -1)));
      last = m.index + t.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = h(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) list.append(h('li', {}, inline(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))));
      root.append(list);
    } else if (/^#{1,6}\s/.test(line)) {
      root.append(h('p', {}, h('strong', {}, inline(line.replace(/^#+\s*/, '')))));
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^```|^\s*([-*•]|\d+[.)])\s+|^#{1,6}\s/.test(lines[i])) para.push(lines[i++]);
      const p = h('p');
      para.forEach((l, k) => { if (k) p.append(h('br')); p.append(...inline(l)); });
      root.append(p);
    }
  }
  return root;
}

/** A link to a web page; it opens in the user's browser. */
function link({ url, title }) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return h('span', {}, title || url); }
  if (!/^https?:/i.test(url)) return h('span', {}, title || url);
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, title || host, h('span', { class: 'ai-host' }, ` ${host}`));
}

const pretty = (v) => { try { return typeof v === 'string' ? (() => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } })() : JSON.stringify(v, null, 2); } catch { return String(v); } };

export class AiWindow {
  constructor(app) {
    this.app = app;
    this.session = new ChatSession(() => scopeFor(app, this.session), () => currentProvider(app), { askBeforeEdits: () => !!this.st().ask });
    this.replyEls = new Map();
    this.attach = false;
    this.files = [];   // attached for the next message: { name, data }
    this._build();
    this.session.on((ev) => this._event(ev));
  }

  st() { return this.app.settings.aiWindow || {}; }
  save(patch) { this.app.patchSettings({ aiWindow: { ...this.st(), ...patch } }); }

  _build() {
    const s = this.st();
    this.modelLabel = h('span', { class: 'ai-model' });
    this.askBox = h('input', { type: 'checkbox', checked: !!s.ask });
    this.askBox.addEventListener('change', () => this.save({ ask: this.askBox.checked }));
    const ask = h('label', { class: 'ai-ask', title: 'Ask before edits: the AI\'s changes wait for you to apply or skip them' }, this.askBox, 'Ask before edits');
    this.head = h('div', { class: 'ai-head' }, icon('sparkle', 16), h('span', { class: 'ai-title' }, 'AI'), this.modelLabel, h('span', { class: 'spacer' }), ask,
      button({ icon: 'newchat', title: 'New chat', size: 16, onClick: () => this.newChat() }),
      button({ icon: 'close', title: 'Close', size: 16, onClick: () => this.toggle(false) }));
    this.list = h('div', { class: 'ai-list', role: 'log', 'aria-live': 'polite' });
    this.input = h('textarea', { class: 'ai-input', rows: 2, placeholder: 'Ask about your design, or describe what to make…', 'aria-label': 'Message to the AI' });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();   // typing here must not trigger editor shortcuts
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendFromInput(); }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.attachBtn = button({ icon: 'attach', title: 'Attach a picture of the view to the next message', size: 16, cls: 'ai-attach', onClick: () => this.setAttach(!this.attach) });
    this.fileIn = h('input', { type: 'file', multiple: true, accept: IMPORT_FILTERS[0].extensions.map((e) => '.' + e).join(','), style: { display: 'none' } });
    this.fileIn.addEventListener('change', () => { this.addFiles([...this.fileIn.files]); this.fileIn.value = ''; });
    this.clipBtn = button({ icon: 'clip', title: 'Attach a file for the AI to import (STL, OBJ, 3MF, SVG, images, .dabble)', size: 16, onClick: () => this.fileIn.click() });
    this.fileChips = h('div', { class: 'ai-files' });
    this.sendBtn = button({ icon: 'send', title: 'Send (Enter)', size: 16, cls: 'btn-primary ai-send', onClick: () => this.sendFromInput() });
    this.stopBtn = button({ icon: 'stop', label: 'Stop', size: 14, cls: 'btn-outline ai-stop', onClick: () => this.session.stop() });
    this.stopBtn.style.display = 'none';
    this.footer = h('div', { class: 'ai-foot' });
    this.el = h('div', { class: 'ai-win', role: 'dialog', 'aria-label': 'AI chat' },
      this.head, this.list,
      this.fileChips,
      h('div', { class: 'ai-compose' }, this.input, h('div', { class: 'ai-compose-btns' }, this.clipBtn, this.attachBtn, this.stopBtn, this.sendBtn), this.fileIn),
      this.footer);
    this.el.classList.add('closed');
    // files dropped on the chat are attached, not imported straight away
    this.el.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    this.el.addEventListener('drop', (e) => { if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); e.stopPropagation(); this.addFiles([...e.dataTransfer.files]); });
  }

  get open() { return !this.el.classList.contains('closed'); }

  /** Show or hide; remembered. In the Slicer the window stays hidden (the AI doesn't work there). */
  toggle(on = !this.open) {
    this.save({ open: on });
    this.sync();
    if (on) setTimeout(() => this.input.focus(), 0);
  }

  /** Match the window to the workspace and settings. */
  async sync() {
    const allowed = this.app.viewMode !== 'slicer';
    const show = allowed && !!this.st().open;
    this.el.classList.toggle('closed', !show);
    this._attach();
    if (this.app.aiBtn) {
      this.app.aiBtn.classList.toggle('active', show);
      this.app.aiBtn.style.display = allowed ? '' : 'none';
    }
    if (!show) return;
    const cfg = aiSettings(this.app);
    const info = providerInfo(cfg.provider);
    this.modelLabel.textContent = cfg.provider === 'local' ? (cfg.model || 'local model') : (cfg.model || info.defaultModel);
    this.footer.textContent = `Sends a design summary and tool results to ${cfg.provider === 'local' ? 'your local model' : info.name.replace(/ \(.*/, '')}.`;
    const ready = !info.needsKey || (await hasKey(cfg.provider));
    this._setupNote(!ready);
  }

  _setupNote(show) {
    if (this.setupEl) { this.setupEl.remove(); this.setupEl = null; }
    if (!show) return;
    this.setupEl = h('div', { class: 'ai-setup' },
      h('p', {}, 'To chat, add an API key for the AI provider in Settings → AI. (Or use a model running on this computer.)'),
      button({ label: 'Set up AI', icon: 'settings', cls: 'btn-primary', onClick: () => this.app.openAiSettings() }));
    this.list.prepend(this.setupEl);
  }

  /** The window floats or docks in the current workspace, like every other panel. */
  _attach() {
    const a = this.app;
    const mgr = a.viewMode === 'laser' ? a.laser && a.laser.dock : a.viewMode === 'slicer' ? a.slicer && a.slicer.dock : a.dock;
    if (!mgr) { if (!this.el.parentElement) document.body.append(this.el); return; }
    if (this.el._dock !== mgr) mgr.add(this.el, { key: 'ai-chat', handle: '.ai-head', grow: true, isOpen: () => this.open });
  }

  setAttach(on) {
    this.attach = on;
    this.attachBtn.classList.toggle('active', on);
    this.attachBtn.title = on ? 'A picture of the view will go with the next message (click to cancel)' : 'Attach a picture of the view to the next message';
  }

  /** A PNG of the current view, about 1024 px on its long side. */
  snapshot() {
    const src = this.app.viewMode === 'laser' ? this.app.laser.canvas : (this.app.viewport.renderNow(), this.app.viewport.canvas);
    const k = Math.min(1, LONG_SIDE / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return { mediaType: 'image/png', data: c.toDataURL('image/png').split(',')[1], url: c.toDataURL('image/png') };
  }

  async addFiles(list) {
    const ok = new Set(IMPORT_FILTERS[0].extensions);
    for (const f of list) {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!ok.has(ext)) { toast(`${f.name}: not a file the design can import`, 'warn'); continue; }
      if (f.size > 100 * 1024 * 1024) { toast(`${f.name} is too big (over 100 MB)`, 'warn'); continue; }
      this.files = this.files.filter((x) => x.name !== f.name);
      this.files.push({ name: f.name, data: await f.arrayBuffer() });
    }
    this._showFiles();
    this.input.focus();
  }

  _showFiles() {
    clear(this.fileChips);
    for (const f of this.files) {
      this.fileChips.append(h('span', { class: 'ai-file' }, icon('clip', 12), f.name,
        button({ icon: 'close', size: 12, title: 'Remove', onClick: () => { this.files = this.files.filter((x) => x !== f); this._showFiles(); } })));
    }
  }

  newChat() {
    this.session.reset();
    clear(this.list);
    this.replyEls.clear();
    this.setAttach(false);
    this.files = [];
    this._showFiles();
    this.sync();
    this.input.focus();
  }

  async sendFromInput() {
    let text = this.input.value.trim();
    if ((!text && !this.files.length) || this.session.busy) return;
    if (this.files.length) {
      for (const f of this.files) {
        this.session.attachments = this.session.attachments.filter((x) => x.name !== f.name);
        this.session.attachments.push(f);
      }
      const names = this.files.map((f) => f.name).join(', ');
      text = `${text || 'Import this.'}\n\n(Attached for import: ${names})`;
      this.files = [];
      this._showFiles();
    }
    this.input.value = '';
    let image = null;
    if (this.attach) { try { image = this.snapshot(); } catch (e) { toast(`Couldn't capture the view: ${e.message}`, 'error'); } }
    this.setAttach(false);
    await this.send(text, image);
  }

  async send(text, image) {
    this.lastSent = { text, image };
    await this.session.send(text, image ? { image } : {});
  }

  // ------------------------------------------------------------------ session events
  _event(ev) {
    if (ev.type === 'busy') {
      this.stopBtn.style.display = ev.busy ? '' : 'none';
      this.sendBtn.classList.toggle('disabled', ev.busy);
      return;
    }
    if (ev.type === 'user') {
      if (this.setupEl) { this.setupEl.remove(); this.setupEl = null; }
      const m = h('div', { class: 'ai-msg ai-user' }, ev.msg.image ? h('img', { class: 'ai-shot', src: ev.msg.image.url, alt: 'Picture of the view' }) : null, h('div', { class: 'ai-text' }, ev.msg.text));
      this.list.append(m);
      this._scroll();
      return;
    }
    const r = ev.reply;
    let v = this.replyEls.get(r.id);
    if (!v) {
      v = { el: h('div', { class: 'ai-msg ai-bot' }), body: h('div', { class: 'ai-body' }), chips: h('div', { class: 'ai-chips' }), cards: h('div', { class: 'ai-cards' }), tail: h('div', { class: 'ai-tail' }), chipEls: new Map(), cardEls: new Map() };
      v.el.append(v.chips, v.cards, v.body, v.tail);
      v.body.append(h('span', { class: 'ai-typing' }, h('i'), h('i'), h('i')));
      this.replyEls.set(r.id, v);
      this.list.append(v.el);
    }
    if (ev.type === 'text') { clear(v.body).append(renderMarkdown(ev.text)); }
    if (ev.type === 'chip') this._chip(v, ev.chip);
    if (ev.type === 'card') this._card(v, ev.card);
    if (ev.type === 'error' || ev.type === 'done') this._finish(v, r);
    this._scroll();
  }

  _chip(v, c) {
    let el = v.chipEls.get(c.id);
    const mark = { running: '…', ok: '✓', error: '!', skipped: '–', waiting: '?' }[c.status] || '';
    const what = c.web && c.input && (c.input.query || c.input.url) ? `: ${String(c.input.query || c.input.url).slice(0, 48)}` : '';
    const label = `${mark} ${c.name.replace(/_/g, ' ')}${what}`;
    if (!el) {
      el = h('details', { class: 'ai-chip' }, h('summary', {}), h('div', { class: 'ai-chip-io' }));
      v.chipEls.set(c.id, el);
      v.chips.append(el);
    }
    el.className = `ai-chip ${c.status}${c.web ? " web" : ""}`;
    el.querySelector('summary').textContent = label;
    const io = clear(el.querySelector('.ai-chip-io'));
    io.append(h('div', { class: 'ai-io-h' }, 'Input'), h('pre', {}, pretty(c.input || {})));
    if (c.web && Array.isArray(c.result)) {
      io.append(h('div', { class: 'ai-io-h' }, `Found (${c.result.length})`), h('ul', { class: 'ai-links' }, c.result.slice(0, 10).map((r) => h('li', {}, link(r)))));
    } else if (c.result != null) io.append(h('div', { class: 'ai-io-h' }, c.status === 'error' ? 'Error' : 'Result'), h('pre', {}, pretty(c.result)));
  }

  _card(v, card) {
    let el = v.cardEls.get(card.id);
    if (!el) {
      el = h('div', { class: 'ai-card' });
      v.cardEls.set(card.id, el);
      v.cards.append(el);
    }
    clear(el).append(h('span', { class: 'ai-card-what' }, card.summary));
    el.className = `ai-card ${card.state}`;
    if (card.state === 'waiting') {
      el.append(h('span', { class: 'ai-card-btns' },
        button({ label: 'Apply', cls: 'btn-primary', onClick: () => card.decide(true) }),
        button({ label: 'Skip', cls: 'btn-outline', onClick: () => card.decide(false) }),
        button({ label: 'Apply all', cls: 'btn-ghost', onClick: () => this.session.applyAll() })));
    } else el.append(h('span', { class: 'ai-card-state' }, card.state === 'applied' ? 'Applied' : 'Skipped'));
  }

  _finish(v, r) {
    const typing = v.body.querySelector('.ai-typing');
    if (typing) typing.remove();
    clear(v.tail);
    if (!r.text && !r.error && !r.refusal && !r.chips.length) v.body.append(h('p', { class: 'ai-dim' }, '(No reply.)'));
    if (r.sources && r.sources.length) {
      v.tail.append(h('div', { class: 'ai-sources' }, h('span', { class: 'ai-io-h' }, 'Sources'), h('ul', { class: 'ai-links' }, r.sources.slice(0, 12).map((x) => h('li', {}, link(x))))));
    }
    if (r.refusal) v.tail.append(h('div', { class: 'ai-refusal' }, r.refusal));
    if (r.error) {
      const cancelled = r.error.kind === 'cancelled';
      const webOff = /web (search|fetch)[^.]*not enabled|not enabled[^.]*web (search|fetch)/i.test(r.error.message || '');
      const msg = webOff ? 'Web search isn\'t turned on for your Anthropic account. An admin can turn it on in the Claude Console (Settings → Capabilities), or switch off Web access in Settings → AI.' : r.error.message;
      v.tail.append(h('div', { class: cancelled ? 'ai-dim' : 'ai-error' }, cancelled ? 'Stopped.' : msg,
        cancelled ? null : button({ label: 'Retry', cls: 'btn-outline', onClick: () => this.retry(r) }),
        r.error.kind === 'auth' ? button({ label: 'Settings', cls: 'btn-ghost', onClick: () => this.app.openAiSettings() }) : null));
    }
    if (r.done && r.edits) {
      v.undoBtn = button({ label: 'Undo this reply', icon: 'undo', size: 14, cls: 'btn-ghost ai-undo', onClick: () => this.undoReply(r) });
      v.tail.append(v.undoBtn);
    }
  }


  async undoReply(r) {
    let res = this.session.undoReply(r);
    if (!res.ok && res.reason === 'changed-since') {
      const ok = await confirmDialog('Undo this reply', 'The design has changed since this reply. Put it back to how it was before the reply? Changes made after it are lost too (you can undo this).', 'Put it back', true);
      if (!ok) return;
      res = this.session.undoReply(r, { force: true });
    }
    if (res.ok) {
      toast('Reply undone');
      const v = [...this.replyEls.values()].find((x) => x.undoBtn && this.session && x.el.isConnected && x === this.replyEls.get(r.id));
      if (v) { v.undoBtn.remove(); v.undoBtn = null; v.tail.append(h('span', { class: 'ai-dim' }, 'Undone.')); }
    }
    else if (res.reason === 'too-old' || res.reason === 'nothing') toast('There is nothing left to undo for this reply');
  }

  retry(r) {
    const v = this.replyEls.get(r.id);
    if (v) v.el.remove();
    this.replyEls.delete(r.id);
    const tail = this.session.messages[this.session.messages.length - 1];
    if (tail && tail.role === 'tool') return this.send('Please carry on (the last attempt failed part-way).', null);
    if (this.lastSent) {
      // the failed user message is shown again by send()
      const prev = this.list.querySelectorAll('.ai-user');
      if (prev.length) prev[prev.length - 1].remove();
      return this.send(this.lastSent.text, this.lastSent.image);
    }
  }

  _scroll() { this.list.scrollTop = this.list.scrollHeight; }
}
