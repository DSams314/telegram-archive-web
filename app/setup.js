// First-run setup.
//
// Runs once. `setup_complete` lives in data/config.json on disk, not in
// localStorage, so it survives clearing browser data and only comes back if
// the user asks for it from Settings.
//
// The order matters: the folder is chosen and indexed *before* identity is
// asked for, because once an index exists the app can offer the real
// participant list instead of asking someone to go hunting for a `from_id`.

import { avatarNode } from './message.js';
import { icons } from './icons.js';
import { logoSVG } from './logo.js';
import { cropToSquare } from './cropper.js';
import { api, isWeb } from './platform.js';

// The mark lives in logo.js so the wizard, the shutdown dialog and the
// generated app icon can never drift apart.

let root = null;
let onFinish = () => {};
const draft = { backupRoot: '', selfId: '', selfName: '', avatar: null };
let manifest = null;
let step = 0;
let firstStep = 0;

/** Has setup been completed? Answered by the server, not the browser. */
export async function isComplete() {
  try {
    const { config } = await api.config();
    return !!config.setup_complete;
  } catch {
    // No server API (someone is opening the files directly): don't block them.
    return true;
  }
}

export async function start(handlers) {
  onFinish = handlers.onFinish;
  // The website has already opened the folder and built the index by the time
  // setup runs, so it starts at "which one is you", with that index in hand.
  firstStep = handlers.startAt === 'identity' ? 2 : 0;
  if (handlers.manifest) manifest = handlers.manifest;
  const info = await api.config().catch(() => ({ config: {} }));
  const config = info.config ?? {};
  // Prefer the absolute path the server resolved: config may hold a path
  // relative to the program folder, which means nothing to the picker.
  draft.backupRoot = info.resolved_root ?? config.backup_root ?? '';
  draft.selfId = config.self?.id ?? '';
  draft.selfName = config.self?.name ?? '';

  root = document.createElement('div');
  root.id = 'setup';
  document.body.append(root);
  step = firstStep;
  render();
}

// ---- shell ---------------------------------------------------------------

function render() {
  const card = document.createElement('div');
  card.className = 'su-card';
  card.append([welcome, folder, identity, done][step]());

  const dots = document.createElement('div');
  dots.className = 'su-dots';
  for (let i = firstStep; i < 4; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'su-dot' + (i === step ? ' on' : '');
    dots.append(dot);
  }
  card.append(dots);

  root.replaceChildren(card);
  // Re-trigger the entry animation on every step change.
  card.animate(
    [{ opacity: 0, transform: 'translateY(10px) scale(.99)' }, { opacity: 1, transform: 'none' }],
    { duration: 320, easing: 'cubic-bezier(.2,.9,.3,1.06)' },
  );
}

const go = (to) => { step = to; render(); };

function actions(...buttons) {
  const row = document.createElement('div');
  row.className = 'su-actions';
  row.append(...buttons);
  return row;
}

function button(label, kind, onClick) {
  const el = document.createElement('button');
  el.className = `su-btn ${kind}`;
  el.textContent = label;
  el.onclick = onClick;
  return el;
}

function heading(title, sub) {
  const wrap = document.createElement('div');
  wrap.className = 'su-head';
  wrap.append(Object.assign(document.createElement('h1'), { textContent: title }));
  if (sub) wrap.append(Object.assign(document.createElement('p'), { textContent: sub }));
  return wrap;
}

// ---- step 1: welcome -----------------------------------------------------

function welcome() {
  const pane = document.createElement('div');
  pane.className = 'su-pane su-welcome';

  const logo = document.createElement('div');
  logo.className = 'su-logo';
  logo.innerHTML = logoSVG(96);

  pane.append(
    logo,
    heading('Welcome to Telegram Archive',
      'A private reader for your Telegram chat exports. Everything stays on '
      + 'this machine — nothing is uploaded, and your exports are never modified.'),
    actions(button('Continue', 'primary', () => go(1))),
  );
  return pane;
}

// ---- step 2: backup folder ----------------------------------------------

