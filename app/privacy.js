// The privacy statement: shown during first-time setup and at the bottom of
// Settings. Every sentence here is a claim the code has to keep true, so the
// wording is deliberately plain and specific rather than reassuring.

import { MODE } from './mode.js';

const WEB = [
  ['Runs in your browser.',
    'There is no account, no sign-in, no tracking, no ads and no cookies.'],
  ['Your archive stays on your device.',
    'Your chats, photos, stickers and settings never leave it. The page is built '
    + 'so that it cannot send them anywhere: not to the developer, not to '
    + 'GitHub, not to anyone.'],
  ['It only reads your exports.',
    'It never changes or deletes them. The one file it ever writes is '
    + 'telegram-archive-config.json, next to your Backups folder, and only in '
    + 'browsers that allow it.'],
  ['What this browser keeps.',
    'The folder you chose (so it can open it again), a copy of your settings, '
    + 'and the index that makes scrolling and search fast. “Forget this folder” '
    + 'in Settings deletes all three.'],
  ['What GitHub sees.',
    'This website is hosted on GitHub. Like any website, loading it tells '
    + 'GitHub your IP address and which browser you use. It never tells GitHub '
    + 'anything about your archive.'],
  ['Check it yourself.',
    'The code is public, so anyone can confirm every line of this.'],
];

const SERVER = [
  ['Runs on this computer.',
    'It never connects to the internet. There is no account, no tracking and no ads.'],
  ['Your archive stays on this computer.',
    'Your chats, photos, stickers and settings never leave it.'],
  ['It only reads your exports.',
    'It never changes or deletes them. Everything it writes stays inside its '
    + 'own data folder.'],
];

export function privacyStatement({ heading = true } = {}) {
  const box = document.createElement('section');
  box.className = 'privacy';
  if (heading) {
    box.append(Object.assign(document.createElement('h3'), { textContent: 'Your privacy' }));
  }
  const list = document.createElement('ul');
  for (const [lead, detail] of MODE === 'web' ? WEB : SERVER) {
    const item = document.createElement('li');
    item.append(Object.assign(document.createElement('b'), { textContent: lead }), ` ${detail}`);
    list.append(item);
  }
  box.append(list);
  return box;
}
