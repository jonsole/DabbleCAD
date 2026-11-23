import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));

// the commit this build was made from (CI sets GITHUB_SHA; locally ask git), shown next to the app name
function git(cmd) { try { return execSync(`git ${cmd}`, { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } }
const sha = process.env.GITHUB_SHA || git('rev-parse HEAD');
const dirty = !process.env.GITHUB_SHA && !!git('status --porcelain --untracked-files=no -- src');
const build = {
  sha: sha || 'unknown',
  short: sha ? sha.slice(0, 7) + (dirty ? '+' : '') : 'dev',
  branch: process.env.GITHUB_REF_NAME || git('rev-parse --abbrev-ref HEAD'),
  date: new Date().toISOString(),
};

// The web version's MCP helper (Settings → AI connection) is the desktop app's server file, run on its own.
const HELPER = 'dabblecad-mcp.cjs';
const helperSource = () => fs.readFileSync(path.join(here, 'electron/mcpserver.js'), 'utf8');
const mcpHelper = {
  name: 'dabblecad-mcp-helper',
  configureServer(server) {
    server.middlewares.use('/' + HELPER, (_req, res) => { res.setHeader('Content-Type', 'application/javascript'); res.end(helperSource()); });
  },
  generateBundle() { this.emitFile({ type: 'asset', fileName: HELPER, source: helperSource() }); },
};

export default defineConfig({
  plugins: [mcpHelper],
  root: path.join(here, 'src/renderer'),
  base: './',
  // the web version shows the same version number as the desktop app
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(build) },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  server: { port: 5183, strictPort: true },
});
