// fetch_page: read a public web page as text. Used for models without their own web tools (local
// models, or Anthropic with Web access off). The desktop app fetches the page in its main process,
// which refuses anything on this computer or the local network; browsers can't read other sites.

import { ToolError } from './tools.js';

const native = typeof window !== 'undefined' ? window.dabbleNative || null : null;
export const pageFetchAvailable = !!(native && native.aiWebFetch);

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'LI', 'UL', 'OL', 'TR', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'BR', 'HR', 'CAPTION']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME', 'TEMPLATE', 'NAV', 'FOOTER', 'FORM', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'ASIDE']);

/** Readable text from HTML: headings marked with #, list items with -, table cells split by |. */
export function htmlToText(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = (doc.querySelector('title') && doc.querySelector('title').textContent.trim()) || '';
  const root = doc.querySelector('main, article, [role=main]') || doc.body;
  const out = [];
  const links = [];
  const walk = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { out.push(n.nodeValue.replace(/\s+/g, ' ')); continue; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName) || n.hidden || n.getAttribute('aria-hidden') === 'true') continue;
      const t = n.tagName;
      if (BLOCK.has(t)) out.push('\n');
      if (/^H[1-6]$/.test(t)) out.push('#'.repeat(+t[1]) + ' ');
      if (t === 'LI') out.push('- ');
      if (t === 'TD' || t === 'TH') out.push(' | ');
      if (t === 'IMG' && n.getAttribute('alt')) out.push(`[image: ${n.getAttribute('alt')}]`);
      walk(n);
      if (t === 'A' && n.getAttribute('href') && links.length < 60) {
        try { const u = new URL(n.getAttribute('href'), baseUrl); if (/^https?:/.test(u.protocol) && n.textContent.trim()) links.push({ text: n.textContent.trim().slice(0, 80), url: u.toString() }); } catch { /* bad link */ }
      }
      if (BLOCK.has(t)) out.push('\n');
    }
  };
  if (root) walk(root);
  const text = out.join('').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim())).join('\n').trim();
  return { title, text, links };
}

export const FETCH_PAGE = {
  name: 'fetch_page',
  kind: 'read',
  description: 'Read a public web page (or plain text / JSON) as text, e.g. a datasheet or a page with a part\'s dimensions. Long pages come in parts: use offset to read on. Pages on the local network can\'t be read.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['url'],
    properties: {
      url: { type: 'string', description: 'The http(s) address.', minLength: 8, maxLength: 2000 },
      offset: { type: 'integer', minimum: 0, description: 'Character to start from (for long pages).' },
      max_chars: { type: 'integer', minimum: 1000, maximum: 60000, description: 'How much to return (default 20000).' },
      links: { type: 'boolean', description: 'Also list the page\'s links.' },
    },
  },
  run: async (_ctx, i) => {
    if (!pageFetchAvailable) throw new ToolError('Reading web pages needs the desktop app.');
    if (!/^https?:\/\//i.test(i.url)) throw new ToolError('Give a full http(s) address.');
    const r = await native.aiWebFetch(i.url);
    if (r.error) throw new ToolError(`Couldn't read the page: ${r.error}`);
    if (r.status >= 400) throw new ToolError(`The site answered ${r.status}.`);
    const ct = (r.contentType || '').toLowerCase();
    let title = '', text, links = [];
    if (/html|xml/.test(ct) || /^\s*</.test(r.body)) ({ title, text, links } = htmlToText(r.body, r.url));
    else if (/^text\/|json/.test(ct) || !ct) text = r.body;
    else throw new ToolError(`That is a ${ct.split(';')[0]} file, not a page that can be read as text.`);
    const off = i.offset || 0, max = i.max_chars || 20000;
    const part = text.slice(off, off + max);
    return {
      url: r.url, title, length: text.length, offset: off, text: part,
      ...(off + max < text.length ? { more: `There is more: read on with offset ${off + max}.` } : {}),
      ...(r.truncated ? { note: 'The page was very large; only its start was read.' } : {}),
      ...(i.links ? { links } : {}),
    };
  },
};
