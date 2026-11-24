// The provider-neutral chat loop. For each user message: send the conversation with this turn's
// design summary, stream the reply, run the tool calls through the tool layer (or hold edits as
// cards in Ask mode), send the results back, and repeat until the model stops.
//
// The window listens with session.on(fn): events are
//   { type: 'user', msg } | { type: 'reply', reply } (a new assistant reply starts)
//   { type: 'text', reply, text } (streamed text so far) | { type: 'chip', reply, chip } (added or changed)
//   { type: 'card', reply, card } (an Ask-mode edit waiting, or decided) | { type: 'done', reply }
//   { type: 'error', reply, error } | { type: 'busy', busy }

import { TOOLS, runTool, designSummary, toolByName } from './tools.js';
import { LASER_TOOLS, laserSummary, laserContext } from './lasertools.js';
import { MORE_TOOLS } from './moretools.js';

export const DESIGN_TOOLS = [...TOOLS, ...MORE_TOOLS];
import { AiError } from './providers.js';

export const SYSTEM_PROMPT = `You are the design assistant inside DabbleCAD Plus, a 3D design app for making things to 3D print, in the style of Tinkercad. You help the user by answering questions about their design and by building or changing it with the tools you have.

How DabbleCAD works:
- A design is a list of shapes and groups on a workplane. z is up; x runs left to right and y runs front to back. All numbers you read and write are in the design's units (given in each design summary, usually mm).
- A shape's position is the middle of its footprint (x, y) and its bottom (z). A shape standing on the workplane has z = 0.
- Shapes are solids or holes. A hole does nothing on its own: grouped (union) with solids, it cuts them away. To make a hollow or a hole, add a hole shape where material should be removed, then group it with the solid.
- Groups: union combines shapes (holes cut), intersect keeps only the overlap, bundle keeps shapes together without combining. Grouping makes a new id; ungrouping gives the parts new ids.
- The shape catalog (list_shape_catalog) has boxes, cylinders, spheres, cones, text, and many more, each with its own settings (for example a box's corner radius, a cylinder's sides). Use add_shape with a size to make one exactly as big as needed.
- Locked shapes belong to the user: never try to move or change them.
- Edges can be rounded or chamfered (list_edges, set_edges), shapes cut with a plane (split), and single shapes reshaped by moving their faces, edges or corners (list_parts, move_parts), as in the Edge, Face and Corner modes.
- You can move the workplane onto a shape or a face (set_workplane) to build on it, change the view so the user can see your work (set_view), lock / hide / show shapes (set_flags), change a group's mode, pin notes, import files the user attached to the chat (list_attachments, import_file) and export the design (export_design).

How to work:
- Read before you edit: the design summary in each message lists every shape with its id and bounding box; use get_node, measure or list_shape_catalog when you need more.
- Prefer few, precise tool calls with exact sizes and positions over many small adjustments.
- Every edit you make is one undo step the user can take back, so make reasonable choices instead of asking about details; ask only when the request is genuinely unclear.
- After building something, make sure the result is selected (add_shape and group leave their result selected; use select otherwise), and say briefly what you made, with its main sizes.
- Keep replies short and plain. Don't repeat the design summary back.
- You cannot control printers or lasers, start jobs, or send G-code, and you have no tools for it: if asked, say the user has to do that themselves.`;

const MAX_STEPS = 30;

/** Undo history of the 3D editor, as the chat needs it (snapshots compared by identity). */
export function editorHistory(ed) {
  const h = ed.history;
  return {
    current: () => h.stack[h.index],
    has: (s) => h.stack.includes(s),
    canUndo: () => h.canUndo,
    undo: () => ed.undo(),
    restore: (s) => { ed._restore(s); ed.commit('AI: undo reply'); },
  };
}

/** What the AI works on: the 3D design, or the laser drawing in the Laser workspace. */
export function scopeFor(app, session = null) {
  if (app.viewMode === 'laser') {
    const ctx = laserContext(app);
    return { id: 'laser', ctx, tools: LASER_TOOLS, summary: () => laserSummary(ctx), history: ctx.history };
  }
  const ctx = { editor: app.editor, app, workspace: () => '3d', attachments: () => (session ? session.attachments : []) };
  return { id: '3d', ctx, tools: DESIGN_TOOLS, summary: () => designSummary(ctx), history: editorHistory(app.editor) };
}

