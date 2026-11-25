// Tools + dialogs review: node tools/run.js --smoke=tools/smoke6.js --shots=<folder>
const app = window.dabble, ed = app.editor, vp = app.viewport;
const lib = window.dabbleLib;
const { CATALOG, nodeFromCatalog } = lib.shapes;
const dir = window.__shotDir;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { vp.renderNow(); await wait(250); await window.dabbleNative.smokeShot(dir + '/' + name + '.png'); };
const add = (id, x, y) => { const n = nodeFromCatalog(CATALOG.find((c) => c.id === id)); ed.placeAt(n, x, y); ed.addNode(n); return n; };
const out = {}; const fails = [];
const check = (name, cond, info) => { if (!cond) fails.push(name + (info !== undefined ? ' -> ' + JSON.stringify(info) : '')); };
const V3 = vp.target.constructor;
const rect = () => vp.canvas.getBoundingClientRect();
const scr = (x, y, z) => { const p = vp.project(new V3(x, y, z), {}); const r = rect(); return { clientX: r.left + p.x, clientY: r.top + p.y }; };
const fire = (el, type, pt, extra = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, button: 0, buttons: 1, ...pt, ...extra }));
const key = (k, mods = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));

// workplane tool on the slanted face of a wedge, then place a cylinder on it
const wedge = add('wedge', 0, 0);
ed.select([wedge.id]); ed.setSize('x', 60); ed.setSize('y', 40); ed.setSize('z', 30);
ed.clearSelection(); vp.renderNow();
key('w'); check('tool-workplane', ed.tool === 'workplane', ed.tool);
const b = ed.bounds([wedge]);
const mid = scr((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, 15);
fire(vp.canvas, 'pointerdown', mid); fire(vp.canvas, 'pointerup', mid);
check('frame-set', ed.hasFrame, ed.hasFrame);
const up = new V3(0, 0, 1).transformDirection(ed.frame); out.frameUp = up.toArray().map((v) => +v.toFixed(2));
check('frame-tilted', up.x > 0.3 && up.z > 0.5, out.frameUp);
const cyl = add('cylinder', 0, 0);
ed.select([cyl.id]); ed.setSize('x', 8); ed.setSize('y', 8);
await shot('k-workplane');
key('Escape'); key('Escape');
ed.setFrame(null); app._updateBanner();

// cruise: drag a sphere onto the top of a box
const base = add('box', -70, 40); const ball = add('sphere', -70, -40);
ed.select([ball.id]); ed.setSize('x', 12, true);
ed.clearSelection(); key('c'); check('cruise-on', ed.cruise);
vp.renderNow();
const s0 = scr(-70, -40, 6), s1 = scr(-70, 40, 20);
fire(vp.canvas, 'pointerdown', s0); fire(vp.canvas, 'pointermove', scr(-70, 0, 6)); fire(vp.canvas, 'pointermove', s1); fire(vp.canvas, 'pointerup', s1);
const bbBall = ed.bounds([ball]); out.cruiseZ = +bbBall.min.z.toFixed(2); check('cruise', Math.abs(bbBall.min.z - 20) < 0.5, out.cruiseZ);
key('c');

// click-to-place through the shape panel + keyboard commands
const tile = [...document.querySelectorAll('.shape-tile')].find((t) => t.textContent === 'Pyramid');
fire(tile, 'pointerdown', { clientX: 10, clientY: 10 }); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 }));
check('placing', !!ed.placing && ed.tool === 'place', ed.tool);
const target = scr(60, -60, 0);
window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, ...target }));
vp.canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...target }));
const pyr = ed.selectedNodes()[0]; const pb = pyr ? ed.bounds([pyr]) : null;
check('click-place', pyr && pyr.kind === 'pyramid' && Math.abs((pb.min.x + pb.max.x) / 2 - 60) <= 1 && Math.abs((pb.min.y + pb.max.y) / 2 + 60) <= 1, pb && [pb.min.x, pb.min.y]);
key('ArrowRight'); key('ArrowUp', { shiftKey: true }); key('ArrowUp', { ctrlKey: true });
const pb2 = ed.bounds([pyr]); check('arrow-keys', Math.abs(pb2.min.x - pb.min.x - 1) < 1e-6 && Math.abs(pb2.min.y - pb.min.y - 10) < 1e-6 && Math.abs(pb2.min.z - 1) < 1e-6, [pb2.min.x - pb.min.x, pb2.min.y - pb.min.y, pb2.min.z]);
key('d'); check('key-drop', Math.abs(ed.bounds([pyr]).min.z) < 1e-9);
key('h'); check('key-hole', pyr.hole === true); key('s'); check('key-solid', pyr.hole === false);
key('t'); check('key-transparent', pyr.transparent === true); key('t');
key('l', { ctrlKey: true }); check('key-lock', pyr.locked === true); key('Delete'); check('locked-not-deleted', !!ed.node(pyr.id)); key('l', { ctrlKey: true });
key('c', { ctrlKey: true }); key('v', { ctrlKey: true }); check('copy-paste', ed.doc.nodes.filter((n) => n.kind === 'pyramid').length === 2);
key('z', { ctrlKey: true }); check('key-undo', ed.doc.nodes.filter((n) => n.kind === 'pyramid').length === 1);
key('a', { ctrlKey: true }); check('select-all', ed.selection.size === ed.doc.nodes.length);
key('h', { ctrlKey: true }); check('hide', ed.doc.nodes.every((n) => n.hidden)); key('h', { ctrlKey: true, shiftKey: true }); check('show-all', ed.doc.nodes.every((n) => !n.hidden));

