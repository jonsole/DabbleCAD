// The settings side panel: Printer / Filament / Process tabs, a preset picker per tab, pages inside
// each tab, search across everything, and a modified marker + reset on every changed setting.
import { h, button, clear, popupMenu, promptDialog, confirmDialog, toast } from '../ui/dom.js';
import { platform } from '../platform.js';
import { SCOPES, SCOPE_ORDER, LEVELS, levelOf, levelRank } from './taxonomy.js';

const fmt = (v) => (typeof v === 'number' ? String(Number(v.toFixed(5))) : String(v));
const isLong = (d) => d.type === 'polygon' || d.type === 'polygons' || /gcode|_code$/.test(d.key) || (typeof d.default === 'string' && d.default.includes('\n'));

export class SettingsPanel {
  constructor({ store, defs, index, info, profiles }) {
    Object.assign(this, { store, defs, index, info, profiles });
    this.scope = 'process';
    this.open = new Set();     // `${scope}/${page}` sections the person has expanded
    for (const s of SCOPE_ORDER) this.open.add(`${s}/${SCOPES[s].pages.find(([p]) => this.index[s][p].length)[0]}`);
    this.secs = new Map();     // `${scope}/${page}` -> { el, head, body, count, pg, built }
    this.activeSecs = [];
    this.expanded = new Map(); // key -> bool (user's choice)
    this.query = '';
    this.results = [];         // rows currently in the search results
    this.onNavigate = () => {};
    this._build();
    this.store.onChange(() => this.refresh());
  }

  // ------------------------------------------------------------------ chrome
  _build() {
    this.tabs = h('div', { class: 'sl-tabs', role: 'tablist', 'aria-label': 'Settings scope' });
    this.tabBtns = {};
    for (const s of SCOPE_ORDER) {
      const b = h('button', { class: 'sl-tab', type: 'button', role: 'tab', style: { '--scope': SCOPES[s].color }, title: SCOPES[s].blurb, onClick: () => this.setScope(s) },
        h('span', { class: 'sl-tab-name' }, SCOPES[s].label), h('span', { class: 'sl-tab-mod', hidden: true }));
      this.tabBtns[s] = b;
      this.tabs.append(b);
    }
    this.presetBar = h('div', { class: 'sl-presetbar' });
    this.blurb = h('div', { class: 'sl-blurb' });
    this.search = h('input', { class: 'input sl-search', type: 'search', placeholder: 'Search all settings', 'aria-label': 'Search settings' });
    this.search.addEventListener('input', () => { clearTimeout(this._st); this._st = setTimeout(() => { this.query = this.search.value.trim().toLowerCase(); this._renderBody(); }, 120); });
    this.levelSeg = h('div', { class: 'segmented sl-levels', role: 'group', 'aria-label': 'How many settings to show' });
    for (const [id, label] of LEVELS) this.levelSeg.append(button({ label, cls: 'sl-level', title: id === 'simple' ? 'The settings most people change' : id === 'advanced' ? 'Everything except experimental settings' : 'Every setting', onClick: () => { this.profiles.setLevel(id); this._renderBody(); this._levelUi(); } }));
    this.body = h('div', { class: 'sl-body' });
    this.el = h('div', { class: 'sl-settings' }, this.tabs, this.presetBar, this.blurb, h('div', { class: 'sl-tools' }, this.search, this.levelSeg), this.body);
    // arrow keys, Delete and friends belong to the fields in here, not to the workspace shortcuts
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this._levelUi();
    this.setScope(this.scope);
  }

  _levelUi() { [...this.levelSeg.children].forEach((b, i) => b.classList.toggle('active', LEVELS[i][0] === this.profiles.level)); }

  setScope(scope, page) {
    this.scope = scope;
    if (page) this.open.add(`${scope}/${page}`);
    this.query = ''; this.search.value = '';
    this._renderBody();
  }

