// AI providers for the chat: each maps the provider-neutral conversation to and from one
// provider's official SDK, streams the reply, and turns its errors into a few kinds the chat
// window knows how to show.
//
// Neutral conversation:
//   { role: 'user', content: [{ type: 'text', text } | { type: 'image', mediaType, data (base64) }] }
//   { role: 'assistant', content: [{ type: 'text', text } | { type: 'tool_call', id, name, input, inputError? }], raw }
//   { role: 'tool', results: [{ id, name, content (string), isError }] }
// A provider's stream() resolves to { content, stopReason: 'end' | 'tool_use' | 'refusal' | 'max_tokens', refusal?, raw }.

import { wireSchema } from './schema.js';

export const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic (Claude)', defaultModel: 'claude-opus-5-5', needsKey: true, keyHint: 'sk-ant-…', host: 'https://api.anthropic.com' },
  { id: 'local', name: 'Local / OpenAI-compatible', defaultModel: '', needsKey: false, keyHint: 'optional', baseURL: 'http://localhost:11434/v1' },
];
export const providerInfo = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

/** A provider failure the window can explain: kind is 'auth' | 'rate' | 'network' | 'cancelled' | 'other'. */
export class AiError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function classify(e, name) {
  if (e instanceof AiError) return e;
  const status = e && (e.status || (e.response && e.response.status));
  const msg = (e && e.message) || String(e);
  if (e && (e.name === 'AbortError' || /aborted|abort/i.test(e.constructor && e.constructor.name) || /Request was aborted/i.test(msg))) return new AiError('cancelled', 'Stopped.');
  if (status === 401 || status === 403) return new AiError('auth', `${name} didn't accept the API key. Check it in Settings → AI.`);
  if (status === 429) return new AiError('rate', `${name} is limiting requests right now (rate limit). Wait a moment and retry.`);
  if (status === 404) return new AiError('other', `${name} doesn't know that model, or the address is wrong (404).`);
  if (status >= 500) return new AiError('other', `${name} had a problem (${status}). Try again shortly.`);
  if (/connection|network|fetch|ECONNREFUSED|ENOTFOUND|timed? ?out/i.test(msg) || (e && /Connection/.test(e.constructor && e.constructor.name))) return new AiError('network', `Couldn't reach ${name}. Check your connection${name.includes('Local') ? ' and that the server is running' : ''}.`);
  return new AiError('other', `${name}: ${msg.replace(/^\d{3}\s*/, '').slice(0, 300)}`);
}

// ------------------------------------------------------------------ Anthropic
const ANTHROPIC_BETAS = ['server-side-fallback-2026-07-01'];

export async function anthropicProvider({ apiKey, fetch: customFetch, model, effort = 'medium' }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: apiKey || 'from-main-process', authToken: null, baseURL: 'https://api.anthropic.com', dangerouslyAllowBrowser: true, maxRetries: 1, ...(customFetch ? { fetch: customFetch } : {}) });
  const name = 'Anthropic';

  const toWire = (messages) => messages.map((m) => {
    if (m.role === 'user') {
      return { role: 'user', content: m.content.map((c) => (c.type === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } }
        : { type: 'text', text: c.text })) };
    }
    if (m.role === 'assistant') {
      // the exact blocks the API returned (thinking, fallback boundaries) go back as they came
      if (m.raw && m.raw.anthropic) return { role: 'assistant', content: m.raw.anthropic };
      return { role: 'assistant', content: m.content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : { type: 'tool_use', id: c.id, name: c.name, input: c.input || {} })) };
    }
    return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: !!r.isError })) };
  });

  return {
    id: 'anthropic', name, model,
    async listModels() {
      try {
        const out = [];
        for await (const m of client.models.list({ limit: 100 })) out.push({ id: m.id, name: m.display_name || m.id });
        return out;
      } catch (e) { throw classify(e, name); }
    },
    async test() {
      try { await client.models.retrieve(model || 'claude-opus-5-5'); return true; } catch (e) { throw classify(e, name); }
    },
    async stream({ system, tools, messages, signal, onText, onToolStart }) {
      const body = {
        model: model || 'claude-opus-5-5',
        max_tokens: 64000,
        // the system prompt and tool list stay byte-for-byte the same, with a cache breakpoint after them
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: wireSchema(t.inputSchema), eager_input_streaming: true })),
        tool_choice: { type: 'auto' },
        thinking: { type: 'adaptive' },
        output_config: { effort },
        messages: toWire(messages),
        betas: ANTHROPIC_BETAS,
        fallbacks: 'default',
      };
      let final;
      try {
        const s = client.beta.messages.stream(body, { signal });
        for await (const ev of s) {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use' && onToolStart) onToolStart(ev.content_block.name, ev.content_block.id);
          else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && onText) onText(ev.delta.text);
        }
        final = await s.finalMessage();
      } catch (e) { throw classify(e, name); }
      // stop_reason first: a refusal may come with partial content that shouldn't be used
      if (final.stop_reason === 'refusal') {
        const d = final.stop_details || {};
        return { content: [], stopReason: 'refusal', refusal: d.explanation || null, raw: null };
      }
      const content = [];
      for (const b of final.content || []) {
        if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') {
          const ok = b.input && typeof b.input === 'object' && !Array.isArray(b.input);
          content.push({ type: 'tool_call', id: b.id, name: b.name, input: ok ? b.input : {}, ...(ok ? {} : { inputError: 'The tool input was not valid JSON (it may have been cut off).' }) });
        }
      }
      const stopReason = final.stop_reason === 'tool_use' ? 'tool_use' : final.stop_reason === 'max_tokens' ? 'max_tokens' : 'end';
      return { content, stopReason, raw: { anthropic: final.content } };
    },
  };
}

