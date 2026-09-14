// Grouping consecutive photos/videos into a single tiled bubble.
//
// Telegram's JSON export has no album field -- a six-photo album is six
// separate messages. What identifies them is that the app sends the whole album
// in one action, so every member shares a sender and an exact send time.

const ALBUM_KINDS = new Set(['photo', 'video']);
const MAX_ALBUM = 10;

/** True when `msg` belongs in the same album as `head`. */
function sameAlbum(head, msg) {
  return msg.from === head.from
    && msg.date === head.date
    && !msg.service
    && !msg.reply_to
    && ALBUM_KINDS.has(msg.media?.kind)
    // A caption ends the album: in Telegram it belongs to the group as a
    // whole and is rendered under the grid.
    && !(head.text?.length);
}

/**
 * Walk a chunk's messages and fold albums into single entries.
 * Returns a list of either `{album: [msg, ...]}` or `{message: msg}`.
 */
export function groupAlbums(messages) {
  const out = [];
  let i = 0;

  while (i < messages.length) {
    const head = messages[i];
    if (!ALBUM_KINDS.has(head.media?.kind) || head.service) {
      out.push({ message: head });
      i += 1;
      continue;
    }

    const members = [head];
    let j = i + 1;
    while (j < messages.length && members.length < MAX_ALBUM
           && sameAlbum(head, messages[j])) {
      members.push(messages[j]);
      j += 1;
    }

    // A caption arrives as the trailing member carrying the text.
    if (members.length > 1) {
      out.push({ album: members });
      i = j;
    } else {
      out.push({ message: head });
      i += 1;
    }
  }

  return out;
}

/**
 * Lay out `count` tiles inside `maxWidth`, roughly the way the app does:
 * two up for a pair, a feature tile plus a stack for three, and a grid
 * beyond that. Returns { width, height, tiles: [{w, h, col, row, colSpan}] }
 * — but expressed as CSS grid areas, which is simpler and reflows correctly.
 */
export function albumLayout(items, maxWidth) {
  const count = items.length;
  const gap = 2;

  // Column count that keeps tiles from getting uselessly small.
  const columns = count === 2 ? 2
    : count === 3 ? 3
    : count === 4 ? 2
    : count <= 6 ? 3
    : 3;

  const rows = Math.ceil(count / columns);
  const cell = (maxWidth - gap * (columns - 1)) / columns;

  // Square-ish cells read best for a mixed-orientation album, which is what
  // the app settles on too once there are more than two items.
  const cellHeight = count === 2
    ? Math.round(cell * averageRatio(items))
    : Math.round(cell);

  return {
    columns,
    gap,
    width: maxWidth,
    height: rows * cellHeight + gap * (rows - 1),
    cellHeight,
  };
}

function averageRatio(items) {
  const ratios = items
    .map((m) => (m.media?.h && m.media?.w ? m.media.h / m.media.w : 1))
    .filter(Boolean);
  if (!ratios.length) return 1;
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // Keep a pair from becoming a skyscraper or a letterbox.
  return Math.min(1.6, Math.max(0.6, mean));
}
