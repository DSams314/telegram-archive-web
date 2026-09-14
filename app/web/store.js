// The browser's own storage for Telegram Archive, on this device only.
//
// Three things live here and nothing else:
//
//   index   the chat index -- rebuildable from your folder at any time
//   meta    the folder you chose, a cached copy of your settings, bookkeeping
//   log     the diagnostic log: events and counts, never message contents
//
// None of it is ever sent anywhere. "Forget this folder" in Settings deletes
// the whole database.

const DB_NAME = 'telegram-archive';
const DB_VERSION = 1;
const LOG_LIMIT = 4000;

let opening = null;

export function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['index', 'meta']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      if (!db.objectStoreNames.contains('log')) {
        db.createObjectStore('log', { autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
    request.onblocked = () => reject(new Error('Telegram Archive is open in another window'));
  });
  return opening;
}

function finished(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(store, mode, work) {
  const db = await open();
  const transaction = db.transaction(store, mode);
  const result = await work(transaction.objectStore(store));
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('storage aborted'));
  });
  return result;
}

export const get = (store, key) =>
  run(store, 'readonly', (s) => finished(s.get(key)));

export const put = (store, key, value) =>
  run(store, 'readwrite', (s) => finished(s.put(value, key)));

export const remove = (store, key) =>
  run(store, 'readwrite', (s) => finished(s.delete(key)));

export const clear = (store) =>
  run(store, 'readwrite', (s) => finished(s.clear()));

/** Many writes in one transaction -- far faster than one each. */
export const putMany = (store, entries) =>
  run(store, 'readwrite', async (s) => {
    for (const [key, value] of entries) s.put(value, key);
  });

export async function appendLog(records) {
  await run('log', 'readwrite', async (s) => {
    for (const record of records) s.add(record);
  });
  // Trim from the front once it gets long; the recent past is what matters.
  const total = await run('log', 'readonly', (s) => finished(s.count()));
  if (total > LOG_LIMIT) {
    await run('log', 'readwrite', (s) => new Promise((resolve) => {
      let excess = total - LOG_LIMIT;
      const cursor = s.openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at || excess <= 0) { resolve(); return; }
        at.delete();
        excess -= 1;
        at.continue();
      };
      cursor.onerror = () => resolve();
    }));
  }
}

export const readLog = () => run('log', 'readonly', (s) => finished(s.getAll()));

/** Remove everything this site has stored in this browser. */
export async function destroy() {
  const db = await open().catch(() => null);
  db?.close();
  opening = null;
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
}
