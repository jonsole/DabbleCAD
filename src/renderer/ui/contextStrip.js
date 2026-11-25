// Ported from ElectroCAD (src/renderer/ui/contextStrip.js) so both apps share one context strip.
// The context strip: a small floating toolbar at the top of the canvas with the options for the
// tool in use (corner style while routing, corner radius for rectangles…) or the actions for what
// is selected (rotate, flip, delete…), so the main toolbar keeps only what always applies. Each
// editor says what to show from its refresh(); the strip rebuilds only when that changes, so a
// field being typed in keeps its focus.
import { h, button, icon, popupMenu } from './dom.js';

export class ContextStrip {
  /** `place`: the name its position is remembered under (one per editor; the routing strip shares it). */
  constructor(label = 'Options', place = null) {
    this.el = h('div', { class: 'tool-strip context-strip', role: 'toolbar', 'aria-label': label, hidden: true });
    this.body = h('div', { class: 'strip-body' });
    this.place = place;
    this.el.append(...(place ? [stripGrip(this.el, place)] : []), this.body);
    this.key = null;
    this.el.addEventListener('strip-moved', () => this._fit());
    // clicks on the strip aren't clicks on the canvas
    for (const ev of ['pointerdown', 'mousedown', 'dblclick', 'wheel']) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev === 'wheel' });
  }

  mount(host) { host.append(this.el); this._watch(host); return this; }

  // DabbleCAD: the inspector card floats at the top right of the same view. When the strip reaches
  // into that corner the host is marked, and the inspector's default place moves down below the strip.
  _watch(host) {
    if (!host || this._host) return;
    this._host = host;
    if (window.ResizeObserver) new ResizeObserver(() => this._fit()).observe(host);
  }

  _fit() {
    const host = this._host;
    if (!host) return;
    // a narrow view: buttons show only their icons, as on a narrow toolbar
    this.el.classList.toggle('strip-compact', host.clientWidth < 760);
    const crowded = !this.el.hidden && this.el.offsetTop < 60 && this.el.offsetLeft + this.el.offsetWidth > host.clientWidth - 290;
    host.classList.toggle('strip-crowded', crowded);
  }

  _shown(on) { this.el.hidden = !on; this._fit(); }

  /**
   * Show the strip for `key` (any string naming the context and the values it shows), built by
   * `build()` -> [elements]. Null or an empty build hides it.
   */
  show(key, build) {
    if (!key) { this.hide(); return; }
    if (key === this.key && !this.el.hidden) return;
    const kids = (build() || []).filter(Boolean);
    this.key = key;
    if (!kids.length) { this._shown(false); return; }
    this.body.replaceChildren(...kids);
    this._shown(true);
    if (this.place) placeStrip(this.el, this.place);
  }

  hide() { this.key = null; this._shown(false); }
}

// ---------------------------------------------------------------- moving a strip

const POS = (place) => `dabblecad.strip.${place}`;
const readPos = (place) => { try { return JSON.parse(localStorage.getItem(POS(place)) || 'null'); } catch { return null; } };

/** Put a strip where it was last moved to (kept inside its canvas), or its home at the top left. */
export function placeStrip(el, place) {
  const pos = readPos(place);
  if (!pos) { el.style.left = el.style.top = ''; return; }
  const host = el.offsetParent || el.parentElement;
  const W = host?.clientWidth || 0, H = host?.clientHeight || 0;
  const w = el.offsetWidth || 200, hh = el.offsetHeight || 40;
  el.style.left = `${Math.max(0, Math.min(pos.left, Math.max(0, W - w)))}px`;
  el.style.top = `${Math.max(0, Math.min(pos.top, Math.max(0, H - hh)))}px`;
}

/**
 * The grip at a strip's left end (three bars): drag it to move the strip over the canvas, where it
 * stays (per editor); double-click it to send the strip home.
 */
