// DabbleCAD - preload bridge. Exposes a small, explicit API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const smokeShotDirArg = process.argv.find((arg) => arg.startsWith('--dabble-smoke-shot-dir='));
if (smokeShotDirArg) {
  contextBridge.exposeInMainWorld('__shotDir', smokeShotDirArg.slice('--dabble-smoke-shot-dir='.length));
}

contextBridge.exposeInMainWorld('dabbleNative', {
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  relaunch: call('app:relaunch'),
  gpuInfo: call('gpu:info'),
  listDesigns: call('designs:list'),
  loadDesign: call('designs:load'),
  saveDesign: call('designs:save'),
  patchDesignMeta: call('designs:meta'),
  deleteDesign: call('designs:delete'),
  openDesignsFolder: call('designs:folder'),
  openDialog: call('dialog:open'),
  saveDialog: call('dialog:save'),
  reveal: call('shell:reveal'),
  openInSlicer: call('slicer:open'),
  pickApp: call('dialog:pick-app'),
  checkUpdate: call('update:check'),
  downloadUpdate: call('update:download'),
  installUpdate: call('update:install'),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, p) => fn(p)),
  openExternal: call('shell:open-external'),
  // Google Drive: sign-in in the system browser, tokens and Drive requests via the main process
  driveSignIn: call('gdrive:signin'),
  driveToken: call('gdrive:token'),
  driveSignOut: call('gdrive:signout'),
  driveFetch: call('gdrive:fetch'),
  printerFetch: call('printer:fetch'),
  driveHasSignIn: call('gdrive:has-signin'),
  listFonts: call('fonts:list'),
  loadFont: call('fonts:load'),
  pendingFile: call('app:pending-file'),
  onOpenFile: (fn) => ipcRenderer.on('app:open-file', (_e, file) => fn(file)),
  onBeforeClose: (fn) => ipcRenderer.on('app:before-close', () => fn()),
  closeReady: () => ipcRenderer.send('app:close-ready'),
  closeHold: () => ipcRenderer.send('app:close-hold'),
  closeCancel: () => ipcRenderer.send('app:close-cancel'),
  // AI chat: keys stay in the main process; provider requests are made there
  aiSetKey: call('ai:set-key'),
  aiHasKey: call('ai:has-key'),
  aiClearKey: call('ai:clear-key'),
  aiFetch: call('ai:fetch'),
  aiCancel: call('ai:cancel'),
  aiWebFetch: call('ai:web-fetch'),
  onAiEvent: (fn) => { const h = (_e, ev) => fn(ev); ipcRenderer.on('ai:event', h); return () => ipcRenderer.removeListener('ai:event', h); },
  smokeShot: call('smoke:shot'),
  // MCP server (AI apps): the main process serves it, the editor answers
  mcpState: call('mcp:state'),
  mcpEnable: call('mcp:enable'),
  mcpNewToken: call('mcp:new-token'),
  mcpHello: (hello) => ipcRenderer.send('mcp:hello', hello),
  mcpRespond: (msg) => ipcRenderer.send('mcp:response', msg),
  onMcpRequest: (fn) => ipcRenderer.on('mcp:request', (_e, msg) => fn(msg)),
  onSerialPorts: (fn) => ipcRenderer.on('serial:ports', (_e, ports) => fn(ports)),
  chooseSerialPort: (id) => ipcRenderer.send('serial:choose', id),
});
