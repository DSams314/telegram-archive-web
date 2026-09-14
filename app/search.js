// Querying the inverted index.
//
// Shards are keyed by a token's first two characters, so a query touches only
// the few kilobytes it actually needs rather than the whole index. Postings are
// a flat int array with stride 3 — chat index, message id, day number — which
// is what lets results be ordered newest-first without opening a single chunk.
// Message text is fetched only for the page being displayed.

import { loadChunk, loadMeta } from './api.js';
import { plainText } from './message.js';

const INDEX = 'data/index';
const MIN_TOKEN_LEN = 2;
const PAGE = 30;

const shardCache = new Map();
let shardList = null;

const tokenize = (text) =>
  (text.toLowerCase().match(/[^\W_]+/gu) ?? []).filter((t) => t.length >= MIN_TOKEN_LEN);

async function loadShardList() {
  shardList ??= fetch(`${INDEX}/search/shards.json`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return shardList;
}

function shardName(token) {
  // Hex-encoded UTF-8 of the first two characters, matching the indexer.
  const bytes = new TextEncoder().encode(token.slice(0, 2));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadShard(token) {
  const name = shardName(token);
  if (!shardCache.has(name)) {
    const shards = await loadShardList();
    if (!shards.includes(name)) {
      shardCache.set(name, Promise.resolve({}));
    } else {
      shardCache.set(
        name,
        fetch(`${INDEX}/search/${name}.json`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})),
      );
    }
  }
  return shardCache.get(name);
}

/** Postings for one token as a Map of "chat:id" -> day. */
async function postingsFor(token) {
  const shard = await loadShard(token);
  const flat = shard[token];
  const out = new Map();
  if (!flat) return out;
  for (let i = 0; i < flat.length; i += 3) {
    out.set(`${flat[i]}:${flat[i + 1]}`, flat[i + 2]);
  }
  return out;
}

/**
 * Find messages containing every token in `query`.
 *
 * @param options.chatIndex  restrict to one chat (the per-chat search)
 * @returns { hits, tokens, truncated } — hits newest-first, not yet hydrated
 */
export async function search(query, options = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return { hits: [], tokens, exhausted: true };

  // Intersect, smallest posting list first so the working set shrinks fast.
  const lists = await Promise.all(tokens.map(postingsFor));
  lists.sort((a, b) => a.size - b.size);

  let survivors = lists[0];
  for (let i = 1; i < lists.length && survivors.size; i += 1) {
    const next = lists[i];
    const merged = new Map();
    for (const [key, day] of survivors) {
      if (next.has(key)) merged.set(key, day);
    }
    survivors = merged;
  }

  const hits = [];
  for (const [key, day] of survivors) {
    const [chatIndex, id] = key.split(':').map(Number);
    if (options.chatIndex != null && chatIndex !== options.chatIndex) continue;
    hits.push({ chatIndex, id, day });
  }

  // Newest first, the way the app orders results.
  hits.sort((a, b) => b.day - a.day || b.id - a.id);
  return { hits, tokens, exhausted: true };
}

/**
 * Fetch the real messages for one page of hits.
 *
 * Only the chunks covering this page are touched, which is what keeps a query
 * matching thousands of messages from pulling the whole archive into memory.
 */
export async function hydrate(hits, manifest, offset = 0, limit = PAGE) {
  const page = hits.slice(offset, offset + limit);
  const metas = new Map();
  const out = [];

  for (const hit of page) {
    const chat = manifest.chats[hit.chatIndex];
    if (!chat) continue;
    if (!metas.has(chat.slug)) metas.set(chat.slug, await loadMeta(chat.slug));
    const meta = metas.get(chat.slug);

    const chunk = meta.chunks.find((c) => hit.id >= c.first_id && hit.id <= c.last_id);
    if (!chunk) continue;

    const messages = await loadChunk(chat.slug, chunk.n);
    const message = messages.find((m) => m.id === hit.id);
    if (message) out.push({ chat, message });
  }

  return { results: out, done: offset + limit >= hits.length };
}

/**
 * Build a snippet around the first matching token, with matches marked.
 * Returns a DocumentFragment so the marks are real elements, not HTML strings.
 */
export function snippet(message, tokens, radius = 90) {
  const text = plainText(message.text ?? []);
  const fragment = document.createDocumentFragment();
  if (!text) {
    fragment.append(`[${message.media?.kind ?? 'message'}]`);
    return fragment;
  }

  const lower = text.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) at = 0;

  let start = Math.max(0, at - radius);
  let end = Math.min(text.length, at + radius);
  // Don't cut mid-word when there's room to reach a space.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < start + 20) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > end - 20) end = space;
  }

  const slice = text.slice(start, end);
  if (start > 0) fragment.append('…');

  // Mark every token occurrence inside the slice.
  const pattern = new RegExp(
    `(${tokens.map(escapeRegExp).join('|')})`,
    'giu',
  );
  let cursor = 0;
  for (const match of slice.matchAll(pattern)) {
    if (match.index > cursor) fragment.append(slice.slice(cursor, match.index));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    fragment.append(mark);
    cursor = match.index + match[0].length;
  }
  if (cursor < slice.length) fragment.append(slice.slice(cursor));
  if (end < text.length) fragment.append('…');

  return fragment;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
