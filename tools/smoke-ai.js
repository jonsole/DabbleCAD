// AI chat, desktop: keys stay in the main process, requests go through it, and a whole chat turn
// runs against a fake OpenAI-compatible server. Run with --smoke=tools/smoke-ai.js --fake-ai=<url>.
const app = window.dabble, native = window.dabbleNative;
const fails = [];
let checks = 0;
const check = (name, ok) => { checks++; if (!ok) fails.push(name); };
const fakeUrl = app.settings.fakeAi;
if (!fakeUrl) throw new Error('Start tools/fakeai.js and pass --fake-ai=<url>');

// the window never sees a key, and Anthropic requests can't be pointed elsewhere
check('no key getter in the bridge', !Object.keys(native).some((k) => /getKey|readKey/i.test(k)));
const evil = await native.aiFetch('t1', 'anthropic', 'https://example.com/v1/messages', { method: 'POST', headers: {}, body: '{}' });
check('anthropic key only goes to api.anthropic.com', !!evil.error);
const bad = await native.aiFetch('t2', 'nope', fakeUrl + '/v1/models', {});
check('unknown provider refused', !!bad.error);

// save a key for the local server
const base = fakeUrl + '/v1';
await native.aiSetKey('local', 'smoke-secret', base);
check('key saved', await native.aiHasKey('local'));
check('key not in settings', !JSON.stringify(app.settings).includes('smoke-secret'));
check('key not in storage', !JSON.stringify({ ...localStorage }).includes('smoke-secret'));

// a whole chat turn: tool call, tool result, text
app.patchSettings({ ai: { provider: 'local', baseURL: base, model: 'fake-model' } });
const n0 = app.editor.doc.nodes.length;
const reply = await app.ai.session.send('make a 30 mm box');
check('turn finished without error', !reply.error);
check('box added', app.editor.doc.nodes.length === n0 + 1 && app.editor.doc.nodes.some((n) => n.name === 'Smoke box'));
check('one labelled undo step', app.editor.history.undoLabel === 'AI: add Smoke box');
check('text streamed', reply.text === 'Made a 30 mm box.');
const seen = await (await fetch(fakeUrl + '/seen')).json();
check('main process added the key', seen.authorization === 'Bearer smoke-secret');
check('two model calls', seen.calls === 2);

// the key only goes to the server it was saved for
await native.aiFetch('t3', 'local', fakeUrl + '/elsewhere/models', { method: 'GET', headers: { authorization: 'Bearer from-window' } });
await new Promise((r) => setTimeout(r, 200));
const seen2 = await (await fetch(fakeUrl + '/seen')).json();
check('key not sent to another address, window header dropped', seen2.path === '/elsewhere/models' && !seen2.authorization);

// undo the reply
check('undo reply', app.ai.session.undoReply(reply).ok && app.editor.doc.nodes.length === n0);

await native.aiClearKey('local');
check('key removed', !(await native.aiHasKey('local')));