export function stripGrip(el, place) {
  const grip = h('span', { class: 'strip-grip', role: 'separator', 'aria-label': 'Move the toolbar (double-click: back to the top left)', title: 'Drag to move this toolbar · double-click to put it back' },
    h('i'), h('i'), h('i'));
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const host = el.offsetParent || el.parentElement;
    const hr = host.getBoundingClientRect(), r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    el.classList.add('moving');
    const move = (ev) => {
      const left = Math.max(0, Math.min(ev.clientX - hr.left - dx, host.clientWidth - el.offsetWidth));
      const top = Math.max(0, Math.min(ev.clientY - hr.top - dy, host.clientHeight - el.offsetHeight));
      el.style.left = `${left}px`; el.style.top = `${top}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      el.classList.remove('moving');
      try { localStorage.setItem(POS(place), JSON.stringify({ left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 })); } catch { /* private mode */ }
      el.dispatchEvent(new CustomEvent('strip-moved', { bubbles: true }));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    try { localStorage.removeItem(POS(place)); } catch { /* private mode */ }
    placeStrip(el, place);
    el.dispatchEvent(new CustomEvent('strip-moved', { bubbles: true }));
  });
  return grip;
}

// ---------------------------------------------------------------- the pieces

const stop = (el) => { el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && el.tagName === 'INPUT') el.blur(); if (e.key === 'Escape') el.blur(); }); return el; };

/** The strip's title: what the options are for. */
export const stripLabel = (text, ic = null) => h('span', { class: 'tool-strip-label' }, ic ? icon(ic, 15) : null, text);
export const stripSep = () => h('span', { class: 'sep' });

/** An icon (and optional label) button. */
export function stripButton({ icon: ic, label, title, onClick, active = false, danger = false, disabled = false }) {
  const b = button({ icon: ic, label, title, cls: 'btn-ghost strip-btn' + (danger ? ' strip-danger' : ''), onClick });
  if (active) b.classList.add('active');
  b.disabled = disabled;
  return b;
}

/** A number field with its unit; onSet(value) on change or Enter. */
export function stripNumber({ label, value, unit = '', step = '0.05', min = '0', max = null, onSet, width = 64, title = '', placeholder = '', disabled = false }) {
  const i = stop(h('input', { class: 'input', type: 'number', step, min, ...(max != null ? { max } : {}), value: value == null ? '' : String(value), placeholder, 'aria-label': label, style: { width: width + 'px' }, disabled }));
  i.addEventListener('change', () => { const v = parseFloat(i.value); if (Number.isFinite(v)) onSet(v); });
  return h('label', { class: 'strip-field', title: title || label }, h('span', {}, label), i, unit ? h('em', {}, unit) : null);
}

/** A select; options [[value, text]]; onSet(value). */
export function stripSelect({ label, value, options, onSet, title = '', showLabel = true, disabled = false }) {
  const s = stop(h('select', { class: 'select', 'aria-label': label, disabled }, ...options.map(([v, t]) => h('option', { value: String(v) }, t))));
  s.value = String(value);
  s.addEventListener('change', () => onSet(s.value));
  return h('label', { class: 'strip-field', title: title || label }, showLabel ? h('span', {}, label) : null, s);
}

/** A segmented choice: items [[id, text, title]]. */
export function stripSegmented({ label, items, value, onPick }) {
  return h('div', { class: 'segmented strip-seg', role: 'radiogroup', 'aria-label': label },
    ...items.map(([id, text, title]) => h('button', { class: 'btn' + (id === value ? ' active' : ''), type: 'button', role: 'radio', 'aria-checked': String(id === value), title: title || text, dataset: { value: id }, onClick: () => onPick(id) }, text)));
}

/**
 * The Properties button every selection strip ends with: opens (or closes) the selection's
 * Properties card. Always here, because double-click may do something else in places.
 */
export function stripProps({ open, onToggle }) {
  const b = stripButton({ icon: 'sliders', label: 'Properties', active: open, title: `${open ? 'Close' : 'Open'} the Properties of the selection (also right-click → Properties…)`, onClick: onToggle });
  b.classList.add('strip-props');
  b.setAttribute('aria-pressed', String(!!open));
  return b;
}

/** A button that opens a menu of further actions (items as for popupMenu). */
export function stripMenu({ icon: ic, label, title, items, disabled = false }) {
  const b = stripButton({ icon: ic, label, title: title || label, disabled, onClick: () => popupMenu(items(), b) });
  b.setAttribute('aria-haspopup', 'menu');
  return b;
}
