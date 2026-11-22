// Google Drive: keep your design library in a DabbleCAD folder in your own Google Drive.
//
// Designs are always saved in this browser first (as before), so the editor never waits on
// the network. When you're signed in, a sync step keeps that local library and the Drive folder
// the same: changed designs are uploaded, designs saved on another computer are pulled in,
// and deletes and renames go both ways. Anything that can't reach Drive right now (offline, or
// sign-in expired) waits, marked "not synced yet", until it can.
//
// The app asks only for access to files it creates itself (the drive.file scope), so it can't
// see anything else in your Drive. In the browser, sign-in uses Google Identity Services, which
// gives a short-lived token; there's no server. In the desktop app, the main process signs in
// through the system browser and keeps a refresh token (electron/googleauth.js), so it stays
// signed in; Drive requests go through it too.
import { GOOGLE_CLIENT_ID, GOOGLE_DESKTOP_CLIENT_ID, GOOGLE_DESKTOP_CLIENT_SECRET } from './config.js';

const native = typeof window !== 'undefined' && window.dabbleNative && window.dabbleNative.driveSignIn ? window.dabbleNative : null;
/** Desktop app: sign-in and Drive requests go through the main process. */
export const desktopDrive = !!native;

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = 'DabbleCAD';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_MIME = 'application/json';
const FILE_FIELDS = 'id,name,modifiedTime,appProperties';
const KEY = {
  linked: 'dabble.drive.linked', // signed in on this browser (stays across reloads)
  state: 'dabble.drive.state', // per design: { driveId, remoteTime, dirty, rev }
  tombs: 'dabble.drive.tombstones', // Drive files to move to the bin (deleted here while offline)
  folder: 'dabble.drive.folder',
  sets: 'dabble.drive.sets', // folders of one-file-per-item JSON (slicer presets): { path: { key: { driveId, updated, name } } }
  clientId: 'dabble.drive.clientId',
  desktopClient: 'dabble.drive.desktopClient', // { id, secret } pasted in Settings (desktop)
  who: 'dabble.drive.who', // { email, name } of the signed-in account
  token: 'dabble.drive.token', // in sessionStorage only: survives a reload, not a closed tab
};

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const desktopClient = () => {
  const own = ls.get(KEY.desktopClient, null) || {};
  return { clientId: GOOGLE_DESKTOP_CLIENT_ID || own.id || '', clientSecret: GOOGLE_DESKTOP_CLIENT_SECRET || own.secret || '' };
};
/** The OAuth client ID in use ('' = Drive not set up). The desktop app also needs its secret. */
export const clientId = () => {
  if (native) { const c = desktopClient(); return c.clientId && c.clientSecret ? c.clientId : ''; }
  return GOOGLE_CLIENT_ID || ls.get(KEY.clientId, '') || '';
};
/** Is the client built in (config / build), so Settings needn't ask for it? */
export const builtInClient = () => (native ? !!(GOOGLE_DESKTOP_CLIENT_ID && GOOGLE_DESKTOP_CLIENT_SECRET) : !!GOOGLE_CLIENT_ID);
export const pastedClient = () => (native ? { ...{ id: '', secret: '' }, ...(ls.get(KEY.desktopClient, null) || {}) } : { id: ls.get(KEY.clientId, ''), secret: '' });
export const setClientId = (id, secret = '') => {
  if (native) { if (id && id.trim()) ls.set(KEY.desktopClient, { id: id.trim(), secret: (secret || '').trim() }); else ls.del(KEY.desktopClient); return; }
  if (id && id.trim()) ls.set(KEY.clientId, id.trim()); else ls.del(KEY.clientId);
  tokenClient = null;
};
export const isLinked = () => !!clientId() && !!ls.get(KEY.linked, false);
export const account = () => ls.get(KEY.who, null);

// ------------------------------------------------------------------ status
let status = { state: 'off', message: '' };
const emit = () => window.dispatchEvent(new CustomEvent('dabble-drive', { detail: getStatus() }));
function setStatus(state, message = '') { status = { state, message }; emit(); }
/** { state: off | signedOut | reconnect | offline | syncing | synced | error, pending, message } */
export function getStatus() {
  const st = loadState();
  const pending = Object.values(st).filter((s) => s.dirty).length + ls.get(KEY.tombs, []).length;
  return { ...status, pending, account: account() };
}

