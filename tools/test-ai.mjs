// Adapter fixture tests for the AI chat providers (no network): node tools/test-ai.mjs
// Each provider talks to a fake fetch that replays a recorded-style streamed reply.
import assert from 'node:assert/strict';
import { anthropicProvider, openaiCompatibleProvider, AiError } from '../src/renderer/ai/providers.js';
import { checkSchema, wireSchema } from '../src/renderer/ai/schema.js';

const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
const chunks = (lines) => lines.map((d) => `data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`).join('');
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body, headers: Object.fromEntries(new Headers(init && init.headers).entries()) });
    const r = handler(String(url), body);
    return new Response(r.body, { status: r.status || 200, headers: { 'content-type': r.type || 'text/event-stream', ...(r.headers || {}) } });
  };
  f.calls = calls;
  return f;
}
const tools = [{ name: 'add_shape', description: 'Add', inputSchema: { type: 'object', additionalProperties: false, properties: { catalogId: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['catalogId'] } }];
const msgs = [{ role: 'user', content: [{ type: 'text', text: 'make a box' }] }];
let n = 0;
const test = async (name, fn) => { try { await fn(); n++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n', e); process.exitCode = 1; } };

const msgStart = ['message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
const msgEnd = (stop, extra = {}) => [['message_delta', { delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage: { output_tokens: 5 } }], ['message_stop', {}]];

await test('anthropic: text + tool call, request shape', async () => {
  const f = fakeFetch(() => ({ body: sse([msgStart,
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Adding ' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'a box.' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'add_shape', input: {} } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"catalogId":' } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"box"}' } }],
    ['content_block_stop', { index: 1 }],
    ...msgEnd('tool_use')]) }));
  const p = await anthropicProvider({ apiKey: 'k', fetch: f, effort: 'high' });
  let text = ''; const started = [];
  const r = await p.stream({ system: 'SYS', tools, messages: msgs, onText: (t) => { text += t; }, onToolStart: (nm) => started.push(nm) });
  assert.equal(text, 'Adding a box.');
  assert.deepEqual(started, ['add_shape']);
  assert.equal(r.stopReason, 'tool_use');
  assert.deepEqual(r.content.find((c) => c.type === 'tool_call'), { type: 'tool_call', id: 'tu1', name: 'add_shape', input: { catalogId: 'box' } });
  const b = f.calls[0].body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.stream, true);
  assert.deepEqual(b.tool_choice, { type: 'auto' });
  assert.deepEqual(b.thinking, { type: 'adaptive' });
  assert.deepEqual(b.output_config, { effort: 'high' });
  assert.equal(b.fallbacks, 'default');
  assert.equal(b.system[0].cache_control.type, 'ephemeral');
  assert.equal(b.tools[0].eager_input_streaming, true);
  assert.equal(b.tools[0].input_schema.properties.count.minimum, undefined, 'bounds stripped from the wire schema');
  assert.match(f.calls[0].headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
  assert.equal(f.calls[0].headers.authorization, 'Bearer k');
  assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/messages');
});

await test('anthropic: tool results and raw assistant blocks go back as-is', async () => {
  const f = fakeFetch(() => ({ body: sse([msgStart, ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } }], ['content_block_stop', { index: 0 }], ...msgEnd('end_turn')]) }));
  const p = await anthropicProvider({ apiKey: 'k', fetch: f });
  const raw = [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'tu1', name: 'add_shape', input: { catalogId: 'box' } }];
  const r = await p.stream({ system: 'S', tools, messages: [...msgs, { role: 'assistant', content: [], raw: { anthropic: raw } }, { role: 'tool', results: [{ id: 'tu1', name: 'add_shape', content: '{"ok":1}', isError: false }] }] });
  assert.equal(r.stopReason, 'end');
  const m = f.calls[0].body.messages;
  assert.deepEqual(m[1].content, raw);
  assert.deepEqual(m[2].content[0], { type: 'tool_result', tool_use_id: 'tu1', content: '{"ok":1}', is_error: false });
});

await test('anthropic: refusal is reported first, content dropped', async () => {
  const f = fakeFetch(() => ({ body: sse([msgStart, ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'partial' } }], ['content_block_stop', { index: 0 }], ...msgEnd('refusal', { stop_details: { type: 'refusal', explanation: 'Not this.' } })]) }));
  const p = await anthropicProvider({ apiKey: 'k', fetch: f });
  const r = await p.stream({ system: 'S', tools, messages: msgs });
  assert.equal(r.stopReason, 'refusal');
  assert.deepEqual(r.content, []);
});

