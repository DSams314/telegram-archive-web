// Telegram Archive's service worker -- the web version only.
//
// A service worker sits between the page and the network and sees every
// request the page makes. This one uses that position for a single purpose:
// making sure nothing from your archive can ever leave your computer.
//
//   data/index/...     answered from this browser's own storage
//   media/...          answered from the folder you chose, through the page
//   data/avatars/...   answered from your settings file, through the page
//   the app itself     answered from a local copy, downloaded once from the
//                      website and replaced only when a new version is published
//
// Every other request is refused on the spot: anything to another website,
// anything that is not a plain read, and anything that is not one of the
// app's own published files. So no request -- even one made by mistake -- can
// carry something from your archive out to the website or anywhere else.
//
// VERSION is stamped in by tools/build_site.py, so publishing a new version
// changes this file, which is what tells browsers to fetch the update.

const VERSION = 'dev';
const CACHE = `ta-shell-${VERSION}`;
const SHELL_LIST = 'app-shell.json';

const scopePath = new URL(self.registration.scope).pathname;

// ---- install / update -------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const list = await (await fetch(SHELL_LIST, { cache: 'no-store' })).json();
    const cache = await caches.open(CACHE);
    await cache.addAll(list.files.map((file) => new Request(file, { cache: 'no-store' })));
    await cache.put(SHELL_LIST, new Response(JSON.stringify(list),
      { headers: { 'Content-Type': 'application/json' } }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('ta-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// A hard reload skips the service worker for that one page load. The page
// asks to be taken back under its wing rather than running uncovered.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'claim') event.waitUntil(self.clients.claim());
});

let shellFiles = null;
async function shell() {
  if (!shellFiles) {
    const cache = await caches.open(CACHE);
    const stored = await cache.match(SHELL_LIST);
    const list = stored ? await stored.json() : { files: [] };
    shellFiles = new Set(list.files);
  }
  return shellFiles;
}

// ---- routing ------------------------------------------------------------------

const refuse = (status = 404) => new Response(null, { status });

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Another website: refused outright. The page's security policy already
  // blocks these; this is the second lock on the same door.
  if (url.origin !== self.location.origin) {
    event.respondWith(Response.error());
    return;
  }
  if (request.method !== 'GET') {
    event.respondWith(refuse(405));
    return;
  }

  const path = url.pathname.startsWith(scopePath)
    ? decodeURIComponent(url.pathname.slice(scopePath.length))
    : null;
  if (path === null) {
    event.respondWith(refuse());
    return;
  }

  if (path.startsWith('data/index/')) {
    event.respondWith(fromIndex(path.slice('data/index/'.length)));
  } else if (path.startsWith('media/')) {
    event.respondWith(fromFolder(event, path.slice('media/'.length)));
  } else if (path.startsWith('data/avatars/')) {
    const key = path.slice('data/avatars/'.length).replace(/\.jpg$/, '');
    event.respondWith(fromSettings(event, key));
  } else if (path === 'site-config.json') {
    event.respondWith(latest(path));
  } else {
    event.respondWith(fromShell(request, path));
  }
});

// ---- the app's own files --------------------------------------------------------

async function fromShell(request, path) {
  const files = await shell();
  let file = path === '' ? 'index.html' : path;
  // A folder-style link (help/, and the root) means that folder's index page.
  // Without this, clicking "How to export" served the main app instead of the
  // guide -- the guide link looked broken.
  if (file.endsWith('/')) file += 'index.html';
  if (request.mode === 'navigate' && !files.has(file)) file = 'index.html';
  if (!files.has(file)) return refuse();

  const cache = await caches.open(CACHE);
  const hit = await cache.match(file);
  if (hit) return hit;
  // Only ever the exact published file, with no query string: a request can
  // never be made to carry data to the website inside its address.
  const response = await fetch(file, { cache: 'no-store' });
  if (response.ok) await cache.put(file, response.clone());
  return response;
}

/** The fund bar should show the latest total when online, the last one when not. */
async function latest(path) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(path, { cache: 'no-store' });
    if (response.ok) {
      await cache.put(path, response.clone());
      return response;
    }
  } catch { /* offline: fall back below */ }
  return (await cache.match(path)) ?? refuse();
}

// ---- the index, from this browser's storage ------------------------------------

function storedIndex(key) {
  return new Promise((resolve) => {
    const opening = indexedDB.open('telegram-archive', 1);
    opening.onupgradeneeded = () => {
      // Never create the database from here; the page owns its shape.
      opening.transaction.abort();
      resolve(null);
    };
    opening.onerror = () => resolve(null);
    opening.onsuccess = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains('index')) { db.close(); resolve(null); return; }
      const read = db.transaction('index', 'readonly').objectStore('index').get(key);
      read.onsuccess = () => { db.close(); resolve(read.result ?? null); };
      read.onerror = () => { db.close(); resolve(null); };
    };
  });
}

async function fromIndex(key) {
  const text = await storedIndex(key);
  if (text == null) return refuse();
  return new Response(text, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ---- your folder and settings, through the page -------------------------------

async function ask(event, message) {
  const client = (event.clientId && await self.clients.get(event.clientId))
    || (await self.clients.matchAll({ type: 'window' }))[0];
  if (!client) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 60000);
    channel.port1.onmessage = (reply) => {
      clearTimeout(timer);
      resolve(reply.data);
    };
    client.postMessage(message, [channel.port2]);
  });
}

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac',
  tgs: 'application/gzip', pdf: 'application/pdf', json: 'application/json',
  txt: 'text/plain',
};

function typeFor(name, file) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] || file.type || 'application/octet-stream';
}

/** A file, whole or in the byte range a video or audio player asks for. */
function respondWithFile(file, request, name) {
  const headers = {
    'Content-Type': typeFor(name, file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const size = file.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
  if (range) {
    let start = range[1] === '' ? null : Number(range[1]);
    let end = range[2] === '' ? null : Number(range[2]);
    if (start === null) {                // "the last N bytes"
      start = Math.max(0, size - (end ?? 0));
      end = size - 1;
    } else if (end === null || end >= size) {
      end = size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }
  return new Response(file, { headers: { ...headers, 'Content-Length': String(size) } });
}

async function fromFolder(event, rel) {
  const reply = await ask(event, { type: 'media', rel });
  if (!reply?.ok || !reply.file) return refuse();
  return respondWithFile(reply.file, event.request, rel);
}

async function fromSettings(event, key) {
  const reply = await ask(event, { type: 'avatar', key });
  if (!reply?.ok || !reply.blob) return refuse();
  return new Response(reply.blob, {
    headers: { 'Content-Type': reply.blob.type || 'image/jpeg', 'Cache-Control': 'no-store' },
  });
}
