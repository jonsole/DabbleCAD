// Dockable panels, the same in every workspace. A panel floats over the view (drag it by its header,
// resize it from its corner), or is docked in a column at the left or right edge of the view: drag
// it to an edge and drop it on the highlighted strip. Docked panels stack top to bottom; drag one
// by its header to float it again. Where each panel is, its floating position and size, and whether
// it is collapsed are remembered in this browser; the columns can be resized and hide when empty.

import { h } from './dom.js';
import { addResizer } from './resizer.js';

const EDGE = 56;   // px from the view's edge that counts as "dock here"

export class DockManager {
  /** view: the element panels float over (its parent row gets a column on each side). */
  constructor(view, { key = 'dock', width = 290 } = {}) {
    this.view = view;
    this.key = key;
    this.panels = new Map();
    this.cols = {
      left: h('div', { class: 'dock dock-left', 'aria-label': 'Docked panels (left)', style: { width: `${width}px` } }),
      right: h('div', { class: 'dock dock-right', 'aria-label': 'Docked panels (right)', style: { width: `${width}px` } }),
    };
    view.before(this.cols.left);
    view.after(this.cols.right);
    addResizer(this.cols.left, { side: 'left', key: `${key}-left`, min: 200, max: 640 });
    addResizer(this.cols.right, { side: 'right', key: `${key}-right`, min: 200, max: 760 });
    this.splitters = { left: this.cols.left.nextElementSibling, right: this.cols.right.previousElementSibling };
    this.hint = h('div', { class: 'dock-hint' });
    view.append(this.hint);
    if (window.ResizeObserver) new ResizeObserver(() => { for (const p of this.panels.values()) if (p.el._dock === this && p.state.dock === 'float') this._applyFloat(p); }).observe(view);
    // columns show only while something in them is open
    this._mo = new MutationObserver(() => this._refresh());
    for (const c of Object.values(this.cols)) this._mo.observe(c, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    this._refresh();
  }

  _load(key) { try { return JSON.parse(localStorage.getItem(`dabblecad.dock.${key}`) || 'null'); } catch { return null; } }
  _save(p) { try { localStorage.setItem(`dabblecad.dock.${p.key}`, JSON.stringify(p.state)); } catch { /* ignore */ } }

  _open(p) { return p.isOpen ? p.isOpen() : !p.el.hidden; }

  _refresh() {
    for (const side of ['left', 'right']) {
      const col = this.cols[side];
      const any = [...col.children].some((c) => { const p = c._dockPanel; return p && this._open(p); });
      col.classList.toggle('empty', !any);
      if (this.splitters[side]) this.splitters[side].style.display = any ? '' : 'none';
    }
  }

  /**
   * Make el dockable. handle: selector of its header (drag here). dock: where it starts
   * ('float' | 'left' | 'right') until the user moves it. isOpen(): whether it is showing (a closed
   * docked panel takes no room). grow: fill spare height when docked. collapsed: start collapsed.
   * oldKey: a makeDraggable key to take the floating position from.
   */
  add(el, { key, handle, dock = 'float', order = this.panels.size * 2, isOpen = null, grow = false, collapsed = false, oldKey = null }) {
    let state = this._load(key);
    if (!state) {
      state = { dock, order, collapsed };
      if (oldKey) { try { const old = JSON.parse(localStorage.getItem('dabblecad.card.' + oldKey) || 'null'); if (old) Object.assign(state, old); } catch { /* ignore */ } }
    }
    const p = { el, key, handle, state, isOpen, grow };
    this.panels.set(key, p);
    el._dockPanel = p;
    el.classList.add('dockable');
    el.classList.toggle('dock-grow', !!grow);
    el.classList.toggle('collapsed', !!state.collapsed);
    if (!el._dockWired) {
      // one listener, whichever workspace's dock the panel is in now (the AI chat moves between them)
      el._dockWired = true;
      el.addEventListener('pointerdown', (e) => { if (el._dock) el._dock._down(el._dockPanel, e); });
    }
    el._dock = this;
    if (state.w && state.dock === 'float') { el.style.width = `${state.w}px`; if (state.h) el.style.height = `${state.h}px`; }
    this._place(p);
    if (window.ResizeObserver && !el._dockRO) {
      // remember a floating panel's size after the user resizes it from its corner
      let t = 0;
      el._dockRO = new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
          const q = el._dockPanel;
          if (!q || q.state.dock !== 'float' || el.classList.contains('dragging') || !el.offsetWidth || !el.style.width) return;
          q.state.w = el.offsetWidth; if (el.style.height) q.state.h = el.offsetHeight;
          el._dock._save(q);
        }, 300);
      });
      el._dockRO.observe(el);
    }
    return p;
  }

  /** Fold a panel down to its header, or open it again (remembered). */
  toggleCollapse(key, on) {
    const p = this.panels.get(key);
    if (!p) return;
    p.state.collapsed = on === undefined ? !p.state.collapsed : on;
    p.el.classList.toggle('collapsed', p.state.collapsed);
    this._save(p);
  }

  /** Move a panel to where its state says. */
  _place(p) {
    const { el, state } = p;
    if (state.dock === 'left' || state.dock === 'right') {
      el.classList.add('docked');
      el.style.left = el.style.top = el.style.right = el.style.maxHeight = '';
      const col = this.cols[state.dock];
      const after = [...col.children].find((c) => c !== el && c._dockPanel && c._dockPanel.state.order > state.order);
      col.insertBefore(el, after || null);
    } else {
      el.classList.remove('docked');
      if (el.parentElement !== this.view) this.view.insertBefore(el, this.hint);
      this._applyFloat(p);
    }
    this._refresh();
  }

  _applyFloat(p) {
    const { el, state } = p;
    if (state.left == null) { el.style.left = el.style.top = el.style.right = el.style.maxHeight = ''; return; }
    const pw = this.view.clientWidth, ph = this.view.clientHeight, w = el.offsetWidth || 262;
    state.left = Math.min(Math.max(0, state.left), Math.max(0, pw - w));
    state.top = Math.min(Math.max(0, state.top), Math.max(0, ph - 48));
    el.style.left = state.left + 'px'; el.style.top = state.top + 'px'; el.style.right = 'auto';
    el.style.maxHeight = `calc(100% - ${state.top + 8}px)`;
  }

  /** Which edge (if any) the pointer is over: an edge strip of the view, or a docked column. */
  _zone(e) {
    const r = this.view.getBoundingClientRect();
    const inY = e.clientY > r.top && e.clientY < r.bottom;
    let side = null;
    if (inY && e.clientX < r.left + EDGE) side = 'left';
    else if (inY && e.clientX > r.right - EDGE) side = 'right';
    for (const s of ['left', 'right']) {
      const c = this.cols[s].getBoundingClientRect();
      if (c.width && e.clientX >= c.left && e.clientX <= c.right && e.clientY >= c.top && e.clientY <= c.bottom) side = s;
    }
    return side;
  }

  _showHint(side) { this.hint.className = side ? `dock-hint on ${side}` : 'dock-hint'; }

  _down(p, e) {
    const head = e.target.closest && e.target.closest(p.handle);
    if (e.button !== 0 || !head || !p.el.contains(head) || e.target.closest('button, input, select, textarea, a, label')) return;
    e.preventDefault();
    const el = p.el;
    const er = el.getBoundingClientRect();
    const dx = e.clientX - er.left, dy = e.clientY - er.top;
    const x0 = e.clientX, y0 = e.clientY;
    let started = false;
    const pid = e.pointerId;
    // follow the pointer on the window: moving the panel between columns and the view drops any
    // pointer capture, and the release must still be seen
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        started = true;
        el.classList.add('dragging');
        if (p.state.dock !== 'float') {
          // out of the column, under the pointer, at a floating size
          p.state = { ...p.state, dock: 'float' };
          const w = p.state.w || Math.min(Math.max(er.width, 260), 380);
          el.style.width = `${w}px`;
          if (p.grow) el.style.height = `${p.state.h || Math.min(560, Math.max(320, er.height))}px`;
          this._place(p);
        }
      }
      const vr = this.view.getBoundingClientRect();
      p.state.left = ev.clientX - vr.left - Math.min(dx, el.offsetWidth - 24);
      p.state.top = ev.clientY - vr.top - dy;
      this._applyFloat(p);
      this._showHint(this._zone(ev));
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
      el.classList.remove('dragging');
      this._showHint(null);
      if (!started) return;
      const side = ev.type === 'pointerup' ? this._zone(ev) : null;
      if (side) {
        if (el.style.width) p.state.w = el.offsetWidth;
        if (el.style.height) p.state.h = el.offsetHeight;
        p.state.dock = side;
        // its place in the column: above the first docked panel whose middle is below the pointer
        const others = [...this.cols[side].children].map((c) => c._dockPanel).filter((q) => q && q !== p);
        others.forEach((q, i) => { q.state.order = i * 2; this._save(q); });
        const below = others.find((q) => { const r = q.el.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        p.state.order = below ? below.state.order - 1 : others.length * 2;
        el.style.width = el.style.height = '';
        this._place(p);
      }
      this._save(p);
    };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
  }

  /** Put a panel in a column or back floating (for menus and tests). */
  set(key, dock) {
    const p = this.panels.get(key);
    if (!p) return;
    p.state.dock = dock;
    if (dock !== 'float') { p.state.order = this.cols[dock].children.length * 2 + 1; p.el.style.width = p.el.style.height = ''; }
    this._place(p);
    this._save(p);
  }
}