  _renderChrome() {
    const sc = SCOPES[this.scope];
    this.el.style.setProperty('--scope', sc.color);
    for (const s of SCOPE_ORDER) this.tabBtns[s].classList.toggle('active', s === this.scope && !this.query);
    this.blurb.textContent = this.query ? 'Search results from the printer, filament and process settings.' : sc.blurb;
    this._renderPresetBar();
  }
  _renderPresetBar() {
    clear(this.presetBar);
    const scope = this.scope, p = this.profiles;
    const cur = p.current(scope), mods = p.modifiedKeys(scope).length;
    const sel = h('select', { class: 'select sl-preset', 'aria-label': `${SCOPES[scope].label} preset`, title: cur && cur.note ? cur.note : '' });
    const built = p.list(scope).filter((x) => x.builtin), mine = p.list(scope).filter((x) => !x.builtin);
    const opt = (x) => h('option', { value: x.id, selected: x.id === cur.id }, x.name + (x.id === cur.id && mods ? ' (modified)' : ''));
    sel.append(h('optgroup', { label: 'Built-in' }, built.map(opt)));
    if (mine.length) sel.append(h('optgroup', { label: 'My presets' }, mine.map(opt)));
    sel.addEventListener('change', async () => {
      if (mods && !(await confirmDialog('Discard changes?', `You changed ${mods} ${SCOPES[scope].label.toLowerCase()} setting${mods > 1 ? 's' : ''}. Switching preset discards them. Use Save to keep them as your own preset.`, 'Switch preset'))) { sel.value = cur.id; return; }
      p.select(scope, sel.value);
      this._renderChrome();
    });
    const menu = (e) => {
      const items = [
        { label: 'Save as new preset…', onClick: async () => { const name = await promptDialog('Save preset', 'Name', cur.builtin ? `${cur.name} copy` : cur.name); if (name && name.trim()) { p.saveAs(scope, name.trim()); this._renderChrome(); toast('Saved preset'); } } },
        { label: 'Update this preset', disabled: cur.builtin || !mods, onClick: () => { p.update(scope); this._renderChrome(); toast('Preset updated'); } },
        { label: 'Rename…', disabled: cur.builtin, onClick: async () => { const name = await promptDialog('Rename preset', 'Name', cur.name); if (name && name.trim()) { p.rename(scope, name.trim()); this._renderChrome(); } } },
        { label: 'Delete', disabled: cur.builtin, onClick: async () => { if (await confirmDialog('Delete preset?', `Delete "${cur.name}"?`, 'Delete', true)) { p.remove(scope); this._renderChrome(); } } },
        'sep',
        { label: 'Discard changes', disabled: !mods, onClick: () => { p.resetScope(scope); this._renderChrome(); } },
        'sep',
        { label: 'Export preset…', onClick: async () => { const path = await platform.saveDialog({ title: 'Export preset', defaultName: `${cur.name.replace(/[^\w .-]+/g, '')}.dabbleslicer.json`, filters: [{ name: 'Slicer preset', extensions: ['json'] }], data: new TextEncoder().encode(p.exportScope(scope)) }); if (path) toast('Exported to ' + path); } },
        { label: 'Import preset…', onClick: async () => { const files = await platform.openDialog({ filters: [{ name: 'Slicer preset', extensions: ['json'] }] }); if (!files || !files.length) return; try { const sc = p.importScope(new TextDecoder().decode(files[0].data)); this.setScope(sc); toast('Imported preset'); } catch (err) { toast(err.message || String(err), 'warn', 5000); } } },
      ];
      popupMenu(items, e.currentTarget);
    };
    this.presetBar.append(sel,
      button({ icon: 'bundle', title: 'Save as a new preset', cls: 'btn-ghost', onClick: async () => { const name = await promptDialog('Save preset', 'Name', cur.builtin ? `${cur.name} copy` : cur.name); if (name && name.trim()) { p.saveAs(scope, name.trim()); this._renderChrome(); toast('Saved preset'); } } }),
      button({ icon: 'list', title: 'Preset options', cls: 'btn-ghost', onClick: menu }));
    if (cur.note) this.presetBar.append(h('div', { class: 'sl-note' }, cur.note));
  }

