import { APP_NAME } from './brand.js';
import { App } from './app.js';
import * as shapes from './core/shapes.js';
import * as doc from './core/doc.js';
import * as geometry from './core/geometry.js';
import * as io from './core/io.js';
import * as solid from './core/solid.js';
import * as dialogs from './ui/dialogs.js';
import * as laserModel from './laser/model.js';
import * as laserGcode from './laser/gcode.js';
import * as laserOps from './laser/ops.js';
import * as laserIo from './laser/io.js';
import * as laserTools from './laser/tools.js';
import * as laserDepth from './laser/depthmap.js';
import * as laserBox from './laser/boxmaker.js';
import { platform } from './platform.js';
import * as drive from './drive.js';

// The app has its own right-click menus, so the browser's never shows, wherever the click
// lands: the app opens its menu as the button comes up, and on Windows the browser's
// 'contextmenu' event follows and lands on that menu rather than on the view. Text fields keep
// the browser menu for copy, paste and spelling.
const TEXT_INPUT = /^(text|search|email|url|tel|password|number)$/;
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  const field = t instanceof Element && t.closest('textarea, [contenteditable=""], [contenteditable="true"], input');
  if (field && (field.tagName !== 'INPUT' || TEXT_INPUT.test(field.type || 'text'))) return;
  e.preventDefault();
});

const app = new App();
// Handy for debugging and automated checks from DevTools (F12).
window.dabble = app;
window.dabbleLib = { platform, drive, shapes, doc, geometry, io, solid, dialogs, laser: { model: laserModel, gcode: laserGcode, ops: laserOps, io: laserIo, tools: laserTools, depthmap: laserDepth, boxmaker: laserBox } };
app.init().catch((err) => {
  console.error(err);
  const boot = document.getElementById('boot');
  if (!boot) return;
  const sub = boot.querySelector('.boot-sub');
  sub.textContent = `${APP_NAME} could not start: ` + (err && err.message ? err.message : err);
  // Most start-up failures are graphics related, so offer the software renderer.
  if (window.dabbleNative) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.style.marginTop = '14px';
    btn.textContent = 'Restart with software rendering';
    btn.onclick = async () => { await window.dabbleNative.setSettings({ gpu: 'off' }); window.dabbleNative.relaunch(); };
    boot.append(btn);
  }
});