// ------------------------------------------------------------------ Local / OpenAI-compatible
export async function openaiCompatibleProvider({ apiKey, baseURL, fetch: customFetch, model, temperature }) {
  const { default: OpenAI } = await import('openai');
  const name = 'Local model';
  const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL, dangerouslyAllowBrowser: true, maxRetries: 1, ...(customFetch ? { fetch: customFetch } : {}) });

  const toWire = (system, messages) => {
    const out = [{ role: 'system', content: system }];
    for (const m of messages) {
      if (m.role === 'user') {
        const parts = m.content.map((c) => (c.type === 'image' ? { type: 'image_url', image_url: { url: `data:${c.mediaType};base64,${c.data}` } } : { type: 'text', text: c.text }));
        out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n\n') : parts });
      } else if (m.role === 'assistant') {
        const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        const calls = m.content.filter((c) => c.type === 'tool_call');
        out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } })) } : {}) });
      } else {
        for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
    return out;
  };

  return {
    id: 'local', name, model,
    async listModels() {
      try {
        const out = [];
        for await (const m of client.models.list()) out.push({ id: m.id, name: m.id });
        return out;
      } catch (e) { throw classify(e, name); }
    },
    async test() { await this.listModels(); return true; },
    async stream({ system, tools, messages, signal, onText, onToolStart }) {
      if (!model) throw new AiError('other', 'Choose a model in Settings → AI.');
      const calls = [];
      let text = '', finish = null;
      try {
        const s = await client.chat.completions.create({
          model, stream: true, messages: toWire(system, messages),
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: wireSchema(t.inputSchema) } })),
          tool_choice: 'auto',
          ...(temperature != null ? { temperature } : {}),
        }, { signal });
        for await (const chunk of s) {
          const ch = chunk.choices && chunk.choices[0];
          if (!ch) continue;
          const d = ch.delta || {};
          if (d.content) { text += d.content; if (onText) onText(d.content); }
          for (const tc of d.tool_calls || []) {
            const i = tc.index ?? calls.length;
            if (!calls[i]) { calls[i] = { id: tc.id || `call_${i}_${Date.now().toString(36)}`, name: '', args: '' }; }
            if (tc.id) calls[i].id = tc.id;
            if (tc.function && tc.function.name) { calls[i].name += tc.function.name; if (onToolStart) onToolStart(calls[i].name, calls[i].id); }
            if (tc.function && tc.function.arguments) calls[i].args += tc.function.arguments;
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      } catch (e) { throw classify(e, name); }
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const c of calls.filter(Boolean)) {
        let input = {}, inputError;
        try { input = c.args ? JSON.parse(c.args) : {}; } catch { inputError = 'The tool input was not valid JSON (it may have been cut off).'; }
        if (!input || typeof input !== 'object' || Array.isArray(input)) { input = {}; inputError = inputError || 'The tool input should be a JSON object.'; }
        content.push({ type: 'tool_call', id: c.id, name: c.name, input, ...(inputError ? { inputError } : {}) });
      }
      const stopReason = calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end';
      return { content, stopReason };
    },
  };
}

/** The provider for the current AI settings. */
export async function makeProvider(cfg, { apiKey, fetch } = {}) {
  if (cfg.provider === 'local') return openaiCompatibleProvider({ apiKey, baseURL: cfg.baseURL || providerInfo('local').baseURL, fetch, model: cfg.model, temperature: cfg.temperature });
  return anthropicProvider({ apiKey, fetch, model: cfg.model || 'claude-opus-5-5', effort: cfg.effort || 'medium' });
}
