import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));

export default defineConfig({
  root: path.join(here, 'src/renderer'),
  base: './',
  // the web version shows the same version number as the desktop app
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  server: { port: 5183, strictPort: true },
});