function folder() {
  const pane = document.createElement('div');
  pane.className = 'su-pane';
  pane.append(heading('Where are your exports?',
    'Pick the folder that holds one sub-folder per conversation. '
    + 'Folders that already contain exports are marked.'));

  const pathRow = document.createElement('div');
  pathRow.className = 'su-path';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '/Users/you/Telegram Backups';
  input.value = draft.backupRoot;
  pathRow.append(input);

  const list = document.createElement('div');
  list.className = 'su-browser';

  const note = document.createElement('p');
  note.className = 'su-note';

  const next = button('Continue', 'primary', async () => {
    draft.backupRoot = input.value.trim();
    if (!draft.backupRoot) { note.textContent = 'Pick a folder first.'; return; }
    next.disabled = true;
    next.textContent = 'Indexing…';
    note.textContent = 'Reading your exports. A large archive can take a minute.';

    await api.save({ backup_root: draft.backupRoot });
    const result = await api.reindex();
    if (!result.ok) {
      next.disabled = false;
      next.textContent = 'Continue';
      note.textContent = (result.output || result.error || 'Indexing failed.')
        .split('\n').filter(Boolean).slice(-2).join(' — ');
      return;
    }
    manifest = await fetch('data/index/manifest.json').then((r) => r.json());
    draft.selfId ||= manifest.self_id ?? '';
    go(2);
  });

  async function show(path) {
    const data = await api.browse(path).catch((e) => ({ error: String(e) }));
    list.replaceChildren();
    if (data.error) {
      list.append(Object.assign(document.createElement('p'),
        { className: 'su-note', textContent: data.error }));
      return;
    }
    input.value = data.path;
    draft.backupRoot = data.path;

    if (data.parent) {
      const up = document.createElement('button');
      up.className = 'su-dir up';
      up.textContent = '↑  ' + data.parent;
      up.onclick = () => show(data.parent);
      list.append(up);
    }
    for (const entry of data.entries) {
      const row = document.createElement('button');
      row.className = 'su-dir' + (entry.export ? ' has-export' : '');
      row.textContent = entry.name;
      if (entry.export) {
        row.append(Object.assign(document.createElement('span'),
          { className: 'su-badge', textContent: 'exports' }));
      }
      row.onclick = () => show(entry.path);
      list.append(row);
    }
    if (!data.entries.length) {
      list.append(Object.assign(document.createElement('p'),
        { className: 'su-note', textContent: 'No sub-folders here.' }));
    }
  }

  input.onchange = () => show(input.value.trim());
  show(draft.backupRoot || undefined);

  pane.append(pathRow, list, note,
    actions(button('Back', 'ghost', () => go(0)), next));
  return pane;
}

// ---- step 3: identity ----------------------------------------------------

