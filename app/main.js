// Bootstrap: wire the theme, the sidebar and the chat pane together.

import { loadManifest } from './api.js';
import * as state from './state.js';
import * as theme from './theme.js';
import * as sidebar from './sidebar.js';
import * as chat from './chat.js';
import * as settings from './settings.js';
import * as keyboard from './keyboard.js';
import * as shutdown from './shutdown.js';
import * as lifetime from './lifetime.js';
import * as splash from './splash.js';
import * as log from './log.js';
import * as setup from './setup.js';
import * as peers from './peers.js';
import * as profile from './profile.js';
import * as webBoot from './web/boot.js';
import { api, isWeb } from './platform.js';
import { icons } from './icons.js';
import { INDEX_SCHEMA } from './version.js';

function paintIcons() {
  for (const node of document.querySelectorAll('[data-icon]')) {
    node.innerHTML = icons[node.dataset.icon] ?? '';
  }
}

function fail(message, detail) {
  const empty = document.getElementById('chat-empty');
  empty.hidden = false;
  empty.innerHTML = '';
  const h = document.createElement('p');
  h.textContent = message;
  h.style.cssText = 'font-size:15px;font-weight:600;color:var(--text);margin:0 0 10px';
  const p = document.createElement('p');
  p.textContent = detail;
  p.style.cssText = 'font-size:13px;line-height:1.55;margin:0;text-align:left';
  const box = document.createElement('div');
  box.append(h, p);
  empty.append(box);
}

/**
 * Explain *why* there is no index.
 *
 * On macOS a backup folder inside Documents, Desktop or Downloads is readable
 * from Terminal but blocked for an app launched from the Dock — the folder is
 * plainly there, and listing it fails. Saying "no index found" in that case
 * sends people looking in entirely the wrong place.
 */
async function failWithReason() {
  let info = null;
  try {
    info = await fetch('api/config').then((r) => r.json());
  } catch { /* no server API; fall through to the generic message */ }

  if (info?.root_exists && info.root_readable === false) {
    const mac = info.platform === 'darwin';
    fail(
      'Your backup folder cannot be read.',
      mac
        ? `macOS is blocking access to ${info.resolved_root}. Documents, `
          + 'Desktop and Downloads are protected, and an app opened from the '
          + 'Dock is denied without a prompt. Either move your archive out of '
          + 'those folders, or grant Telegram Archive access under System '
          + 'Settings › Privacy & Security › Files and Folders. Opening '
          + '"Start Viewer.command" instead also works.'
        : `The folder at ${info.resolved_root} exists but cannot be listed. `
          + 'Check its permissions.',
    );
    return;
  }

  if (info?.config?.backup_root && !info.root_exists) {
    fail(
      'Backup folder not found.',
      `Nothing at ${info.config.backup_root}. Open Settings → Archive to point `
      + 'it somewhere else, then Rebuild the index.',
    );
    return;
  }

  fail(
    'No index yet.',
    'Open Settings → Archive, pick your backup folder, then Rebuild the index.',
  );
}

async function start() {
  // The website's log goes to this browser's storage and nowhere else. That
  // has to be settled before the first line is logged.
  if (isWeb) webBoot.prepare();
  log.init();
  theme.init();
  paintIcons();

  if (isWeb) {
    // No local server to stop: closing the tab is all it takes.
    document.getElementById('btn-power').hidden = true;
    await webBoot.start(() => boot());
    return;
  }

  lifetime.init();
  await state.hydrate();
  theme.apply();

  // The window now opens before indexing has finished, so wait for a first
  // run to complete rather than booting into an index that is still being
  // written. Previously the launcher blocked here instead, which meant a big
  // archive showed nothing at all for minutes.
  await waitForIndexing();

  // Setup state lives on disk, not in localStorage, so it survives clearing
  // browser data and reappears only when explicitly reset from Settings.
  if (!(await setup.isComplete())) {
    setup.start({ onFinish: () => boot() });
    return;
  }
  await boot();
}

/** Show indexing progress until it finishes, if a run is under way. */
function waitForIndexing() {
  return new Promise((resolve) => {
    let shown = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stop?.();
      if (shown) splash.hide();
      resolve();
    };

    // Nothing running: don't flash a loading screen at someone for 40ms.
    const decide = setTimeout(() => {
      if (!lifetime.status()) finish();
    }, 1200);

    // Cancel stops the downloadable app's indexer, which leaves nothing half
    // done that matters: the next launch simply starts it again.
    splash.onCancel(() => api.cancelIndex());

    const stop = lifetime.onStatus((info) => {
      if (!info) return;
      if (info.running) {
        clearTimeout(decide);
        shown = true;
        splash.show(info);
        return;
      }
      clearTimeout(decide);
      if (info.ok === false && info.error) {
        shown = true;
        splash.failed(info.error);
        return;   // deliberately stays up: this needs reading, not dismissing
      }
      finish();
    });
  });
}

