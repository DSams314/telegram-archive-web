// Your settings, identity and chosen pictures -- one file you own:
// telegram-archive-config.json, in your Telegram Archive folder.
//
// Where the browser allows it (Chrome, Edge), every change is saved into that
// file automatically. Where it doesn't (Safari, Firefox, Brave), changes are
// kept in this browser and marked unsaved until you press Save, which hands
// you the file to put back in your folder. Closing the tab with unsaved
// changes asks first.

import * as store from './store.js';
import * as folder from './folder.js';

export const FORMAT = 1;
const AUTOSAVE_MS = 400;
const CACHE_KEY = 'config';

let data = blank();
let savedCanonical = canonical(data);   // what the folder (or the last download) holds
let touched = 0;
let state = 'clean';                    // clean | dirty | saving
let problem = null;                     // why the last save failed, if it did
let timer = 0;
let leaving = false;
const listeners = new Set();

export function blank() {
  return {
    app: 'telegram-archive',
    format: FORMAT,
    saved_at: null,
    setup_complete: false,
    self: { id: null, name: null },
    settings: {},
    avatars: {},
  };
}

const text = (value) => (typeof value === 'string' && value ? value : null);
const isImage = (value) => typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(value);

/**
 * Read a config file, keeping only what Telegram Archive knows.
 *
 * The file is yours and could have been edited by hand, so nothing in it is
 * trusted blindly: pictures must be embedded images, never links to anywhere,
 * and anything unrecognised is dropped rather than applied.
 */
export function parse(source) {
  const raw = JSON.parse(source);
  if (!raw || typeof raw !== 'object' || raw.app !== 'telegram-archive') {
    throw new Error("That isn't a Telegram Archive settings file.");
  }
  const out = blank();
  out.saved_at = text(raw.saved_at);
  out.setup_complete = raw.setup_complete === true;
  if (raw.self && typeof raw.self === 'object') {
    out.self.id = text(raw.self.id);
    out.self.name = text(raw.self.name);
  }
  if (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
    out.settings = { ...raw.settings };
    if (out.settings.customWallpaper != null && !isImage(out.settings.customWallpaper)) {
      delete out.settings.customWallpaper;
    }
  }
  if (raw.avatars && typeof raw.avatars === 'object') {
    for (const [key, value] of Object.entries(raw.avatars)) {
      if (isImage(value)) out.avatars[key] = value;
    }
  }
  return out;
}

function canonical(value) {
  return JSON.stringify({ ...value, saved_at: null });
}

const serialize = (value) => JSON.stringify(value, null, 2);

function emit() {
  for (const fn of listeners) fn(status());
}

// ---- reading and changing ----------------------------------------------------

export const get = () => data;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isDirty() {
  return canonical(data) !== savedCanonical;
}

/** Everything the save indicator needs to know. */
export function status() {
  return {
    state,
    dirty: isDirty(),
    autosave: folder.savableLayout(),
    problem,
    savedAt: data.saved_at,
  };
}

/**
 * Pick up where this browser and the folder left off. Whichever copy was
 * changed most recently wins -- so settings changed in Safari, saved, but
 * never moved back into the folder are not silently thrown away.
 */
export async function load() {
  const name = folder.active()?.name ?? null;
  const cached = await store.get('meta', CACHE_KEY).catch(() => null);
  const mine = cached && cached.folder === name ? cached : null;

  let disk = null;
  const fileText = await folder.readConfigFile();
  if (fileText) {
    try { disk = parse(fileText); } catch { disk = null; }
  }

  if (disk && (!mine || Date.parse(disk.saved_at ?? 0) >= (mine.touched ?? 0))) {
    data = disk;
    savedCanonical = canonical(disk);
    touched = Date.parse(disk.saved_at ?? 0) || 0;
  } else if (mine) {
    data = mine.data;
    savedCanonical = mine.savedCanonical;
    touched = mine.touched ?? 0;
  } else {
    data = blank();
    savedCanonical = canonical(data);
  }
  state = isDirty() ? 'dirty' : 'clean';
  emit();
  return data;
}

/** The settings this browser last had, before a folder is open. */
export async function cachedSettings() {
  const cached = await store.get('meta', CACHE_KEY).catch(() => null);
  return cached?.data?.settings ?? null;
}

async function cache() {
  await store.put('meta', CACHE_KEY, {
    folder: folder.active()?.name ?? null,
    data,
    savedCanonical,
    touched,
  }).catch(() => {});
}

/** Change the config. Saves itself where it can; is marked unsaved where not. */
export function update(change) {
  change(data);
  touched = Date.now();
  cache();
  clearTimeout(timer);
  if (folder.savableLayout()) {
    timer = setTimeout(() => { save({ auto: true }).catch(() => {}); }, AUTOSAVE_MS);
  }
  state = isDirty() ? 'dirty' : 'clean';
  emit();
}

// ---- saving -------------------------------------------------------------------

/**
 * Save the config.
 *
 * Into the folder where the browser allows it; otherwise as a download of
 * the same file, for putting back into the folder by hand.
 */
export async function save({ auto = false } = {}) {
  clearTimeout(timer);
  const stamp = new Date().toISOString();

  if (folder.savableLayout()) {
    state = 'saving';
    emit();
    try {
      data.saved_at = stamp;
      await folder.writeConfigFile(serialize(data));
      savedCanonical = canonical(data);
      problem = null;
    } catch (error) {
      problem = error?.name === 'PermissionNeeded' ? 'permission' : (error?.message || 'unknown');
      state = 'dirty';
      await cache();
      emit();
      if (!auto) throw error;
      return false;
    }
    state = isDirty() ? 'dirty' : 'clean';
    await cache();
    emit();
    return true;
  }

  if (auto) return false;          // nothing to do without being asked
  data.saved_at = stamp;
  download(serialize(data));
  savedCanonical = canonical(data);
  state = 'clean';
  problem = null;
  await cache();
  emit();
  return true;
}

function download(contents) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  link.download = folder.CONFIG_NAME;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

/**
 * Reload on purpose -- after changing folder, rebuilding, resetting. Unsaved
 * changes are still kept in this browser across the reload, so there is
 * nothing to warn about.
 */
export function reloadWithoutPrompt() {
  leaving = true;
  location.reload();
}

/** Replace everything with a config file the user picked. */
export async function importFile(file) {
  data = parse(await file.text());
  touched = Date.now();
  savedCanonical = folder.savableLayout() ? '' : canonical(data);
  await cache();
  if (folder.savableLayout()) await save({ auto: true });
  state = isDirty() ? 'dirty' : 'clean';
  emit();
}

// ---- not losing changes --------------------------------------------------------

/**
 * Ask before the tab closes with changes that exist only in this browser.
 *
 * The browser writes the question itself -- usually "Leave site? Changes you
 * made may not be saved." -- and no page is allowed to change that wording.
 */
export function guardUnsaved() {
  window.addEventListener('beforeunload', (event) => {
    if (leaving || !isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  // A tab being hidden is often the last chance to finish a pending save.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && isDirty() && folder.savableLayout()) {
      save({ auto: true }).catch(() => {});
    }
  });
}
