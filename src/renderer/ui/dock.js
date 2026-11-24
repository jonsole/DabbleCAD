// Dockable panels. A panel floats over the view (drag it by its header), or is docked in a column
// at the left or right edge of the view: drag it to an edge and drop it on the highlighted strip.
// Docked panels stack top to bottom; drag one by its header to take it out again. Where each panel
// is (and its floating position) is remembered in this browser; the columns can be resized.

import { h } from './dom.js';
import { addResizer } from './resizer.js';

const EDGE = 56;   // px from the view's edge that counts as "dock here"

export class DockManager {
  /** view: the element panels float over; main: the row holding it (columns go either side). */
  constructor(view, { key = 'dock' } = {}) {
    this.view = view;
    this.key = key;
    this.panels = new Map();
    this.cols = {
      left: h('div', { class: 'dock dock-left', 'aria-label': 'Docked panels (left)' }),
      right: h('div', { class: 'dock dock-right', 'aria-label': 'Docked panels (right)' }),
    };
    view.before(this.cols.left);
    view.after(this.cols.right);
    addResizer(this.cols.left, { side: 'left', key: `${key}-left`, min: 220, max: 560 });
    addResizer(this.cols.right, { side: 'right', key: `${key}-right`, min: 220, max: 560 });
    this.hint = h('div', { class: 'dock-hint' });
    view.append(this.hint);
    if (window.ResizeObserver) new ResizeObserver(() => { for (const p of this.panels.values()) if (p.state.dock === 'float') this._applyFloat(p); }).observe(view);
  }

  _load(key) { try { return JSON.parse(localStorage.getItem(`dabblecad.dock.${key}`) || 'null'); } catch { return null; } }
  _save(p) { try { localStorage.setItem(`dabblecad.dock.${p.key}`, JSON.stringify(p.state)); } catch { /* ignore */ } }

  /**
   * Make el dockable. handle: selector of its header (drag here). dock: where it starts
   * ('float' | 'left' | 'right') until the user moves it. oldKey: a makeDraggable key to take
   * the floating position from.
   */
  add(el, { key, handle, dock = 'float', oldKey = null }) {
    let state = this._load(key);
    if (!state) {
      state = { dock, order: this.panels.size };
      if (oldKey) { try { const old = JSON.parse(localStorage.getItem('dabblecad.card.' + oldKey) || 'null'); if (old) Object.assign(state, old); } catch { /* ignore */ } }
    }
    const p = { el, key, handle, state };
    this.panels.set(key, p);
    el.classList.add('dockable');
    this._place(p);
    el.addEventListener('pointerdown', (e) => this._down(p, e));
    return p;
  }

  /** Move a panel to where its state says. */
  _place(p) {
    const { el, state } = p;
    if (state.dock === 'left' || state.dock === 'right') {
      el.classList.add('docked');
      el.style.left = el.style.top = el.style.right = el.style.maxHeight = '';
      const col = this.cols[state.dock];
      const after = [...col.children].find((c) => { const q = [...this.panels.values()].find((x) => x.el === c); return q && q.state.order > state.order; });
      col.insertBefore(el, after || null);
    } else {
      el.classList.remove('docked');
      if (el.parentElement !== this.view) this.view.insertBefore(el, this.hint);
      this._applyFloat(p);
    }
  }

  _applyFloat(p) {
    const { el, state } = p;
    if (state.left == null) { el.style.left = el.style.top = ''; el.style.right = ''; el.style.maxHeight = ''; return; }
    const pw = this.view.clientWidth, ph = this.view.clientHeight, w = el.offsetWidth || 262;
    state.left = Math.min(Math.max(0, state.left), Math.max(0, pw - w));
    state.top = Math.min(Math.max(0, state.top), Math.max(0, ph - 48));
    el.style.left = state.left + 'px'; el.style.top = state.top + 'px'; el.style.right = 'auto';
    el.style.maxHeight = `calc(100% - ${state.top + 14}px)`;
  }

  /** Which edge (if any) the pointer is over, and where in that column a panel would go. */
  _zone(e) {
    const r = this.view.getBoundingClientRect();
    const inY = e.clientY > r.top && e.clientY < r.bottom;
    let side = null;
    if (inY && e.clientX < r.left + EDGE) side = 'left';
    else if (inY && e.clientX > r.right - EDGE) side = 'right';
    // already-docked columns are drop targets too
    for (const s of ['left', 'right']) {
      const c = this.cols[s].getBoundingClientRect();
      if (c.width && e.clientX >= c.left && e.clientX <= c.right && e.clientY >= c.top && e.clientY <= c.bottom) side = s;
    }
    return side;
  }

  _showHint(side) {
    this.hint.className = side ? `dock-hint on ${side}` : 'dock-hint';
  }

  _down(p, e) {
    const head = e.target.closest && e.target.closest(p.handle);
    if (e.button !== 0 || !head || !p.el.contains(head) || e.target.closest('button, input, select, textarea, a')) return;
    e.preventDefault();
    const el = p.el;
    const er = el.getBoundingClientRect();
    const dx = e.clientX - er.left, dy = e.clientY - er.top;
    const x0 = e.clientX, y0 = e.clientY;
    let started = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        started = true;
        el.classList.add('dragging');
        if (p.state.dock !== 'float') {
          // take it out of the column, under the pointer
          const w = Math.min(er.width, 320);
          p.state = { ...p.state, dock: 'float' };
          this._place(p);
          el.style.width = el.style.width || `${w}px`;
        }
      }
      const vr = this.view.getBoundingClientRect();
      p.state.left = ev.clientX - vr.left - Math.min(dx, el.offsetWidth - 20);
      p.state.top = ev.clientY - vr.top - dy;
      this._applyFloat(p);
      this._showHint(this._zone(ev));
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      this._showHint(null);
      if (!started) return;
      const side = ev.type === 'pointerup' ? this._zone(ev) : null;
      if (side) {
        p.state.dock = side;
        // its place in the column: above the first docked panel whose middle is below the pointer
        const others = [...this.cols[side].children].map((c) => [...this.panels.values()].find((x) => x.el === c)).filter(Boolean);
        const below = others.find((q) => { const r = q.el.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        others.forEach((q, i) => { q.state.order = i * 2; this._save(q); });
        p.state.order = below ? below.state.order - 1 : others.length * 2;
        el.style.width = '';
        this._place(p);
      }
      this._save(p);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }

  /** Put a panel in a column or back floating (for a menu or a test). */
  set(key, dock) {
    const p = this.panels.get(key);
    if (!p) return;
    p.state.dock = dock;
    if (dock !== 'float') p.state.order = this.cols[dock].children.length * 2 + 1;
    this._place(p);
    this._save(p);
  }
}
