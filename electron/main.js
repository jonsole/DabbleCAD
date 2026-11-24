// DabbleCAD - Electron main process
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, net } = require('electron');
const { spawn } = require('node:child_process');
const { registerUpdater } = require('./updater');
const { registerGoogleAuth } = require('./googleauth');
const { registerAi } = require('./ai');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const argv = process.argv.slice(1);
const argValue = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const SMOKE = argValue('smoke');
const SHOT = argValue('shot');
const DEV_URL = argValue('dev-url');

if (SMOKE) {
  // Keep test runs away from the user's real designs and settings.
  app.setPath('userData', path.join(os.tmpdir(), 'dabblecad-smoke-' + process.pid));
} else {
  // This fork was called DabbleCAD before it became DabbleCAD Plus, and kept its library in a
  // folder of that name. On first start, copy the designs and settings across (a copy, so the
  // original DabbleCAD app, if installed, keeps its own).
  try {
    const now = app.getPath('userData');
    const old = path.join(app.getPath('appData'), 'DabbleCAD');
    if (now !== old && fs.existsSync(old) && !fs.existsSync(path.join(now, 'designs')) && !fs.existsSync(path.join(now, 'settings.json'))) {
      fs.mkdirSync(now, { recursive: true });
      for (const name of ['designs', 'settings.json']) {
        const from = path.join(old, name);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(now, name), { recursive: true });
      }
    }
  } catch (err) { console.warn('Could not copy the old DabbleCAD library', err); }
}

// ---------------------------------------------------------------- settings
const DEFAULT_SETTINGS = {
  theme: 'dark',
  gpu: 'auto', // 'auto' = use the GPU when present, 'off' = software rendering
  gpuAutoDisabled: false,
  antialias: true,
  shadows: true,
  edges: false,
  zoomInvert: false,
  orbitSpeed: 1,
  zoomSpeed: 1,
  autosave: true,
  units: 'mm',
  snap: 1,
  showDims: true,
  projection: 'perspective',
  window: { width: 1500, height: 940, maximized: false },
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...raw, window: { ...DEFAULT_SETTINGS.window, ...(raw.window || {}) } };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings', err);
  }
}

loadSettings();
if (argValue('software')) settings.gpu = 'off';

// GPU policy has to be decided before the app is ready.
const hardwareAcceleration = settings.gpu !== 'off';
if (!hardwareAcceleration) {
  app.disableHardwareAcceleration();
  // Linux builds of Chromium only create a software WebGL context when asked to.
  // The app renders its own bundled files, never remote content.
  if (process.platform === 'linux') app.commandLine.appendSwitch('enable-unsafe-swiftshader');
} else {
  // Prefer the discrete / high-performance adapter on multi-GPU machines.
  app.commandLine.appendSwitch('force_high_performance_gpu');
}

// ---------------------------------------------------------------- designs
const designsDir = () => path.join(app.getPath('userData'), 'designs');
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');
const designPath = (id) => path.join(designsDir(), safeId(id) + '.dabble');
const metaPath = (id) => path.join(designsDir(), safeId(id) + '.meta.json');

function listDesigns() {
  fs.mkdirSync(designsDir(), { recursive: true });
  const out = [];
  for (const file of fs.readdirSync(designsDir())) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(designsDir(), file), 'utf8'));
      if (fs.existsSync(designPath(meta.id))) out.push(meta);
    } catch { /* skip unreadable entries */ }
  }
  out.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  return out;
}

// ---------------------------------------------------------------- fonts
function fontDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts'));
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'));
  }
  return dirs;
}

let fontIndex = null;
function listFonts() {
  if (fontIndex) return fontIndex;
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
      if (/\.(ttf|otf)$/i.test(e.name)) found.push({ name: e.name.replace(/\.(ttf|otf)$/i, ''), file: full });
    }
  };
  for (const d of fontDirs()) walk(d, 0);
  found.sort((a, b) => a.name.localeCompare(b.name));
  fontIndex = found;
  return found;
}

// ---------------------------------------------------------------- window
let win = null;
let pendingOpenFile = argv.find((a) => /\.dabble$/i.test(a)) || null;

