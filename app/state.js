// Persisted user settings.
//
// Defaults come from the schema, so a new setting needs no change here. Values
// are stored whole, and anything unrecognised (an older or newer build) simply
// falls back to its default rather than breaking the app.

import { DEFAULTS } from './settings-schema.js';
import { api } from './platform.js';

const KEY = 'tgviewer.settings';

// Not user settings, but they belong in the same store.
const INTERNAL = {
  sidebarWidth: 320,
  lastChat: null,
  importedTheme: null,   // { name, vars, mode, wallpaper }
  customWallpaper: null, // uploaded background: a URL, or the image itself on the web
  peerColors: {},        // participant id -> colour override
};

// Remembered in this browser only, never written into the settings file.
// Which chat was open last changes on every click; saving that would mark
// the file "unsaved" in Safari the moment anyone read a message.
const LOCAL_ONLY = new Set(['lastChat']);

const BASE = { ...DEFAULTS, ...INTERNAL };

function read() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...BASE, ...stored };
  } catch {
    return { ...BASE };
  }
}

let settings = read();
const listeners = new Set();

export const get = (key) => settings[key];
export const all = () => ({ ...settings });
export const defaults = () => ({ ...BASE });

function notify(keys) {
  for (const key of keys) {
    for (const fn of listeners) fn(key, settings[key]);
  }
}

/**
 * Take on a full set of settings without saving them anywhere -- they came
 * from somewhere already (the settings file, or this browser's copy of it).
 */
export function adopt(values) {
  if (!values || typeof values !== 'object') return;
  const lastChat = settings.lastChat;
  settings = { ...BASE, ...values };
  if (!('lastChat' in values)) settings.lastChat = lastChat;
  persistLocal();
  notify(Object.keys(BASE));
}

/**
 * Load settings from where they are really kept.
 *
 * localStorage alone was not durable enough: Safari deletes script-writable
 * storage for a site untouched for seven days, and 127.0.0.1 counts as a
 * site. The downloadable app keeps them in data/config.json and the website
 * in your settings file; localStorage stays as a same-tick cache so nothing
 * has to wait before the first paint.
 */
export async function hydrate() {
  try {
    const info = await api.config();
    const stored = info?.config?.settings;
    if (stored && typeof stored === 'object' && Object.keys(stored).length) adopt(stored);
  } catch {
    // Nothing to load from: the localStorage copy still works.
  }
}

function persistLocal() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or a full quota: the session still works, it just won't
    // survive a reload.
  }
}

let pending = 0;
function persist() {
  persistLocal();
  // Coalesced: dragging a slider must not become one save per pixel.
  clearTimeout(pending);
  pending = setTimeout(() => {
    const lasting = Object.fromEntries(
      Object.entries(settings).filter(([key]) => !LOCAL_ONLY.has(key)));
    api.save({ settings: lasting }).catch(() => {});
  }, 400);
}

export function set(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  if (LOCAL_ONLY.has(key)) persistLocal();
  else persist();
  for (const fn of listeners) fn(key, value);
}

/** Apply many values at once, notifying once per changed key. */
export function merge(values) {
  const changed = [];
  for (const [key, value] of Object.entries(values)) {
    if (settings[key] === value) continue;
    settings[key] = value;
    changed.push(key);
  }
  if (!changed.length) return;
  persist();
  notify(changed);
}

export function reset() {
  settings = { ...BASE };
  persist();
  notify(Object.keys(BASE));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
