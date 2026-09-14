// Reading the generated index. The viewer never touches a raw export.

const INDEX = 'data/index';

const cache = new Map();

async function getJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(path).then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      return res.json();
    }).catch((err) => {
      // A failed fetch must not poison the cache for later retries.
      cache.delete(path);
      throw err;
    }));
  }
  return cache.get(path);
}

export const loadManifest = () => getJSON(`${INDEX}/manifest.json`);
export const loadMeta = (slug) => getJSON(`${INDEX}/chats/${slug}/meta.json`);
export const loadMedia = (slug) => getJSON(`${INDEX}/chats/${slug}/media.json`);

export const loadChunk = (slug, n) =>
  getJSON(`${INDEX}/chats/${slug}/chunk-${String(n).padStart(4, '0')}.json`);

/**
 * Backup-root-relative path -> a URL the read-only server will answer.
 * Each segment is encoded separately so the spaces and parentheses in names
 * like `sticker (12).webp` survive, while the slashes stay real slashes.
 */
export function mediaURL(rel) {
  if (!rel) return '';
  return `media/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** Which chunk holds a message id, using the ranges in meta.json. */
export function chunkForMessage(meta, id) {
  const found = meta.chunks.find((c) => id >= c.first_id && id <= c.last_id);
  return found ? found.n : null;
}

/** Which chunk covers a moment in time. */
export function chunkForDate(meta, unix) {
  for (const chunk of meta.chunks) {
    if (unix <= chunk.last_date) return chunk.n;
  }
  return meta.chunks.length ? meta.chunks[meta.chunks.length - 1].n : null;
}
