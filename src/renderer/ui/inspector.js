// Shape inspector: Solid / Hole, colour, shape parameters, numeric position / size / rotation.
import { h, clear, button, icon, toast } from './dom.js';
import { stats as geoStats } from '../core/geometry.js';
import { KINDS, kindName } from '../core/shapes.js';
import { PALETTE } from '../core/doc.js';
import { listFontNames, ensureFont } from '../core/fonts.js';
import { formatLength, parseLength } from '../view/gizmo.js';

export class Inspector {
  constructor(editor, host, app) {
    this.editor = editor;
    this.host = host;
    this.app = app;
    this.open = { params: true, transform: false, edges: false };
    this.numberFields = [];
    editor.on('selection', () => this.render());
    editor.on('transform', () => this.updateNumbers());
    host.addEventListener('pointerdown', (e) => e.stopPropagation());
    host.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  render() {
    const ed = this.editor;
    const nodes = ed.selectedNodes();
    const active = document.activeElement;
    if (active && this.host.contains(active) && (active.tagName === 'TEXTAREA' || active.type === 'range')) return this.updateNumbers();
    clear(this.host);
    this.numberFields = [];
    if (ed.edgeMode) return this._renderEdgePanel();
    if (!nodes.length || ed.placing) return;
    const first = nodes[0];
    const allLocked = nodes.every((n) => n.locked);
    const title = nodes.length === 1 ? (first.name || kindName(first)) : `${nodes.length} shapes`;
    const anyHole = nodes.some((n) => n.hole), allHole = nodes.every((n) => n.hole);
    const multi = nodes.every((n) => n.type === 'group' && n.multicolor);

    this.host.append(h('div', { class: 'insp-head' },
      h('div', { class: 'insp-title', title: 'Double-click to rename', onDblclick: () => this.app.renameNode(first) }, title),
      button({ icon: allLocked ? 'lock' : 'unlock', title: allLocked ? 'Unlock (Ctrl+L)' : 'Lock (Ctrl+L)', cls: allLocked ? 'active' : '', onClick: () => ed.toggleLock() }),
      button({ icon: 'bulb', title: 'Hide (Ctrl+H)', onClick: () => ed.hideSelection() })));

    if (allLocked) {
      this.host.append(h('div', { class: 'insp-section' }, h('div', { class: 'insp-note' }, 'This selection is locked. Unlock it to make changes.')));
      return;
    }

    const solidBtn = h('button', { class: 'kind-btn' + (!allHole ? ' active' : ''), type: 'button', title: 'Solid (S). Click to choose a colour.' },
      h('span', { class: 'swatch' + (multi ? ' swatch-multi' : ''), style: multi ? {} : { background: first.color } }), 'Solid');
    solidBtn.addEventListener('click', () => {
      if (anyHole) ed.setHole(false);
      this._colorPopup(solidBtn);
    });
    const holeBtn = h('button', { class: 'kind-btn' + (allHole ? ' active' : ''), type: 'button', title: 'Hole (H)' }, h('span', { class: 'swatch swatch-hole' }), 'Hole');
    holeBtn.addEventListener('click', () => ed.setHole(true));
    this.host.append(h('div', { class: 'insp-kind' }, solidBtn, holeBtn));

    // shape parameters (single shape, or several shapes of the same kind)
    const sameKind = nodes.every((n) => n.type === 'shape' && n.kind === first.kind);
    if (sameKind && KINDS[first.kind]) {
      const defs = KINDS[first.kind].params;
      const rows = defs.map((def) => this._param(def, first));
      if (first.kind === 'extrusion' && first.params.sketch && nodes.length === 1) {
        rows.push(button({ label: 'Edit sketch', icon: 'pencil', cls: 'btn-outline', onClick: () => this.app.openSketch(first) }));
      }
      if (first.kind === 'extrusion' && first.params.image && nodes.length === 1) {
        rows.push(button({ label: 'Edit scribble', icon: 'pencil', cls: 'btn-outline', onClick: () => this.app.openScribble(first) }));
      }
      if (rows.length) this.host.append(this._section('params', 'Shape', rows));
    }
    if (nodes.every((n) => n.type === 'group')) {
      const rows = [];
      if (first.mode !== 'bundle') {
        const cb = h('input', { type: 'checkbox', checked: multi });
        cb.addEventListener('change', () => ed.setMulticolor(cb.checked));
        rows.push(h('label', { class: 'check' }, cb, 'Multicolor'));
      }
      rows.push(h('div', { class: 'insp-note' }, `${first.children.length} parts · ${first.mode === 'bundle' ? 'Bundle (parts stay separate)' : first.mode === 'intersect' ? 'Intersection' : 'Union'}`));
      rows.push(h('div', { class: 'insp-row-btns' }, button({ label: 'Edit parts', icon: 'pencil', cls: 'btn-outline', title: 'Change the parts inside this group without ungrouping (or double-click the group)', onClick: () => ed.enterGroup(first) }), button({ label: 'Ungroup', icon: 'ungroup', cls: 'btn-outline', onClick: () => ed.ungroup() })));
      this.host.append(this._section('params', 'Group', rows));
    }
    this.host.append(this._edgesSection(nodes));
    this.host.append(this._transformSection());
    this.updateNumbers();
  }

  // Round or bevel the outside edges of any shape or group (applied when the slider is released).
  _edgesSection(nodes) {
    const ed = this.editor, first = nodes[0];
    const value = first.round || 0;
    const range = h('input', { type: 'range', min: 0, max: 5, step: 0.1, value });
    const num = h('input', { class: 'input', type: 'number', min: 0, max: 5, step: 0.1, value });
    const note = h('div', { class: 'insp-note' }, 'Softens every outside edge. Overall size stays the same; holes and gaps get slightly tighter. Complex shapes can take a few seconds.');
    const apply = async (v) => {
      v = Math.min(5, Math.max(0, v));
      if (!isFinite(v)) return;
      range.value = v; num.value = v;
      geoStats.roundSkipped = null;
      await ed._busy(() => ed.patchSelection({ round: v }));
      const why = geoStats.roundSkipped;
      if (v > 0 && why) toast(why === 'detail' ? 'This shape has too much detail to round' : 'This shape is not a closed solid, so its edges cannot be rounded', 'warn', 4000);
    };
    range.addEventListener('input', () => { num.value = range.value; });
    range.addEventListener('change', () => { apply(parseFloat(range.value)); range.blur(); });
    num.addEventListener('change', () => apply(parseFloat(num.value)));
    num.addEventListener('keydown', (e) => e.stopPropagation());
    const style = h('select', { class: 'input' }, h('option', { value: 'round' }, 'Round'), h('option', { value: 'bevel' }, 'Bevel'));
    style.value = first.roundStyle === 'bevel' ? 'bevel' : 'round';
    style.addEventListener('change', () => ed._busy(() => ed.patchSelection({ roundStyle: style.value })));
    const rows = [];
    if (nodes.length === 1) rows.push(...this._pickedEdgeRows(first));
    rows.push(h('div', { class: 'insp-subhead' }, 'All edges'),
      h('div', { class: 'param' }, h('label', {}, 'Radius'), range, num),
      h('div', { class: 'param' }, h('label', {}, 'Style'), style),
      note);
    return this._section('edges', 'Edges', rows);
  }

  // In the shape inspector: a way into the Edges tool, and a summary of styled edges.
  _pickedEdgeRows(node) {
    const ed = this.editor;
    const n = (node.edgeRounds || []).length;
    const rows = [h('div', { class: 'insp-row-btns' },
      button({ label: 'Edit edges', icon: 'edges', cls: 'btn-outline', title: 'Round or chamfer individual edges (E)', onClick: () => ed.enterEdgeMode() }))];
    if (n) {
      rows.push(h('div', { class: 'insp-note' }, `${n} edge${n > 1 ? 's' : ''} rounded or chamfered.`),
        h('div', { class: 'insp-row-btns' }, button({ label: 'Apply Edges', cls: 'btn-outline', title: 'Make the rounded and chamfered edges a permanent part of the shape (Ctrl+Z to undo)', onClick: () => ed.applyEdges(node) }), button({ label: 'Make all sharp', cls: 'btn-outline', onClick: () => ed._busy(() => ed.patchSelection((x) => (x.id === node.id ? { edgeRounds: undefined } : {}))) })));
    }
    return rows;
  }

  // Edge properties: shown in place of the shape inspector while the Edges tool is active.
  _renderEdgePanel() {
    const ed = this.editor;
    const info = ed.edgeInfo();
    const node = info.node;
    const done = button({ icon: 'close', title: 'Done (Esc)', onClick: () => ed.exitEdgeMode() });
    this.host.append(h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, node ? node.name || kindName(node) : 'Edges'), done));
    if (!node) return;
    const applyBtn = () => button({ label: 'Apply Edges', cls: 'btn-outline', title: 'Make the rounded and chamfered edges a permanent part of the shape (Ctrl+Z to undo)', onClick: () => ed.applyEdges(node) });
    const canApply = ed.hasShapedEdges(node) && !node.locked;
    if (this.open.edgetool === undefined) this.open.edgetool = true;
    const rows = [];
    if (!info.picked.length) {
      if (canApply) rows.push(h('div', { class: 'insp-row-btns' }, applyBtn()));
      if (rows.length) this.host.append(this._section('edgetool', 'Edges', rows));
      return;
    }
    // same controls as the Edges section of the shape inspector: radius 0 means a sharp edge
    const shaped = info.styles.filter((x) => x.t !== 'sharp');
    const types = new Set(shaped.map((x) => x.t));
    if (types.size === 1) this.edgeStyle = shaped[0].t;
    const style = this.edgeStyle || 'round';
    const value = shaped.length ? shaped[0].r : 0;
    const range = h('input', { type: 'range', min: 0, max: 10, step: 0.1, value: Math.min(10, value) });
    const num = h('input', { class: 'input', type: 'number', min: 0, max: 50, step: 0.1, value });
    const apply = (v) => {
      v = Math.max(0, v);
      if (!isFinite(v)) return;
      range.value = Math.min(10, v); num.value = v;
      ed.setPickedEdgeStyle(v > 0 ? (this.edgeStyle || 'round') : 'sharp', v);
    };
    range.addEventListener('input', () => { num.value = range.value; });
    range.addEventListener('change', () => { range.blur(); apply(parseFloat(range.value)); });
    num.addEventListener('change', () => apply(parseFloat(num.value)));
    num.addEventListener('keydown', (e) => e.stopPropagation());
    const sel = h('select', { class: 'input' }, h('option', { value: 'round' }, 'Round'), h('option', { value: 'chamfer' }, 'Chamfer'));
    sel.value = style;
    sel.addEventListener('change', () => {
      this.edgeStyle = sel.value;
      const r = parseFloat(num.value);
      if (r > 0) ed.setPickedEdgeStyle(sel.value, r);
    });
    const n = info.picked.length;
    rows.push(
      h('div', { class: 'insp-note' }, `${n} edge${n > 1 ? 's' : ''} selected`),
      h('div', { class: 'param' }, h('label', {}, 'Radius'), range, num),
      h('div', { class: 'param' }, h('label', {}, 'Style'), sel),
      h('div', { class: 'insp-row-btns' },
        button({ label: 'Unselect', cls: 'btn-outline', title: 'Unselect (Esc)', onClick: () => ed.clearEdgePicks() }),
        ...(canApply ? [applyBtn()] : [])));
    if (node.locked) rows.push(h('div', { class: 'insp-note' }, 'Locked'));
    this.host.append(this._section('edgetool', 'Edges', rows));
  }

  _section(key, title, rows) {
    const d = h('details', { class: 'insp-section', open: this.open[key] }, h('summary', {}, title), ...rows);
    d.addEventListener('toggle', () => { this.open[key] = d.open; });
    return d;
  }

  _param(def, node) {
    const ed = this.editor;
    const value = node.params[def.key] ?? def.def;
    if (def.type === 'range') {
      const range = h('input', { type: 'range', min: def.min, max: def.max, step: def.step, value });
      const num = h('input', { class: 'input', type: 'number', min: def.min, max: def.max, step: def.step, value });
      const clampV = (v) => Math.min(def.max, Math.max(def.min, v));
      range.addEventListener('input', () => { num.value = range.value; ed.setParam(def.key, parseFloat(range.value), false); });
      range.addEventListener('change', () => { ed.setParam(def.key, parseFloat(range.value), true); range.blur(); ed.emit('selection'); });
      num.addEventListener('change', () => {
        const v = clampV(parseFloat(num.value));
        if (!isFinite(v)) return;
        num.value = v; range.value = v;
        ed.setParam(def.key, v, true);
        ed.emit('selection');
      });
      num.addEventListener('keydown', (e) => e.stopPropagation());
      return h('div', { class: 'param' }, h('label', {}, def.label), range, num);
    }
    if (def.type === 'text') {
      const ta = h('textarea', { value, spellcheck: false, placeholder: 'Type here…' });
      ta.value = value;
      // the panel is not rebuilt while typing, so edits go to the shapes it was built for
      const ids = [...ed.selection];
      const sameSelection = () => [...ed.selection].join(',') === ids.join(',');
      let timer = null;
      ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => ed.setParam(def.key, ta.value, false, ids), 120); });
      ta.addEventListener('change', () => { clearTimeout(timer); ed.setParam(def.key, ta.value, true, ids); ed.emit('selection'); });
      ta.addEventListener('blur', () => { if (!sameSelection()) setTimeout(() => this.render(), 0); });
      ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') ta.blur(); });
      this.textArea = ta;
      return h('div', { class: 'param param-wide' }, h('label', {}, def.label), ta);
    }
    const options = def.type === 'font' ? listFontNames() : def.options;
    const sel = h('select', { class: 'select' }, options.map((o) => h('option', { value: o, selected: o === value }, o)));
    sel.value = value;
    sel.addEventListener('change', async () => {
      if (def.type === 'font') {
        const ok = await ensureFont(sel.value);
        if (!ok) { this.app.toast('That font could not be loaded', 'warn'); sel.value = value; return; }
      }
      ed.setParam(def.key, sel.value, true);
      sel.blur();
      ed.emit('selection');
    });
    return h('div', { class: 'param param-wide' }, h('label', {}, def.label), sel);
  }

  _numField(cls, get, set) {
    const input = h('input', { class: 'input ' + cls, type: 'text' });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.dataset.cancel = '1'; input.blur(); } });
    input.addEventListener('change', () => {
      if (input.dataset.cancel) { delete input.dataset.cancel; return this.updateNumbers(); }
      set(input.value);
      this.updateNumbers();
    });
    input.addEventListener('focus', () => { delete input.dataset.cancel; input.select(); });
    this.numberFields.push({ input, get });
    return input;
  }

  _transformSection() {
    const ed = this.editor;
    const u = () => ed.units;
    const pos = (axis) => this._numField('ax-' + axis, (b) => formatLength(b.min[axis], u()), (v) => ed.setPosition(axis, parseLength(v, u())));
    const size = (axis) => this._numField('ax-' + axis, (b) => formatLength(b.max[axis] - b.min[axis], u()), (v) => ed.setSize(axis, parseLength(v, u()), this.uniform && this.uniform.checked));
    const rot = (axis) => {
      const input = h('input', { class: 'input ax-' + axis, type: 'text', placeholder: '0°', title: 'Type an angle and press Enter to rotate by it' });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { const v = parseFloat(input.value); input.value = ''; if (isFinite(v)) ed.rotateSelection(axis, v); }
      });
      return input;
    };
    this.uniform = h('input', { type: 'checkbox' });
    const unit = u() === 'in' ? 'in' : u() === 'brick' ? 'bricks' : 'mm';
    return this._section('transform', 'Position & size', [
      h('div', { class: 'xyz' }, h('span', {}, ''), h('span', {}, 'X'), h('span', {}, 'Y'), h('span', {}, 'Z')),
      h('div', { class: 'xyz' }, h('span', {}, 'Pos'), pos('x'), pos('y'), pos('z')),
      h('div', { class: 'xyz' }, h('span', {}, 'Size'), size('x'), size('y'), size('z')),
      h('div', { class: 'xyz' }, h('span', {}, 'Rotate'), rot('x'), rot('y'), rot('z')),
      h('label', { class: 'check' }, this.uniform, 'Scale all axes together'),
      h('div', { class: 'insp-note' }, `Values in ${unit}, measured on the workplane.`),
    ]);
  }

  updateNumbers() {
    if (!this.numberFields.length) return;
    const nodes = this.editor.selectedNodes();
    if (!nodes.length) return;
    const b = this.editor.bounds(nodes);
    if (b.isEmpty()) return;
    for (const f of this.numberFields) if (document.activeElement !== f.input) f.input.value = f.get(b);
  }

  focusText() {
    if (this.textArea && this.host.contains(this.textArea)) { this.textArea.focus(); this.textArea.select(); }
  }

  _colorPopup(anchor) {
    document.querySelectorAll('.color-pop').forEach((p) => p.remove());
    const ed = this.editor;
    const nodes = ed.selectedNodes();
    if (!nodes.length) return;
    const pop = h('div', { class: 'color-pop' });
    const grid = h('div', { class: 'color-grid' });
    for (const c of PALETTE) {
      const cell = h('button', { class: 'color-cell', type: 'button', style: { background: c }, title: c });
      cell.addEventListener('click', () => { ed.setColor(c); close(); });
      grid.append(cell);
    }
    const custom = h('input', { type: 'color', value: nodes[0].color });
    custom.addEventListener('input', () => ed.setColor(custom.value, false));
    custom.addEventListener('change', () => ed.setColor(custom.value, true));
    const transparent = h('input', { type: 'checkbox', checked: nodes.every((n) => n.transparent) });
    transparent.addEventListener('change', () => ed.patchSelection({ transparent: transparent.checked }));
    pop.append(grid, h('div', { class: 'color-custom' }, custom, h('span', {}, 'Custom colour')), h('label', { class: 'check' }, transparent, 'Transparent (T)'));
    if (nodes.every((n) => n.type === 'group')) {
      const mc = h('input', { type: 'checkbox', checked: nodes.every((n) => n.multicolor) });
      mc.addEventListener('change', () => ed.setMulticolor(mc.checked));
      pop.append(h('label', { class: 'check' }, mc, 'Multicolor'));
    }
    document.body.append(pop);
    const r = this.host.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left - 240) + 'px';
    pop.style.top = Math.max(8, r.top + 40) + 'px';
    const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }
}
