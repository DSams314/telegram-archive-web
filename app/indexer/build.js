// Merge every export of each conversation into the viewer's chunked index.
//
// A port of tools/tgindex/build.py and __main__.py, with one deliberate
// difference, and it is the reason this file exists at all:
//
//   ** It never reads a photo, video, sticker or any other media file. **
//
// The Python indexer hashed every media file to collapse duplicate stickers,
// and read image headers to recover photos an export claimed it skipped. On a
// cloud or network drive with on-demand sync, every one of those reads makes
// the sync app download the whole file -- which is how opening the archive
// once pulled around 100 GB off a NAS. Here, whether a file exists is decided
// from folder listings alone, and duplicates are recognised from the details
// already written in result.json. The only files ever opened are result.json
// and the HTML export pages, which the index cannot be built without.

import {
  AVATAR_DIRS, AVATAR_SUFFIXES, CHUNK_SIZE, DEDUPE_TABS, LIBRARY_TABS,
  MIN_TOKEN_LEN, SCHEMA_VERSION,
} from './model.js';
import {
  compareKeys, completeness, extractLinks, normalizeMessage, plainText,
} from './normalize.js';
import { addPageToMap } from './htmlmap.js';
import { byText, discover } from './discover.js';

export function newReport() {
  return {
    chats: 0,
    exports: 0,
    messages: 0,
    duplicates_merged: 0,
    media_total: 0,
    media_missing: 0,
    media_excluded: 0,
    media_recovered_from_html: 0,
    media_from_sibling_export: 0,
    unhandled_fields: {},
    service_actions: {},
    unknown_media: {},
    warnings: [],
  };
}

const bump = (counts, key, by = 1) => { counts[key] = (counts[key] ?? 0) + by; };
const isObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);
const codePoints = (text) => Array.from(text);

// Letters and numbers in any script -- what Python's [^\W_] matches. The
// viewer's search box uses the same rule, so a query always tokenises the
// way the index was built.
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text) {
  const out = new Set();
  for (const token of text.match(TOKEN_RE) ?? []) {
    if (codePoints(token).length >= MIN_TOKEN_LEN) out.add(token.toLowerCase());
  }
  return out;
}

