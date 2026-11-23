// The editor side of the MCP server: the tools an AI app can call, answered inside the editor so
// the desktop app and the web version behave the same (see electron/mcpserver.js for the door).
//
// A tool is { name, title, description, inputSchema, annotations, run(args, ctx) }. run returns
// { text, data, images } (see result()); errors thrown with a code come back as tool errors the
// model can act on. Each call that changes the design is one undo step.
import { designTools } from './designtools.js';
import { slicerTools } from './slicertools.js';
import { APP_NAME } from '../brand.js';
import { ToolError } from './errors.js';

export { ToolError };

/** Build an MCP tool result from text, structured data and pictures. */
export function result({ text, data, images = [], resources = [] }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (data !== undefined) content.push({ type: 'text', text: JSON.stringify(data, null, 1) });
  for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' });
  for (const r of resources) content.push({ type: 'resource', resource: r });
  const out = { content };
  if (data !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data)) out.structuredContent = data;
  return out;
}

const PROMPTS = [
  {
    name: 'design_part', title: 'Design a printable part',
    description: 'Design a part from a description, checking it with screenshots as you go.',
    arguments: [{ name: 'description', description: 'What to make, with sizes in mm', required: true }],
    text: (a) => `Design this in ${APP_NAME}: ${a.description}\n\nWork step by step: call get_design and list_shape_kinds first, build with add_shape (holes have hole: true, then group them with the solids), check each step with screenshot, and fix anything that looks wrong. Use millimetres. Say what you made and its overall size when done.`,
  },
  {
    name: 'print_design', title: 'Slice and print the design',
    description: 'Put the design on the plate, check the settings, slice and send it to the printer.',
    arguments: [{ name: 'notes', description: 'Anything about this print (material, strength, speed)', required: false }],
    text: (a) => `Get the open ${APP_NAME} design ready to print${a.notes ? ` (${a.notes})` : ''}. Call slicer_get_state, add the design with slicer_add_to_plate, check the printer, filament and process presets and adjust settings with slicer_set_settings where it helps, then slicer_slice and report the time and filament. Ask me before starting the print; printer_send with start: false only uploads it.`,
  },
];

/** Check arguments against a tool's input schema (the subset the tools use), so a bad call gets a clear message. */
export function checkArgs(schema, value, path = 'arguments') {
  if (!schema) return;
  const fail = (m) => { throw new ToolError('invalid_args', `${path} ${m}`); };
  const t = schema.type;
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('must be an object');
    const props = schema.properties || {};
    for (const k of schema.required || []) if (value[k] === undefined) fail(`needs "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) checkArgs(props[k], v, `${k}`);
      else if (schema.additionalProperties === false) fail(`has unknown field "${k}" (allowed: ${Object.keys(props).join(', ') || 'none'})`);
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) fail('must be a list');
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`needs at least ${schema.minItems} item${schema.minItems > 1 ? 's' : ''}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`takes at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => checkArgs(schema.items, v, `${path}[${i}]`));
  } else if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !isFinite(value)) fail('must be a number');
    if (t === 'integer' && !Number.isInteger(value)) fail('must be a whole number');
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  } else if (t === 'string') {
    if (typeof value !== 'string') fail('must be text');
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') fail('must be true or false');
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
}

export class McpTools {
  constructor(app) {
    this.app = app;
    this.tools = new Map();
    for (const t of [...designTools(), ...slicerTools()]) this.tools.set(t.name, t);
    this.busy = 0;
    this.listeners = new Set();
  }

  onActivity(fn) { this.listeners.add(fn); }
  _activity(name, running) { for (const fn of this.listeners) fn({ name, running, busy: this.busy }); }

  /** Descriptions of the tools, as tools/list returns them. */
  list() {
    return [...this.tools.values()].map((t) => ({
      name: t.name, title: t.title, description: t.description,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, idempotentHint: !!t.readOnly, openWorldHint: !!t.openWorld },
    }));
  }

  /** Answer one MCP request passed on by the server. */
  async handle(method, params = {}) {
    switch (method) {
      case 'tools/list': return { tools: this.list() };
      case 'tools/call': return this.call(params.name, params.arguments || {});
      case 'resources/list': return { resources: [
        { uri: 'dabblecad://design', name: 'design', title: 'The open design', mimeType: 'application/json', description: 'Objects in the open design, as get_design returns them' },
        { uri: 'dabblecad://shapes', name: 'shapes', title: 'Shape catalogue', mimeType: 'application/json', description: 'Shape kinds and their parameters' },
      ] };
      case 'resources/templates/list': return { resourceTemplates: [] };
      case 'resources/read': {
        const tool = params.uri === 'dabblecad://design' ? 'get_design' : params.uri === 'dabblecad://shapes' ? 'list_shape_kinds' : null;
        if (!tool) throw new ToolError('not_found', 'No such resource: ' + params.uri);
        const r = await this.tools.get(tool).run({}, this._ctx());
        return { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(r.data) }] };
      }
      case 'prompts/list': return { prompts: PROMPTS.map(({ text, ...p }) => p) };
      case 'prompts/get': {
        const p = PROMPTS.find((x) => x.name === params.name);
        if (!p) throw new ToolError('not_found', 'No such prompt: ' + params.name);
        return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(params.arguments || {}) } }] };
      }
      default: throw new ToolError('not_found', 'Unknown method ' + method);
    }
  }

  _ctx() { return { app: this.app, editor: this.app.editor, viewport: this.app.viewport, tools: this }; }

  async call(name, args) {
    const tool = this.tools.get(name);
    if (!tool) return { ...result({ text: `not_found: there is no tool called ${name}` }), isError: true };
    try { checkArgs(tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false }, args || {}); }
    catch (e) { return { content: [{ type: 'text', text: `${e.code}: ${e.message}` }], isError: true }; }
    const ed = this.app.editor;
    // every change made by one call is one undo step, named after the tool
    const commit = ed.commit;
    let changed = false;
    const group = !tool.readOnly && !tool.ownHistory;
    if (group) ed.commit = function grouped() { changed = true; };
    this.busy++;
    this._activity(name, true);
    try {
      // leave a group being edited or a part mode first, so ids and edits mean the whole design
      if (!tool.readOnly && tool.design !== false) await this._toObjectMode();
      const r = await tool.run(args || {}, this._ctx());
      return result(r);
    } catch (e) {
      const code = e.code || 'failed';
      return { content: [{ type: 'text', text: `${code}: ${e.message || e}` }], isError: true };
    } finally {
      if (group) { ed.commit = commit; if (changed) ed.commit(); }
      this.busy--;
      this._activity(name, false);
    }
  }

  async _toObjectMode() {
    const ed = this.app.editor;
    if (ed.tool !== 'select') ed.setTool('select');
    if (ed.editing) await ed.exitGroup();
  }
}
