// Date, time and label formatting, matched to how the desktop app reads.

import * as state from './state.js';

const pad = (n) => String(n).padStart(2, '0');
const at = (unix) => new Date(unix * 1000);

/** "1:45 AM", or "01:45" when the 24-hour setting is on. */
export function clock(unix) {
  return at(unix).toLocaleTimeString([], {
    hour: state.get('clock24') ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: !state.get('clock24'),
  });
}

/** "24 July", or "24 July 2024" once the year stops being obvious. */
export function dayLabel(unix) {
  const d = at(unix);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * The right-hand column of a chat row, exactly as Telegram tiers it:
 * a time today, a weekday this past week, then a date.
 */
export function listDate(unix) {
  const d = at(unix);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()))
    / 86400000;

  if (daysAgo <= 0) return clock(unix);
  if (daysAgo < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

/** "Backed Up to 07/26/2026 @ 12:00 AM" — the chat row's second line. */
export function backedUpLabel(unix) {
  if (!unix) return 'Backup date unknown';
  const d = at(unix);
  let hour = d.getHours();
  const meridiem = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `Backed Up to ${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`
    + ` @ ${hour}:${pad(d.getMinutes())} ${meridiem}`;
}

/** "Jan 2026 – Jul 2026", the coverage line under a chat's name. */
export function rangeLabel(firstUnix, lastUnix) {
  const fmt = (u) => at(u).toLocaleDateString([], { month: 'short', year: 'numeric' });
  const a = fmt(firstUnix);
  const b = fmt(lastUnix);
  return a === b ? a : `${a} – ${b}`;
}

/** "0:17" / "1:02:33" */
export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/** True when two messages fall on different calendar days. */
export function differentDay(a, b) {
  const x = at(a);
  const y = at(b);
  return x.getFullYear() !== y.getFullYear()
    || x.getMonth() !== y.getMonth()
    || x.getDate() !== y.getDate();
}

// Telegram's avatar palette, picked deterministically so a person keeps the
// same colour across sessions.
const AVATAR_COLORS = [
  '#e17076', '#7bc862', '#e5ca77', '#65aadd',
  '#a695e7', '#ee7aae', '#6ec9cb', '#faa774',
];

export function avatarColor(key = '') {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function initials(name = '') {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] ?? '';
  const second = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : '';
  return (first + second).toUpperCase();
}
