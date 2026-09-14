// Building the index in the web version: when to, and doing it.
//
// The index is rebuilt only when the folder's contents have changed since
// last time -- worked out from folder listings and file dates alone, so
// checking costs almost nothing and downloads nothing. The work itself runs
// in a worker (indexer-worker.js) so the loading screen stays live and
// Cancel always works.

import * as folder from './folder.js';
import * as store from './store.js';
import { discover } from '../indexer/discover.js';
import { SCHEMA_VERSION } from '../indexer/model.js';

// How long with no sign of progress before saying what it is waiting for.
// Reading from a paused cloud drive does not fail -- it just never finishes --
// so silence is the only symptom there is.
const STALL_AFTER_MS = 20000;

let current = null;
let presenter = null;

/** Where progress is shown: set once by the page (the loading screen). */
export function present(view) {
  presenter = view;
}

export const busy = () => current !== null;

/** A cheap summary of what is in the folder, to tell whether to re-index. */
export async function fingerprint() {
  const conversations = await discover(folder.active().exports);
  return JSON.stringify(conversations.map((c) => [
    c.rel,
    c.exports.map((e) => [e.rel, e.resultJson, e.htmlFiles.length, e.exportedAt]),
  ]));
}

/** Whether the stored index is complete, current, and for this folder. */
export async function isCurrent() {
  const manifest = await store.get('index', 'manifest.json').catch(() => null);
  if (!manifest) return false;
  try {
    if (JSON.parse(manifest).schema !== SCHEMA_VERSION) return false;
  } catch {
    return false;
  }
  const saved = await store.get('meta', 'fingerprint').catch(() => null);
  if (!saved || saved.folder !== folder.active()?.name) return false;
  return saved.value === await fingerprint().catch(() => null);
}

/**
 * Index the open folder. Resolves to { ok, error?, cancelled?, chats, selfId }.
 * Asking while a run is already going returns that run instead of a second.
 */
export function run({ selfId = null } = {}) {
  if (current) return current.promise;
  const active = folder.active();
  if (!active) return Promise.resolve({ ok: false, error: 'No folder is open.' });

  const worker = new Worker(new URL('./indexer-worker.js', import.meta.url), { type: 'module' });
  let lastActivity = Date.now();
  let lastFile = null;
  let stalled = false;
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });

  const watch = setInterval(() => {
    if (!stalled && Date.now() - lastActivity > STALL_AFTER_MS) {
      stalled = true;
      presenter?.stalled?.(lastFile);
    }
  }, 2000);

  const done = async (result) => {
    if (!current || current.promise !== promise) return;
    clearInterval(watch);
    worker.terminate();
    current = null;
    if (result.ok) {
      const value = await fingerprint().catch(() => null);
      await store.put('meta', 'fingerprint', { folder: active.name, value }).catch(() => {});
    }
    finish(result);
  };

  worker.onmessage = ({ data }) => {
    lastActivity = Date.now();
    if (stalled) {
      stalled = false;
      presenter?.stalled?.(null);
    }
    if (data.type === 'progress') presenter?.show?.({ running: true, ...data });
    else if (data.type === 'file') lastFile = data.rel;
    else if (data.type === 'done') done(data);
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    done({ ok: false, error: 'The indexer could not start in this browser.' });
  };

  const message = {
    type: 'index',
    prefix: active.layout === 'archive' ? folder.BACKUPS : '',
    selfId,
  };
  if (active.kind === 'handle') message.handle = active.handle;
  else message.entries = active.entries;

  current = {
    promise,
    cancel: () => done({ ok: false, cancelled: true, error: 'Indexing was cancelled.' }),
  };
  presenter?.show?.({ running: true, phase: 'starting', done: 0, total: 0 });
  worker.postMessage(message);
  return promise;
}

export function cancel() {
  current?.cancel();
}