function identity() {
  const pane = document.createElement('div');
  pane.className = 'su-pane';
  pane.append(heading('Which one is you?',
    'Your messages go on the right, in your accent colour. '
    + 'This was detected from your exports — change it if it looks wrong.'));

  // Every participant across every chat, most-messages first.
  const peers = new Map();
  for (const chat of manifest?.chats ?? []) {
    for (const peer of chat.peers ?? []) {
      const at = peers.get(peer.id) ?? { ...peer, messages: 0, chats: 0 };
      at.messages += peer.messages;
      at.chats += 1;
      peers.set(peer.id, at);
    }
  }
  // Most chats first: the account owner is the one person in every conversation.
  const ranked = [...peers.values()].sort((a, b) => b.chats - a.chats || b.messages - a.messages);

  // The detection already picked someone, so seed the name from them rather
  // than leaving the field blank next to a highlighted row.
  const detected = ranked.find((p) => p.id === draft.selfId) ?? ranked[0];
  if (detected) {
    draft.selfId ||= detected.id;
    draft.selfName ||= detected.name;
  }

  const choices = document.createElement('div');
  choices.className = 'su-peers';
  for (const peer of ranked.slice(0, 6)) {
    const row = document.createElement('button');
    row.className = 'su-peer' + (peer.id === draft.selfId ? ' on' : '');
    row.append(avatarNode(peer.name, 38));
    const body = document.createElement('div');
    body.append(Object.assign(document.createElement('b'), { textContent: peer.name }));
    body.append(Object.assign(document.createElement('span'), {
      textContent: `${peer.id} · in ${peer.chats} chat${peer.chats === 1 ? '' : 's'}`
        + ` · ${peer.messages.toLocaleString()} messages`,
    }));
    row.append(body);
    row.onclick = () => {
      draft.selfId = peer.id;
      draft.selfName ||= peer.name;
      for (const other of choices.children) other.classList.remove('on');
      row.classList.add('on');
      nameInput.value = draft.selfName;
    };
    choices.append(row);
  }

  const help = document.createElement('details');
  help.className = 'su-help';
  help.append(Object.assign(document.createElement('summary'),
    { textContent: 'Not listed? How to find your ID' }));
  help.append(Object.assign(document.createElement('p'), {
    textContent: 'Open any result.json from your exports and find a message you '
      + 'sent. Its "from_id" is yours — it looks like user123456789 and is the '
      + 'same in every chat. You can also paste it below.',
  }));
  const manual = document.createElement('input');
  manual.type = 'text';
  manual.placeholder = 'user0000000000';
  manual.value = draft.selfId;
  manual.onchange = () => { draft.selfId = manual.value.trim(); };
  help.append(manual);

  const fields = document.createElement('div');
  fields.className = 'su-fields';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Your display name';
  nameInput.value = draft.selfName;
  nameInput.onchange = () => { draft.selfName = nameInput.value.trim(); };

  const photoRow = document.createElement('div');
  photoRow.className = 'su-photo';
  const preview = avatarNode(draft.selfName || 'You', 56, null, 'self');
  const pick = button('Choose photo…', 'ghost', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const cropped = await cropToSquare(file);
      if (!cropped) return;          // cancelled
      draft.avatar = cropped;
      const url = URL.createObjectURL(draft.avatar);
      preview.replaceChildren(Object.assign(document.createElement('img'), { src: url }));
      preview.style.background = 'none';
    };
    input.click();
  });
  photoRow.append(preview, pick);

  fields.append(nameInput, photoRow);
  const next = button('Continue', 'primary', () => go(3));
  pane.append(choices, fields, help, firstStep < 2
    ? actions(button('Back', 'ghost', () => go(1)), next)
    : actions(next));
  return pane;
}

// ---- step 4: finish ------------------------------------------------------

function done() {
  const pane = document.createElement('div');
  pane.className = 'su-pane su-welcome';

  const chats = manifest?.chats?.length ?? 0;
  const messages = (manifest?.chats ?? []).reduce((n, c) => n + c.messages, 0);

  const logo = document.createElement('div');
  logo.className = 'su-logo';
  logo.innerHTML = logoSVG(96);

  pane.append(
    logo,
    heading('All set',
      `${chats} conversation${chats === 1 ? '' : 's'} · `
      + `${messages.toLocaleString()} messages indexed.`),
  );

  // A browser that cannot save into the folder hands the file over instead.
  const automatic = api.savesAutomatically?.() ?? true;
  if (!automatic) {
    pane.append(Object.assign(document.createElement('p'), {
      className: 'su-note',
      textContent: 'This browser can’t save into your folder by itself, so the '
        + 'button below downloads your settings file, telegram-archive-config.json. '
        + 'Put it in your Telegram Archive folder, next to Backups, and your '
        + 'settings will be there next time.',
    }));
  }

  const finish = button(automatic ? "Let's go" : 'Download settings & start', 'primary', async () => {
    finish.disabled = true;
    finish.textContent = 'Saving…';
    if (draft.avatar) {
      const saved = await api.avatar('self', draft.avatar).catch(() => null);
      if (saved?.url) draft.avatarURL = saved.url;
    }
    await api.save({
      backup_root: draft.backupRoot,
      setup_complete: true,
      self: {
        id: draft.selfId || null,
        name: draft.selfName || null,
        avatar: draft.avatarURL ?? null,
      },
    });
    // Still inside the click: the browser only asks to save into a folder, or
    // lets a download start, in direct response to one.
    if (isWeb) await api.persist({ download: !automatic }).catch(() => {});
    root.remove();
    onFinish();
  });

  pane.append(actions(button('Back', 'ghost', () => go(2)), finish));
  return pane;
}

// ---- helpers -------------------------------------------------------------

export { api };
