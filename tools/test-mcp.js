// Checks the MCP server's door (electron/mcpserver.js) without the app: the protocol, the token,
// the Host and Origin checks, and the WebSocket bridge's origin check. A fake editor answers.
// Run: node tools/test-mcp.js
'use strict';
const http = require('node:http');
const { createMcpServer, createCallbackBridge } = require('../electron/mcpserver');

const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* empty */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function upgrade(port, origin) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/bridge', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: origin } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('error', () => resolve(0));
    req.end();
  });
}

(async () => {
  const TOKEN = 'test-token';
  // a fake editor: answers tools/list and one tool
  let bridge;
  bridge = createCallbackBridge((msg) => setImmediate(() => {
    if (msg.method === 'tools/list') bridge.respond({ id: msg.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
    else if (msg.method === 'tools/call') bridge.respond({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(msg.params.arguments) }] } });
    else bridge.respond({ id: msg.id, error: { message: 'nope' } });
  }));
  const mcp = createMcpServer({ bridge, getToken: () => TOKEN, port: 7797 });
  const port = await mcp.start();
  const auth = { Authorization: `Bearer ${TOKEN}` };
  try {
    let r = await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' });
    check(r.status === 401, 'no token: 401');
    r = await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong-token' });
    check(r.status === 401, 'wrong token: 401');
    r = await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth, Origin: 'https://example.com' });
    check(r.status === 403, 'request from a web page: 403');
    r = await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...auth, Host: `evil.example:${port}` });
    check(r.status === 403, 'foreign Host header (DNS rebinding): 403');

    r = await post(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, auth);
    const sid = r.headers['mcp-session-id'];
    check(r.status === 200 && r.json.result.protocolVersion === '2025-06-18' && !!sid, 'initialize: version and session id');
    r = await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, { ...auth, 'Mcp-Session-Id': sid });
    check(r.status === 202, 'notification: 202');
    r = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...auth, 'Mcp-Session-Id': sid });
    check(r.json.result.tools.length === 0, 'tools/list with the editor away: empty list');
    r = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {} } }, { ...auth, 'Mcp-Session-Id': sid });
    check(r.json.result.isError === true && /not connected/.test(r.json.result.content[0].text), 'tools/call with the editor away: a tool error');

    bridge.setConnected(true, { tools: [] });
    r = await post(port, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { ...auth, 'Mcp-Session-Id': sid });
    check(r.json.result.tools[0].name === 'echo', 'tools/list goes to the editor');
    r = await post(port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }, { ...auth, 'Mcp-Session-Id': sid });
    check(r.json.result.content[0].text === '{"a":1}', 'tools/call goes to the editor and back');
    r = await post(port, [{ jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '2.0', id: 7, method: 'nope/nope' }], { ...auth, 'Mcp-Session-Id': sid });
    check(Array.isArray(r.json) && r.json[1].error.code === -32601, 'batch, and unknown method: -32601');
    r = await post(port, '{oops', { ...auth, 'Mcp-Session-Id': sid });
    check(r.status === 400 && r.json.error.code === -32700, 'bad JSON: parse error');
    r = await post(port, { jsonrpc: '2.0', id: 8, method: 'ping' }, { ...auth, 'Mcp-Session-Id': 'made-up' });
    check(r.status === 404, 'unknown session: 404');
  } finally { await mcp.stop(); }

  // the browser route: the bridge only takes DabbleCAD Plus's own pages
  const { createWsBridge } = require('../electron/mcpserver');
  const ws = createWsBridge({ allowedOrigins: ['https://jonsole.github.io'], describe: () => ({}) });
  const helper = createMcpServer({ bridge: ws, getToken: () => TOKEN, port: 7798 });
  const hp = await helper.start();
  try {
    check(await upgrade(hp, 'https://evil.example') === 403, 'bridge refuses other web pages');
    check(await upgrade(hp, 'https://jonsole.github.io') === 101, 'bridge accepts DabbleCAD Plus');
  } finally { await helper.stop(); }

  console.log(fails.length ? `\n${fails.length} failed` : '\nall passed');
  process.exit(fails.length ? 1 : 0);
})();
