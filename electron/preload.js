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
  smokeShot: call('smoke:shot'),
  onSerialPorts: (fn) => ipcRenderer.on('serial:ports', (_e, ports) => fn(ports)),
  chooseSerialPort: (id) => ipcRenderer.send('serial:choose', id),
});