  // ------------------------------------------------------------------ body
  _renderBody() {
    this._renderChrome();
    // detach everything first
    for (const c of [...this.body.children]) c.remove();
    for (const r of this.results) this._dropRow(r);
    this.results = [];
    if (this.query) { this._renderResults(); return; }
    const wrap = h('div', { class: 'sl-secs' });
    this.activeSecs = [];
    for (const [id, label] of SCOPES[this.scope].pages) {
      if (!this.index[this.scope][id].length) continue;
      const sec = this._section(this.scope, id, label);
      this.activeSecs.push(sec);
      wrap.append(sec.el);
    }
    this.active = null;
    this.body.append(wrap);
    this.refresh();
  }

  _section(scope, id, label) {
    const key = `${scope}/${id}`;
    let sec = this.secs.get(key);
    if (sec) return sec;
    sec = { key, scope, id, pg: { el: h('div', { class: 'sl-list' }), rows: [] }, built: false };
    sec.count = h('span', { class: 'sl-sec-mod', hidden: true });
    sec.chev = h('span', { class: 'sl-sec-chev', 'aria-hidden': 'true' }, '▸');
    sec.head = h('button', { class: 'sl-sec-head', type: 'button', 'aria-expanded': 'false', onClick: () => { this.open.has(key) ? this.open.delete(key) : this.open.add(key); this._syncSection(sec); } }, sec.chev, h('span', { class: 'sl-sec-name' }, label), sec.count);
    sec.body = h('div', { class: 'sl-sec-body', hidden: true }, sec.pg.el);
    sec.el = h('section', { class: 'sl-sec' }, sec.head, sec.body);
    this.secs.set(key, sec);
    return sec;
  }

  /** Open or close a section, building its rows the first time it is opened. */
  _syncSection(sec) {
    const open = this.open.has(sec.key);
    if (open && !sec.built) {
      sec.built = true;
      for (const node of this.index[sec.scope][sec.id]) this._addNode(sec.pg, sec.pg.el, node, 0);
    }
    sec.el.classList.toggle('open', open);
    sec.body.hidden = !open;
    sec.chev.textContent = open ? '▾' : '▸';
    sec.head.setAttribute('aria-expanded', String(open));
    if (open) for (const r of sec.pg.rows) r.refresh();
  }

  _renderResults() {
    const q = this.query.split(/\s+/).filter(Boolean);
    const hits = [];
    for (const node of this.info.values()) {
      const d = node.def, hay = (d.label + ' ' + d.key + ' ' + d.description).toLowerCase();
      if (q.every((t) => hay.includes(t))) hits.push(node);
      if (hits.length >= 80) break;
    }
    const list = h('div', { class: 'sl-list' });
    const pg = { el: list, rows: [] };
    if (!hits.length) list.append(h('div', { class: 'sl-empty' }, 'No setting matches that.'));
    for (const node of hits) { const r = this._makeRow(node, 0, true); pg.rows.push(r); list.append(r.el); this.results.push(r); }
    this.active = pg;
    this.body.append(list);
    this.refresh();
  }

  _dropRow(r) { r.el.remove(); }

  _addNode(pg, parentEl, node, depth) {
    const row = this._makeRow(node, depth, false);
    pg.rows.push(row);
    parentEl.append(row.el);
    if (node.children.length) {
      row.kids = h('div', { class: 'sl-kids' });
      row.el.append(row.kids);
      for (const c of node.children) this._addNode(pg, row.kids, c, depth + 1);
    }
  }

  _anyVisible(node, rank) {
    const d = node.def;
    return levelRank[levelOf(d)] <= rank || this.profiles.isModified(d.key) || node.children.some((c) => this._anyVisible(c, rank));
  }

