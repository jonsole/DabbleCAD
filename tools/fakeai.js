// A fake OpenAI-compatible AI server for the AI chat smoke test. It streams a scripted reply
// (one add_shape tool call, then text) and remembers the Authorization header it last saw.
// Usage: node tools/fakeai.js <file to write its address to>
const http = require('node:http');
const fs = require('node:fs');

let seen = { authorization: null, path: null }, calls = 0;
const chunk = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-model' };

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    if (req.url === '/seen') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ...seen, calls })); return; }
    seen = { authorization: req.headers.authorization || null, path: req.url };
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] })); return; }
    if (req.url.endsWith('/chat/completions')) {
      calls++;
      const body = JSON.parse(raw || '{}');
      const answered = (body.messages || []).some((m) => m.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...cors });
      if (!answered) {
        chunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add_shape', arguments: '{"catalogId":"box",' } }] } }] });
        chunk(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"name":"Smoke box","size":{"x":30}}' } }] } }] });
        chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        chunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Made a ' } }] });
        chunk(res, { ...base, choices: [{ index: 0, delta: { content: '30 mm box.' } }] });
        chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404, cors); res.end('{}');
  });
});
server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  if (process.argv[2]) fs.writeFileSync(process.argv[2], url); else console.log(url);
});
