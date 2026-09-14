// Message id -> media path, recovered from an HTML export.
//
// A port of tools/tgindex/htmlmap.py. Telegram names sticker files after the
// sticker's own filename, so every send collides and gets a " (N)" suffix
// numbered per export run: the same sticker is "sticker (5).webp" in one
// export and "sticker (12).webp" in the next. An HTML export already on disk
// is therefore a correct map from message to bytes, and reading it lets a
// fresh JSON export reuse files instead of needing them downloaded again.
//
// A regex scan rather than a parser: the files are huge and machine-written.

import { MEDIA_DIRS } from './model.js';

const MESSAGE_RE = /<div class="message[^"]*"\s+id="message(-?\d+)"/g;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ASSET_RE = new RegExp(
  `(?:href|src)="((?:${MEDIA_DIRS.map(escape).join('|')})/[^"]+)"`, 'gi');

const THUMB_SUFFIXES = ['_thumb.jpg', '_thumb.png', '_thumb.webp'];

function isThumb(path) {
  const lowered = path.toLowerCase();
  if (THUMB_SUFFIXES.some((suffix) => lowered.endsWith(suffix))) return true;
  // "sticker (2)_thumb (3).webp" -- a de-duplicated thumbnail.
  return /_thumb(?: \(\d+\))?\.\w+$/.test(lowered);
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The HTML entities Telegram's exporter actually writes, as html.unescape. */
function unescapeHTML(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

const utf8 = new TextDecoder('utf-8');

/** Percent-decoding as urllib.parse.unquote: bad bytes become U+FFFD. */
function unquote(text) {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    const bytes = run.match(/%[0-9a-f]{2}/gi).map((h) => Number.parseInt(h.slice(1), 16));
    return utf8.decode(Uint8Array.from(bytes));
  });
}

const clean = (raw) => unquote(unescapeHTML(raw));

/**
 * Add one HTML page's message -> media entries to `out`.
 *
 * One page at a time on purpose: a big export runs to hundreds of pages, and
 * holding them all in memory at once is how a browser tab runs out of it.
 * Earlier pages win, matching the order the Python indexer reads them in.
 */
export function addPageToMap(text, out) {
  const marks = [...text.matchAll(MESSAGE_RE)].map((m) => [m.index, Number(m[1])]);
  for (let i = 0; i < marks.length; i += 1) {
    const [start, id] = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1][0] : text.length;
    const block = text.slice(start, end);

    let src = null;
    let thumb = null;
    for (const asset of block.matchAll(ASSET_RE)) {
      const candidate = clean(asset[1]);
      if (isThumb(candidate)) thumb ??= candidate;
      else src ??= candidate;
    }

    if ((src || thumb) && !out.has(id)) {
      const entry = {};
      if (src) entry.src = src;
      if (thumb) entry.thumb = thumb;
      out.set(id, entry);
    }
  }
  return out;
}

/** Map message id -> { src, thumb } for a list of page texts. */
export function parseMediaMap(pages) {
  const out = new Map();
  for (const text of pages) addPageToMap(text, out);
  return out;
}
