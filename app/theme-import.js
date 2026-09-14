// Importing real Telegram themes.
//
// Three formats, all handled without a library:
//
//   .attheme            Android. Plain text, `key=#AARRGGBB`, sometimes with a
//                       base64 wallpaper appended after a JPEG marker.
//   .tdesktop-palette   Desktop. Plain text, `key: #rrggbb;`, with comments and
//                       `key: otherKey;` aliases.
//   .tdesktop-theme     Desktop. A ZIP holding a palette plus a background
//                       image. Read with DecompressionStream('deflate-raw'),
//                       which is native -- same trick as .tgs.
//
// Telegram palettes carry hundreds of keys and ours has a few dozen, so the
// mapping is deliberately lossy: pick the keys that carry the character of a
// theme and let everything else fall back to the built-in palette.

const DESKTOP_MAP = {
  windowBg: '--panel-solid',
  windowFg: '--text',
  windowSubTextFg: '--text-dim',
  windowBgActive: '--accent',
  windowActiveTextFg: '--accent',
  dialogsBg: '--panel-solid',
  dialogsBgActive: '--panel-active',
  dialogsTextFg: '--text',
  dialogsTextFgService: '--text-dim',
  msgInBg: '--bubble-in',
  msgOutBg: '--bubble-out',
  historyTextInFg: '--bubble-in-text',
  historyTextOutFg: '--bubble-out-text',
  msgInDateFg: '--bubble-meta',
  msgOutDateFg: '--bubble-meta-out',
  msgServiceBg: '--scrim',
  msgServiceFg: '--text',
  windowBoldFg: '--text',
  shadowFg: '--line',
};

const ANDROID_MAP = {
  windowBackgroundWhite: '--panel-solid',
  windowBackgroundWhiteBlackText: '--text',
  windowBackgroundWhiteGrayText: '--text-dim',
  windowBackgroundWhiteGrayText2: '--text-dim',
  windowBackgroundWhiteBlueText: '--accent',
  windowBackgroundWhiteValueText: '--accent',
  chats_actionBackground: '--accent',
  chat_inBubble: '--bubble-in',
  chat_outBubble: '--bubble-out',
  chat_messageTextIn: '--bubble-in-text',
  chat_messageTextOut: '--bubble-out-text',
  chat_inTimeText: '--bubble-meta',
  chat_outTimeText: '--bubble-meta-out',
  chat_serviceBackground: '--scrim',
  chat_serviceText: '--text',
  actionBarDefault: '--panel-solid',
  actionBarDefaultTitle: '--text',
  divider: '--line',
};

// ---- colour parsing ------------------------------------------------------

/** `#rgb`, `#rrggbb`, `#rrggbbaa` (desktop) or a signed int (android). */
function parseColor(raw, android) {
  const value = String(raw).trim().replace(/;$/, '');

  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    if (hex.length === 6) return `#${hex}`;
    if (hex.length === 8) {
      // Desktop writes RRGGBBAA; Android writes AARRGGBB.
      const [a, b, c, d] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)];
      return android
        ? `rgba(${parseInt(b, 16)}, ${parseInt(c, 16)}, ${parseInt(d, 16)}, ${(parseInt(a, 16) / 255).toFixed(3)})`
        : `rgba(${parseInt(a, 16)}, ${parseInt(b, 16)}, ${parseInt(c, 16)}, ${(parseInt(d, 16) / 255).toFixed(3)})`;
    }
    return null;
  }

  // Android also stores colours as signed 32-bit ARGB integers.
  if (/^-?\d+$/.test(value)) {
    const n = Number(value) >>> 0;
    const a = (n >>> 24) & 0xff;
    return `rgba(${(n >>> 16) & 0xff}, ${(n >>> 8) & 0xff}, ${n & 0xff}, ${(a / 255).toFixed(3)})`;
  }
  return null;
}

