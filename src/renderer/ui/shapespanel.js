// Right-hand shape library: categories, search, drag-or-click placement, saved creations.
import { h, clear, icon, button, toast } from './dom.js';
import { CATALOG, CATEGORIES, nodeFromCatalog } from '../core/shapes.js';
import { serializeDoc, deserializeDoc, makeGroup, cloneNode, uid } from '../core/doc.js';
import { thumbnail, dropThumbnail } from '../view/thumbs.js';

const STORE_KEY = 'dabble.creations';

function loadCreations() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return raw.map((c) => ({ id: c.id, name: c.name, cat: 'mine', color: '#888', node: deserializeDoc(c.doc).nodes[0] }));
  } catch { return []; }
}

function saveCreations(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.map((c) => ({ id: c.id, name: c.name, doc: serializeDoc({ name: c.name, nodes: [c.node], workplane: {}, notes: [] }) }))));
  } catch { toast('Could not save: storage is full', 'error'); }
}

export class ShapesPanel {
  constructor(editor, host, app) {
    this.editor = editor;
    this.app = app;
    this.category = 'basic';
    this.query = '';
    this.creations = loadCreations();

    this.tools = {};
    const tool = (id, label, ic, title) => {
      const b = h('button', { class: 'side-tool', type: 'button', title }, icon(ic, 22), label);
      b.addEventListener('click', () => { editor.setTool(id); b.blur(); });
      this.tools[id] = b;
      return b;
    };
    this.select = h('select', { class: 'select', title: 'Shape category' }, CATEGORIES.map((c) => h('option', { value: c.id }, c.name)));
    this.select.addEventListener('change', () => { this.category = this.select.value; this.select.blur(); this.render(); });
    this.search = h('input', { class: 'input', type: 'search', placeholder: 'Search shapes' });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.render(); });
    this.search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { this.search.value = ''; this.query = ''; this.search.blur(); this.render(); } });
    this.grid = h('div', { class: 'shape-grid' });
    host.append(
      h('div', { class: 'side-tools' },
        tool('workplane', 'Workplane', 'workplane', 'Workplane (W): click a face to build on it, click empty space to reset'),
        tool('ruler', 'Ruler', 'ruler', 'Ruler (R): click the workplane to place a ruler'),
        tool('note', 'Notes', 'note', 'Notes (N): click to pin a note')),
      h('div', { class: 'side-filter' }, this.select),
      h('div', { class: 'side-search' }, icon('search', 15), this.search),
      this.grid,
      h('div', { class: 'side-foot' },
        button({ label: 'Import', icon: 'import', cls: 'btn-outline', title: 'Import STL, OBJ, GLB, 3MF, SVG or an image', onClick: () => app.importDialog() }),
        button({ label: 'Save shape', icon: 'star', cls: 'btn-outline', title: 'Save the selection to Your Creations', onClick: () => this.saveCreation() })));
    editor.on('tool', () => { for (const [id, b] of Object.entries(this.tools)) b.classList.toggle('active', editor.tool === id); });
    this.render();
  }

  entries() {
    const all = [...CATALOG, ...this.creations];
    let list = this.category === 'all' ? all : all.filter((e) => e.cat === this.category);
    if (this.query) list = all.filter((e) => e.name.toLowerCase().includes(this.query) || e.kind === this.query);
    return list;
  }

  render() {
    clear(this.grid);
    const list = this.entries();
    if (!list.length) {
      this.grid.append(h('div', { class: 'side-empty' }, this.category === 'mine' && !this.query
        ? 'Select something in your design and press “Save shape” to keep it here for reuse.' : 'No shapes match.'));
      return;
    }
    for (const entry of list) this.grid.append(this._tile(entry));
  }

  _tile(entry) {
    const img = h('img', { alt: '', draggable: false });
    img.style.visibility = 'hidden';
    thumbnail(entry.id, () => {
      const n = nodeFromCatalog(entry);
      return n;
    }).then((url) => { if (url) { img.src = url; img.style.visibility = ''; } });
    const tile = h('div', { class: 'shape-tile', role: 'button', tabindex: '0', 'aria-label': entry.name, title: entry.special === 'scribble' ? 'Scribble: draw your own shape' : entry.special === 'sketch' ? 'Sketch: draw an exact outline with typed sizes, then pull it into 3D' : `${entry.name}: drag onto the workplane, or click then click to place` }, img, h('span', {}, entry.name));
    if (entry.cat === 'mine') {
      const del = h('button', { class: 'shape-del', type: 'button', title: 'Remove from Your Creations' }, '×');
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.creations = this.creations.filter((c) => c.id !== entry.id);
        saveCreations(this.creations);
        dropThumbnail(entry.id);
        this.render();
      });
      tile.append(del);
    }
    // keyboard: Enter or Space drops the shape in the middle of the view
    tile.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); e.stopPropagation();
      if (entry.special === 'sketch') this.app.openSketch(null);
      else if (entry.special === 'scribble') this.app.openScribble(null);
      else this.editor.addAtViewCenter(nodeFromCatalog(entry));
    });
    tile.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (entry.special === 'scribble' || entry.special === 'sketch') {
        const upOnce = () => { window.removeEventListener('pointerup', upOnce); if (entry.special === 'sketch') this.app.openSketch(null); else this.app.openScribble(null); };
        window.addEventListener('pointerup', upOnce);
        return;
      }
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        stop();
        this.editor.beginPlace(nodeFromCatalog(entry), { drag: true });
      };
      const up = () => {
        stop();
        this.editor.beginPlace(nodeFromCatalog(entry), { drag: false });
      };
      const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return tile;
  }

  async saveCreation() {
    const nodes = this.editor.selectedNodes();
    if (!nodes.length) { toast('Select a shape first, then save it to Your Creations'); return; }
    const name = await this.app.prompt('Save to Your Creations', 'Name', nodes.length === 1 && nodes[0].name ? nodes[0].name : 'My shape');
    if (!name) return;
    const node = nodes.length === 1 ? cloneNode(nodes[0], true) : makeGroup(nodes.map((n) => cloneNode(n, true)), 'bundle');
    node.locked = false; node.hidden = false; node.name = name;
    this.creations.push({ id: uid('c'), name, cat: 'mine', color: '#888', node });
    saveCreations(this.creations);
    this.category = 'mine';
    this.select.value = 'mine';
    this.render();
    toast('Saved to Your Creations');
  }
}