// ------------------------------------------------------------------ sign-in (Google Identity Services)
let gis = null, tokenClient = null, token = null, tokenExp = 0, waiting = null;
try {
  const t = JSON.parse(sessionStorage.getItem(KEY.token) || 'null');
  if (t && t.exp > Date.now()) { token = t.token; tokenExp = t.exp; }
} catch { /* no session storage */ }
const hasToken = () => !!token && Date.now() < tokenExp;

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (!gis) {
    gis = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gis = null; reject(new Error("Couldn't reach Google sign-in")); };
      document.head.append(s);
    });
  }
  return gis;
}

/** Ask Google for an access token. Must be called from a click (it may open a popup). */
const keepToken = (r) => {
  token = r.access_token;
  tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
  try { sessionStorage.setItem(KEY.token, JSON.stringify({ token, exp: tokenExp })); } catch { /* ignore */ }
};

/** Desktop: a new access token from the stored sign-in, with no window. Returns why not, or ''. */
async function silentToken() {
  if (!native) return 'browser';
  const r = await native.driveToken(desktopClient());
  if (r && r.access_token) { keepToken(r); return ''; }
  return (r && r.error) || 'failed';
}

async function requestToken(prompt) {
  if (native) {
    // the system browser opens Google's sign-in page; the app waits for it to come back
    const who = account();
    keepToken(await native.driveSignIn({ ...desktopClient(), loginHint: who && who.email }));
    return;
  }
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: (r) => {
        const w = waiting; waiting = null;
        if (!w) return;
        if (r.error) { w.reject(new Error(r.error_description || r.error)); return; }
        token = r.access_token;
        tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
        try { sessionStorage.setItem(KEY.token, JSON.stringify({ token, exp: tokenExp })); } catch { /* ignore */ }
        w.resolve();
      },
      error_callback: (e) => { const w = waiting; waiting = null; if (w) w.reject(new Error(e && e.type === 'popup_closed' ? 'Sign-in was closed' : 'Sign-in failed')); },
    });
  }
  return new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    const who = account();
    tokenClient.requestAccessToken({ prompt, ...(who && who.email ? { login_hint: who.email } : {}) });
  });
}

// ------------------------------------------------------------------ Drive REST
class DriveError extends Error {
  constructor(msg, statusCode) { super(msg); this.status = statusCode; this.auth = statusCode === 401; }
}

async function call(url, { method = 'GET', json, body, headers = {}, text = false } = {}) {
  if (!hasToken()) throw new DriveError('Not signed in', 401);
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  };
  let res;
  if (native) {
    // desktop: the page is a local file, which Google's servers won't answer; the main process asks instead
    const r = await native.driveFetch(url, init);
    res = { status: r.status, ok: r.ok, json: async () => JSON.parse(r.text), text: async () => r.text };
  } else {
    res = await fetch(url, init);
  }
  if (res.status === 401) { token = null; try { sessionStorage.removeItem(KEY.token); } catch { /* ignore */ } }
  if (!res.ok) {
    let msg = `Google Drive error ${res.status}`;
    try { const e = await res.json(); if (e.error && e.error.message) msg = e.error.message; } catch { /* not JSON */ }
    throw new DriveError(msg, res.status);
  }
  if (res.status === 204) return null;
  return text ? res.text() : res.json();
}

const q = (s) => encodeURIComponent(s);

async function listAll(query) {
  const out = [];
  let page = '';
  do {
    const r = await call(`${API}/files?q=${q(query)}&spaces=drive&pageSize=1000&fields=${q(`nextPageToken,files(${FILE_FIELDS})`)}${page ? `&pageToken=${q(page)}` : ''}`);
    out.push(...(r.files || []));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}

/** The DabbleCAD folder: { id, created } (created: it had to be made just now). */
async function ensureFolder() {
  const cached = ls.get(KEY.folder, null);
  if (cached) {
    try {
      const f = await call(`${API}/files/${cached}?fields=id,trashed`);
      if (f && !f.trashed) return { id: cached, created: false };
    } catch (e) { if (e.auth) throw e; }
  }
  const found = await listAll(`mimeType='${FOLDER_MIME}' and name='${FOLDER_NAME}' and trashed=false and appProperties has { key='dabbleRoot' and value='1' }`);
  if (found.length) { ls.set(KEY.folder, found[0].id); return { id: found[0].id, created: false }; }
  const f = await call(`${API}/files?fields=id`, { method: 'POST', json: { name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { dabbleRoot: '1' } } });
  ls.set(KEY.folder, f.id);
  return { id: f.id, created: true };
}

/** Create (no id) or update a design file, content and details together. */
async function upload({ id, name, content, appProperties, parent, thumb, mimeType = FILE_MIME }) {
  const meta = { name, mimeType, appProperties };
  if (!id) meta.parents = [parent];
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(thumb || '');
  // Drive shows this preview in its own file list; it is base64url without padding
  if (m && m[2].length < 1.9e6) meta.contentHints = { thumbnail: { mimeType: m[1], image: m[2].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } };
  const boundary = 'dabble' + Math.random().toString(36).slice(2);
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
    + `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`;
  const url = id ? `${UPLOAD}/files/${id}?uploadType=multipart&fields=${q(FILE_FIELDS)}` : `${UPLOAD}/files?uploadType=multipart&fields=${q(FILE_FIELDS)}`;
  return call(url, { method: id ? 'PATCH' : 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } });
}

