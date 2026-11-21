// Google sign-in for the desktop app (Google Drive storage).
//
// Google doesn't allow sign-in inside an app's own windows, and the browser-style sign-in the
// web version uses needs a web address. Desktop apps use "OAuth for installed apps" instead:
// the system browser opens Google's sign-in page, and Google sends the answer back to a
// one-off web server on 127.0.0.1 here (loopback redirect, with PKCE). We keep the refresh
// token, encrypted with the system keychain (safeStorage), so the app stays signed in; access
// tokens only live in memory. The only permission asked for is drive.file: files this app made.
//
// Drive requests from the renderer also go through here (driveFetch), because the app's page
// is loaded from a file and Google's servers don't answer cross-origin requests from files.
const { safeStorage, shell, net, app } = require('electron');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SIGNIN_TIMEOUT = 5 * 60 * 1000;

// Test runs point these at a fake Google (see tools/smoke-drive.js).
const ENDPOINTS = { auth: AUTH_URL, token: TOKEN_URL, revoke: REVOKE_URL, api: 'https://www.googleapis.com/' };

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const store = () => path.join(app.getPath('userData'), 'google-auth.bin');

let refreshToken = null; // decrypted, in memory
let memoryOnly = false; // no keychain: stay signed in until the app closes
let pending = null; // a sign-in in progress

function loadRefresh() {
  if (refreshToken || ENDPOINTS.headless) return refreshToken; // tests never touch the keychain
  try {
    const raw = fs.readFileSync(store());
    if (safeStorage.isEncryptionAvailable()) refreshToken = safeStorage.decryptString(raw);
  } catch { /* none stored */ }
  return refreshToken;
}

function saveRefresh(tok) {
  refreshToken = tok;
  memoryOnly = ENDPOINTS.headless || !safeStorage.isEncryptionAvailable();
  if (memoryOnly) return; // never written to disk unencrypted
  try { fs.writeFileSync(store(), safeStorage.encryptString(tok), { mode: 0o600 }); } catch { /* keep it in memory */ }
}

function forget() {
  refreshToken = null;
  try { fs.unlinkSync(store()); } catch { /* already gone */ }
}

async function postForm(url, fields) {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, data };
}

const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui,sans-serif;background:#16181d;color:#e7eaf0;display:grid;place-items:center;height:90vh;margin:0">
<div style="text-align:center"><h2 style="margin:0 0 8px">${title}</h2><p style="color:#98a2b3">${text}</p></div></body>`;

/** Open Google's sign-in page in the system browser and wait for the answer. */
function signIn({ clientId, clientSecret, loginHint }, focusApp) {
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let redirect = '';
    let timer = null;
    const finish = (err, value) => {
      clearTimeout(timer);
      server.close();
      pending = null;
      if (focusApp) focusApp();
      if (err) reject(err); else resolve(value);
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirect);
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (url.searchParams.get('state') !== state || (!code && !error)) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Sign-in failed', 'Please try again from DabbleCAD.'));
        return;
      }
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Sign-in cancelled', 'You can close this tab and return to DabbleCAD.'));
        finish(new Error(error === 'access_denied' ? 'Sign-in was cancelled' : `Google sign-in failed (${error})`));
        return;
      }
      try {
        const r = await postForm(ENDPOINTS.token, {
          code, client_id: clientId, client_secret: clientSecret || '', redirect_uri: redirect,
          grant_type: 'authorization_code', code_verifier: verifier,
        });
        if (!r.ok || !r.data.access_token) throw new Error(r.data.error_description || r.data.error || `Google sign-in failed (${r.status})`);
        if (r.data.refresh_token) saveRefresh(r.data.refresh_token);
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Signed in to Google Drive', 'You can close this tab and return to DabbleCAD.'));
        finish(null, { access_token: r.data.access_token, expires_in: r.data.expires_in, persistent: !memoryOnly });
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Sign-in failed', String(e.message || e)));
        finish(e);
      }
    });
    server.on('error', (e) => finish(e));
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}/`;
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
        code_challenge: challenge, code_challenge_method: 'S256', state,
        access_type: 'offline', prompt: 'consent', ...(loginHint ? { login_hint: loginHint } : {}),
      });
      timer = setTimeout(() => finish(new Error('Sign-in timed out')), SIGNIN_TIMEOUT);
      const authUrl = `${ENDPOINTS.auth}?${q}`;
      // tests: a fake Google answers straight away, so "the browser" is just a request
      if (ENDPOINTS.headless) net.fetch(authUrl).catch(() => {});
      else shell.openExternal(authUrl).catch((e) => finish(e));
    });
  });
  return pending;
}

/** A fresh access token from the stored sign-in, without any window. */
async function token({ clientId, clientSecret }) {
  const rt = loadRefresh();
  if (!rt) return { error: 'signed_out' };
  try {
    const r = await postForm(ENDPOINTS.token, { refresh_token: rt, client_id: clientId, client_secret: clientSecret || '', grant_type: 'refresh_token' });
    if (r.ok && r.data.access_token) return { access_token: r.data.access_token, expires_in: r.data.expires_in, persistent: !memoryOnly };
    if (r.data.error === 'invalid_grant') { forget(); return { error: 'signed_out' }; } // revoked or expired
    return { error: 'failed', message: r.data.error_description || `Google error ${r.status}` };
  } catch (e) {
    return { error: 'offline', message: String(e.message || e) };
  }
}

async function signOut() {
  const rt = loadRefresh();
  forget();
  if (rt) { try { await postForm(ENDPOINTS.revoke, { token: rt }); } catch { /* offline: it stays valid until Google expires it */ } }
  return true;
}

/** A Drive API request on the renderer's behalf (only to the Drive API). */
async function driveFetch(url, opts = {}) {
  const API = 'https://www.googleapis.com/';
  if (typeof url !== 'string' || !url.startsWith(API)) throw new Error('Only Google Drive requests are allowed');
  const res = await net.fetch(ENDPOINTS.api + url.slice(API.length), { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

function registerGoogleAuth(ipcMain, getWindow, overrides = null) {
  if (overrides) Object.assign(ENDPOINTS, overrides);
  const focusApp = () => { const w = getWindow(); if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } };
  ipcMain.handle('gdrive:signin', (_e, cfg) => signIn(cfg || {}, focusApp));
  ipcMain.handle('gdrive:token', (_e, cfg) => token(cfg || {}));
  ipcMain.handle('gdrive:signout', () => signOut());
  ipcMain.handle('gdrive:fetch', (_e, url, opts) => driveFetch(url, opts));
  ipcMain.handle('gdrive:has-signin', () => !!loadRefresh());
}

module.exports = { registerGoogleAuth };
