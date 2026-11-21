// Bridge to the desktop shell. When DabbleCAD runs in a plain browser (vite dev)
// the same API is backed by localStorage / downloads so the editor still works.
import { installDrive } from './drive.js';

const native = window.dabbleNative || null;
export const isDesktop = !!native;

const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; /* quota */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const BROWSER_DEFAULTS = {
  theme: 'dark', gpu: 'auto', gpuAutoDisabled: false, antialias: true, shadows: true, edges: false,
  zoomInvert: false, orbitSpeed: 1, zoomSpeed: 1, autosave: true, units: 'mm', snap: 1, showDims: true,
  projection: 'perspective', hardwareAcceleration: true, platform: 'browser',
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0', // from package.json at build time
};

function pickFiles({ filters = [], multi = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multi;
    const exts = filters.flatMap((f) => f.extensions || []).filter((e) => e !== '*');
    if (exts.length) input.accept = exts.map((e) => '.' + e).join(',');
    input.onchange = async () => {
      const out = [];
      for (const f of input.files) out.push({ name: f.name, path: f.name, data: await f.arrayBuffer() });
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

function download({ defaultName = 'design', data }) {
  const blob = new Blob([data]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return defaultName;
}

const browser = {
  // the version always comes from this build (older saves stored one with the settings)
  getSettings: async () => ({ ...BROWSER_DEFAULTS, ...LS.get('dabble.settings', {}), version: BROWSER_DEFAULTS.version }),
  setSettings: async (patch) => {
    const next = { ...BROWSER_DEFAULTS, ...LS.get('dabble.settings', {}), ...patch };
    LS.set('dabble.settings', next);
    return next;
  },
  relaunch: async () => location.reload(),
  gpuInfo: async () => ({ hardwareAcceleration: true, featureStatus: {}, devices: [] }),
  listDesigns: async () => LS.get('dabble.designs', []).sort((a, b) => (b.modified || 0) - (a.modified || 0)),
  loadDesign: async (id) => localStorage.getItem('dabble.design.' + id),
  saveDesign: async (id, json, meta) => {
    try { localStorage.setItem('dabble.design.' + id, json); } catch { return false; }
    const list = LS.get('dabble.designs', []).filter((m) => m.id !== id);
    list.push({ ...meta, id });
    return LS.set('dabble.designs', list);
  },
  patchDesignMeta: async (id, patch) => {
    LS.set('dabble.designs', LS.get('dabble.designs', []).map((m) => (m.id === id ? { ...m, ...patch } : m)));
    return true;
  },
  deleteDesign: async (id) => {
    LS.del('dabble.design.' + id);
    LS.set('dabble.designs', LS.get('dabble.designs', []).filter((m) => m.id !== id));
    return true;
  },
  openDesignsFolder: async () => {},
  openDialog: pickFiles,
  saveDialog: async (opts) => download(opts),
  reveal: async () => {},
  openInSlicer: async () => ({ ok: false, error: 'Opening a slicer needs the desktop app' }),
  pickApp: async () => null,
  checkUpdate: async (opts) => (opts && opts.manual ? { status: 'error', error: 'Updates are handled by the desktop app' } : null),
  downloadUpdate: async () => ({ ok: false, error: 'Updates are handled by the desktop app' }),
  installUpdate: async () => ({ ok: false }),
  onUpdateProgress: () => {},
  openExternal: async (url) => { window.open(url, '_blank', 'noopener'); },
  listFonts: async () => [],
  loadFont: async () => null,
  pendingFile: async () => null,
  onOpenFile: () => {},
  onBeforeClose: (fn) => window.addEventListener('beforeunload', (e) => fn(e)),
  closeReady: () => {},
  closeHold: () => {},
  closeCancel: () => {},
  onSerialPorts: () => {},
  chooseSerialPort: () => {},
};

// The design library can also be kept in the user's Google Drive (see drive.js). The desktop
// bridge object is read-only, so it is copied before Drive wraps its library functions.
export const platform = native ? { ...native } : browser;
installDrive(platform);