  // ------------------------------------------------------------------ one setting
  _makeRow(node, depth, withBadge) {
    const d = node.def, store = this.store;
    const el = h('div', { class: 'sl-row', dataset: { key: d.key } });
    const name = h('span', { class: 'sl-name', title: d.description, tabindex: 0 }, d.label);
    const mod = h('span', { class: 'sl-mod', title: 'Changed from the preset', hidden: true });
    const reset = button({ icon: 'undo', title: 'Back to the preset value', cls: 'btn-ghost sl-reset', size: 14, onClick: () => this.profiles.resetKey(d.key) });
    reset.hidden = true;
    const chev = node.children.length && !withBadge ? h('button', { class: 'sl-chev', type: 'button', 'aria-label': 'Show related settings', onClick: () => { this.expanded.set(d.key, !this._isOpen(node)); this.refresh(); } }, '▸') : null;
    const desc = h('div', { class: 'sl-desc', hidden: true }, d.description, h('code', {}, d.key));
    const toggleDesc = () => { desc.hidden = !desc.hidden; };
    name.addEventListener('click', toggleDesc);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggleDesc(); });

    const ctl = this._makeControl(d);
    const unit = d.unit ? h('span', { class: 'sl-unit' }, d.unit) : null;
    const long = isLong(d);
    const head = h('div', { class: 'sl-head' }, chev, name, mod, reset);
    const badge = withBadge ? (() => { const sc = SCOPES[node.scope]; const page = sc.pages.find(([p]) => p === node.page)[1]; return h('span', { class: 'sl-badge', style: { '--scope': sc.color }, title: `${sc.label} › ${page}`, onClick: () => { this.setScope(node.scope, node.page); this.focusKey(d.key); } }, `${sc.label} › ${page}`); })() : null;
    el.append(h('div', { class: 'sl-line' + (long ? ' sl-long' : ''), style: { paddingLeft: depth * 14 + 'px' } }, head, h('div', { class: 'sl-ctl' }, ctl.el, unit)), badge || [], desc);

    const row = { el, node, kids: null, ctl, refresh: () => {} };
    row.refresh = () => {
      const v = store.get(d.key), on = store.isEnabled(d.key);
      ctl.set(v);
      el.classList.toggle('sl-off', !on);
      const m = this.profiles.isModified(d.key);
      mod.hidden = !m; reset.hidden = !m;
      const status = store.check(d.key);
      ctl.el.classList.toggle('sl-warn', status === 'warn');
      ctl.el.classList.toggle('sl-err', status === 'error');
      const l = store.limits(d.key);
      ctl.el.title = status === 'ok' ? '' : (status === 'error' ? `Out of range (${l.min ?? '…'} to ${l.max ?? '…'})` : `Unusual value (suggested ${l.minWarn ?? '…'} to ${l.maxWarn ?? '…'})`);
      if (ctl.limits) ctl.limits(l);
      if (!on) el.title = 'Not used with the current settings'; else el.removeAttribute('title');
      if (chev) chev.textContent = this._isOpen(node) ? '▾' : '▸';
      if (row.kids) row.kids.hidden = !this._isOpen(node);
      const rank = levelRank[this.profiles.level];
      el.hidden = withBadge ? false : !this._anyVisible(node, rank);
    };
    return row;
  }

  _isOpen(node) {
    const k = node.def.key;
    if (this.expanded.has(k)) return this.expanded.get(k);
    // Simple mode lists the settings people use, so their children are not hidden behind a chevron
    return this.profiles.level === 'simple' || node.children.some((c) => this.profiles.isModified(c.def.key));
  }

  _makeControl(d) {
    const store = this.store;
    const commit = (v) => store.set(d.key, v);
    switch (d.type) {
      case 'bool': {
        const input = h('input', { type: 'checkbox', 'aria-label': d.label });
        input.addEventListener('change', () => commit(input.checked));
        return { el: h('label', { class: 'switch' }, input, h('i')), set: (v) => { input.checked = !!v; } };
      }
      case 'enum': {
        const sel = h('select', { class: 'select', 'aria-label': d.label }, Object.entries(d.options || {}).map(([v, t]) => h('option', { value: v }, t)));
        sel.addEventListener('change', () => commit(sel.value));
        return { el: sel, set: (v) => { sel.value = String(v); } };
      }
      case 'float': case 'int': {
        const input = h('input', { class: 'input', type: 'number', step: d.type === 'int' ? 1 : 'any', 'aria-label': d.label });
        input.addEventListener('change', () => {
          let v = parseFloat(input.value);
          if (!Number.isFinite(v)) { input.value = fmt(store.get(d.key)); return; }
          const l = store.limits(d.key);
          if (l.min !== undefined) v = Math.max(l.min, v);
          if (l.max !== undefined) v = Math.min(l.max, v);
          commit(v);
          input.value = fmt(store.get(d.key));
        });
        return { el: input, set: (v) => { if (document.activeElement !== input) input.value = fmt(v); }, limits: (l) => { if (l.min !== undefined) input.min = l.min; else input.removeAttribute('min'); if (l.max !== undefined) input.max = l.max; else input.removeAttribute('max'); } };
      }
      case 'str': case 'polygon': case 'polygons': case '[int]': case 'vec2': {
        const json = d.type !== 'str';
        const long = isLong(d);
        const input = long ? h('textarea', { class: 'input sl-text', rows: json ? 3 : 6, spellcheck: false, 'aria-label': d.label }) : h('input', { class: 'input', type: 'text', spellcheck: false, 'aria-label': d.label });
        input.addEventListener('change', () => {
          if (!json) { commit(input.value); return; }
          try { const v = JSON.parse(input.value); if (!Array.isArray(v)) throw new Error('not a list'); commit(v); input.classList.remove('sl-err'); } catch { input.classList.add('sl-err'); input.title = 'This needs to be a list such as [[0, 0], [10, 0]]'; }
        });
        return { el: input, set: (v) => { if (document.activeElement !== input && !input.classList.contains('sl-err')) input.value = json ? JSON.stringify(v) : String(v); } };
      }
      default: {
        const input = h('input', { class: 'input', type: 'text', 'aria-label': d.label });
        input.addEventListener('change', () => commit(input.value));
        return { el: input, set: (v) => { if (document.activeElement !== input) input.value = String(v); } };
      }
    }
  }

  // ------------------------------------------------------------------ updates
  refresh() {
    for (const s of SCOPE_ORDER) {
      const n = this.profiles.modifiedKeys(s).length;
      const m = this.tabBtns[s].querySelector('.sl-tab-mod');
      m.hidden = !n; m.textContent = n;
      m.title = `${n} setting${n === 1 ? '' : 's'} changed from the ${SCOPES[s].label.toLowerCase()} preset`;
    }
    this._renderPresetBar();
    const rank = levelRank[this.profiles.level];
    const mods = new Set(this.profiles.modifiedKeys(this.scope));
    for (const sec of this.activeSecs) {
      const nodes = this.index[sec.scope][sec.id];
      sec.el.hidden = !nodes.some((n) => this._anyVisible(n, rank));
      const n = [...mods].filter((k) => { const i = this.info.get(k); return i && i.page === sec.id; }).length;
      sec.count.hidden = !n; sec.count.textContent = n;
      sec.count.title = `${n} setting${n === 1 ? '' : 's'} changed in this section`;
      this._syncSection(sec);
    }
    if (this.active) for (const r of this.active.rows) r.refresh();
    this._levelUi();
  }

  /** Jump to a setting: switch to its scope and page, make sure it is visible, scroll to it. */
  focusKey(key) {
    const n = this.info.get(key);
    if (!n) return;
    if (this.query) { this.query = ''; this.search.value = ''; }
    this.scope = n.scope; this.open.add(`${n.scope}/${n.page}`);
    if (levelRank[levelOf(n.def)] > levelRank[this.profiles.level]) this.profiles.setLevel(levelOf(n.def));
    // open any collapsed parents
    for (let p = n.def.parent; p; p = this.defs.get(p).parent) this.expanded.set(p, true);
    this._renderBody();
    const el = this.body.querySelector(`[data-key="${key}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('sl-flash'); setTimeout(() => el.classList.remove('sl-flash'), 1600); }
  }
}
