// The settings side panel: Printer / Filament / Process tabs, a preset picker per tab, pages inside
// each tab, search across everything, and a modified marker + reset on every changed setting.
import { readCuraProject } from './cura3mf.js';
import { KINDS, testConnection } from './printerlink.js';
import { h, button, clear, popupMenu, promptDialog, confirmDialog, toast } from '../ui/dom.js';
import { platform } from '../platform.js';
import { SCOPES, SCOPE_ORDER, LEVELS, levelOf, levelRank } from './taxonomy.js';

const fmt = (v) => (typeof v === 'number' ? String(Number(v.toFixed(5))) : String(v));
const isFormula = (d) => typeof d.value === 'string' && /[A-Za-z_]{2,}/.test(d.value.replace(/'[^']*'|"[^"]*"/g, '').replace(/\b(True|False|None)\b/g, ''));
const svgIcon = (d, size = 18) => h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'icon' }, h('path', { d }));
const PAGE_ICONS = {
  quality: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5', strength: 'M4 4h16v16H4zM4 12h16M12 4v16', speed: 'M4 18a9 9 0 1 1 16 0M12 18l4-6',
  travel: 'M4 12h14M13 7l5 5-5 5', support: 'M3 20h18M6 20v-8M12 20V8M18 20v-8M4 8h16', adhesion: 'M3 17h18M6 17v-4h12v4M9 13V9h6v4',
  others: 'M5 12h.01M12 12h.01M19 12h.01',
  basic: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.500v.500', gcode: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14',
  extruder: 'M8 3h8v6l-2 3h-4l-2-3zM12 12v4M10 20h4', motion: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  filament: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  cooling: 'M12 10.500a1.500 1.500 0 1 0 0 3 1.500 1.500 0 0 0 0-3zM12 10.500C12 6 14 3 17 4c2 1 1 4-2 6M13.500 12c4.500 0 7.500 2 6.500 5-1 2-4 1-6-2M12 13.500c0 4.500-2 7.500-5 6.500-2-1-1-4 2-6M10.500 12C6 12 3 10 4 7c1-2 4-1 6 2',
  advanced: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4',
};
/** Arrow-key / spinner step: 0.2 goes to 0.3, 0.15 to 0.16, 205 to 206, 20 % to 21 %. */
const stepFor = (d, v) => {
  if (d.type === 'int') return 1;
  const dec = (String(Number(Math.abs(v).toFixed(5))).split('.')[1] || '').length;
  if (dec >= 2) return Number((10 ** -dec).toFixed(dec));
  return Math.abs(v) >= 10 || d.unit === '%' ? 1 : 0.1;
};
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
    this.rail = h('div', { class: 'sl-rail', role: 'navigation', 'aria-label': 'Jump to a section' });
    this.bodyWrap = h('div', { class: 'sl-bodywrap' }, this.rail, this.body);
    this._spy = 0;
    this.body.addEventListener('scroll', () => { if (!this._spy) this._spy = requestAnimationFrame(() => { this._spy = 0; this._spyUpdate(); }); });
    this.el = h('div', { class: 'sl-settings' }, this.tabs, this.presetBar, this.blurb, h('div', { class: 'sl-tools' }, this.search, this.levelSeg), this.bodyWrap);
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
      if (scope === 'printer' && this.connSync) this.connSync();
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
        { label: 'Import from Cura (.3mf / .curaprofile)…', onClick: () => this._importCura() },
      ];
      popupMenu(items, e.currentTarget);
    };
    this.presetBar.append(sel,
      button({ icon: 'bundle', title: 'Save as a new preset', cls: 'btn-ghost', onClick: async () => { const name = await promptDialog('Save preset', 'Name', cur.builtin ? `${cur.name} copy` : cur.name); if (name && name.trim()) { p.saveAs(scope, name.trim()); this._renderChrome(); toast('Saved preset'); } } }),
      button({ icon: 'list', title: 'Preset options', cls: 'btn-ghost', onClick: menu }));
    if (cur.note) this.presetBar.append(h('div', { class: 'sl-note' }, cur.note));
  }

  /** How to reach the selected printer to send it G-code (kept per printer preset, on this computer only). */
  _connectionCard() {
    const p = this.profiles;
    const kind = h('select', { class: 'select', 'aria-label': 'Firmware' }, Object.entries(KINDS).map(([id, k]) => h('option', { value: id }, k.label)));
    const url = h('input', { class: 'input', type: 'text', placeholder: 'http://ratrig.local', 'aria-label': 'Printer address', spellcheck: false });
    const user = h('input', { class: 'input', type: 'text', placeholder: 'optional', autocomplete: 'off', 'aria-label': 'Username' });
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Password or API key' });
    const start = h('input', { type: 'checkbox' });
    const result = h('div', { class: 'sl-conn-result', role: 'status' });
    const passLabel = h('span', {}, 'Password');
    const hint = h('div', { class: 'sl-note' });
    const read = () => ({ kind: kind.value, url: url.value.trim(), user: user.value.trim(), password: pass.value, start: start.checked });
    const sync = () => {
      const c = p.connection();
      kind.value = c.kind; url.value = c.url; user.value = c.user; pass.value = c.password; start.checked = !!c.start;
      passLabel.textContent = KINDS[c.kind].secret; url.placeholder = KINDS[c.kind].hint.replace(/^.*e\.g\. /, '');
      hint.textContent = KINDS[c.kind].hint + '. A username is only for a printer behind a login (HTTP basic); otherwise leave it empty.';
      result.textContent = ''; result.className = 'sl-conn-result';
    };
    const save = () => { p.setConnection(read()); passLabel.textContent = KINDS[kind.value].secret; };
    for (const el of [kind, url, user, pass, start]) el.addEventListener('change', save);
    kind.addEventListener('change', sync);
    const test = button({ label: 'Test connection', cls: 'btn-outline', onClick: async () => {
      save(); result.className = 'sl-conn-result'; result.textContent = 'Connecting…';
      try { result.textContent = '✓ ' + (await testConnection(p.connection())); result.className = 'sl-conn-result ok'; } catch (err) { result.textContent = err.message || String(err); result.className = 'sl-conn-result bad'; }
    } });
    const row = (label, el) => h('label', { class: 'sl-conn-row' }, h('span', {}, label), el);
    this.connSync = sync;
    sync();
    return h('div', { class: 'sl-conn' },
      h('div', { class: 'sl-conn-head' }, 'Printer connection', h('span', { class: 'sl-note' }, 'to send G-code straight to this printer')),
      row('Firmware', kind), row('Address', url), row('Username', user), row(passLabel, pass),
      h('label', { class: 'sl-conn-row sl-conn-check' }, start, h('span', {}, 'Start the print after sending')),
      hint, h('div', { class: 'sl-conn-actions' }, test, result));
  }

  /** Read printer, material and quality settings from a Cura project and add them as presets. */
  async _importCura() {
    const files = await platform.openDialog({ filters: [{ name: 'Cura project or profile', extensions: ['3mf', 'curaprofile'] }] });
    if (!files || !files.length) return;
    try {
      const { presets, skipped, machine } = readCuraProject(new Uint8Array(files[0].data), this.defs, (k) => (this.info.get(k) || {}).scope || null);
      if (!presets.length) throw new Error('No settings found in this project');
      for (const pr of presets) {
        if (pr.partial) this.store.patch(pr.overrides);          // a profile has no machine: adjust the current printer, keep its size and G-code
        else this.profiles.addPreset(pr.scope, pr.name, pr.overrides);
      }
      this._renderChrome(); this._renderBody();
      const count = presets.reduce((n, pr) => n + Object.keys(pr.overrides).length, 0);
      toast(`Imported "${machine}" from Cura: ${count} settings in ${presets.filter((pr) => !pr.partial).length} presets${skipped.length ? ` (${skipped.length} not supported)` : ''}`, 'ok', 7000);
      if (skipped.length) console.info('Cura settings not imported:', skipped);
    } catch (err) { toast(err.message || String(err), 'warn', 6000); }
  }

  // ------------------------------------------------------------------ body
  _renderBody() {
    this._renderChrome();
    // detach everything first
    for (const c of [...this.body.children]) c.remove();
    for (const r of this.results) this._dropRow(r);
    this.results = [];
    if (this.query) { this.rail.hidden = true; this._renderResults(); return; }
    const wrap = h('div', { class: 'sl-secs' });
    this.activeSecs = [];
    for (const [id, label] of SCOPES[this.scope].pages) {
      if (!this.index[this.scope][id].length) continue;
      const sec = this._section(this.scope, id, label);
      this.activeSecs.push(sec);
      wrap.append(sec.el);
    }
    this.active = null;
    if (this.scope === 'printer') this.body.append(this._connectionCard());
    this.body.append(wrap);
    this.refresh();
    this._buildRail();
  }

  /** The icon strip down the left: one button per visible section, to jump straight to it. */
  _buildRail() {
    clear(this.rail);
    this.rail.hidden = !!this.query;
    this.railBtns = new Map();
    if (this.query) return;
    for (const sec of this.activeSecs) {
      const label = SCOPES[sec.scope].pages.find(([p]) => p === sec.id)[1];
      const b = h('button', { class: 'sl-rail-btn', type: 'button', title: label, 'aria-label': label, onClick: () => this._goSection(sec) }, svgIcon(PAGE_ICONS[sec.id] || PAGE_ICONS.others));
      this.railBtns.set(sec, b);
      this.rail.append(b);
    }
    this._spyUpdate();
  }

  _goSection(sec) {
    this.open.add(sec.key);
    this._syncSection(sec);
    sec.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    sec.head.classList.add('sl-flash');
    setTimeout(() => sec.head.classList.remove('sl-flash'), 1200);
  }

  _spyUpdate() {
    if (!this.railBtns || this.query) return;
    const top = this.body.getBoundingClientRect().top;
    let cur = null;
    for (const sec of this.activeSecs) {
      if (sec.el.hidden) continue;
      if (sec.el.getBoundingClientRect().top - top <= 40) cur = sec;
    }
    if (!cur) cur = this.activeSecs.find((x) => !x.el.hidden) || null;
    for (const [sec, b] of this.railBtns) { b.classList.toggle('active', sec === cur); b.hidden = sec.el.hidden; }
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
    const reset = button({ icon: 'undo', title: 'Back to the preset value', cls: 'btn-ghost sl-ico sl-reset', size: 14, onClick: () => this.profiles.resetKey(d.key) });
    const formula = isFormula(d);
    const fx = formula ? h('button', { class: 'sl-ico sl-fx', type: 'button', onClick: () => { if (store.isOverridden(d.key)) store.reset(d.key); } }, 'fx') : h('span', { class: 'sl-ico' });
    const chev = node.children.length && !withBadge ? h('button', { class: 'sl-chev', type: 'button', 'aria-label': 'Show related settings', onClick: () => { this.expanded.set(d.key, !this._isOpen(node)); this.refresh(); } }, '▸') : null;
    const desc = h('div', { class: 'sl-desc', hidden: true }, d.description, formula ? h('div', { class: 'sl-formula' }, 'Calculated by default: ', h('code', {}, String(d.value).replace(/\s+/g, ' ').slice(0, 200))) : null, h('code', {}, d.key));
    const toggleDesc = () => { desc.hidden = !desc.hidden; };
    name.addEventListener('click', toggleDesc);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggleDesc(); });

    const ctl = this._makeControl(d);
    const unit = d.unit ? h('span', { class: 'sl-unit' }, d.unit) : null;
    const long = isLong(d);
    const head = h('div', { class: 'sl-head' }, chev, name, long ? [reset, fx] : null);
    const badge = withBadge ? (() => { const sc = SCOPES[node.scope]; const page = sc.pages.find(([p]) => p === node.page)[1]; return h('span', { class: 'sl-badge', style: { '--scope': sc.color }, title: `${sc.label} › ${page}`, onClick: () => { this.setScope(node.scope, node.page); this.focusKey(d.key); } }, `${sc.label} › ${page}`); })() : null;
    el.append(h('div', { class: 'sl-line' + (long ? ' sl-long' : ''), style: { paddingLeft: depth * 14 + 'px' } }, head, h('div', { class: 'sl-ctl' }, long ? null : [reset, fx], h('div', { class: 'sl-inwrap' }, ctl.el, unit))), badge || [], desc);

    const row = { el, node, kids: null, ctl, refresh: () => {} };
    row.refresh = () => {
      const v = store.get(d.key), on = store.isEnabled(d.key);
      ctl.set(v);
      el.classList.toggle('sl-off', !on);
      const m = this.profiles.isModified(d.key);
      reset.style.display = m ? '' : 'none';
      if (formula) {
        const own = store.isOverridden(d.key);
        fx.classList.toggle('on', !own); fx.classList.toggle('ovr', own);
        fx.title = own ? 'You set this yourself. Click to go back to the calculated value.' : 'Calculated from other settings. Type a value to override it.';
      }
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
        const input = h('input', { class: 'input', type: 'number', step: d.type === 'int' ? 1 : 0.1, 'aria-label': d.label });
        if (d.unit) input.style.paddingRight = (12 + d.unit.length * 6.5) + 'px';
        input.addEventListener('change', () => {
          let v = parseFloat(input.value);
          if (!Number.isFinite(v)) { input.value = fmt(store.get(d.key)); return; }
          const l = store.limits(d.key);
          if (l.min !== undefined) v = Math.max(l.min, v);
          if (l.max !== undefined) v = Math.min(l.max, v);
          commit(v);
          input.value = fmt(store.get(d.key));
          input.step = stepFor(d, store.get(d.key));
        });
        // no min/max attributes: the browser would measure the arrow steps from the minimum (0.04 + 0.1 steps
        // never land on 0.2). Out-of-range values are clamped by the change handler above.
        return { el: input, set: (v) => { input.step = stepFor(d, v); if (document.activeElement !== input) input.value = fmt(v); } };
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
    this._spyUpdate();
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
