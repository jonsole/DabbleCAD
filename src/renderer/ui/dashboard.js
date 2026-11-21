// Design library: thumbnails of every saved design, like a home screen.
import { h, clear, button, icon, popupMenu, confirmDialog, toast } from './dom.js';
import { platform, isDesktop } from '../platform.js';
import * as drive from '../drive.js';

/** Label, icon and tooltip for the Google Drive button, from the sync status. */
function driveLabel(st) {
  const n = st.pending;
  const waiting = n ? `${n} not synced` : '';
  switch (st.state) {
    case 'signedOut': return { label: 'Sign in to Google Drive', icon: 'cloud', title: 'Keep your designs in a DabbleCAD folder in your Google Drive' };
    case 'reconnect': return { label: n ? `Reconnect Drive · ${waiting}` : 'Reconnect Drive', icon: 'cloudOff', title: 'Google sign-in has run out; click to carry on syncing' };
    case 'offline': return { label: n ? `Offline · ${waiting}` : 'Drive: offline', icon: 'cloudOff', title: 'Changes are saved here and upload when you are back online' };
    case 'syncing': return { label: 'Syncing…', icon: 'cloud', title: 'Syncing with Google Drive' };
    case 'error': return { label: n ? `Drive problem · ${waiting}` : 'Drive problem', icon: 'cloudOff', title: st.message || 'Google Drive sync failed' };
    default: return n
      ? { label: waiting, icon: 'cloud', title: 'Waiting to upload to Google Drive' }
      : { label: 'Drive: up to date', icon: 'cloudCheck', title: 'Your designs are in Google Drive' + (st.account ? ` (${st.account.email})` : '') };
  }
}

export async function driveAction(fn) {
  try { await fn(); } catch (e) { console.warn(e); toast(e.message || 'Google Drive failed'); }
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export class Dashboard {
  constructor(app) {
    this.app = app;
    this.grid = h('div', { class: 'dash-grid' });
    this.closeBtn = button({ label: 'Back to design', icon: 'chevronRight', cls: 'btn-outline', onClick: () => this.hide() });
    this.driveBtn = button({ label: 'Google Drive', icon: 'cloud', cls: 'btn-outline drive-btn', onClick: () => this.driveMenu() });

    this.el = h('div', { class: 'dashboard' },
      h('div', { class: 'dash-head' },
        h('div', { class: 'logo', style: { cursor: 'default' } }, app.logoMark(), h('span', { class: 'logo-name' }, 'DabbleCAD')),
        h('span', { class: 'spacer' }),
        this.driveBtn,
        button({ label: 'Open file…', icon: 'folder', cls: 'btn-outline', title: 'Open a .dabble file from disk', onClick: () => app.openFile() }),
        isDesktop ? button({ label: 'Library folder', cls: 'btn-outline', onClick: () => platform.openDesignsFolder() }) : null,
        this.closeBtn),
      h('div', { class: 'dash-body' }, h('h2', { class: 'dash-title' }, 'Your designs'), this.grid));
    document.body.append(this.el);
    this.updateDrive();
    window.addEventListener('dabble-drive', () => this.updateDrive());
    window.addEventListener('dabble-designs-changed', () => { if (this.isOpen) this.refresh(); });
  }

  updateDrive() {
    const b = this.driveBtn;
    if (!b) return;
    const st = drive.getStatus();
    b.style.display = st.state === 'off' ? 'none' : '';
    const d = driveLabel(st);
    b.replaceChildren(icon(d.icon), h('span', { class: 'btn-label' }, d.label));
    b.title = d.title;
    b.setAttribute('aria-label', d.label);
    b.classList.toggle('warn', ['reconnect', 'error'].includes(st.state));
    if (this.isOpen && this._lastPending !== st.pending) { this._lastPending = st.pending; this.refresh(); }
  }

  driveMenu() {
    const st = drive.getStatus();
    if (st.state === 'signedOut') { driveAction(() => drive.signIn()); return; }
    if (st.state === 'reconnect') { driveAction(() => drive.reconnect()); return; }
    popupMenu([
      st.account ? { label: st.account.email, icon: 'cloud', disabled: true } : null,
      { label: 'Sync now', icon: 'cloud', onClick: () => driveAction(() => drive.syncNow()) },
      { label: 'Copy my designs to Drive', icon: 'arrowUp', onClick: () => driveAction(async () => { await drive.copyAllToDrive(); toast('Designs copied to Google Drive'); }) },
      'sep',
      { label: 'Sign out of Google Drive', icon: 'cloudOff', onClick: async () => {
        if (await confirmDialog('Sign out of Google Drive', 'Your designs stay in this browser and in your Drive; they just stop syncing here.', 'Sign out')) drive.signOut();
      } },
    ], this.driveBtn);
  }

  get isOpen() { return this.el.classList.contains('open'); }

  async show() {
    if (!(await this.app.confirmLeave())) return false;
    this.el.classList.add('open');
    await this.refresh();
    return true;
  }

  hide() { this.el.classList.remove('open'); }

  async refresh() {
    const list = await platform.listDesigns();
    clear(this.grid);
    const create = h('div', { class: 'dash-card dash-new' }, icon('plus', 34), 'Create new design');
    create.addEventListener('click', async () => { if (await this.app.newDesign()) this.hide(); });
    this.grid.append(create);
    for (const meta of list) {
      const more = button({ icon: 'list', title: 'More', cls: 'btn-ghost', onClick: (e) => {
        e.stopPropagation();
        popupMenu([
          { label: 'Open', icon: 'pencil', onClick: () => open() },
          { label: 'Duplicate', icon: 'duplicate', onClick: async () => { await this.app.duplicateDesign(meta.id); this.refresh(); } },
          { label: 'Rename', icon: 'pencil', onClick: async () => {
            const name = await this.app.prompt('Rename design', 'Name', meta.name);
            if (name) { await this.app.renameDesign(meta.id, name); this.refresh(); }
          } },
          'sep',
          { label: 'Delete', icon: 'trash', onClick: async () => {
            if (await confirmDialog('Delete design', `“${meta.name}” will be permanently deleted.`, 'Delete', true)) {
              if (await this.app.deleteDesign(meta.id)) this.refresh();
            }
          } },
        ], more);
      } });
      const open = async () => { if (await this.app.openDesign(meta.id)) this.hide(); };
      const card = h('div', { class: 'dash-card' + (meta.id === this.app.designId ? ' current' : '') },
        h('div', { class: 'dash-thumb', style: meta.thumb ? { backgroundImage: `url(${meta.thumb})` } : {} }),
        meta.sync === 'pending' || meta.sync === 'local'
          ? h('span', { class: 'dash-sync', title: meta.sync === 'pending' ? 'Not synced to Google Drive yet' : 'Only in this browser (use "Copy my designs to Drive")' }, icon('cloudOff', 16))
          : null,
        h('div', { class: 'dash-meta' }, h('div', {}, h('b', {}, meta.name || 'Untitled'), h('small', {}, `${ago(meta.modified)}${meta.shapes != null ? ' · ' + meta.shapes + ' shapes' : ''}`)), more));
      card.addEventListener('click', open);
      this.grid.append(card);
    }
  }
}
