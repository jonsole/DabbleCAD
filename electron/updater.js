// DabbleCAD - in-app updates. Looks up the latest GitHub release, downloads the build for
// this computer, checks it against the release's SHA-256 list, and installs it.
// Designs and settings live in the user-data folder, which installing never touches.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// This fork's releases (the original app's would replace the fork's features).
const REPO = 'jonsole/DabbleCAD';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'DabbleCAD-Plus' };

const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(latest, current) {
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

/** Which release file suits this computer, and what we can do with it once downloaded. */
function pickAsset(version, { platform = process.platform, arch = process.arch, execPath = process.execPath, env = process.env } = {}) {
  if (platform === 'win32') {
    // the installer leaves an uninstaller beside the app; the portable ZIP does not
    const installed = fs.existsSync(path.join(path.dirname(execPath), 'Uninstall DabbleCAD Plus.exe'));
    return installed
      ? { name: `DabbleCAD-Plus-${version}-win-x64-setup.exe`, mode: 'install' }
      : { name: `DabbleCAD-Plus-${version}-win-x64.zip`, mode: 'reveal' };
  }
  if (platform === 'darwin') return { name: `DabbleCAD-Plus-${version}-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`, mode: 'open' };
  if (platform === 'linux') return { name: `DabbleCAD-Plus-${version}-linux-x64.AppImage`, mode: env.APPIMAGE ? 'appimage' : 'reveal' };
  return null;
}

function registerUpdater({ ipcMain, app, net, shell, getWindow, getSettings, smoke, argValue }) {
  // test hooks, honoured only by the automated checks
  const pretendVersion = smoke ? argValue('update-as') : null;
  const dryRun = smoke && !!argValue('update-dry-run');
  const currentVersion = () => (typeof pretendVersion === 'string' ? pretendVersion : app.getVersion());
  let found = null; // { version, asset, mode, url, sumsUrl, size, notes }
  let downloaded = null; // { file, mode, version }
  let busy = false;

  // tidy up installers left behind by earlier updates
  if (!smoke) {
    try {
      const dir = path.join(app.getPath('temp'), 'DabbleCAD-update');
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (Date.now() - fs.statSync(file).mtimeMs > 3 * 24 * 3600 * 1000) fs.rmSync(file, { force: true });
      }
    } catch { /* no leftovers */ }
  }

  async function lookUp() {
    const res = await net.fetch(API, { headers: HEADERS });
    if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is limiting requests right now. Try again in a few minutes.' : `GitHub answered with status ${res.status}`);
    const body = await res.json();
    const version = String(body.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The latest release has an unexpected version name');
    const pick = pickAsset(version);
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const file = pick ? assets.find((a) => a.name === pick.name) : null;
    const sums = assets.find((a) => a.name === 'SHA256SUMS.txt');
    const ok = (a) => a && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(DOWNLOAD_PREFIX);
    return {
      version, notes: String(body.body || '').slice(0, 4000), page: `https://github.com/${REPO}/releases/tag/v${version}`,
      asset: ok(file) ? file.name : null, url: ok(file) ? file.browser_download_url : null, size: file ? file.size : 0,
      sumsUrl: ok(sums) ? sums.browser_download_url : null, mode: pick ? pick.mode : null,
    };
  }

  // Start-up notice (quiet) and the manual "Check for updates" button (reports every outcome).
  ipcMain.handle('update:check', async (_e, opts = {}) => {
    const manual = !!(opts && opts.manual);
    if (smoke && !pretendVersion) return manual ? { status: 'error', error: 'Update checks are switched off during automated tests' } : null;
    if (!manual && getSettings().checkUpdates === false) return null;
    const current = currentVersion();
    try {
      const info = await lookUp();
      if (!isNewer(info.version, current)) { found = null; return manual ? { status: 'current', current, latest: info.version } : null; }
      found = info;
      return { status: 'available', latest: info.version, current, url: info.page, notes: info.notes, size: info.size, canInstall: !!(info.url && info.sumsUrl), mode: info.mode };
    } catch (err) {
      // offline, blocked or rate limited: the start-up check stays silent
      return manual ? { status: 'error', error: String(err && err.message ? err.message : err), current } : null;
    }
  });

  ipcMain.handle('update:download', async () => {
    if (busy) return { ok: false, error: 'An update is already downloading' };
    if (!found || !found.url || !found.sumsUrl) return { ok: false, error: 'There is no downloadable update for this computer. Open the release page instead.' };
    busy = true;
    const info = found;
    const dir = path.join(app.getPath('temp'), 'DabbleCAD-update');
    const file = path.join(dir, info.asset);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const sumsRes = await net.fetch(info.sumsUrl, { headers: { 'User-Agent': 'DabbleCAD-Plus' } });
      if (!sumsRes.ok) throw new Error('Could not fetch the checksum list');
      const line = (await sumsRes.text()).split(/\r?\n/).find((l) => l.trim().endsWith('  ' + info.asset) || l.trim().endsWith(' *' + info.asset));
      const expected = line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
      if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('The release has no checksum for this file');

      const res = await net.fetch(info.url, { headers: { 'User-Agent': 'DabbleCAD-Plus' } });
      if (!res.ok || !res.body) throw new Error(`The download failed with status ${res.status}`);
      const total = Number(res.headers.get('content-length')) || info.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file);
      const reader = res.body.getReader();
      let received = 0, lastSent = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        received += value.length;
        const now = Date.now();
        const win = getWindow();
        if (win && now - lastSent > 150) { lastSent = now; win.webContents.send('update:progress', { received, total }); }
      }
      await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
      const actual = hash.digest('hex');
      if (actual !== expected) { fs.rmSync(file, { force: true }); throw new Error('The download did not match its checksum and was discarded'); }
      downloaded = { file, mode: info.mode, version: info.version };
      return { ok: true, mode: info.mode, version: info.version, bytes: received, verified: true };
    } catch (err) {
      try { fs.rmSync(file, { force: true }); } catch { /* nothing to clean */ }
      return { ok: false, error: String(err && err.message ? err.message : err) };
    } finally { busy = false; }
  });

  // The renderer saves the open design before calling this.
  ipcMain.handle('update:install', async () => {
    if (!downloaded || !fs.existsSync(downloaded.file)) return { ok: false, error: 'Download the update first' };
    const { file, mode } = downloaded;
    if (dryRun) return { ok: true, mode, dryRun: true, file };
    try {
      if (mode === 'install') {
        // silent install over the current copy, then start the new version
        const child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        setTimeout(() => app.exit(0), 400);
        return { ok: true, mode, quitting: true };
      }
      if (mode === 'appimage') {
        const target = process.env.APPIMAGE;
        const staged = target + '.new';
        fs.copyFileSync(file, staged);
        fs.chmodSync(staged, 0o755);
        fs.renameSync(staged, target);
        const child = spawn(target, [], { detached: true, stdio: 'ignore', env: { ...process.env } });
        child.on('error', () => {});
        child.unref();
        setTimeout(() => app.exit(0), 400);
        return { ok: true, mode, quitting: true };
      }
      if (mode === 'open') {
        const err = await shell.openPath(file);
        return err ? { ok: false, error: err, file } : { ok: true, mode, file };
      }
      shell.showItemInFolder(file);
      return { ok: true, mode: 'reveal', file };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err), file };
    }
  });
}

module.exports = { registerUpdater, isNewer, pickAsset };