// ------------------------------------------------------------------ local sync state
const loadState = () => ls.get(KEY.state, {});
function patchState(id, patch) {
  const st = loadState();
  if (patch === null) delete st[id]; else st[id] = { ...(st[id] || {}), ...patch };
  ls.set(KEY.state, st);
}
const fileName = (name) => `${(name || 'Untitled').replace(/[\\/:*?"<>|]/g, '_')}.dabble`;
/** The file on Drive is a normal .dabble design with its thumbnail added (ignored when opened). */
const withThumb = (json, thumb) => { if (!thumb) return json; try { return JSON.stringify({ ...JSON.parse(json), thumb }); } catch { return json; } };

// ------------------------------------------------------------------ the sync engine
let local = null; // the browser library's own functions (localStorage), before wrapping
let running = null, again = false, timer = null, lastPull = 0;

/** Sync soon (several saves in a row go up together). */
function soon(ms = 3000) { clearTimeout(timer); timer = setTimeout(() => syncNow(), ms); }

/** Run a sync now (or once more after the one in progress). */
export function syncNow() {
  if (running) { again = true; return running; }
  running = (async () => {
    try { do { again = false; await syncOnce(); } while (again); } finally { running = null; }
  })();
  return running;
}

async function syncOnce() {
  if (!local) return;
  if (!clientId()) { setStatus('off'); return; }
  if (!isLinked()) { setStatus('signedOut'); return; }
  if (!navigator.onLine) { setStatus('offline'); return; }
  if (!hasToken() && native) {
    const why = await silentToken(); // desktop stays signed in: just get a new token
    if (why === 'offline') { setStatus('offline'); return; }
    if (why) { setStatus('reconnect'); return; }
  }
  if (!hasToken()) { setStatus('reconnect'); return; }
  setStatus('syncing');
  const changed = [];
  try {
    const folder = await ensureFolder();
    // 1. designs deleted here: move their Drive files to the bin (recoverable there)
    for (const fid of ls.get(KEY.tombs, [])) {
      try { await call(`${API}/files/${fid}?fields=id`, { method: 'PATCH', json: { trashed: true } }); } catch (e) { if (e.status !== 404) throw e; }
      ls.set(KEY.tombs, ls.get(KEY.tombs, []).filter((x) => x !== fid));
    }
    // 2. pull: designs added or changed on Drive (by another computer)
    const remote = await listAll(`'${folder.id}' in parents and trashed=false`);
    const localList = await local.list();
    const localMeta = new Map(localList.map((m) => [m.id, m]));
    const seen = new Set();
    for (const f of remote) {
      const id = f.appProperties && f.appProperties.dabbleId;
      if (!id) continue;
      seen.add(id);
      const s = loadState()[id] || {};
      if (s.driveId && s.driveId !== f.id) continue; // another copy of the same design: keep the one we know
      const lm = localMeta.get(id);
      const remoteChanged = s.remoteTime !== f.modifiedTime;
      const remoteNewer = Number(f.appProperties.modified || 0) > Number((lm && lm.modified) || 0);
      if (!lm || (remoteChanged && (!s.dirty || remoteNewer))) { await pull(f, id); changed.push(id); } // the newer edit wins
      else if (!s.driveId) patchState(id, { driveId: f.id, remoteTime: f.modifiedTime });
    }
    // 3. designs deleted on Drive: delete them here too, unless they've changed here since.
    //    Never on a folder that was just made, or an empty list: that's a lost folder, not deletes.
    const trustDeletes = !folder.created && remote.length > 0;
    for (const [id, s] of Object.entries(loadState())) {
      if (!s.driveId || seen.has(id)) continue;
      if (s.dirty || !trustDeletes) patchState(id, { driveId: undefined, remoteTime: undefined, dirty: true });
      else { await local.del(id); patchState(id, null); changed.push(id); }
    }
    // 4. push: designs changed here
    for (const [id, s] of Object.entries(loadState())) if (s.dirty) await push(id, folder.id);
    await syncExtras(folder.id, remote);
    for (const [path, adapter] of sets) await syncSet(folder, path, adapter);
    lastPull = Date.now();
    setStatus('synced');
  } catch (e) {
    console.warn('Google Drive sync:', e);
    if (e.auth) setStatus('reconnect');
    else if (!navigator.onLine) setStatus('offline');
    else setStatus('error', e.message);
  }
  if (changed.length) window.dispatchEvent(new CustomEvent('dabble-designs-changed', { detail: { ids: changed } }));
}