export const LASER_PROMPT = `
The user is in the Laser workspace now: a 2D drawing on the laser bed, in mm, measured from the bed's top-left corner with y going down. Shapes sit on numbered layers (1 to 30); each layer has cut settings (line = cut or score along outlines, fill = engrave the area). Use the laser tools (get_laser_summary, list_laser_layers, set_laser_layer, add_laser_shape, arrange_laser, select_laser). You can't run, frame, jog or home the laser: the user does that.`;

export class ChatSession {
  /**
   * getScope(): { id, ctx, tools, summary(), history } for the current workspace (see scopeFor).
   * getProvider(): resolves to a provider (providers.js). opts.askBeforeEdits(): true to hold edits as cards.
   */
  constructor(getScope, getProvider, { askBeforeEdits = () => false } = {}) {
    this.getScope = getScope;
    this.getProvider = getProvider;
    this.askBeforeEdits = askBeforeEdits;
    // every tool is always offered (so the tool list, and the prompt cache, stay the same);
    // the ones for the other workspace say so when called
    this.tools = [...DESIGN_TOOLS, ...LASER_TOOLS];
    this.attachments = [];   // files the user attached for import: { name, data: ArrayBuffer }
    this.messages = [];     // the conversation sent to the provider
    this.listeners = new Set();
    this.busy = false;
    this.abort = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch (e) { console.error(e); } } }

  reset() {
    this.stop();
    this.messages = [];
    this.attachments = [];
  }

  stop() {
    if (this.abort) this.abort.abort();
    // an Ask-mode card left waiting counts as skipped
    if (this._pending) for (const c of [...this._pending]) c.decide(false);
  }

  /** Send a user message (text, optional image { mediaType, data }). Resolves when the reply is finished. */
  async send(text, { image } = {}) {
    if (this.busy) throw new Error('Wait for the current reply (or press Stop).');
    const scope = this.getScope();
    this.scope = scope;
    const userMsg = { role: 'user', content: [{ type: 'text', text }] };
    if (image) userMsg.content.push({ type: 'image', mediaType: image.mediaType, data: image.data });
    // the design as it is now goes after the user's words (after the cache breakpoint)
    userMsg.content.push({ type: 'text', text: `<design_summary workspace="${scope.id}">\n${JSON.stringify(scope.summary())}\n</design_summary>` });
    this.emit({ type: 'user', msg: { text, image } });

    const reply = {
      id: Math.random().toString(36).slice(2),
      text: '', chips: [], cards: [], error: null, refusal: null, done: false,
      scope: scope.id, history: scope.history, before: scope.history.current(), after: null, edits: 0,
    };
    this.emit({ type: 'reply', reply });
    this.messages.push(userMsg);
    const sentFrom = this.messages.length - 1;
    this._setBusy(true);
    this.abort = new AbortController();
    try {
      const provider = await this.getProvider();
      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.abort.signal.aborted) throw new AiError('cancelled', 'Stopped.');
        const res = await provider.stream({
          system: SYSTEM_PROMPT + LASER_PROMPT,
          tools: this.tools,
          messages: this.messages,
          signal: this.abort.signal,
          onText: (t) => { reply.text += t; this.emit({ type: 'text', reply, text: reply.text }); },
          onToolStart: () => {},
        });
        if (res.stopReason === 'refusal') {
          reply.refusal = res.refusal || 'The model declined this request.';
          // the turn that was declined leaves the conversation, so the next message starts clean
          this.messages.length = sentFrom;
          break;
        }
        if (res.content.length) this.messages.push({ role: 'assistant', content: res.content, raw: res.raw });
        const calls = res.content.filter((c) => c.type === 'tool_call');
        if (!calls.length) {
          if (res.stopReason === 'max_tokens') reply.text += '\n\n(The reply was cut off: it was too long.)';
          break;
        }
        const results = [];
        for (const call of calls) results.push(await this._runCall(reply, call));
        this.messages.push({ role: 'tool', results });
        if (step === MAX_STEPS - 1) reply.text += '\n\n(Stopped after many steps. Ask me to carry on if it isn\'t finished.)';
      }
    } catch (e) {
      const stopped = this.abort && this.abort.signal.aborted;
      const err = stopped ? new AiError('cancelled', 'Stopped.') : e instanceof AiError ? e : new AiError((e && e.kind) || 'other', (e && e.message) || String(e));
      reply.error = err;
      // keep the conversation valid for the next message: drop an unanswered tail
      this._trimUnanswered(sentFrom);
      this.emit({ type: 'error', reply, error: err });
    } finally {
      reply.done = true;
      reply.after = scope.history.current();
      this.abort = null;
      this._setBusy(false);
      this.emit({ type: 'done', reply });
    }
    return reply;
  }

  /** Tool calls that never got results (a cancel mid-way) would make the next request invalid. */
  _trimUnanswered(sentFrom) {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'assistant' && last.content.some((c) => c.type === 'tool_call')) this.messages.pop();
    if (this.messages.length === sentFrom + 1 && this.messages[sentFrom].role === 'user') this.messages.length = sentFrom;
  }

  async _runCall(reply, call) {
    const scope = this.scope;
    const tool = toolByName(call.name, this.tools);
    const chip = { id: call.id, name: call.name, input: call.input, status: 'running', result: null };
    reply.chips.push(chip);
    this.emit({ type: 'chip', reply, chip });
    const finish = (ok, payload, extra = {}) => {
      chip.status = ok ? 'ok' : extra.skipped ? 'skipped' : 'error';
      chip.result = payload;
      this.emit({ type: 'chip', reply, chip });
      return { id: call.id, name: call.name, content: typeof payload === 'string' ? payload : JSON.stringify(payload), isError: !ok };
    };
    if (call.inputError) return finish(false, call.inputError);
    if (!tool) return finish(false, `There's no tool called "${call.name}".`);
    if (!scope.tools.includes(tool)) {
      return finish(false, scope.id === 'laser'
        ? `${call.name} is for the 3D design; the user is in the Laser workspace, so use the laser tools.`
        : `${call.name} is for the Laser workspace; the user is in 3D Design, so use the 3D tools.`);
    }
    if (tool.kind === 'edit' && this.askBeforeEdits()) {
      const ok = await this._ask(reply, chip, tool, call);
      if (!ok) return finish(false, 'The user skipped this edit: it was not made.', { skipped: true });
    }
    const r = await runTool(scope.ctx, call.name, call.input, scope.tools);
    if (r.ok && r.edited) reply.edits++;
    return r.ok ? finish(true, r.result) : finish(false, r.error);
  }

  /** Ask mode: hold the edit as a card until the user applies or skips it. */
  _ask(reply, chip, tool, call) {
    return new Promise((resolve) => {
      const card = {
        id: call.id, name: call.name, input: call.input,
        summary: tool.summary ? tool.summary(call.input) : call.name.replace(/_/g, ' '),
        state: 'waiting',
        decide: (apply) => {
          if (card.state !== 'waiting') return;
          card.state = apply ? 'applied' : 'skipped';
          this._pending.delete(card);
          this.emit({ type: 'card', reply, card });
          resolve(apply);
        },
      };
      this._pending = this._pending || new Set();
      this._pending.add(card);
      chip.status = 'waiting';
      reply.cards.push(card);
      this.emit({ type: 'card', reply, card });
      if (this._applyAll) card.decide(true);
    });
  }

  /** Apply every waiting card, and the ones still to come in this reply. */
  applyAll() {
    this._applyAll = true;
    for (const c of [...(this._pending || [])]) c.decide(true);
  }

  _setBusy(on) {
    this.busy = on;
    if (!on) this._applyAll = false;
    this.emit({ type: 'busy', busy: on });
  }

  /**
   * Take back everything a reply changed. Straight undo steps when nothing happened since;
   * otherwise (the user carried on editing) the design goes back to how it was before the reply,
   * as a new undo step, if `force`.
   */
  undoReply(reply, { force = false } = {}) {
    const h = reply.history;
    if (!reply.edits || !reply.before) return { ok: false, reason: 'nothing' };
    if (this.canUndoCleanly(reply)) {
      while (h.current() !== reply.before && h.canUndo()) h.undo();
      return { ok: true };
    }
    if (!force) return { ok: false, reason: 'changed-since' };
    h.restore(reply.before);
    return { ok: true };
  }

  /** Can this reply still be taken back with plain undo steps? */
  canUndoCleanly(reply) {
    const h = reply.history;
    return !!reply.edits && h.current() === reply.after && h.has(reply.before);
  }
}