/** A path inside the archive, or null if it tries to leave it. */
export function safeRel(rel) {
  if (typeof rel !== 'string' || rel.startsWith('/')) return null;
  const parts = [];
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * Turns export-relative media paths into archive-relative ones.
 *
 * Tries, in order: the path result.json gives, inside the export the message
 * came from; the same path inside any other export of the conversation; and
 * the path an HTML export of the conversation records for that message.
 */
export class Resolver {
  constructor(source) {
    this.source = source;
    this.known = new Map();
  }

  async exists(rel) {
    const clean = safeRel(rel);
    if (!clean) return false;
    if (!this.known.has(clean)) {
      this.known.set(clean, Promise.resolve(this.source.isFile(clean)).catch(() => false));
    }
    return this.known.get(clean);
  }

  async locate(path, origin, siblings, htmlMedia, id, slot) {
    const candidates = [];
    if (path) {
      candidates.push([`${origin}/${path}`, 'json']);
      for (const rel of siblings) if (rel !== origin) candidates.push([`${rel}/${path}`, 'sibling']);
    }
    const recovered = htmlMedia.get(id)?.[slot];
    if (recovered) {
      candidates.push([`${origin}/${recovered}`, 'html']);
      for (const rel of siblings) if (rel !== origin) candidates.push([`${rel}/${recovered}`, 'html']);
    }
    for (const [candidate, via] of candidates) {
      if (await this.exists(candidate)) return [candidate, via];
    }
    return [null, null];
  }

  /** Rewrite `media` in place; return how each slot was found. */
  async resolve(media, origin, siblings, htmlMedia, id) {
    const [src, srcVia] = await this.locate(media.src, origin, siblings, htmlMedia, id, 'src');
    const [thumb, thumbVia] = await this.locate(media.thumb, origin, siblings, htmlMedia, id, 'thumb');
    media.src = src;
    media.thumb = thumb;
    if (src === null && thumb === null) media.missing = true;
    if (media.src === null) delete media.src;
    if (media.thumb === null) delete media.thumb;
    return { src: srcVia, thumb: thumbVia };
  }
}

async function loadExport(source, exp, report, onFile) {
  if (!exp.resultJson) return [{}, []];
  let data;
  try {
    onFile?.(exp.resultJson);
    data = JSON.parse(await source.text(exp.resultJson));
  } catch (error) {
    report.warnings.push(`${exp.rel}: unreadable result.json (${error.message})`);
    return [{}, []];
  }
  if (!isObject(data)) {
    report.warnings.push(`${exp.rel}: result.json is not an export`);
    return [{}, []];
  }

  const header = {};
  for (const [key, value] of Object.entries(data)) if (key !== 'messages') header[key] = value;
  if (!Array.isArray(data.messages)) {
    report.warnings.push(`${exp.rel}: result.json has no message list`);
    return [header, []];
  }

  const unhandled = {};
  const messages = [];
  for (const item of data.messages) {
    if (!isObject(item)) continue;
    const norm = normalizeMessage(item, unhandled);
    if (!norm) continue;
    norm._export = exp.rel;
    messages.push(norm);
    if ('service' in norm) bump(report.service_actions, norm.service);
    if (norm.media?.kind === 'unknown') {
      bump(report.unknown_media, item.media_type || item.mime_type || '?');
    }
  }
  for (const [key, count] of Object.entries(unhandled)) bump(report.unhandled_fields, key, count);
  return [header, messages];
}

async function loadHtmlMedia(source, conv, onFile) {
  const merged = new Map();
  for (const exp of conv.exports) {
    if (!exp.htmlFiles.length) continue;
    const mapping = new Map();
    for (const rel of exp.htmlFiles) {
      try {
        onFile?.(rel);
        addPageToMap(await source.text(rel), mapping);
      } catch { /* a page that will not open costs only its own messages */ }
    }
    for (const [id, entry] of mapping) if (!merged.has(id)) merged.set(id, entry);
  }
  return merged;
}

const extension = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

async function findAvatar(source, conv) {
  for (const exp of [...conv.exports].reverse()) {
    for (const folder of AVATAR_DIRS) {
      let listed = null;
      try { listed = await source.list(`${exp.rel}/${folder}`); } catch { listed = null; }
      if (!listed) continue;
      const images = listed
        .filter((e) => e.kind === 'file' && AVATAR_SUFFIXES.includes(extension(e.name)))
        .map((e) => e.name)
        .sort(byText);
      if (images.length) return `${exp.rel}/${folder}/${images[images.length - 1]}`;
    }
  }
  return null;
}

/**
 * Identify a sticker or GIF without opening it.
 *
 * The Python indexer hashed the bytes. Size, dimensions, emoji and duration
 * from result.json tell the same repeats apart without a single read; two
 * different stickers would have to agree on every one of them to collide.
 */
function repeatKey(media) {
  if (!Number.isInteger(media.size)) return null;
  return [media.kind, media.size, media.w ?? '', media.h ?? '',
    media.emoji ?? '', media.duration ?? ''].join('|');
}

/** Builds the sharded search index incrementally, chat by chat. */
export class SearchBuilder {
  constructor() {
    this.shards = new Map();      // key -> Map(token -> [chat, id, day, ...])
  }

  add(chatId, id, date, text) {
    const day = Math.floor(date / 86400);
    for (const token of tokenize(text)) {
      const key = codePoints(token).slice(0, 2).join('');
      let shard = this.shards.get(key);
      if (!shard) this.shards.set(key, (shard = new Map()));
      let list = shard.get(token);
      if (!list) shard.set(token, (list = []));
      list.push(chatId, id, day);
    }
  }

  /**
   * Write every shard, renumbering chats to their final manifest position.
   *
   * Chats are indexed in folder order but listed newest-first, so the chat
   * numbers in the postings are only known once every chat is done. Postings
   * are then re-sorted by that final number -- stably, so each chat's own
   * messages keep their date order, exactly as the Python indexer lays them out.
   */
  async write(sink, finalIndex) {
    const names = [];
    for (const [key, tokens] of this.shards) {
      const out = {};
      for (const [token, flat] of tokens) {
        const triples = [];
        for (let i = 0; i < flat.length; i += 3) {
          triples.push([finalIndex.get(flat[i]), flat[i + 1], flat[i + 2]]);
        }
        triples.sort((a, b) => a[0] - b[0]);
        out[token] = triples.flat();
      }
      const name = hexName(key);
      names.push(name);
      await sink.put(`search/${name}.json`, out);
    }
    await sink.put('search/shards.json', names.sort(byText));
    return names.length;
  }
}

const hexName = (key) => [...new TextEncoder().encode(key)]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

/** Index one conversation. Returns its manifest entry, or null if empty. */
export async function buildChat(conv, source, resolver, sink, report, options = {}) {
  const { dedupe = true, onFile, search, chatId = 0 } = options;
  const header = {};
  const byId = new Map();
  let duplicates = 0;

  for (const exp of conv.exports) {
    const [exportHeader, messages] = await loadExport(source, exp, report, onFile);
    // The newest export wins for the chat's name and type.
    for (const [key, value] of Object.entries(exportHeader)) {
      if (value !== null && value !== undefined) header[key] = value;
    }
    report.exports += 1;

    for (const msg of messages) {
      const existing = byId.get(msg.id);
      if (!existing) {
        byId.set(msg.id, msg);
        continue;
      }
      duplicates += 1;
      // The more complete copy wins; ties go to the newer export.
      if (compareKeys(completeness(msg), completeness(existing)) >= 0) byId.set(msg.id, msg);
    }
  }
  if (!byId.size) return null;
  report.duplicates_merged += duplicates;

  const htmlMedia = await loadHtmlMedia(source, conv, onFile);
  const exportRels = conv.exports.map((e) => e.rel);
  const messages = [...byId.values()].sort((a, b) => (a.date - b.date) || (a.id - b.id));

  const peers = new Map();
  const catalogs = Object.fromEntries(LIBRARY_TABS.map(([tab]) => [tab, []]));
  const seen = Object.fromEntries(DEDUPE_TABS.map((tab) => [tab, new Set()]));
  const kindCounts = {};

  for (const msg of messages) {
    const origin = msg._export;
    delete msg._export;

    const sender = msg.from;
    if (sender) {
      const peer = peers.get(sender) ?? { messages: 0, name: null };
      peer.messages += 1;
      if (msg.from_name) peer.name = msg.from_name;
      peers.set(sender, peer);
    }

    const { media } = msg;
    if (media) {
      const via = await resolver.resolve(media, origin, exportRels, htmlMedia, msg.id);
      report.media_total += 1;
      bump(kindCounts, media.kind);

      if (media.missing) {
        report.media_missing += 1;
        if (media.excluded) report.media_excluded += 1;
      } else if (via.src === 'html') {
        report.media_recovered_from_html += 1;
      } else if (via.src === 'sibling') {
        report.media_from_sibling_export += 1;
      }

      for (const [tab, kinds] of LIBRARY_TABS) {
        if (!kinds.includes(media.kind)) continue;
        if (media.missing) break;
        if (dedupe && tab in seen) {
          const key = repeatKey(media);
          if (key && seen[tab].has(key)) break;
          if (key) seen[tab].add(key);
        }
        const entry = { id: msg.id, date: msg.date, kind: media.kind, src: media.src ?? null };
        for (const key of ['thumb', 'w', 'h', 'duration', 'name', 'size', 'emoji']) {
          if (key in media) entry[key] = media[key];
        }
        catalogs[tab].push(entry);
        break;
      }
    }

    for (const url of extractLinks(msg.text ?? [])) {
      catalogs.links.push({ id: msg.id, date: msg.date, url });
    }
  }

  // A reply usually points into a different chunk; a short preview of its
  // target lets every chunk render on its own.
  const finalById = new Map(messages.map((m) => [m.id, m]));
  for (const msg of messages) {
    const target = finalById.get(msg.reply_to);
    if (!target) continue;
    const preview = {};
    if (target.from_name) preview.from_name = target.from_name;
    if (target.from) preview.from = target.from;
    const excerpt = plainText(target.text ?? []).trim();
    if (excerpt) preview.text = codePoints(excerpt).slice(0, 120).join('');
    else if (target.media) preview.kind = target.media.kind;
    msg.reply_preview = preview;
  }

  const chunks = [];
  for (let n = 0, start = 0; start < messages.length; n += 1, start += CHUNK_SIZE) {
    const block = messages.slice(start, start + CHUNK_SIZE);
    await sink.put(`chats/${conv.slug}/chunk-${String(n).padStart(4, '0')}.json`, block);
    const last = block[block.length - 1];
    chunks.push({
      n,
      count: block.length,
      first_id: block[0].id,
      last_id: last.id,
      first_date: block[0].date,
      last_date: last.date,
      last_from: last.from ?? null,
      media: block.filter((m) => m.media).length,
    });
  }

  if (search) {
    for (const msg of messages) {
      const text = plainText(msg.text ?? []);
      const name = msg.media?.name ?? '';
      const blob = `${text} ${name}`.trim();
      if (blob) search.add(chatId, msg.id, msg.date, blob);
    }
  }

  const peerList = [...peers.entries()]
    .map(([id, info]) => ({ id, name: info.name || id, messages: info.messages }))
    .sort((a, b) => b.messages - a.messages);

  await sink.put(`chats/${conv.slug}/meta.json`, {
    slug: conv.slug,
    name: header.name || conv.name,
    chunks,
    peers: peerList,
    exports: conv.exports.map((e) => ({
      rel: e.rel,
      name: e.name,
      exported_at: e.exportedAt ?? null,
      has_json: e.resultJson !== null,
      html_pages: e.htmlFiles.length,
    })),
  });

  // Newest first: the library is mostly for finding what was sent recently.
  for (const entries of Object.values(catalogs)) entries.reverse();
  await sink.put(`chats/${conv.slug}/media.json`, catalogs);

  report.chats += 1;
  report.messages += messages.length;

  const stamps = conv.exports.map((e) => e.exportedAt).filter(Boolean);
  return {
    slug: conv.slug,
    name: header.name || conv.name,
    folder: conv.name,
    type: header.type || 'personal_chat',
    tg_id: header.id ?? null,
    messages: messages.length,
    first_date: messages[0].date,
    last_date: messages[messages.length - 1].date,
    backed_up_at: stamps.length ? Math.max(...stamps) : null,
    avatar: await findAvatar(source, conv),
    exports: conv.exports.length,
    chunks: chunks.length,
    peers: peerList,
    media_counts: kindCounts,
    library_counts: Object.fromEntries(
      Object.entries(catalogs).map(([tab, items]) => [tab, items.length])),
  };
}

/** The one participant present in every conversation is the account owner. */
export function detectSelfId(chats) {
  const sets = chats
    .filter((c) => c.peers?.length)
    .map((c) => new Set(c.peers.map((p) => p.id).filter(Boolean)));
  if (sets.length < 2) return null;
  let common = sets[0];
  for (const other of sets.slice(1)) common = new Set([...common].filter((id) => other.has(id)));
  return common.size === 1 ? [...common][0] : null;
}

/**
 * Index a whole archive.
 *
 *   source      a read-only folder view (see discover.js)
 *   sink        { begin(), put(path, value), commit() } -- where the index goes
 *   selfId      the account owner if already known
 *   onProgress  ({ phase, done, total, name }) as it goes
 *   onFile      (rel) just before a file is opened, so a stall can be named
 *
 * The manifest is written last, after everything it refers to. An index that
 * was interrupted therefore has no manifest, and is rebuilt rather than read.
 */
export async function runIndex({
  source, sink, selfId = null, onProgress, onFile, dedupe = true,
}) {
  const report = newReport();
  onProgress?.({ phase: 'discover', done: 0, total: 0 });
  const conversations = await discover(source);

  await sink.begin?.();
  const resolver = new Resolver(source);
  const search = new SearchBuilder();
  const built = [];

  for (let i = 0; i < conversations.length; i += 1) {
    const conv = conversations[i];
    onProgress?.({ phase: 'chats', done: i, total: conversations.length, name: conv.name });
    const entry = await buildChat(conv, source, resolver, sink, report,
      { dedupe, onFile, search, chatId: i });
    if (entry) built.push({ entry, chatId: i });
  }

  built.sort((a, b) => (b.entry.last_date || 0) - (a.entry.last_date || 0));
  const chats = built.map((b) => b.entry);
  const owner = selfId || detectSelfId(chats);

  onProgress?.({ phase: 'search', done: chats.length, total: chats.length });
  await search.write(sink, new Map(built.map((b, position) => [b.chatId, position])));

  await sink.put('manifest.json', {
    schema: SCHEMA_VERSION,
    generated: Math.floor(Date.now() / 1000),
    self_id: owner ?? null,
    chats,
  });
  await sink.commit?.();
  onProgress?.({ phase: 'done', done: 1, total: 1 });
  return { report, chats: chats.length, selfId: owner ?? null };
}