// ------------------------------------------------------------------ extra synced files
// Other parts of the app (the slicer's presets) keep one JSON file each in the DabbleCAD folder.
// read/merge are theirs: merge(remoteText | null) applies what's on Drive and returns what Drive should hold.
const extras = new Map();
export function registerSyncFile(name, merge) { extras.set(name, merge); if (isLinked()) soon(500); }
/** Something in a registered file changed here: sync it soon. */
export function syncFileChanged() { if (isLinked()) soon(); }

async function syncExtras(folderId, remote) {
  for (const [name, merge] of extras) {
    const f = remote.find((r) => r.name === name && !(r.appProperties && r.appProperties.dabbleId));
    const text = f ? await call(`${API}/files/${f.id}?alt=media`, { text: true }) : null;
    const next = merge(text);
    if (next === false) { if (f) await call(`${API}/files/${f.id}?fields=id`, { method: 'PATCH', json: { trashed: true } }); continue; }  // retired file
    if (next == null || next === text) continue;
    try { await upload({ id: f && f.id, name, content: next, appProperties: { dabbleFile: name }, parent: folderId }); } catch (e) {
      if (e.status !== 404 || !f) throw e;
      await upload({ name, content: next, appProperties: { dabbleFile: name }, parent: folderId });
    }
  }
}

// ------------------------------------------------------------------ folders of named JSON files
// A part of the app can keep a set of items (e.g. the slicer's printer presets) as one readable JSON
// file per item in a sub folder such as DabbleCAD/Slicer presets/Printer. The adapter:
//   items()            -> [{ key, name, updated, content }]   what is here now
//   tombstones()       -> { key: time }                       items deleted here (their files go to the bin)
//   apply(key, text)   -> true if it took the Drive version   a file that is new or newer on Drive
//   remove(key)                                               the file was deleted on Drive
const sets = new Map();
const subfolders = new Map();   // 'parentId/name' -> folder id (this session)
const madeFolders = new Set();  // sub folders this session had to create (empty because they're new)
export function registerSyncFolder(path, adapter) { sets.set(path.join('/'), { path, ...adapter }); if (isLinked()) soon(500); }

async function subfolder(parentId, name) {
  const k = parentId + '/' + name;
  if (subfolders.has(k)) return subfolders.get(k);
  const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const found = await listAll(`mimeType='${FOLDER_MIME}' and name='${esc}' and '${parentId}' in parents and trashed=false`);
  const id = found.length ? found[0].id : (await call(`${API}/files?fields=id`, { method: 'POST', json: { name, mimeType: FOLDER_MIME, parents: [parentId] } })).id;
  subfolders.set(k, id);
  if (!found.length) madeFolders.add(id);
  return id;
}
const jsonName = (name) => `${String(name || 'Untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled'}.json`;

