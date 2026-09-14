// Raw Telegram export messages -> the viewer's message schema.
//
// A line-for-line port of tools/tgindex/normalize.py. Pure functions over
// plain objects: nothing here touches a file, so the same code runs in the
// browser, in a worker, and under Node for the parity tests.

import {
  HANDLED_MESSAGE_FIELDS,
  LINK_ENTITY_TYPES,
  MEDIA_TYPE_KIND,
  NOT_INCLUDED_PREFIX,
} from './model.js';

const isObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);

/** Python's int() on a string or number, or null if it isn't one. */
function toInt(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : null;
}

/**
 * Local wall time with no offset -> unix seconds, as Python's
 * datetime.fromisoformat(...).timestamp() does. JavaScript reads an
 * offset-less date-time as local time too, which is what makes this match.
 */
function isoToUnix(text) {
  if (typeof text !== 'string') return null;
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function parseDate(msg) {
  // date_unixtime is authoritative and timezone-free; `date` is a fallback.
  const exact = toInt(msg.date_unixtime);
  if (exact !== null) return exact;
  return isoToUnix(msg.date);
}

function editedAt(msg) {
  const exact = toInt(msg.edited_unixtime);
  if (exact !== null) return exact;
  return isoToUnix(msg.edited);
}

/** Text as a list of typed entities. */
export function normalizeEntities(msg) {
  const entities = msg.text_entities;
  if (Array.isArray(entities) && entities.length) {
    return entities.filter((e) => isObject(e) && e.text !== '');
  }

  const { text } = msg;
  if (typeof text === 'string') return text ? [{ type: 'plain', text }] : [];
  if (Array.isArray(text)) {
    const out = [];
    for (const part of text) {
      if (typeof part === 'string') {
        if (part) out.push({ type: 'plain', text: part });
      } else if (isObject(part) && part.text) {
        out.push(part);
      }
    }
    return out;
  }
  return [];
}

export function plainText(entities) {
  return entities.map((e) => e.text ?? '').join('');
}

export function extractLinks(entities) {
  const out = [];
  for (const e of entities) {
    if (!LINK_ENTITY_TYPES.includes(e.type)) continue;
    const url = e.href || e.text;
    if (url) out.push(url);
  }
  return out;
}

export function normalizeReactions(msg) {
  const raw = msg.reactions;
  if (!Array.isArray(raw) || !raw.length) return null;

  const out = [];
  for (const r of raw) {
    if (!isObject(r)) continue;
    const entry = { count: r.count ?? 0 };
    if (r.type === 'custom_emoji') {
      entry.custom_emoji_id = r.document_id ?? null;
      entry.emoji = r.emoji || '';
    } else {
      entry.emoji = r.emoji || '';
    }
    const senders = (Array.isArray(r.recent) ? r.recent : [])
      .filter((rec) => isObject(rec) && rec.from_id)
      .map((rec) => rec.from_id);
    if (senders.length) entry.from = senders;
    out.push(entry);
  }
  return out.length ? out : null;
}

function mediaKind(msg) {
  if ('photo' in msg) return 'photo';

  if (msg.media_type) return MEDIA_TYPE_KIND[msg.media_type] ?? 'unknown';

  if ('file' in msg) {
    const mime = String(msg.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) return 'photo';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'music';
    return 'file';
  }
  return null;
}

const MEDIA_FIELDS = [
  ['width', 'w'], ['height', 'h'], ['duration_seconds', 'duration'],
  ['file_name', 'name'], ['mime_type', 'mime'], ['sticker_emoji', 'emoji'],
  ['title', 'title'], ['performer', 'performer'],
];

export function normalizeMedia(msg) {
  const kind = mediaKind(msg);
  if (kind === null) return null;

  const rawSrc = kind === 'photo' && 'photo' in msg ? msg.photo : msg.file;
  const rawThumb = msg.thumbnail;

  const excluded = typeof rawSrc === 'string'
    && rawSrc.startsWith(NOT_INCLUDED_PREFIX);
  const src = excluded || typeof rawSrc !== 'string' ? null : rawSrc;
  const thumb = typeof rawThumb === 'string'
    && !rawThumb.startsWith(NOT_INCLUDED_PREFIX) ? rawThumb : null;

  const media = { kind, src, thumb };
  if (excluded) media.excluded = true;
  if (msg.media_spoiler) media.spoiler = true;

  for (const [from, to] of MEDIA_FIELDS) {
    const value = msg[from];
    if (value !== null && value !== undefined && value !== '') media[to] = value;
  }

  const size = kind !== 'photo' ? msg.file_size : msg.photo_file_size;
  if (Number.isInteger(size)) media.size = size;
  return media;
}

/** One raw export message -> one index message, or null to skip it. */
export function normalizeMessage(msg, unhandled) {
  const id = msg.id;
  if (!Number.isInteger(id)) return null;

  for (const key of Object.keys(msg)) {
    if (!HANDLED_MESSAGE_FIELDS.has(key)) unhandled[key] = (unhandled[key] ?? 0) + 1;
  }

  const date = parseDate(msg);
  if (date === null) return null;

  const entities = normalizeEntities(msg);
  const out = { id, date };

  if (msg.type === 'service') {
    out.service = msg.action || 'unknown';
    out.from = msg.actor_id || msg.from_id || null;
    if (msg.actor) out.from_name = msg.actor;
    for (const key of ['duration_seconds', 'message_id']) {
      if (key in msg) out[key] = msg[key];
    }
    if (Array.isArray(msg.members)) {
      out.members = msg.members.filter((m) => typeof m === 'string');
    }
  } else {
    // null, not absent: the Python indexer writes "from": null too.
    out.from = msg.from_id ?? null;
    if (msg.from) out.from_name = msg.from;
  }

  if (entities.length) out.text = entities;

  const edited = editedAt(msg);
  if (edited) out.edited = edited;

  if (Number.isInteger(msg.reply_to_message_id)) out.reply_to = msg.reply_to_message_id;

  const reactions = normalizeReactions(msg);
  if (reactions) out.reactions = reactions;

  if (msg.forwarded_from) {
    out.forwarded_from = msg.forwarded_from;
    if (msg.forwarded_from_id) out.forwarded_from_id = msg.forwarded_from_id;
  }
  if (msg.via_bot) out.via_bot = msg.via_bot;

  const media = normalizeMedia(msg);
  if (media) out.media = media;
  return out;
}

/**
 * Sort key for picking the best copy of a message seen in several exports.
 * Compared element by element, higher is better -- as Python compares tuples.
 */
export function completeness(message) {
  const media = message.media ?? {};
  return [
    media.src ? 1 : 0,
    media.thumb ? 1 : 0,
    message.reactions ? 1 : 0,
    message.text ? 1 : 0,
    Object.keys(message).length,
  ];
}

export function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
