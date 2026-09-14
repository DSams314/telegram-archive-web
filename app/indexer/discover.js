// Walk the backup folder and work out which exports exist.
//
// A port of tools/tgindex/discover.py. It works against a "source" -- a
// read-only view of a folder -- so the same code runs over a folder handle in
// the browser, a list of picked files, or the real filesystem under Node:
//
//   source.list(rel)      -> [{ name, kind: 'file' | 'dir' }] or null
//   source.isFile(rel)    -> boolean
//   source.text(rel)      -> the file's contents as a string
//   source.modified(rel)  -> last-modified time in ms, or null
//
// Only directory listings and file metadata are used here. Nothing is read.

const EXPORT_DATE_RE = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/;

export class ArchiveError extends Error {}

/** Python's str comparison: by code unit, not by locale. */
export const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byLowerName = (a, b) => byText(a.name.toLowerCase(), b.name.toLowerCase());

/**
 * FNV-1a. The Python version falls back to hash(), which Python randomises
 * per process -- so a chat whose name has no Latin letters got a different
 * id every run. This is stable, which is strictly better.
 */
function stableHash(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Filesystem- and URL-safe id for a conversation, unique within the run. */
export function slugify(name, taken) {
  const ascii = name.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  let base = ascii.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (!base) base = `chat-${(stableHash(name) % 0xffffff).toString(16).padStart(6, '0')}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  taken.add(slug);
  return slug;
}

const sameDay = (date, y, m, d) =>
  date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;

/**
 * When an export was taken, in unix seconds.
 *
 * The folder name pins the local calendar date. A file's modified time
 * supplies the time of day, but only if it agrees with that date -- copying a
 * folder rewrites it, and then it can't be trusted.
 */
export function exportedAt(name, modifiedMs) {
  const mtime = Number.isFinite(modifiedMs) ? modifiedMs / 1000 : null;
  const match = EXPORT_DATE_RE.exec(name);
  if (!match) return mtime;

  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const midnight = new Date(y, m - 1, d);            // local time, as Python's naive datetime
  if (!sameDay(midnight, y, m, d)) return mtime;     // an impossible date, e.g. month 13

  if (mtime !== null && sameDay(new Date(modifiedMs), y, m, d)) return mtime;
  return midnight.getTime() / 1000;
}

async function safeList(source, rel) {
  try {
    return await source.list(rel);
  } catch {
    return null;                  // one unreadable folder must not stop the rest
  }
}

const htmlOrder = (name) => Number(name.replace(/\.html$/, '').replace(/\D/g, '') || 0);

const basename = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

/** An export if this folder looks like one, else null. */
async function scanExport(source, rel) {
  const entries = await safeList(source, rel);
  if (!entries) return null;

  const files = entries.filter((e) => e.kind === 'file').map((e) => e.name);
  const hasJson = files.includes('result.json');
  // messages.html, messages2.html, ... messages10.html must sort naturally.
  const pages = files.filter((n) => /^messages.*\.html$/.test(n))
    .sort((a, b) => htmlOrder(a) - htmlOrder(b));
  if (!hasJson && !pages.length) return null;

  const resultJson = hasJson ? `${rel}/result.json` : null;
  // Directory handles carry no timestamp, so the file that defines the
  // export stands in for the folder the Python version stats.
  const stampFrom = resultJson ?? `${rel}/${pages[0]}`;
  let modified = null;
  try {
    modified = await source.modified(stampFrom);
  } catch { /* the date in the folder name still works */ }

  return {
    rel,
    name: basename(rel),
    resultJson,
    htmlFiles: pages.map((n) => `${rel}/${n}`),
    exportedAt: exportedAt(basename(rel), modified),
  };
}

/** Every conversation under the source's root, oldest export first. */
export async function discover(source) {
  const top = await safeList(source, '');
  if (top === null) {
    throw new ArchiveError('That folder could not be opened.');
  }

  const conversations = [];
  const taken = new Set();

  for (const entry of [...top].sort(byLowerName)) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue;

    // Case 1: the conversation folder is itself a single export.
    const direct = await scanExport(source, entry.name);
    if (direct) {
      conversations.push({
        name: entry.name, rel: entry.name,
        slug: slugify(entry.name, taken), exports: [direct],
      });
      continue;
    }

    // Case 2: the normal layout, one sub-folder per export run.
    const children = await safeList(source, entry.name);
    if (!children) continue;
    const exports = [];
    for (const sub of [...children].sort(byLowerName)) {
      if (sub.kind !== 'dir' || sub.name.startsWith('.')) continue;
      const found = await scanExport(source, `${entry.name}/${sub.name}`);
      if (found) exports.push(found);
    }
    if (!exports.length) continue;
    exports.sort((a, b) => ((a.exportedAt || 0) - (b.exportedAt || 0))
      || byText(a.name, b.name));
    conversations.push({
      name: entry.name, rel: entry.name,
      slug: slugify(entry.name, taken), exports,
    });
  }
  return conversations;
}