async function syncSet(root, key, a) {
  let folderId = root.id;
  for (const part of a.path) folderId = await subfolder(folderId, part);
  const all = ls.get(KEY.sets, {});
  const state = all[key] || {};
  const save = () => { const x = ls.get(KEY.sets, {}); x[key] = state; ls.set(KEY.sets, x); };
  const trash = async (id) => { try { await call(`${API}/files/${id}?fields=id`, { method: 'PATCH', json: { trashed: true } }); } catch (e) { if (e.status !== 404) throw e; } };
  let remote;
  try { remote = await listAll(`'${folderId}' in parents and trashed=false`); } catch (e) {
    if (e.status === 404) { subfolders.clear(); return; }  // the folder went away: found or made again next time
    throw e;
  }
  const tombs = a.tombstones();
  // 1. deleted here: to the bin on Drive
  for (const f of remote) {
    const k = f.appProperties && f.appProperties.dabbleKey;
    if (k && tombs[k] && tombs[k] >= Number(f.appProperties.updated || 0)) { await trash(f.id); delete state[k]; f.gone = true; }
  }
  // 2. new or changed on Drive (another computer): take it when it is newer than ours
  const items = new Map(a.items().map((it) => [it.key, it]));
  const seen = new Set();
  for (const f of remote) {
    const k = f.appProperties && f.appProperties.dabbleKey;
    if (f.gone || !k || seen.has(k)) continue;
    seen.add(k);
    const upd = Number(f.appProperties.updated || 0), here = items.get(k);
    if (!here || upd > (here.updated || 0)) {
      const text = await call(`${API}/files/${f.id}?alt=media`, { text: true });
      if (a.apply(k, text)) state[k] = { driveId: f.id, updated: upd, name: f.name };
    } else if (!state[k] || state[k].driveId !== f.id) state[k] = { driveId: f.id, updated: Math.min(upd, here.updated || 0), name: f.name };
  }
  // 3. gone from Drive (deleted there): delete here too, unless it changed here since. Never when the
  //    folder had to be made again (a lost folder, not deletions).
  const trustDeletes = !root.created && !madeFolders.has(folderId);
  for (const k of Object.keys(state)) {
    if (seen.has(k)) continue;
    const here = items.get(k);
    if (here && (here.updated || 0) > (state[k].updated || 0)) { delete state[k]; continue; }   // re-upload below
    if (here && trustDeletes) a.remove(k);
    delete state[k];
  }
  // 4. new or changed here: upload, one named file each
  for (const it of a.items()) {
    const s = state[it.key];
    const name = jsonName(it.name);
    if (s && s.driveId && (s.updated || 0) >= (it.updated || 0) && s.name === name) continue;
    const meta = { name, content: it.content, appProperties: { dabbleKey: it.key, updated: String(it.updated || 0) }, parent: folderId, mimeType: 'application/json' };
    let f;
    try { f = await upload({ ...meta, id: s && s.driveId }); } catch (e) { if (e.status !== 404 || !s) throw e; f = await upload(meta); }
    state[it.key] = { driveId: f.id, updated: it.updated || 0, name };
  }
  madeFolders.delete(folderId);
  save();
}

async function pull(f, id) {
  const text = await call(`${API}/files/${f.id}?alt=media`, { text: true });
  const obj = JSON.parse(text);
  const thumb = typeof obj.thumb === 'string' ? obj.thumb : '';
  delete obj.thumb;
  const meta = {
    name: obj.name || f.name.replace(/\.dabble$/i, ''),
    modified: Number(f.appProperties.modified) || Date.parse(f.modifiedTime) || Date.now(),
    thumb,
    ...(f.appProperties.shapes ? { shapes: Number(f.appProperties.shapes) } : {}),
  };
  const ok = await local.save(id, JSON.stringify(obj), meta);
  if (ok === false) {
    // browser storage is full: list it anyway; it is fetched from Drive when opened
    const list = ls.get('dabble.designs', []).filter((m) => m.id !== id);
    list.push({ ...meta, thumb: '', id, onDriveOnly: true });
    ls.set('dabble.designs', list);
  }
  patchState(id, { driveId: f.id, remoteTime: f.modifiedTime, dirty: false });
}

async function push(id, folderId) {
  const meta = (await local.list()).find((m) => m.id === id);
  if (!meta) { patchState(id, null); return; }
  const json = await local.load(id);
  if (json == null) return;
  const s = loadState()[id] || {};
  const rev = s.rev || 0;
  const args = {
    id: s.driveId, name: fileName(meta.name), content: withThumb(json, meta.thumb), parent: folderId, thumb: meta.thumb,
    appProperties: { dabbleId: id, modified: String(meta.modified || Date.now()), ...(meta.shapes != null ? { shapes: String(meta.shapes) } : {}) },
  };
  let f;
  try { f = await upload(args); } catch (e) {
    if (e.status !== 404 || !args.id) throw e;
    f = await upload({ ...args, id: undefined }); // its file was removed from Drive: make a new one
  }
  // saved again while uploading? then it stays marked, for the next round
  const now = loadState()[id] || {};
  patchState(id, { driveId: f.id, remoteTime: f.modifiedTime, dirty: (now.rev || 0) !== rev });
}

