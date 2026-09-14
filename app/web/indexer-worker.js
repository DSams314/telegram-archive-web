// Runs the indexer off the page's main thread.
//
// A large archive takes a while to read, and doing that on the page itself
// would freeze the loading screen -- no progress, no working Cancel button.
// In a worker the page stays responsive, and cancelling simply ends the
// worker. The index is written to this browser's own storage and nowhere else.

import { runIndex } from '../indexer/build.js';
import { ArchiveError } from '../indexer/discover.js';
import { FileListSource, HandleSource, PrefixedSource } from './sources.js';
import * as store from './store.js';

/** Writes the index into this browser's storage, many entries per transaction. */
class StoreSink {
  constructor() {
    this.buffer = [];
  }

  async begin() {
    // Clearing first means the old manifest is gone before anything new is
    // written. An interrupted run therefore leaves no manifest at all, and the
    // next visit rebuilds instead of reading half an index.
    await store.clear('index');
  }

  async put(path, value) {
    this.buffer.push([path, JSON.stringify(value)]);
    if (this.buffer.length >= 64) await this.flush();
  }

  async flush() {
    if (!this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];
    await store.putMany('index', batch);
  }

  async commit() {
    await this.flush();
  }
}

/** Something a person can act on, rather than an exception's own wording. */
function describe(error) {
  if (error instanceof ArchiveError) return error.message;
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Telegram Archive no longer has permission to read your folder. '
        + 'Open it again to continue.';
    case 'NotFoundError':
      return 'A file or folder disappeared while it was being read. If your '
        + 'archive is on a cloud or network drive, check that it is connected, '
        + 'then try again.';
    case 'NotReadableError':
      return 'A file in your folder could not be read. If it is on a cloud or '
        + 'network drive that is paused or offline, reconnect it and try again.';
    case 'QuotaExceededError':
      return 'This browser has run out of storage space for the index. Free up '
        + 'some disk space, then try again.';
    default:
      return error?.message || 'Indexing stopped unexpectedly.';
  }
}

function summarise(report) {
  const {
    chats, exports, messages, duplicates_merged: merged, media_total: media,
    media_missing: missing, media_excluded: excluded, warnings,
  } = report;
  return { chats, exports, messages, merged, media, missing, excluded, warnings: warnings.length };
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'index') return;
  const base = data.handle ? new HandleSource(data.handle) : new FileListSource(data.entries);
  const source = data.prefix ? new PrefixedSource(base, data.prefix) : base;
  const started = Date.now();

  try {
    const result = await runIndex({
      source,
      sink: new StoreSink(),
      selfId: data.selfId ?? null,
      onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
      onFile: (rel) => self.postMessage({ type: 'file', rel }),
    });
    self.postMessage({
      type: 'done',
      ok: true,
      chats: result.chats,
      selfId: result.selfId,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      report: summarise(result.report),
    });
  } catch (error) {
    self.postMessage({ type: 'done', ok: false, error: describe(error), kind: error?.name ?? null });
  }
};
