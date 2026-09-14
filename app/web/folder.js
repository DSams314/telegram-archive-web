// Everything that touches the folder you chose lives in this one file, so the
// complete list of what Telegram Archive can do to that folder is short enough
// to read in one sitting:
//
//   * list folders and read files -- to build the index and to show your media
//   * write ONE file, telegram-archive-config.json, at the top of the folder,
//     and only when that folder is a Telegram Archive folder (it has a Backups
//     folder inside it) -- never in among your exports
//   * create an empty Backups folder, and only when you press the button for it
//
// Nothing else. There is no delete, rename or move anywhere in the program,
// and tools/tests/test_web_safety.py fails if one ever appears.

import * as store from './store.js';
import { FileListSource, HandleSource, PrefixedSource } from './sources.js';

export const CONFIG_NAME = 'telegram-archive-config.json';
export const BACKUPS = 'Backups';

export class PermissionNeeded extends Error {
  constructor() {
    super('Telegram Archive needs your permission to save into this folder.');
    this.name = 'PermissionNeeded';
  }
}

let current = null;

/** The folder in use, or null. */
export const active = () => current;

/** Whether this browser can hand over a folder that can be reopened later. */
export const canUseHandles = () => typeof globalThis.showDirectoryPicker === 'function';

// ---- getting hold of a folder ------------------------------------------------

/** Chrome and Edge: the system folder picker, read-only to begin with. */
export async function pickWithHandle() {
  try {
    const handle = await globalThis.showDirectoryPicker({ id: 'telegram-archive', mode: 'read' });
    return { kind: 'handle', name: handle.name, handle };
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    throw error;
  }
}

/** Every other browser: a one-off folder upload field (nothing is uploaded). */
export function pickWithInput() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.addEventListener('change', () => resolve(fromFileList(input.files)), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

function fromFileList(files) {
  if (!files?.length) return null;
  const entries = [];
  let name = null;
  for (const file of files) {
    // "Telegram Archive/Backups/Robin/ChatExport_.../result.json"
    const path = file.webkitRelativePath || file.name;
    const slash = path.indexOf('/');
    if (slash < 0) continue;
    name ??= path.slice(0, slash);
    entries.push([path.slice(slash + 1), file]);
  }
  return entries.length ? { kind: 'files', name: name ?? 'folder', entries } : null;
}

/**
 * A folder dragged onto the page.
 *
 * Has to be called synchronously inside the drop event: the browser takes
 * the dragged items away the moment the handler returns, so the handle (or
 * entry) is grabbed first and only the waiting happens afterwards.
 */
export function fromDrop(dataTransfer) {
  const item = [...(dataTransfer?.items ?? [])].find((i) => i.kind === 'file');
  if (!item) return Promise.resolve(null);

  const pendingHandle = item.getAsFileSystemHandle?.();
  const entry = pendingHandle ? null : item.webkitGetAsEntry?.();

  return (async () => {
    if (pendingHandle) {
      const handle = await pendingHandle.catch(() => null);
      return handle?.kind === 'directory' ? { kind: 'handle', name: handle.name, handle } : null;
    }
    if (!entry?.isDirectory) return null;
    const entries = [];
    await walkEntry(entry, '', entries);
    return entries.length ? { kind: 'files', name: entry.name, entries } : null;
  })();
}

function readEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(all);
      else { all.push(...batch); next(); }
    }, reject);
    next();
  });
}

async function walkEntry(dir, prefix, out) {
  for (const child of await readEntries(dir.createReader())) {
    const rel = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory) await walkEntry(child, rel, out);
    else out.push([rel, await new Promise((resolve, reject) => child.file(resolve, reject))]);
  }
}

// ---- opening it --------------------------------------------------------------

/**
 * Work out what kind of folder this is:
 *
 *   archive   has a Backups folder inside -- the layout Telegram Archive uses,
 *             and the only one it will ever save its settings file into
 *   empty     nothing in it yet; a Backups folder can be made on request
 *   exports   the exports themselves; read, never written to
 */
async function describe(choice) {
  const root = choice.handle ? new HandleSource(choice.handle) : new FileListSource(choice.entries);
  const top = (await root.list('')) ?? [];
  const visible = top.filter((e) => !e.name.startsWith('.'));
  const hasBackups = visible.some((e) => e.kind === 'dir' && e.name === BACKUPS);
  const hasConfig = visible.some((e) => e.kind === 'file' && e.name === CONFIG_NAME);
  const others = visible.filter((e) => e.name !== CONFIG_NAME);

  let layout = 'exports';
  if (hasBackups) layout = 'archive';
  else if (!others.length) layout = 'empty';

  return {
    ...choice,
    root,
    exports: hasBackups ? new PrefixedSource(root, BACKUPS) : root,
    layout,
    hasConfig,
  };
}

export async function open(choice) {
  current = await describe(choice);
  if (current.kind === 'handle') await store.put('meta', 'folder', current.handle).catch(() => {});
  return current;
}

/** Re-read what is at the top of the folder, e.g. after exports were added. */
export async function refresh() {
  if (!current) return null;
  current = await describe(current);
  return current;
}

/** The folder handle kept from a previous visit (Chrome and Edge only). */
export async function recall() {
  if (!canUseHandles()) return null;
  return store.get('meta', 'folder').catch(() => null);
}

export async function permission(handle, mode = 'read') {
  try { return await handle.queryPermission({ mode }); } catch { return 'denied'; }
}

/** Must run inside a click: browsers only ask in response to one. */
export async function askPermission(handle, mode = 'read') {
  try { return await handle.requestPermission({ mode }); } catch { return 'denied'; }
}

// ---- the only two changes Telegram Archive can make ---------------------------

/** Whether this folder is one Telegram Archive is allowed to save into at all. */
export const savableLayout = () => current?.kind === 'handle' && current.layout === 'archive';

export async function canSaveNow() {
  return savableLayout() && (await permission(current.handle, 'readwrite')) === 'granted';
}

/** Ask to be allowed to save. Must run inside a click. */
export async function allowSaving() {
  if (!savableLayout()) return false;
  return (await askPermission(current.handle, 'readwrite')) === 'granted';
}

/**
 * THE write. The single place in the whole program that changes a file.
 *
 * Always telegram-archive-config.json, always at the top of the folder, and
 * only in an archive-shaped folder. The browser writes to a temporary copy
 * and swaps it in on close(), so an interrupted save never leaves half a file.
 */
export async function writeConfigFile(text) {
  if (!savableLayout()) throw new Error('This folder is read-only for Telegram Archive.');
  if ((await permission(current.handle, 'readwrite')) !== 'granted') throw new PermissionNeeded();
  const handle = await current.handle.getFileHandle(CONFIG_NAME, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  }
  current.hasConfig = true;
}

/** The other change: an empty Backups folder, when asked for. Must run in a click. */
export async function createBackupsFolder() {
  if (current?.kind !== 'handle' || current.layout !== 'empty') return false;
  if ((await askPermission(current.handle, 'readwrite')) !== 'granted') return false;
  await current.handle.getDirectoryHandle(BACKUPS, { create: true });
  await refresh();
  return true;
}

// ---- reading -------------------------------------------------------------------

export async function readConfigFile() {
  if (!current?.hasConfig) return null;
  try { return await current.root.text(CONFIG_NAME); } catch { return null; }
}

/** A media file, for display. Its path is relative to the exports folder. */
export function mediaFile(rel) {
  if (!current) return Promise.reject(new Error('no folder open'));
  return current.exports.file(rel);
}

/** Close the folder and remove everything this browser kept about it. */
export async function forget() {
  current = null;
  await store.destroy();
}