// ---- the chat loop with a scripted fake provider (no network)
const out = await (async () => {
    const ai = app.ai, s = ai.session, out = {};
    const log = [];
    // scripted fake provider: each call returns the next step
    const fake = (steps) => ({ async stream({ messages, onText, signal }) {
      log.push(messages.map((m) => m.role).join(','));
      const st = steps.shift();
      if (!st) return { content: [{ type: 'text', text: 'done' }], stopReason: 'end' };
      if (st.wait) await new Promise((r, j) => { const t = setTimeout(r, st.wait); signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('Request was aborted.'); e.name = 'AbortError'; j(e); }); });
      if (st.throw) { const { AiError } = { AiError: class extends Error { constructor(k, m) { super(m); this.kind = k; } } }; throw new AiError(st.throw, 'boom ' + st.throw); }
      if (st.text) onText(st.text);
      return st;
    } });
    const call = (name, input, id = Math.random().toString(36).slice(2)) => ({ type: 'tool_call', id, name, input });

    ai.toggle(true);
    // 1. live apply: two edits in one reply, then text
    const n0 = app.editor.doc.nodes.length, h0 = app.editor.history.index;
    s.getProvider = async () => fake([
      { content: [call('add_shape', { catalogId: 'box', name: 'Base', size: { x: 40, y: 30, z: 10 } })], stopReason: 'tool_use' },
      { content: [call('add_shape', { catalogId: 'cylinder', name: 'Peg', size: { x: 10, y: 10, z: 20 }, position: { x: 0, y: 0, z: 10 } })], stopReason: 'tool_use' },
      { text: 'Made a **base** and a peg.', content: [{ type: 'text', text: 'Made a base and a peg.' }], stopReason: 'end' },
    ]);
    const r1 = await s.send('make a base with a peg');
    out.live = { added: app.editor.doc.nodes.length - n0, steps: app.editor.history.index - h0, edits: r1.edits, label: app.editor.history.undoLabel, undoTitle: app.btn.undo.title, text: r1.text, roles: log.slice() };
    out.summaryInUser = s.messages[0].content.some((c) => c.type === 'text' && c.text.includes('<design_summary'));
    // 2. undo this reply (clean)
    const u = s.undoReply(r1);
    out.undo = { ok: u.ok, count: app.editor.doc.nodes.length - n0, index: app.editor.history.index - h0 };
    // 3. ask mode: skip first, apply second
    ai.askBox.checked = true; ai.save({ ask: true });
    s.getProvider = async () => fake([
      { content: [call('add_shape', { catalogId: 'box', name: 'Skipped' }, 'c1'), call('add_shape', { catalogId: 'sphere', name: 'Kept' }, 'c2')], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end' },
    ]);
    const pr = s.send('two shapes');
    await new Promise((r) => setTimeout(r, 100));
    const cards = [...document.querySelectorAll('.ai-card.waiting')].length;
    document.querySelector('.ai-card.waiting .btn-outline').click();   // Skip
    await new Promise((r) => setTimeout(r, 50));
    document.querySelector('.ai-card.waiting .btn-primary').click();   // Apply
    const r3 = await pr;
    const names = app.editor.doc.nodes.map((n) => n.name);
    const toolMsg = s.messages.findLast((m) => m.role === 'tool');
    out.ask = { cardsShown: cards, hasKept: names.includes('Kept'), hasSkipped: names.includes('Skipped'), skippedReported: toolMsg && toolMsg.results[0].isError && /skipped/.test(toolMsg.results[0].content), edits: r3.edits };
    ai.askBox.checked = false; ai.save({ ask: false });
    // 4. undo after the user edited since -> needs force
    app.editor.commit('user edit');
    const u2 = s.undoReply(r3);
    const u3 = s.undoReply(r3, { force: true });
    out.forceUndo = { first: u2.reason, forced: u3.ok, keptGone: !app.editor.doc.nodes.some((n) => n.name === 'Kept'), label: app.editor.history.undoLabel };
    // 5. error + retry
    s.getProvider = async () => fake([{ throw: 'rate' }]);
    const r5 = await s.send('hello');
    out.error = { kind: r5.error && r5.error.kind, msgsAfter: s.messages.length, shown: !!document.querySelector('.ai-error .btn') };
    // 6. cancel mid-stream
    s.getProvider = async () => fake([{ wait: 2000, content: [], stopReason: 'end' }]);
    const before = s.messages.length;
    const p6 = s.send('slow');
    await new Promise((r) => setTimeout(r, 100));
    out.stopVisible = ai.stopBtn.style.display !== 'none';
    s.stop();
    const r6 = await p6;
    out.cancel = { kind: r6.error && r6.error.kind, msgs: s.messages.length - before, busy: s.busy };
    // 7. locked shape refused, bad input refused, laser tool in 3d refused
    app.editor.addNode(window.dabbleLib.doc.makeShape('box', window.dabbleLib.shapes.defaultParams('box'), '#888888', 'Lockme')); app.editor.commit();
    const id = app.editor.doc.nodes.find((n) => n.name === 'Lockme').id;
    app.editor.doc.nodes.find((n) => n.id === id).locked = true;
    s.getProvider = async () => fake([
      { content: [call('set_color', { ids: [id], color: '#00ff00' }), call('set_size', { ids: [id] , size: { x: -3 } }), call('add_laser_shape', { type: 'rect', x: 0, y: 0, w: 5, h: 5 })], stopReason: 'tool_use' },
    ]);
    const r7 = await s.send('colour it');
    out.refuse = r7.chips.map((c) => c.status + ':' + String(c.result).slice(0, 60));
    app.editor.doc.nodes.find((n) => n.id === id).locked = false;
    // 8. laser workspace
    app.setViewMode('laser');
    const L0 = app.laser.doc.shapes.length, LH = app.laser.hIndex;
    s.getProvider = async () => fake([
      { content: [call('add_laser_shape', { type: 'rect', x: 10, y: 10, w: 50, h: 20, layer: 2 }), call('set_laser_layer', { layer: 2, mode: 'fill', power_max: 40 })], stopReason: 'tool_use' },
    ]);
    const r8 = await s.send('a rect');
    out.laser = { added: app.laser.doc.shapes.length - L0, hsteps: app.laser.hIndex - LH, mode: app.laser.doc.layers[1].mode, summary: s.messages[s.messages.length - 3]?.content?.at(-1)?.text?.slice(0, 50), chips: r8.chips.map((c) => c.status) };
    const ul = s.undoReply(r8);
    out.laserUndo = { ok: ul.ok, back: app.laser.doc.shapes.length - L0, mode: (app.laser.doc.layers[1] || {}).mode };
    // 9. slicer hides the window
    app.setViewMode('slicer');
    out.slicerHidden = ai.el.style.display === 'none' && app.aiBtn.style.display === 'none';
    app.setViewMode('design');
    out.backOpen = ai.el.style.display !== 'none';
    // no device tools
    out.deviceTools = s.tools.map((t) => t.name).filter((n) => /connect|start|pause|frame|home|jog|gcode|g_code|print|run_job|send/i.test(n));

    return out;
})();
const ok = (name, cond) => check('loop: ' + name, cond);
ok('live: two shapes, two labelled steps', out.live.added === 2 && out.live.steps === 2 && out.live.label === 'AI: add Peg' && /Undo AI: add Peg/.test(out.live.undoTitle));
ok('design summary in the user turn', out.summaryInUser);
ok('undo this reply', out.undo.ok && out.undo.count === 0 && out.undo.index === 0);
ok('ask mode: skip and apply', out.ask.cardsShown === 1 && out.ask.hasKept && !out.ask.hasSkipped && out.ask.skippedReported);
ok('undo after later edits needs confirming', out.forceUndo.first === 'changed-since' && out.forceUndo.forced && out.forceUndo.keptGone);
ok('error shown with Retry, conversation kept valid', out.error.kind === 'rate' && out.error.shown);
ok('cancel', out.stopVisible && out.cancel.kind === 'cancelled' && out.cancel.msgs === 0 && !out.cancel.busy);
ok('refusals: locked, bad input, wrong workspace', out.refuse.length === 3 && out.refuse.every((r) => r.startsWith('error:')));
ok('laser tools: one undo step each, undo reply', out.laser.added === 1 && out.laser.hsteps === 2 && out.laser.mode === 'fill' && out.laserUndo.ok && out.laserUndo.back === 0);
ok('hidden in the Slicer', out.slicerHidden && out.backOpen);
ok('no printer or laser control tools', out.deviceTools.length === 0);

