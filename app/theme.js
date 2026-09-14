// Turning settings into CSS.
//
// Every colour and metric in the UI resolves through a custom property on
// <html>, so applying a theme -- built-in, tweaked, or imported from a real
// Telegram theme file -- is just writing properties. Nothing downstream cares
// where they came from.

import * as state from './state.js';
import { SETTINGS } from './settings-schema.js';
import { searchIconDataURI } from './icons.js';

const root = document.documentElement;
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// Exactly the custom properties this module has written. Other modules put
// their own on <html> too -- the sidebar keeps its width there -- so clearing
// the element's inline styles wholesale would silently reset them. It did:
// every settings change re-ran apply(), so clicking a chat snapped the
// sidebar back to its default width.
const written = new Set();

function write(name, value) {
  root.style.setProperty(name, value);
  written.add(name);
}

// Settings that write a custom property directly.
const CSS_BACKED = SETTINGS.filter((s) => s.cssVar);

function resolveMode(theme) {
  if (theme === 'system') return systemDark.matches ? 'dark' : 'light';
  return theme === 'light' ? 'light' : 'dark';
}

export function apply() {
  const imported = state.get('importedTheme');

  // An imported theme decides light vs dark unless the user pinned one.
  const themeSetting = state.get('theme');
  const mode = imported && themeSetting === 'system'
    ? imported.mode
    : resolveMode(themeSetting);
  root.dataset.theme = mode;
  root.dataset.wallpaper = state.get('wallpaper');

  // Clear only what a previous theme wrote, so switching never leaves half of
  // an old palette behind -- and nothing else on <html> is disturbed.
  for (const name of written) root.style.removeProperty(name);
  written.clear();

  // Imported palette first, then the user's own settings on top -- a chosen
  // accent should survive importing a theme.
  if (imported) {
    for (const [name, value] of Object.entries(imported.vars)) {
      write(name, value);
    }
    if (imported.wallpaper) {
      write('--wallpaper', `url("${imported.wallpaper}")`);
    }
  }

  // An uploaded photo outranks both the built-ins and a theme's own background.
  const custom = state.get('customWallpaper');
  if (custom && state.get('wallpaper') === 'custom') {
    write('--wallpaper', `url("${custom}")`);
  }

  for (const setting of CSS_BACKED) {
    const value = state.get(setting.id);
    if (value === undefined) continue;
    // An imported theme owns the accent unless the user has moved it off the
    // default; otherwise importing a theme would look like it did nothing.
    if (setting.id === 'accent' && imported && value === setting.default) continue;
    write(setting.cssVar, setting.format ? setting.format(value) : value);
  }

  root.dataset.reduceMotion = String(state.get('reduceMotion'));

  // Reduce-motion has to be written inline rather than left to the stylesheet:
  // the animation-speed setting also writes --dur inline, and an inline value
  // always beats a rule, so a stylesheet override would silently lose.
  if (state.get('reduceMotion')) {
    write('--dur', '1ms');
    write('--dur-fast', '1ms');
    write('--spring', 'linear(0, 1)');
    write('--spring-fast', 'linear(0, 1)');
  }

  // The search field's magnifier is a background image and can't inherit
  // currentColor, so it is re-baked whenever the palette changes.
  const dim = getComputedStyle(root).getPropertyValue('--text-faint').trim();
  write('--search-icon', searchIconDataURI(dim || '#888'));
}

export function toggle() {
  state.set('theme', resolveMode(state.get('theme')) === 'dark' ? 'light' : 'dark');
}

export function init() {
  apply();
  state.subscribe(() => apply());
  systemDark.addEventListener('change', () => {
    if (state.get('theme') === 'system') apply();
  });
}

export const currentMode = () => root.dataset.theme;
