// A folder chooser, for picking the backup folder without typing a path.
//
// The browser cannot hand a real filesystem path to a page — a file input
// gives you file contents, never a directory location — so the server does the
// listing over /api/browse and this only draws it. Directories only: no file
// is opened, and nothing is read from the folders themselves.

import { icons } from './icons.js';

let dialog = null;
let resolveChoice = null;
let current = null;

const api = {
  browse: (path) =>
    fetch(`api/browse?path=${encodeURIComponent(path ?? '')}`).then((r) => r.json()),
};

function build() {
  dialog = document.createElement('div');
  dialog.id = 'picker';
  dialog.hidden = true;
  dialog.innerHTML = `
    <div class="pk-card" role="dialog" aria-labelledby="pk-title" aria-modal="true">
      <h2 id="pk-title">Choose your backup folder</h2>
      <p class="pk-help">Pick the folder that holds one sub-folder per conversation.</p>
      <div class="pk-body">
        <nav class="pk-places" aria-label="Places"></nav>
        <div class="pk-main">
          <div class="pk-path"><code></code></div>
          <div class="pk-list su-browser"></div>
        </div>
      </div>
      <p class="pk-volume"></p>
      <div class="sd-actions pk-actions">
        <button class="sd-btn ghost" data-act="cancel">Cancel</button>
        <button class="sd-btn accent" data-act="choose">Use this folder</button>
      </div>
    </div>`;

  dialog.querySelector('[data-act="cancel"]').onclick = () => finish(null);
  dialog.querySelector('[data-act="choose"]').onclick = () => finish(current);
  dialog.onclick = (event) => { if (event.target === dialog) finish(null); };
  window.addEventListener('keydown', (event) => {
    if (!dialog.hidden && event.key === 'Escape') {
      event.stopPropagation();   // don't also close the settings panel behind
      finish(null);
    }
  });
  document.body.append(dialog);
}

/**
 * Choose a folder. Resolves to a path, or null if cancelled.
 *
 * The system's own chooser is used wherever there is one — it is the window
 * people already know, it can reach places this list cannot, and picking a
 * folder in it is how macOS expects an app to be pointed at one. The built-in
 * browser stays as the fallback for machines with no chooser installed.
 */
export async function choose(startAt) {
  const native = await tryNative(startAt);
  if (native.handled) return native.path;
  return chooseInApp(startAt);
}

async function tryNative(startAt) {
  try {
    const result = await fetch('api/pickfolder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: startAt || null }),
    }).then((r) => r.json());
    if (result.ok) return { handled: true, path: result.path };
    // Dismissing the system dialog is a real answer: don't then show ours.
    if (result.cancelled) return { handled: true, path: null };
  } catch { /* no server, or no chooser here */ }
  return { handled: false };
}

/** The built-in browser, used when the system has no chooser of its own. */
export function chooseInApp(startAt) {
  if (!dialog) build();
  dialog.hidden = false;
  show(startAt || undefined);
  return new Promise((resolve) => { resolveChoice = resolve; });
}

function finish(path) {
  dialog.hidden = true;
  const done = resolveChoice;
  resolveChoice = null;
  if (done) done(path);
}

function row(label, { path, badge, kind, up }) {
  const button = document.createElement('button');
  button.className = 'su-dir' + (badge ? ' has-export' : '') + (up ? ' up' : '');
  const icon = document.createElement('span');
  icon.className = 'pk-icon';
  icon.innerHTML = up ? icons.chevronUp ?? '↑' : (icons.folder ?? '');
  const text = document.createElement('span');
  text.className = 'pk-name';
  text.textContent = label;
  button.append(icon, text);
  if (badge) {
    button.append(Object.assign(document.createElement('span'),
      { className: 'su-badge', textContent: 'exports' }));
  }
  if (kind && kind !== 'internal' && kind !== 'home') {
    button.append(Object.assign(document.createElement('span'),
      { className: 'pk-kind', textContent: kind === 'network' ? 'network' : 'drive' }));
  }
  button.onclick = () => show(path);
  return button;
}

async function show(path) {
  const list = dialog.querySelector('.pk-list');
  const data = await api.browse(path).catch((e) => ({ error: String(e.message || e) }));

  if (data.error) {
    // A refused folder is a normal thing to walk into; say so and stay put.
    list.replaceChildren(Object.assign(document.createElement('p'),
      { className: 'su-note pk-error', textContent: data.error }));
    return;
  }

  current = data.path;
  dialog.querySelector('.pk-path code').textContent = data.path;
  dialog.querySelector('.pk-volume').textContent = data.volume?.summary ?? '';

  const places = dialog.querySelector('.pk-places');
  places.replaceChildren();
  for (const place of data.places ?? []) {
    const button = row(place.name, { path: place.path, kind: place.kind });
    button.classList.add('pk-place');
    if (place.path === data.path) button.classList.add('here');
    places.append(button);
  }

  list.replaceChildren();
  if (data.parent) list.append(row(data.parent, { path: data.parent, up: true }));
  for (const entry of data.entries) {
    list.append(row(entry.name, { path: entry.path, badge: entry.export }));
  }
  if (!data.entries.length) {
    list.append(Object.assign(document.createElement('p'), {
      className: 'su-note',
      textContent: 'No sub-folders here. You can still use this folder.',
    }));
  }
}