await test('anthropic: typed errors (401, 429, network)', async () => {
  for (const [status, kind] of [[401, 'auth'], [429, 'rate']]) {
    const f = fakeFetch(() => ({ status, type: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'x', message: 'nope' } }) }));
    const p = await anthropicProvider({ apiKey: 'k', fetch: f });
    await assert.rejects(p.stream({ system: 'S', tools, messages: msgs }), (e) => e instanceof AiError && e.kind === kind);
  }
  const p = await anthropicProvider({ apiKey: 'k', fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(p.stream({ system: 'S', tools, messages: msgs }), (e) => e instanceof AiError && e.kind === 'network');
});

await test('anthropic: cancel gives a cancelled error', async () => {
  const ac = new AbortController();
  const f = async (_u, init) => new Promise((_r, j) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; j(e); }));
  const p = await anthropicProvider({ apiKey: 'k', fetch: f });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p.stream({ system: 'S', tools, messages: msgs, signal: ac.signal }), (e) => e.kind === 'cancelled');
});

await test('anthropic: web search results, citations and pause_turn', async () => {
  const f = fakeFetch(() => ({ body: sse([msgStart,
    ['content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: {} } }],
    ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"M3 nut size"}' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [{ type: 'web_search_result', url: 'https://example.com/m3', title: 'M3 nuts', encrypted_content: 'x', page_age: null }] } }],
    ['content_block_stop', { index: 1 }],
    ['content_block_start', { index: 2, content_block: { type: 'text', text: '', citations: [] } }],
    ['content_block_delta', { index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.com/m3', title: 'M3 nuts', encrypted_index: 'e', cited_text: '5.5 mm' } } }],
    ['content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'An M3 nut is 5.5 mm across.' } }],
    ['content_block_stop', { index: 2 }],
    ...msgEnd('pause_turn')]) }));
  const p = await anthropicProvider({ apiKey: 'k', fetch: f, web: true });
  const started = [];
  const r = await p.stream({ system: 'S', tools, messages: msgs, onToolStart: (n, id, info) => started.push([n, id, !!(info && info.server)]) });
  assert.deepEqual(started, [['web_search', 'srv1', true]]);
  assert.equal(r.stopReason, 'pause');
  assert.deepEqual(r.server, [{ id: 'srv1', name: 'web_search', input: { query: 'M3 nut size' }, results: [{ title: 'M3 nuts', url: 'https://example.com/m3' }] }]);
  assert.deepEqual(r.sources, [{ url: 'https://example.com/m3', title: 'M3 nuts' }]);
  assert.equal(r.raw.anthropic.length, 3, 'all blocks kept to send back unchanged');
  const t = f.calls[0].body.tools;
  assert.ok(t.some((x) => x.type === 'web_search_20260318') && t.some((x) => x.type === 'web_fetch_20260318'));
  const off = fakeFetch(() => ({ body: sse([msgStart, ...msgEnd('end_turn')]) }));
  await (await anthropicProvider({ apiKey: 'k', fetch: off })).stream({ system: 'S', tools, messages: msgs });
  assert.ok(!off.calls[0].body.tools.some((x) => x.type), 'no web tools unless asked');
});

await test('local (OpenAI-compatible): streamed tool call deltas', async () => {
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'llama' };
  const f = fakeFetch(() => ({ body: chunks([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Sure. ' } }] },
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add_shape', arguments: '{"catalog' } }] } }] },
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"box"}' } }] } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]']) }));
  const p = await openaiCompatibleProvider({ baseURL: 'http://localhost:11434/v1', fetch: f, model: 'llama', temperature: 0.3 });
  let text = '';
  const r = await p.stream({ system: 'S', tools, messages: msgs, onText: (t) => { text += t; } });
  assert.equal(text, 'Sure. ');
  assert.equal(r.stopReason, 'tool_use');
  const tc = r.content.find((c) => c.type === 'tool_call');
  assert.equal(tc.name, 'add_shape');
  assert.deepEqual(tc.input, { catalogId: 'box' });
  const b = f.calls[0].body;
  assert.equal(f.calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.tools[0].function.name, 'add_shape');
  assert.equal(b.temperature, 0.3);
});

await test('local: broken tool JSON becomes an input error', async () => {
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' };
  const f = fakeFetch(() => ({ body: chunks([
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'add_shape', arguments: '{"catal' } }] } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']) }));
  const p = await openaiCompatibleProvider({ baseURL: 'http://localhost:1/v1', fetch: f, model: 'm' });
  const r = await p.stream({ system: 'S', tools, messages: msgs });
  assert.ok(r.content[0].inputError);
});

await test('schema checks', async () => {
  const s = tools[0].inputSchema;
  assert.deepEqual(checkSchema(s, { catalogId: 'box' }), []);
  assert.ok(checkSchema(s, {}).length);
  assert.ok(checkSchema(s, { catalogId: 'box', count: 9 }).length);
  assert.ok(checkSchema(s, { catalogId: 'box', extra: 1 }).length);
  assert.equal(wireSchema(s).properties.count.maximum, undefined);
});

console.log(`${n} passed`);