async function boot() {
  document.getElementById('btn-settings').onclick = () =>
    (settings.isOpen() ? settings.close() : settings.open());
  if (!isWeb) document.getElementById('btn-power').onclick = shutdown.open;

  let manifest;
  try {
    manifest = await loadManifest();
  } catch {
    await failWithReason();
    return;
  }

  // An index written by a different build is not something to half-read. The
  // number was already being stamped into the manifest; nothing checked it,
  // so a format change would have surfaced as inexplicable breakage after an
  // update rather than as a sentence saying what to do.
  if (Number(manifest.schema) !== INDEX_SCHEMA) {
    log.warn('index.schema_mismatch',
             { found: manifest.schema, expected: INDEX_SCHEMA });
    await offerRebuild(manifest.schema);
    return;
  }

  // The indexer's detection is the default; the Archive settings can override.
  const selfId = state.get('selfId') || manifest.self_id;
  if (!state.get('selfId') && manifest.self_id) state.set('selfId', manifest.self_id);
  chat.init(manifest);
  peers.init(manifest, state.get('peerColors'));
  settings.init({ onReload: () => chat.reopen(selfId) });

  const openChat = (entry) => {
    state.set('lastChat', entry.slug);
    sidebar.clearSearch();
    sidebar.select(entry.slug);
    chat.open(entry, selfId);
  };

  profile.configure({
    selfId,
    onOpenChat: openChat,
    // A colour change has to reach every rendered name, quote and avatar.
    onColorChange: () => {
      state.set('peerColors', peers.allOverrides());
      chat.reopen(selfId);
    },
  });
  keyboard.init({
    stepChat: (delta) => sidebar.step(delta),
    jumpToLatest: () => chat.jumpToLatest(),
    jumpToStart: () => chat.jumpToStart(),
    toggleProfile: () => chat.openProfile(),
  });
  sidebar.init(manifest, {
    onSelect: (entry) => {
      state.set('lastChat', entry.slug);
      chat.open(entry, selfId);
    },
    // A global-search result opens its chat and lands on the message.
    onOpenAt: (entry, messageId) => {
      state.set('lastChat', entry.slug);
      // Return to the chat list so the opened chat reads as selected, the
      // way picking a result does in the app.
      sidebar.clearSearch();
      sidebar.select(entry.slug);
      chat.openAt(entry, selfId, messageId);
    },
  });

  // An archive with nothing in it is a normal place to be -- it is exactly
  // what pointing at a fresh folder gives you. The shell stays fully alive so
  // Settings can be opened and the folder repointed; the alternative was a
  // dead window with no way out but editing config.json by hand.
  if (!manifest.chats.length) {
    await showEmptyArchive();
    return;
  }

  // Reopen whatever was last read, falling back to the most recent chat.
  const remembered = manifest.chats.find((c) => c.slug === state.get('lastChat'));
  const initial = remembered ?? manifest.chats[0];
  sidebar.select(initial.slug);
  chat.open(initial, selfId);
}

/**
 * An index from another version: offer to rebuild instead of breaking.
 *
 * Rebuilding only ever re-reads the exports, so this is always safe to accept
 * -- worth saying, because being told your index is the wrong version sounds
 * a lot like being told your archive is damaged.
 */
async function offerRebuild(found) {
  const empty = document.getElementById('chat-empty');
  empty.hidden = false;
  empty.replaceChildren();

  const title = document.createElement('p');
  title.textContent = 'The index needs rebuilding';
  title.style.cssText =
    'font-size:15px;font-weight:600;color:var(--text);margin:0 0 10px';

  const detail = document.createElement('p');
  detail.style.cssText =
    'font-size:13px;line-height:1.55;margin:0 0 14px;text-align:left';
  detail.textContent =
    `This index was written by a different version of Telegram Archive `
    + `(format ${found ?? 'unknown'}, this build reads ${INDEX_SCHEMA}). `
    + 'Rebuilding re-reads your exports; nothing in them is changed.';

  const action = document.createElement('button');
  action.className = 'st-btn';
  action.textContent = 'Rebuild now';
  action.onclick = async () => {
    action.disabled = true;
    action.textContent = 'Rebuilding…';
    await api.reindex().catch(() => {});
    location.reload();
  };

  const box = document.createElement('div');
  box.append(title, detail, action);
  empty.append(box);
}

/** The chat pane when the backup folder holds no exports. */
async function showEmptyArchive() {
  let where = null;
  try {
    const info = await api.config();
    where = info?.resolved_root ?? info?.config?.backup_root ?? null;
  } catch { /* the path is a nicety here, not the point */ }

  const empty = document.getElementById('chat-empty');
  empty.hidden = false;
  empty.replaceChildren();

  const title = document.createElement('p');
  title.textContent = 'No chats here yet';
  title.style.cssText =
    'font-size:15px;font-weight:600;color:var(--text);margin:0 0 10px';

  const detail = document.createElement('p');
  detail.style.cssText = 'font-size:13px;line-height:1.55;margin:0 0 14px;text-align:left';
  if (isWeb) {
    detail.textContent = `Nothing in “${where ?? 'this folder'}” looks like a `
      + 'Telegram export yet. Put your exports in its Backups folder, one folder '
      + 'per chat, then use Rebuild the index in Settings.';
  } else {
    detail.textContent = where
      ? `Nothing in ${where} looks like a Telegram export. Drop your export `
        + 'folders in there, or point somewhere else.'
      : 'Add your Telegram exports to your backup folder, or point somewhere else.';
  }

  const action = document.createElement('button');
  action.textContent = isWeb ? 'How to export your chats' : 'Choose backup folder…';
  action.className = 'st-btn';
  action.onclick = () => {
    if (isWeb) {
      window.open('help/#export', '_blank', 'noopener');
      return;
    }
    settings.open();
    settings.reveal('backupRoot');
  };

  const box = document.createElement('div');
  box.append(title, detail, action);
  empty.append(box);
}

start();
