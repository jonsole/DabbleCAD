// Run the existing suites offline against development Electron or a packaged app.
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const appArg = process.argv.slice(2).find((arg) => arg.startsWith('--app='));
const packaged = process.argv.includes('--packaged') || !!appArg;
let executable;
if (appArg) {
  executable = path.resolve(appArg.slice('--app='.length));
} else if (!packaged) {
  executable = require('electron');
} else if (process.platform === 'win32') {
  executable = path.join(root, 'release', version, 'win-unpacked', 'DabbleCAD Plus.exe');
} else if (process.platform === 'darwin') {
  executable = path.join(root, 'release', version, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'DabbleCAD Plus.app', 'Contents', 'MacOS', 'DabbleCAD Plus');
} else if (process.platform === 'linux') {
  executable = path.join(root, 'release', version, 'linux-unpacked', 'dabblecad-plus');
} else {
  throw new Error('Packaged smoke tests currently support Windows, macOS, and Linux only');
}
if (!fs.existsSync(executable)) throw new Error('Build the app first; executable not found: ' + executable);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'dabblecad-test-shots-'));
const suites = ['smoke3.js', 'smoke-laser.js', 'smoke-depth.js', 'smoke6.js', 'smoke-save.js', 'smoke-drive.js'];
// The Drive suite talks to a fake Google on 127.0.0.1 instead of running offline.
const fakeFile = path.join(shots, 'fake-google.txt');
const fake = spawn(process.execPath, [path.join(__dirname, 'fakegoogle.js'), fakeFile], { stdio: 'ignore' });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < 100 && !fs.existsSync(fakeFile); i++) sleep(50);
const fakeUrl = fs.existsSync(fakeFile) ? fs.readFileSync(fakeFile, 'utf8') : '';
// Windows and Linux test on software rendering (Linux needs a display, such as
// xvfb-run on a headless machine). Macs have no software WebGL, so they
// test on the GPU (hosted Apple Silicon runners have one; hosted Intel runners do not).
let modes = process.platform === 'darwin' ? [[]] : [['--software']];
let failed = false;
try {
  for (const suite of suites) {
    const network = suite === 'smoke-drive.js' ? ['--fake-google=' + fakeUrl] : ['--offline'];
    console.log('\n=== ' + suite + (packaged ? ' (packaged, ' : ' (') + (suite === 'smoke-drive.js' ? 'fake Google)' : 'offline)') + ' ===');
    let result, line;
    for (const mode of modes) {
      if (modes.length > 1) console.log('[render mode] ' + (mode.join(' ') || 'gpu'));
      const args = [...(packaged ? [] : [root]), '--smoke=' + path.join(__dirname, suite), '--shots=' + shots, ...mode, ...network];
      result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      line = (result.stdout || '').split(/\r?\n/).find((text) => text.startsWith('[smoke result] '));
      const ok = !result.error && result.status === 0 && line;
      if (ok || mode === modes[modes.length - 1]) { if (ok) modes = [mode]; break; }
      console.log('[render mode] unavailable, trying the next one');
    }
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) console.error(result.error);
    if (result.error || result.status !== 0 || !line) {
      console.error(suite + ' did not complete successfully');
      failed = true;
      continue;
    }
    const report = JSON.parse(line.slice('[smoke result] '.length));
    if (!Array.isArray(report.fails) || report.fails.length) {
      console.error(suite + ' reported failed or missing assertions', report);
      failed = true;
    }
  }
} finally {
  fake.kill();
  fs.rmSync(shots, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