function createWindow() {
  const w = settings.window || {};
  nativeTheme.themeSource = settings.theme === 'light' ? 'light' : 'dark';
  win = new BrowserWindow({
    width: SMOKE ? 1500 : w.width || 1500,
    height: SMOKE ? 940 : w.height || 940,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'DabbleCAD Plus',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: settings.theme === 'light' ? '#f3f5f8' : '#16181d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: SMOKE ? [`--dabble-smoke-shot-dir=${argValue('shots') || os.tmpdir()}`] : [],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  if (w.maximized && !SMOKE) win.maximize();

  if (SMOKE && argValue('offline')) {
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }));
  }
  if (DEV_URL && typeof DEV_URL === 'string') win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.once('ready-to-show', () => { if (!SMOKE || argValue('show')) win.show(); });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.key === 'F5') {
      win.webContents.reload();
      event.preventDefault();
    } else if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });

  // Serial ports (laser controllers): allow access and let the renderer pick the port.
  const ses = win.webContents.session;
  ses.setPermissionCheckHandler(() => true);
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');
  ses.on('select-serial-port', (event, portList, _wc, callback) => {
    event.preventDefault();
    pendingSerial = callback;
    win.webContents.send('serial:ports', portList.map((p) => ({ id: p.portId, name: p.portName, label: p.displayName || p.portName, vendorId: p.vendorId, productId: p.productId })));
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Let the renderer flush unsaved work (or ask about it) before the window goes away.
  let closing = false, closeTimer = null;
  win.on('close', (event) => {
    if (!SMOKE) {
      const b = win.getNormalBounds();
      settings.window = { width: b.width, height: b.height, maximized: win.isMaximized() };
      saveSettings();
    }
    if (SMOKE) return;
    event.preventDefault();
    if (closing) return; // already saving or asking
    closing = true;
    win.webContents.send('app:before-close');
    closeTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); }, 2500);
  });
  ipcMain.removeAllListeners('app:close-ready');
  ipcMain.removeAllListeners('app:close-hold');
  ipcMain.removeAllListeners('app:close-cancel');
  ipcMain.on('app:close-ready', () => { clearTimeout(closeTimer); if (win && !win.isDestroyed()) win.destroy(); });
  // the renderer is showing a "Save changes?" prompt: wait for the user instead of force-closing
  ipcMain.on('app:close-hold', () => { clearTimeout(closeTimer); });
  ipcMain.on('app:close-cancel', () => { clearTimeout(closeTimer); closing = false; });
  win.on('closed', () => { win = null; });

  if (SMOKE) runSmoke();
}

// ---------------------------------------------------------------- GPU crash fallback
let gpuCrashes = 0;
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU' || details.reason === 'clean-exit' || details.reason === 'killed') return;
  gpuCrashes += 1;
  if (gpuCrashes >= 2 && hardwareAcceleration && !SMOKE) {
    settings.gpu = 'off';
    settings.gpuAutoDisabled = true;
    saveSettings();
    app.relaunch();
    app.exit(0);
  }
});

// ---------------------------------------------------------------- IPC
let pendingSerial = null;
ipcMain.on('serial:choose', (_e, id) => {
  if (!pendingSerial) return;
  const cb = pendingSerial;
  pendingSerial = null;
  cb(id || '');
});
ipcMain.handle('settings:get', () => ({ ...settings, hardwareAcceleration, platform: process.platform, version: app.getVersion(), smoke: !!SMOKE, ...(SMOKE && argValue('fake-ai') ? { fakeAi: argValue('fake-ai') } : {}) }));
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  if (patch && patch.theme) nativeTheme.themeSource = settings.theme === 'light' ? 'light' : 'dark';
  if (patch && patch.gpu === 'auto') settings.gpuAutoDisabled = false;
  saveSettings();
  return { ...settings, hardwareAcceleration };
});
// G-code to a printer on the local network (the page itself can't: CORS, mixed content). Any http(s) address.
ipcMain.handle('printer:fetch', async (_e, url, opts = {}) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { error: 'Not a web address' };
    const body = opts.body ? Buffer.from(opts.body) : undefined;
    const res = await net.fetch(url, { method: opts.method || 'GET', headers: opts.headers || {}, body, signal: AbortSignal.timeout(10 * 60 * 1000) });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (err) { return { error: `Couldn't reach the printer: ${err && err.message ? err.message : err}` }; }
});
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('gpu:info', async () => {
  let info = null;
  try { info = await app.getGPUInfo('basic'); } catch { /* not available */ }
  return { hardwareAcceleration, featureStatus: app.getGPUFeatureStatus(), devices: info && info.gpuDevice ? info.gpuDevice : [] };
});

// Google Drive sign-in (system browser + loopback). Test runs can point it at a fake Google.
const fakeGoogle = SMOKE && typeof argValue('fake-google') === 'string' ? argValue('fake-google').replace(/\/$/, '') : null;
registerGoogleAuth(ipcMain, () => win, fakeGoogle ? {
  auth: fakeGoogle + '/o/oauth2/v2/auth', token: fakeGoogle + '/token', revoke: fakeGoogle + '/revoke', api: fakeGoogle + '/', headless: true,
} : null);

// AI chat: keys and provider requests (nothing here can reach printers or lasers)
registerAi(ipcMain, () => win);

ipcMain.handle('designs:list', () => listDesigns());
ipcMain.handle('designs:load', (_e, id) => fs.readFileSync(designPath(id), 'utf8'));
ipcMain.handle('designs:save', (_e, id, json, meta) => {
  fs.mkdirSync(designsDir(), { recursive: true });
  const tmp = designPath(id) + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, designPath(id));
  fs.writeFileSync(metaPath(id), JSON.stringify({ ...meta, id: safeId(id) }));
  return true;
});
ipcMain.handle('designs:meta', (_e, id, patch) => {
  const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  fs.writeFileSync(metaPath(id), JSON.stringify({ ...meta, ...patch, id: safeId(id) }));
  return true;
});
ipcMain.handle('designs:delete', (_e, id) => {
  for (const p of [designPath(id), metaPath(id)]) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
  return true;
});
ipcMain.handle('designs:folder', () => { fs.mkdirSync(designsDir(), { recursive: true }); shell.openPath(designsDir()); });

