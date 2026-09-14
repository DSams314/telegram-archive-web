// Global keyboard shortcuts, and the sheet that lists them.
//
// Registered in one place so the bindings can be enumerated for the help
// sheet rather than described twice and drifting apart.

import * as settings from './settings.js';
import * as profile from './profile.js';
import * as lightbox from './lightbox.js';
import * as contextmenu from './contextmenu.js';
import * as shutdown from './shutdown.js';

const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

export const SHORTCUTS = [
  { keys: [`${mod}K`], label: 'Search all messages' },
  { keys: [`${mod}F`], label: 'Search this chat' },
  { keys: [`${mod},`], label: 'Settings' },
  { keys: ['↑', '↓'], label: 'Previous / next chat' },
  { keys: ['Home', 'End'], label: 'Jump to the start / latest of a chat' },
  { keys: ['PgUp', 'PgDn'], label: 'Scroll a screen' },
  { keys: ['I'], label: 'Toggle the profile panel' },
  { keys: ['Esc'], label: 'Close whatever is open' },
  { keys: ['?'], label: 'This list' },
];

// Typing in a field must never trigger a bare-letter shortcut.
const isTyping = (target) =>
  target instanceof HTMLElement
  && (target.isContentEditable
      || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function init(handlers) {
  window.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    const typing = isTyping(event.target);

    if (meta && event.key === 'k') {
      event.preventDefault();
      document.getElementById('search').focus();
      document.getElementById('search').select();
      return;
    }
    if (meta && event.key === ',') {
      event.preventDefault();
      settings.isOpen() ? settings.close() : settings.open();
      return;
    }

    if (event.key === 'Escape') {
      // Close the topmost thing only, so Escape unwinds one layer at a time.
      contextmenu.close();
      // The lightbox element only exists once it has been opened; testing
      // `?.hidden` alone reads undefined as "showing" and swallows the Escape.
      if (shutdown.isOpen()) { shutdown.close(); return; }
      const box = document.getElementById('lightbox');
      if (box && !box.hidden) { lightbox.close(); return; }
      if (settings.isOpen()) { settings.close(); return; }
      if (profile.isOpen()) { profile.close(); return; }
      if (typing) event.target.blur();
      return;
    }

    if (typing || meta || event.altKey) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        handlers.stepChat(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        handlers.stepChat(-1);
        break;
      case 'Home':
        event.preventDefault();
        handlers.jumpToStart();
        break;
      case 'End':
        event.preventDefault();
        handlers.jumpToLatest();
        break;
      case 'i':
      case 'I':
        handlers.toggleProfile();
        break;
      case '?':
        toggleHelp();
        break;
      default:
        break;
    }
  });
}

// ---- help sheet ----------------------------------------------------------

let sheet = null;

function toggleHelp() {
  if (!sheet) buildHelp();
  sheet.hidden = !sheet.hidden;
}

function buildHelp() {
  sheet = document.createElement('div');
  sheet.id = 'shortcuts';
  sheet.hidden = true;

  const card = document.createElement('div');
  card.className = 'sc-card';
  card.append(Object.assign(document.createElement('h2'), {
    textContent: 'Keyboard shortcuts',
  }));

  for (const { keys, label } of SHORTCUTS) {
    const row = document.createElement('div');
    row.className = 'sc-row';
    const combo = document.createElement('div');
    combo.className = 'sc-keys';
    for (const key of keys) {
      combo.append(Object.assign(document.createElement('kbd'), { textContent: key }));
    }
    row.append(combo, Object.assign(document.createElement('span'), {
      textContent: label,
    }));
    card.append(row);
  }

  sheet.append(card);
  sheet.onclick = () => { sheet.hidden = true; };
  document.body.append(sheet);
}
