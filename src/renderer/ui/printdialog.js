// Print check dialog: runs the analysis, shows the findings and offers the obvious fixes.
import * as THREE from 'three';
import { h, modal, button, toast, clear, icon } from './dom.js';
import { isDesktop } from '../platform.js';
import { analyzePrint, printNodes, DEFAULT_BED } from '../core/printcheck.js';
import { sliceDialog } from './slicedialog.js';

const MARK = { ok: '✓', warn: '!', error: '✕' };

export function printCheckDialog(app, { selectedOnly = false } = {}) {
  const ed = app.editor;
  const m = modal({ title: 'Print check', width: 600 });
  const bed = { ...DEFAULT_BED, ...(app.settings.bed || {}) };
  const list = h('div', { class: 'pc-list' });
  const summary = h('div', { class: 'insp-note' });

  const bedInput = (axis) => {
    const input = h('input', { class: 'input', type: 'number', min: 20, max: 2000, step: 1, value: bed[axis], 'aria-label': `Printer bed ${axis.toUpperCase()} in millimetres` });
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!(v >= 20)) { input.value = bed[axis]; return; }
      bed[axis] = v;
      app.patchSettings({ bed: { ...bed } });
      run();
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    return input;
  };

  async function run() {
    clear(list);
    list.append(h('div', { class: 'insp-note' }, 'Checking…'));
    const result = await ed._busy(() => analyzePrint(ed, { selectedOnly, bed }));
    clear(list);
    for (const item of result.items) {
      const fix = item.fix === 'drop' ? button({ label: 'Rest on plate', cls: 'btn-outline', onClick: () => {
        const nodes = printNodes(ed, selectedOnly).filter((n) => !n.locked);
        if (!nodes.length) { toast('The shapes are locked', 'warn'); return; }
        ed.select(nodes.map((n) => n.id));
        ed.transformSelection(new THREE.Matrix4().makeTranslation(0, 0, -result.summary.minZ));
        run();
      } }) : null;
      list.append(h('div', { class: 'pc-item pc-' + item.level },
        h('span', { class: 'pc-mark', 'aria-hidden': 'true' }, MARK[item.level]),
        h('div', { class: 'pc-text' }, h('b', {}, item.title), item.detail ? h('small', {}, item.detail) : null),
        fix));
    }
    const s = result.summary;
    summary.textContent = !s ? '' : [
      `${Math.round(s.triangles).toLocaleString()} triangles`,
      s.volumeCm3 !== null ? `${s.volumeCm3.toFixed(1)} cm³ of material if printed solid (about ${s.grams.toFixed(0)} g of PLA; real prints use far less with infill)` : null,
    ].filter(Boolean).join(' · ');
    const errors = result.items.filter((i) => i.level === 'error').length, warns = result.items.filter((i) => i.level === 'warn').length;
    verdict.textContent = errors ? `${errors} problem${errors > 1 ? 's' : ''} to fix before printing` : warns ? `Printable, with ${warns} thing${warns > 1 ? 's' : ''} to keep in mind` : 'Ready to print';
    verdict.className = 'pc-verdict pc-' + (errors ? 'error' : warns ? 'warn' : 'ok');
  }

  const verdict = h('div', { class: 'pc-verdict' });
  m.body.append(
    verdict, list, summary,
    h('div', { class: 'field pc-bed' }, h('span', {}, 'Printer bed (mm)'), h('div', { class: 'pc-bed-inputs' }, bedInput('x'), '×', bedInput('y'), '×', bedInput('z'))),
    h('div', { class: 'insp-note' }, 'This is a quick geometric check, not a slicer. Thin-wall and overhang figures are estimates.'),
    h('div', { class: 'modal-actions' },
      button({ label: 'Check again', cls: 'btn-outline', onClick: () => run() }),
      isDesktop ? button({ label: 'Open in slicer', icon: 'export', cls: 'btn-outline', onClick: () => { m.close(); app.openInSlicer(selectedOnly); } }) : null,
      button({ label: 'Slice to G-code', icon: 'export', cls: 'btn-outline', title: 'Slice in the browser with CuraEngine', onClick: () => { m.close(); sliceDialog(app, { selectedOnly }); } }),
      button({ label: 'Export STL', icon: 'export', cls: 'btn-primary', onClick: () => { m.close(); app.exportAs('stl', selectedOnly); } })));
  void icon;
  run();
  return { rerun: run, close: m.close };
}