ipcMain.handle('dialog:open', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: opts.title || 'Open',
    filters: opts.filters || [],
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => {
    const buf = fs.readFileSync(p);
    return { name: path.basename(p), path: p, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  });
});
ipcMain.handle('dialog:save', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog(win, {
    title: opts.title || 'Save',
    defaultPath: opts.defaultName || 'design',
    filters: opts.filters || [],
  });
  if (res.canceled || !res.filePath) return null;
  const data = typeof opts.data === 'string' ? opts.data : Buffer.from(opts.data);
  fs.writeFileSync(res.filePath, data);
  return res.filePath;
});
// Hand an exported model to a slicer: the chosen app, or whatever opens that file type.
ipcMain.handle('slicer:open', async (_e, opts = {}) => {
  try {
    const dir = path.join(app.getPath('temp'), 'DabbleCAD');
    fs.mkdirSync(dir, { recursive: true });
    const name = String(opts.name || 'design.stl').replace(/[^\w .-]/g, '_');
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof opts.data === 'string' ? opts.data : Buffer.from(opts.data));
    const slicer = typeof settings.slicerPath === 'string' ? settings.slicerPath : '';
    if (slicer && fs.existsSync(slicer)) {
      const isMacApp = process.platform === 'darwin' && slicer.endsWith('.app');
      const child = isMacApp ? spawn('open', ['-a', slicer, file], { detached: true, stdio: 'ignore' }) : spawn(slicer, [file], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { ok: true, path: file, app: path.basename(slicer) };
    }
    const err = await shell.openPath(file);
    return err ? { ok: false, path: file, error: err } : { ok: true, path: file, app: null };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});
ipcMain.handle('dialog:pick-app', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose your slicer',
    filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
    properties: process.platform === 'darwin' ? ['openFile', 'openDirectory', 'treatPackageAsDirectory'] : ['openFile'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

registerUpdater({ ipcMain, app, net, shell, getWindow: () => win, getSettings: () => settings, smoke: !!SMOKE, argValue });
ipcMain.handle('shell:open-external', (_e, url) => {
  // only this fork's, the original app's and the web version's pages
  if (typeof url === 'string' && /^https:\/\/(github\.com\/(jonsole|DJMcNewgent)\/|jonsole\.github\.io\/)/.test(url)) shell.openExternal(url);
});
ipcMain.handle('shell:reveal', (_e, p) => { if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p); });

ipcMain.handle('fonts:list', () => listFonts().map((f) => f.name));
ipcMain.handle('fonts:load', (_e, name) => {
  const hit = listFonts().find((f) => f.name === name);
  if (!hit) return null;
  const buf = fs.readFileSync(hit.file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});
ipcMain.handle('app:pending-file', () => {
  if (!pendingOpenFile) return null;
  const p = pendingOpenFile;
  pendingOpenFile = null;
  try { return { name: path.basename(p), path: p, text: fs.readFileSync(p, 'utf8') }; } catch { return null; }
});

// ---------------------------------------------------------------- smoke test harness
ipcMain.handle('smoke:shot', async (_e, file) => {
  if (!SMOKE || !win) return false;
  await win.webContents.capturePage(); // the first capture of a hidden window can be a stale frame
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
  return true;
});

function runSmoke() {
  const logs = [];
  win.webContents.on('console-message', (e) => {
    const line = `[renderer:${e.level}] ${e.message}`;
    logs.push(line);
    console.log(line);
  });
  win.webContents.on('render-process-gone', (_e, d) => { console.log('[renderer gone]', d.reason); app.exit(3); });
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await wait(2500);
      if (typeof SMOKE === 'string') {
        const script = fs.readFileSync(SMOKE, 'utf8');
        const result = await win.webContents.executeJavaScript(`(async () => { ${script}\n })()`, true);
        console.log('[smoke result]', JSON.stringify(result));
        if (Array.isArray(result?.fails) && result.fails.length) {
          throw new Error('Smoke assertions failed: ' + result.fails.join('; '));
        }
      }
      await wait(900);
      if (typeof SHOT === 'string') {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(SHOT, img.toPNG());
        console.log('[smoke] screenshot', SHOT);
      }
    } catch (err) {
      console.log('[smoke error]', err && err.stack ? err.stack : String(err));
      process.exitCode = 2;
    }
    app.exit(process.exitCode || 0);
  });
}

// ---------------------------------------------------------------- lifecycle
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, args) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = args.find((a) => /\.dabble$/i.test(a));
    if (file) {
      try { win.webContents.send('app:open-file', { name: path.basename(file), path: file, text: fs.readFileSync(file, 'utf8') }); } catch { /* ignore */ }
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
