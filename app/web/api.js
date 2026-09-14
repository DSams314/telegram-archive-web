// The web version's operations, in the same shape as the downloadable app's
// server requests -- so settings, setup and the profile panel work unchanged.
//
// Nothing here makes a network request. Settings go into your config file,
// pictures are embedded in it, the index is rebuilt in this browser, and the
// diagnostic report is handed to you as a download.

import * as config from './config.js';
import * as folder from './folder.js';
import * as indexing from './indexing.js';
import * as store from './store.js';

function shape() {
  const c = config.get();
  return {
    setup_complete: c.setup_complete,
    self: { ...c.self },
    settings: c.settings,
    backup_root: null,
  };
}

function toDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function download(name, contents, type) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([contents], { type }));
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

/**
 * Strip names out of the diagnostic log before it is handed over.
 *
 * The web version's log is written to hold counts and events rather than
 * paths or names in the first place; this is the second layer, for anything
 * that slipped into an error message.
 */
async function redactor() {
  const names = new Set();
  const active = folder.active();
  if (active?.name) names.add(active.name);
  const c = config.get();
  if (c.self.name) names.add(c.self.name);
  if (c.self.id) names.add(c.self.id);
  try {
    const manifest = JSON.parse(await store.get('index', 'manifest.json'));
    for (const chat of manifest.chats ?? []) {
      names.add(chat.name);
      names.add(chat.folder);
      for (const peer of chat.peers ?? []) {
        names.add(peer.name);
        names.add(peer.id);
      }
    }
  } catch { /* no index yet: nothing more to hide */ }

  const terms = [...names].filter((n) => typeof n === 'string' && n.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  return (text) => terms.reduce((out, re) => out.replace(re, (m) => `<name:${m.length}>`), text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/\buser\d{5,}\b/g, '<telegram-id>');
}

export const webApi = {
  async config() {
    const active = folder.active();
    return {
      config: shape(),
      resolved_root: active?.name ?? null,
      root_exists: Boolean(active),
      root_readable: Boolean(active),
      platform: 'web',
      volume: null,
      native_picker: false,
    };
  },

  async browse() {
    return { error: 'Not available in the browser version.' };
  },

  async save(body) {
    config.update((c) => {
      if ('setup_complete' in body) c.setup_complete = Boolean(body.setup_complete);
      if (body.self && typeof body.self === 'object') {
        for (const key of ['id', 'name']) {
          if (key in body.self) c.self[key] = body.self[key] || null;
        }
      }
      if (body.settings && typeof body.settings === 'object') {
        c.settings = { ...c.settings, ...body.settings };
      }
    });
    return { ok: true, config: shape() };
  },

  reindex() {
    return indexing.run({ selfId: config.get().self.id });
  },

  async avatar(key, blob) {
    const picture = await toDataURL(blob);
    config.update((c) => { c.avatars[key] = picture; });
    return { ok: true, url: `data/avatars/${encodeURIComponent(key)}.jpg` };
  },

  /** The background stays embedded in your settings, as the image itself. */
  async wallpaper(dataURL) {
    return dataURL;
  },

  async clearWallpaper() {},

  async diagnostics() {
    const records = await store.readLog().catch(() => []);
    const clean = await redactor();
    const lines = records.map((record) => clean(JSON.stringify(record)));
    const header = [
      'Telegram Archive diagnostics (web version)',
      `generated ${new Date().toISOString()}`,
      `${records.length} events`,
      '',
      'Folder, chat and contact names are replaced by <name:N> (N is the',
      'length), email addresses by <email>, Telegram IDs by <telegram-id>.',
      'This file was made in your browser and has not been sent anywhere.',
      '-'.repeat(62),
      '',
    ];
    const day = new Date().toISOString().slice(0, 10);
    download(`telegram-archive-diagnostics-${day}.txt`,
      `${header.concat(lines).join('\n')}\n`, 'text/plain');
    return { ok: true, downloaded: true };
  },

  /**
   * Make sure the settings are safe before carrying on. Called from a click,
   * so that the browser is willing to ask for permission to save.
   */
  async persist({ download = false } = {}) {
    if (!config.isDirty()) return { ok: true };
    if (folder.savableLayout()) {
      if (!(await folder.canSaveNow()) && !(await folder.allowSaving())) {
        return { ok: false, reason: 'permission' };
      }
      await config.save();
      return { ok: true };
    }
    if (download) {
      await config.save();
      return { ok: true, downloaded: true };
    }
    return { ok: false, reason: 'download' };
  },

  savesAutomatically: () => folder.savableLayout(),

  cancelIndex() {
    indexing.cancel();
  },
};
