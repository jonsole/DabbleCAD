// A fake Google (sign-in + the bits of the Drive API DabbleCAD uses) for the Drive smoke test.
// Start it, pass its address to the app as --fake-google=<url>, and it answers like Google.
const http = require('node:http');
const crypto = require('node:crypto');

function startFakeGoogle() {
  const files = new Map();
  let nextId = 1, refreshRevoked = false;
  const state = { signIns: 0, refreshes: 0, revoked: 0, challenge: null };
  const now = () => new Date().toISOString();
  const meta = (f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, appProperties: f.appProperties || {}, mimeType: f.mimeType });
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const p = url.pathname;
      // ---- sign-in
      if (p === '/o/oauth2/v2/auth') {
        state.challenge = url.searchParams.get('code_challenge');
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', 'code-1');
        back.searchParams.set('state', url.searchParams.get('state'));
        res.writeHead(302, { Location: back.toString() });
        res.end();
        return;
      }
      if (p === '/token') {
        const f = new URLSearchParams(raw);
        if (!f.get('client_id') || !f.get('client_secret')) return send(401, { error: 'invalid_client' });
        if (f.get('grant_type') === 'authorization_code') {
          const ok = f.get('code') === 'code-1' && b64url(crypto.createHash('sha256').update(f.get('code_verifier') || '').digest()) === state.challenge;
          if (!ok) return send(400, { error: 'invalid_grant' });
          state.signIns++;
          refreshRevoked = false;
          return send(200, { access_token: 'tok-' + Date.now(), expires_in: 3600, refresh_token: 'refresh-1' });
        }
        if (f.get('grant_type') === 'refresh_token') {
          if (refreshRevoked || f.get('refresh_token') !== 'refresh-1') return send(400, { error: 'invalid_grant' });
          state.refreshes++;
          return send(200, { access_token: 'tok-' + Date.now(), expires_in: 3600 });
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      if (p === '/revoke') { refreshRevoked = true; state.revoked++; return send(200, {}); }
      if (p === '/__state') return send(200, { ...state, files: [...files.values()].map((f) => ({ ...meta(f), parents: f.parents, trashed: f.trashed, content: f.content })) });
      // ---- Drive API
      if (!(req.headers.authorization || '').startsWith('Bearer tok-')) return send(401, { error: { message: 'Invalid credentials' } });
      if (p === '/drive/v3/about') return send(200, { user: { emailAddress: 'me@example.com', displayName: 'Me' } });
      const m = /^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/.exec(p);
      if (!m) return send(404, { error: { message: 'Not found' } });
      let fid = m[2];
      if (m[1]) {
        const boundary = /boundary=(\S+)/.exec(req.headers['content-type'])[1];
        const parts = raw.split('--' + boundary).filter((x) => x.trim() && x.trim() !== '--');
        const body = (part) => part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
        const md = JSON.parse(body(parts[0]));
        if (req.method === 'POST') { fid = 'f' + nextId++; files.set(fid, { id: fid, parents: md.parents, trashed: false }); delete md.parents; }
        const f = files.get(fid);
        if (!f || f.trashed) return send(404, { error: { message: 'File not found' } });
        Object.assign(f, md, { content: body(parts[1]), modifiedTime: now() });
        return send(200, meta(f));
      }
      if (fid) {
        const f = files.get(fid);
        if (!f) return send(404, { error: { message: 'File not found' } });
        if (req.method === 'PATCH') { Object.assign(f, JSON.parse(raw), { modifiedTime: now() }); return send(200, meta(f)); }
        if (url.searchParams.get('alt') === 'media') return send(200, f.content, 'application/json');
        return send(200, { ...meta(f), trashed: f.trashed });
      }
      if (req.method === 'POST') {
        const md = JSON.parse(raw);
        fid = 'f' + nextId++;
        files.set(fid, { ...md, id: fid, parents: md.parents || [], trashed: false, modifiedTime: now() });
        return send(200, { id: fid });
      }
      const q = url.searchParams.get('q') || '';
      let list;
      if (q.includes('google-apps.folder')) {
        const name = /name='((?:[^'\\]|\\.)*)'/.exec(q), parent = /'([^']+)' in parents/.exec(q);
        list = [...files.values()].filter((f) => (f.mimeType || '').endsWith('folder') && !f.trashed
          && (!name || f.name === name[1].replace(/\\(.)/g, '$1')) && (!parent || (f.parents || []).includes(parent[1])));
      } else {
        const parent = /'([^']+)' in parents/.exec(q)[1];
        list = [...files.values()].filter((f) => (f.parents || []).includes(parent) && !f.trashed);
      }
      return send(200, { files: list.map(meta) });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { startFakeGoogle };

// `node tools/fakegoogle.js <file>`: serve until killed, writing the address to <file>.
if (require.main === module) {
  startFakeGoogle().then(({ url }) => require('node:fs').writeFileSync(process.argv[2], url));
}