// notes + ruler
ed.addNote(new V3(-70, 40, 20), 'Ball sits on the box');
ed.select([base.id]); key('r'); const rp = scr(-95, 20, 0); fire(vp.canvas, 'pointerdown', rp); fire(vp.canvas, 'pointerup', rp);
check('ruler', !!ed.ruler, ed.ruler);
await shot('l-notes-ruler');

// dialogs
document.querySelector('.btn[title="Settings"]').click(); await wait(500); await shot('m-settings');
out.gpuBox = (document.querySelector('.gpu-box') || {}).textContent; key('Escape');
await wait(100);
document.querySelector('.btn[title^="Download"]').click(); await wait(200); await shot('n-export'); document.querySelector('.modal-head .btn').click();
document.querySelector('.btn[title^="Workplane size"]').click(); await wait(200); await shot('o-grid'); document.querySelector('.modal-head .btn').click();
document.querySelector('.btn[title^="Help: shortcuts"]').click(); await wait(200); await shot('p-shortcuts'); document.querySelector('.modal-head .btn').click();
ed.select([base.id, ball.id]); document.querySelector('.btn[title^="Size, volume"]').click(); await wait(200); await shot('q-stats'); document.querySelector('.modal-head .btn').click();

// scribble: draw two strokes, finish, expect a new extrusion
const before = ed.doc.nodes.length;
const p = app.openScribble(null); await wait(200);
const cv = document.querySelector('.scribble-canvas'); const cr = cv.getBoundingClientRect();
const at = (x, y) => ({ clientX: cr.left + x, clientY: cr.top + y });
fire(cv, 'pointerdown', at(120, 120)); for (let i = 0; i <= 40; i++) fire(cv, 'pointermove', at(120 + i * 10, 120 + 60 * Math.sin(i / 4))); fire(cv, 'pointerup', at(520, 120));
fire(cv, 'pointerdown', at(200, 300)); for (let i = 0; i <= 40; i++) fire(cv, 'pointermove', at(320 + 110 * Math.cos(i / 40 * 6.283), 310 + 70 * Math.sin(i / 40 * 6.283))); fire(cv, 'pointerup', at(430, 310));
await shot('r-scribble');
[...document.querySelectorAll('.modal .btn')].find((x) => x.textContent === 'Done').click(); await p; await wait(100);
check('scribble', ed.doc.nodes.length === before + 1 && ed.selectedNodes()[0].kind === 'extrusion', ed.doc.nodes.length - before);
const sb = ed.bounds(ed.selectedNodes()); out.scribbleSize = [sb.max.x - sb.min.x, sb.max.y - sb.min.y, sb.max.z - sb.min.z].map((v) => +v.toFixed(1));
ed.clearSelection(); vp.home(); await wait(500);
await shot('s-final');
// update dialog: reachable from Settings, and it fails politely when no check is possible
{
  document.querySelector('.btn[title="Settings"]').click(); await wait(250);
  const ub = [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Check for updates');
  check('update-button', !!ub);
  ub.click(); await wait(400);
  const um = document.querySelector('.modal');
  out.updateText = um.querySelector('.update-status').textContent;
  check('update-dialog', um.getAttribute('aria-label') === 'Updates' && out.updateText === 'Could not check for updates' && [...um.querySelectorAll('button')].some((b) => b.textContent === 'Try again'), out.updateText);
  um.querySelector('.modal-head .btn').click(); await wait(60);
}
// the context strip (ElectroCAD's convention): selection actions float over the view, not on the toolbar
{
  const strip = () => app.viewEl.querySelector('.context-strip');
  const stripBtn = (title) => [...strip().querySelectorAll('button')].find((b) => (b.title || '').startsWith(title));
  ed.selection.clear(); ed.emit('selection'); await wait(30);
  check('strip-hidden-empty', strip().hidden === true);
  check('toolbar-no-selection-actions', !document.querySelector('.toolbar .btn[title^="Delete"]') && !document.querySelector('.toolbar .btn[title^="Group"]'));
  const a = add('box', -40, 40), b = add('box', -10, 40);
  ed.selection.clear(); ed.selection.add(a.id); ed.selection.add(b.id); ed.emit('selection'); await wait(30);
  check('strip-shown', strip().hidden === false && strip().textContent.includes('2 shapes'), strip().textContent);
  const count = ed.doc.nodes.length;
  stripBtn('Group:').click(); await wait(400);
  check('strip-group', ed.doc.nodes.length === count - 1 && ed.selectedNodes()[0]?.type === 'group', ed.doc.nodes.length);
  check('strip-ungroup-offered', !!stripBtn('Ungroup'));
  const props = strip().querySelector('.strip-props');
  props.click(); await wait(30);
  check('strip-props-hide', app.inspectorEl.style.display === 'none' && !strip().querySelector('.strip-props').classList.contains('active'));
  strip().querySelector('.strip-props').click(); await wait(30);
  check('strip-props-show', app.inspectorEl.style.display === '' && strip().querySelector('.strip-props').classList.contains('active'));
  stripBtn('Delete').click(); await wait(300);
  check('strip-delete', ed.doc.nodes.length === count - 2 && strip().hidden === true, ed.doc.nodes.length);
}
// accessibility basics and the getting-started guide
{
  const unnamed = [...document.querySelectorAll('button.btn')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label'));
  check('icon-buttons-named', unnamed.length === 0, unnamed.length);
  check('toolbar-roles', document.querySelectorAll('[role="toolbar"]').length >= 2 && !!document.querySelector('.shape-tile[role="button"][tabindex="0"]'));
  const wm = lib.dialogs.welcomeDialog(app); await wait(120);
  check('welcome-dialog', wm.el.getAttribute('role') === 'dialog' && wm.el.getAttribute('aria-modal') === 'true' && wm.el.contains(document.activeElement), document.activeElement && document.activeElement.tagName);
  const nextBtn = [...wm.el.querySelectorAll('button')].find((b) => b.textContent === 'Next');
  for (let i = 0; i < 5; i++) nextBtn.click();
  check('welcome-last-step', nextBtn.textContent === 'Start designing' && wm.el.querySelector('h3').textContent.startsWith('5.'), nextBtn.textContent);
  check('welcome-no-null', !wm.el.textContent.includes('null'));
  await shot('u-welcome');
  nextBtn.click(); await wait(60);
  check('welcome-closed', !document.querySelector('.modal') && app.settings.welcomeSeen === true);
  const tile = document.querySelector('.shape-tile'); const n0 = ed.doc.nodes.length;
  tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check('tile-keyboard', ed.doc.nodes.length === n0 + 1);
  ed.deleteSelection();
}
// sketch: an L-shaped plate with a round cut-out becomes one extrusion with a hole
{
  const before = ed.doc.nodes.length;
  const pending = app.openSketch(null); await wait(250);
  const sk = document.querySelector('.modal').__sketch;
  sk.add({ type: 'rect', x: 0, y: 0, w: 40, h: 10, cut: false });
  sk.add({ type: 'rect', x: 0, y: 0, w: 10, h: 30, cut: false });
  sk.add({ type: 'circle', cx: 30, cy: 5, r: 3, cut: true });
  await shot('t-sketch');
  sk.done(); await pending;
  const sn = ed.selectedNodes()[0]; const sbb = ed.bounds([sn]);
  out.sketch = [sn && sn.params.polys.length, sn && sn.params.polys[0].holes.length, +(sbb.max.x - sbb.min.x).toFixed(1), +(sbb.max.y - sbb.min.y).toFixed(1), +(sbb.max.z - sbb.min.z).toFixed(1)];
  check('sketch-shape', ed.doc.nodes.length === before + 1 && sn.params.polys.length === 1 && sn.params.polys[0].holes.length === 1 && out.sketch[2] === 40 && out.sketch[3] === 30 && out.sketch[4] === 10 && !!sn.params.sketch, out.sketch);
  check('sketch-solid', lib.solid.inspectSolid(lib.geometry.getGeometry(sn)).closed === true);
}
out.fails = fails; out.csg = lib.geometry.stats;
return out;