/** Rough perceived luminance, used to guess whether a theme is dark. */
function luminance(css) {
  const nums = css.match(/\d+(\.\d+)?/g);
  let r, g, b;
  if (css.startsWith('#')) {
    r = parseInt(css.slice(1, 3), 16);
    g = parseInt(css.slice(3, 5), 16);
    b = parseInt(css.slice(5, 7), 16);
  } else if (nums?.length >= 3) {
    [r, g, b] = nums.slice(0, 3).map(Number);
  } else return 0.5;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// ---- text palettes -------------------------------------------------------

function parsePalette(text, android) {
  const raw = new Map();
  const aliases = new Map();

  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z0-9_]+)\s*[:=]\s*(.+?)\s*;?$/);
    if (!match) continue;
    const [, key, value] = match;
    const color = parseColor(value, android);
    if (color) raw.set(key, color);
    else if (/^[A-Za-z0-9_]+$/.test(value.replace(/;$/, ''))) {
      aliases.set(key, value.replace(/;$/, ''));
    }
  }

  // `key: otherKey;` indirection, resolved a few hops deep.
  for (let pass = 0; pass < 4; pass += 1) {
    for (const [key, target] of aliases) {
      if (!raw.has(key) && raw.has(target)) raw.set(key, raw.get(target));
    }
  }
  return raw;
}

// ---- ZIP (.tdesktop-theme) ----------------------------------------------

/**
 * Minimal ZIP reader: walk the central directory, inflate stored entries.
 * DecompressionStream('deflate-raw') does the actual decompression, so there
 * is nothing to vendor and nothing to download.
 */
async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // End of central directory: scan back for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map();

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );

    // The local header repeats the name/extra with its own lengths.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      files.set(name, data);
    } else if (method === 8) {
      const stream = new Blob([data]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      files.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// ---- entry point ---------------------------------------------------------

/**
 * Read a theme file into `{ vars, mode, wallpaper, name, matched, total }`.
 * `vars` is a map of our CSS custom properties; `wallpaper` is a data URL.
 */
export async function importThemeFile(file) {
  const name = file.name;
  const lower = name.toLowerCase();
  let palette = new Map();
  let wallpaper = null;
  const android = lower.endsWith('.attheme');

  if (lower.endsWith('.tdesktop-theme') || lower.endsWith('.zip')) {
    const files = await readZip(await file.arrayBuffer());
    for (const [entry, data] of files) {
      const entryLower = entry.toLowerCase();
      if (entryLower.endsWith('.tdesktop-palette') || entryLower === 'colors.tdesktop-palette') {
        palette = parsePalette(new TextDecoder().decode(data), false);
      } else if (/\.(jpe?g|png|webp)$/.test(entryLower)) {
        const blob = new Blob([data]);
        wallpaper = await blobToDataURL(blob);
      }
    }
    if (!palette.size) throw new Error('no palette inside the theme');
  } else {
    const text = await file.text();
    palette = parsePalette(text, android);

    // .attheme may append a wallpaper after the colour block.
    const marker = text.indexOf('WPS\n');
    if (marker !== -1) {
      const tail = text.slice(marker + 4);
      const blob = new Blob([Uint8Array.from(tail, (c) => c.charCodeAt(0) & 0xff)]);
      wallpaper = await blobToDataURL(blob);
    }
  }

  const map = android ? ANDROID_MAP : DESKTOP_MAP;
  const vars = new Map();
  let matched = 0;
  for (const [key, cssVar] of Object.entries(map)) {
    const color = palette.get(key);
    if (!color) continue;
    matched += 1;
    // Later keys must not clobber an earlier, more specific match.
    if (!vars.has(cssVar)) vars.set(cssVar, color);
  }
  if (!matched) throw new Error('no recognised colour keys');

  const base = vars.get('--panel-solid') ?? vars.get('--bubble-in');
  const mode = base && luminance(base) > 0.55 ? 'light' : 'dark';

  return {
    name: name.replace(/\.[^.]+$/, ''),
    vars: Object.fromEntries(vars),
    mode,
    wallpaper,
    matched,
    total: Object.keys(map).length,
  };
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
