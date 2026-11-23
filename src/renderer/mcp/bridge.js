// Connects the editor's MCP tools to the server that AI apps talk to.
//   Desktop: the main process serves http://127.0.0.1:7787/mcp and passes each request here over IPC.
//   Web: the person runs the helper (node dabblecad-mcp.cjs), and this tab connects to it over a
//        WebSocket on 127.0.0.1. A page can't open a server itself, so the helper is the door.
// Either way the requests are answered by McpTools, so both routes behave the same.
import { platform, isDesktop } from '../platform.js';
import { McpTools } from './index.js';

export const HELPER_FILE = 'dabblecad-mcp.cjs';
const DEFAULT_PORT = 7787;

export class McpConnection {
  constructor(app) {
    this.app = app;
    this.tools = new McpTools(app);
    this.status = { enabled: false, running: false, connected: false, url: '', token: '', error: '' };
    this.listeners = new Set();
    this.ws = null;
    this.retry = null;
    this.tools.onActivity((a) => this._emit({ activity: a }));
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(extra = {}) { for (const fn of this.listeners) fn({ ...this.status, ...extra }); }
  _set(patch) { Object.assign(this.status, patch); this._emit(); }
  _hello() { return { app: 'DabbleCAD Plus', version: this.app.settings.version, tools: this.tools.list() }; }

  async _answer(msg, send) {
    let reply;
    try { reply = { type: 'response', id: msg.id, result: await this.tools.handle(msg.method, msg.params) }; }
    catch (e) { reply = { type: 'response', id: msg.id, error: { message: e.message || String(e), code: typeof e.code === 'number' ? e.code : -32603 } }; }
    send(reply);
  }

  async start() {
    if (isDesktop) {
      platform.onMcpRequest((msg) => this._answer(msg, (r) => platform.mcpRespond(r)));
      platform.mcpHello(this._hello());
      this._set({ ...(await platform.mcpState()), connected: true });
    } else {
      this.status.enabled = !!this.app.settings.mcpEnabled;
      if (this.status.enabled) this._connect();
    }
  }

  async setEnabled(on) {
    if (isDesktop) { this._set({ ...(await platform.mcpEnable(on)), connected: true }); return; }
    this.app.patchSettings({ mcpEnabled: !!on });
    this._set({ enabled: !!on, error: '' });
    if (on) this._connect(); else this._disconnect();
  }

  async newToken() {
    if (isDesktop) this._set({ ...(await platform.mcpNewToken()), connected: true });
  }

  // ---------------------------------------------------------------- web: the helper's WebSocket
  get port() { return Number(this.app.settings.mcpPort) || DEFAULT_PORT; }

  _connect() {
    this._disconnect();
    let ws;
    try { ws = new WebSocket(`ws://127.0.0.1:${this.port}/bridge`); } catch (e) { this._set({ running: false, error: e.message }); return; }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', ...this._hello() }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'info') this._set({ running: true, connected: true, url: msg.url, token: msg.token, error: '' });
      else if (msg.type === 'request') this._answer(msg, (r) => { if (ws.readyState === 1) ws.send(JSON.stringify(r)); });
      else if (msg.type === 'replaced') { this.status.enabled && this._set({ error: 'Another DabbleCAD Plus tab took over the AI connection.' }); this.replaced = true; }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._set({ running: false, connected: false });
      // keep looking for the helper while this is turned on (not when another tab took over)
      if (this.status.enabled && !this.replaced) this.retry = setTimeout(() => this._connect(), 4000);
    };
  }

  _disconnect() {
    clearTimeout(this.retry);
    this.replaced = false;
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
    this._set({ running: false, connected: false });
  }

  /** Take the connection back after another tab had it. */
  reconnect() { this.replaced = false; this._set({ error: '' }); this._connect(); }
}
