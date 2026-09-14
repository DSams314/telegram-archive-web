// The loading screen shown while the archive is being indexed.
//
// It exists because of how a slow first launch used to feel: nothing opened,
// and after a minute or two the reasonable conclusion was that the program
// had hung. Saying what it is reading, with a count, turns a hang into a
// wait -- and a Cancel button means waiting is always a choice.
//
// When nothing has moved for a while it says what it is waiting for. A paused
// cloud drive does not make reading fail; it makes it wait forever, and a
// progress bar sitting still says nothing about why.

import { logoSVG } from './logo.js';

let node = null;
let cancelHandler = null;

function build() {
  node = document.createElement('div');
  node.id = 'splash';
  node.innerHTML = `
    <div class="sp-card" role="status" aria-live="polite">
      <div class="sp-logo">${logoSVG(64)}</div>
      <h2>Reading your archive</h2>
      <p class="sp-what">Getting started…</p>
      <div class="sp-track"><div class="sp-bar"></div></div>
      <p class="sp-stall" hidden></p>
      <p class="sp-note">This only takes a while the first time, or after you
         add new exports. Your exports are only being read.</p>
      <div class="sp-actions"></div>
    </div>`;
  document.body.append(node);
}

function card() {
  if (!node) build();
  return node.querySelector('.sp-card');
}

function setActions(buttons) {
  const row = card().querySelector('.sp-actions');
  row.replaceChildren();
  for (const { label, kind = 'ghost', onClick } of buttons) {
    const button = document.createElement('button');
    button.className = `sd-btn ${kind}`;
    button.textContent = label;
    button.onclick = onClick;
    row.append(button);
  }
  row.hidden = !buttons.length;
}

/** What to do if Cancel is pressed. Null hides the button. */
export function onCancel(handler) {
  cancelHandler = handler;
  if (node && !card().classList.contains('failed')) {
    setActions(handler ? [{ label: 'Cancel', onClick: () => cancelHandler?.() }] : []);
  }
}

function reset() {
  const c = card();
  if (!c.classList.contains('failed')) return;
  c.classList.remove('failed');
  c.querySelector('h2').textContent = 'Reading your archive';
  c.querySelector('.sp-track').hidden = false;
  c.querySelector('.sp-note').textContent = 'This only takes a while the first '
    + 'time, or after you add new exports. Your exports are only being read.';
}

export function show(info) {
  const c = card();
  node.hidden = false;
  reset();
  setActions(cancelHandler ? [{ label: 'Cancel', onClick: () => cancelHandler?.() }] : []);

  const total = Number(info.total) || 0;
  const done = Number(info.done) || 0;
  const bar = c.querySelector('.sp-bar');
  const what = c.querySelector('.sp-what');

  if (info.phase === 'chats' && total) {
    what.textContent = info.name
      ? `Reading ${info.name} — ${done + 1} of ${total}`
      : `Reading chat ${done + 1} of ${total}`;
    bar.style.width = `${Math.round((done / total) * 100)}%`;
    bar.classList.remove('sweeping');
  } else if (info.phase === 'search') {
    what.textContent = 'Building the search index…';
    bar.style.width = '95%';
    bar.classList.remove('sweeping');
  } else {
    // No count to show yet; a sweeping bar beats a stuck one at 0%.
    what.textContent = 'Looking for your exports…';
    bar.classList.add('sweeping');
  }
}

/** `file` is what it is stuck on, or null once things move again. */
export function stalled(file) {
  const line = card().querySelector('.sp-stall');
  if (!file) {
    line.hidden = true;
    return;
  }
  const name = file.split('/').slice(-2).join('/');
  line.textContent = `Still waiting for ${name}. If your archive is on a cloud `
    + 'or network drive, check that it is connected and that syncing is not '
    + 'paused. You can cancel at any time; nothing in your folder is changed.';
  line.hidden = false;
}

/**
 * Stop and explain. `actions` is a list of { label, kind, onClick }; with no
 * list given it offers the downloadable app's Settings, as before.
 */
export function failed(message, actions = null) {
  const c = card();
  node.hidden = false;
  c.classList.add('failed');
  c.querySelector('h2').textContent = 'The archive could not be read';
  c.querySelector('.sp-what').textContent = message;
  c.querySelector('.sp-track').hidden = true;
  c.querySelector('.sp-stall').hidden = true;
  c.querySelector('.sp-note').textContent =
    'Nothing in your exports has been changed.';

  setActions(actions ?? [{
    label: 'Open Settings',
    kind: 'accent',
    // Loaded lazily: settings pulls in most of the app, and this path is the
    // one where as little as possible should be required to work.
    onClick: async () => {
      hide();
      const settings = await import('./settings.js');
      settings.open();
      settings.reveal('backupRoot');
    },
  }]);
}

export function hide() {
  if (node) node.hidden = true;
}