// ------------------------------------------------------------------ account actions (from clicks)
export async function signIn() {
  if (!clientId()) throw new Error('Google Drive is not set up (no client ID)');
  await requestToken(isLinked() ? '' : 'consent');
  let who = null;
  try { const a = await call(`${API}/about?fields=${q('user(displayName,emailAddress)')}`); who = { email: a.user.emailAddress, name: a.user.displayName }; } catch { /* optional */ }
  const before = account();
  if (who && before && before.email !== who.email) {
    // a different Google account: its Drive knows nothing of these designs; they stay here, unsynced
    ls.del(KEY.state); ls.del(KEY.tombs); ls.del(KEY.folder); ls.del(KEY.sets); subfolders.clear();
  }
  if (who) ls.set(KEY.who, who);
  ls.set(KEY.linked, true);
  emit();
  await syncNow();
}

export async function reconnect() {
  if (native && !(await silentToken())) { await syncNow(); return; }
  await requestToken('');
  await syncNow();
}

/** Tests: act as if the access token ran out. */
export function _forgetToken() { token = null; tokenExp = 0; try { sessionStorage.removeItem(KEY.token); } catch { /* ignore */ } }

/** Stop syncing here. Designs stay here and on Drive. */
export function signOut() {
  if (native) native.driveSignOut().catch(() => {}); // forgets and revokes the stored sign-in
  try { if (token && window.google && window.google.accounts) window.google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
  token = null; tokenExp = 0;
  try { sessionStorage.removeItem(KEY.token); } catch { /* ignore */ }
  ls.del(KEY.linked);
  setStatus('signedOut');
}

/** Put every design in this browser on Drive (those already there are kept up to date). */
export async function copyAllToDrive() {
  for (const m of await local.list()) markDirty(m.id);
  await syncNow();
}

/** Where a design stands: 'synced', 'pending' (waiting to upload) or 'local' (not on Drive). */
export function designSync(id) {
  if (!isLinked()) return null;
  const s = loadState()[id];
  if (!s) return 'local';
  return s.dirty ? 'pending' : 'synced';
}

function markDirty(id) {
  const s = loadState()[id] || {};
  patchState(id, { dirty: true, rev: (s.rev || 0) + 1 });
}

// ------------------------------------------------------------------ hooking into the browser library
/**
 * Wrap the browser design library so every save, rename and delete is also synced. The local
 * library stays the one the app reads from; Drive is kept in step behind it.
 */
export function installDrive(platform) {
  if (local) return;
  local = {
    list: platform.listDesigns, load: platform.loadDesign, save: platform.saveDesign,
    patch: platform.patchDesignMeta, del: platform.deleteDesign,
  };
  platform.saveDesign = async (id, json, meta) => {
    const ok = await local.save(id, json, meta);
    if (ok !== false && isLinked()) { markDirty(id); emit(); soon(); }
    return ok;
  };
  platform.patchDesignMeta = async (id, patch) => {
    const ok = await local.patch(id, patch);
    if (isLinked() && loadState()[id] && ('name' in patch || 'thumb' in patch)) { markDirty(id); soon(); }
    return ok;
  };
  platform.deleteDesign = async (id) => {
    const s = loadState()[id];
    const ok = await local.del(id);
    if (s) {
      if (s.driveId) ls.set(KEY.tombs, [...ls.get(KEY.tombs, []), s.driveId]);
      patchState(id, null);
      if (isLinked()) soon(500);
    }
    return ok;
  };
  platform.loadDesign = async (id) => {
    const text = await local.load(id);
    if (text != null) return text;
    // listed but not stored here (browser storage was full): fetch it from Drive
    const s = loadState()[id];
    if (!s || !s.driveId || !hasToken()) return text;
    const obj = JSON.parse(await call(`${API}/files/${s.driveId}?alt=media`, { text: true }));
    delete obj.thumb;
    return JSON.stringify(obj);
  };
  platform.listDesigns = async () => {
    // looking at the library is a good moment to pick up changes from other computers
    if (isLinked() && hasToken() && !running && Date.now() - lastPull > 30000) soon(50);
    return (await local.list()).map((m) => ({ ...m, sync: designSync(m.id) }));
  };
  window.addEventListener('online', () => { if (isLinked()) syncNow(); });
  if (!clientId()) setStatus('off');
  else if (!isLinked()) setStatus('signedOut');
  else syncNow(); // reports 'reconnect' if the sign-in from last time has run out
}