// ---- the extra 3D tools (edges, split, parts, workplane, flags, notes, import)
{
  const { scopeFor } = window.dabbleAi;
  const sc = scopeFor(app, app.ai.session);
  const run = (n, i) => window.dabbleAi.runTool(sc.ctx, n, i, sc.tools);
  app.setViewMode('design');
  await run('add_shape', { catalogId: 'box', name: 'T', size: { x: 40, y: 30, z: 20 } });
  const id = app.editor.selectedNodes()[0].id;
  const e = await run('set_edges', { id, set: 'top', style: 'round', size: 3 });
  check('tools: round top edges', e.ok && e.result.edges.length === 4 && app.editor.history.undoLabel === 'AI: round top edges');
  const faces = (await run('list_parts', { id, kind: 'faces' })).result.faces;
  const top = faces.find((f) => f.outward.z > 0.9);
  check('tools: move a face', (await run('move_parts', { id, kind: 'faces', parts: [top.face], by: 5 })).ok && Math.abs(app.editor.bounds([app.editor.node(id)]).max.z - 25) < 0.01);
  const sp = await run('split', { ids: [id], axis: 'z', at: 8 });
  check('tools: split', sp.ok && sp.result.pieces.length === 2);
  check('tools: workplane on top and back', (await run('set_workplane', { to: 'on_top', ids: [sp.result.pieces[0].id] })).ok && app.editor.hasFrame && (await run('set_workplane', { to: 'main' })).ok && !app.editor.hasFrame);
  check('tools: lock, no unlock', (await run('set_flags', { ids: [sp.result.pieces[0].id], locked: true })).ok && !(await run('set_flags', { ids: [sp.result.pieces[0].id], locked: false })).ok);
  check('tools: note', (await run('note', { action: 'add', text: 'hi', at: { x: 0, y: 0, z: 30 } })).ok && app.editor.doc.notes.length >= 1);
  const stl = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n';
  app.ai.session.attachments = [{ name: 'tri.stl', data: new TextEncoder().encode(stl).buffer }];
  const im = await run('import_file', { name: 'tri.stl', largest_side: 30 });
  check('tools: import an attachment', im.ok && im.result.imported.length === 1);
}

if (fails.length) throw new Error(fails.join('\n'));
return { checks, fails };
