// The settings screen: rendered from the schema, searched against the schema.

import * as state from './state.js';
import { GROUPS, SETTINGS, BY_ID, matches, available } from './settings-schema.js';
import { importThemeFile } from './theme-import.js';
import { api, isWeb } from './platform.js';
import { cropToSquare } from './cropper.js';
import * as picker from './folderpicker.js';
import * as splash from './splash.js';
import { icons } from './icons.js';
import { VERSION_LABEL } from './version.js';
import { privacyStatement } from './privacy.js';
import { fundCard, loadFund } from './fund.js';
import * as webConfig from './web/config.js';
import * as webFolder from './web/folder.js';
import * as webBoot from './web/boot.js';

let panel = null;
let onReload = () => {};
let statusTimer = 0;
let configWatch = null;

// A search that should still show the privacy statement at the bottom.
const PRIVACY_WORDS = /privacy|private|track|cookie|github|safe|upload|data/i;

export function init(handlers) {
  onReload = handlers.onReload ?? (() => {});

  // Any setting flagged `reload` needs the open chat rebuilt to take effect.
  state.subscribe((key) => {
    if (BY_ID.get(key)?.reload) onReload();
  });
}

function build() {
  panel = document.createElement('section');
  panel.id = 'settings';
  panel.hidden = true;
  panel.innerHTML = `
    <header class="st-head">
      <div class="st-titlebar">
        <h2>Settings</h2>
        <span class="st-version">${VERSION_LABEL}</span>
      </div>
      <button class="icon-btn st-close" aria-label="Close">${icons.close}</button>
    </header>
    <div class="st-fund" hidden></div>
    <div class="st-searchwrap">
      <input id="st-search" type="search" placeholder="Search settings"
             autocomplete="off" spellcheck="false">
    </div>
    <div class="st-status" hidden></div>
    <div class="st-body scroll"></div>`;

  panel.querySelector('.st-close').onclick = close;
  panel.querySelector('#st-search').addEventListener('input', (e) => {
    render(e.target.value);
  });
  document.getElementById('chat-pane').append(panel);
}

export function isOpen() {
  return panel != null && !panel.hidden;
}

export function close() {
  if (panel) panel.hidden = true;
}

export function open() {
  if (!panel) build();
  panel.hidden = false;
  render('');
  panel.querySelector('#st-search').focus();
  hydrateFromConfig();
  refreshFund();
}

/** The fund panel: re-read each time, so the bar moves when it is updated. */
async function refreshFund() {
  const slot = panel.querySelector('.st-fund');
  const fund = await loadFund();
  if (!fund) {
    slot.hidden = true;
    return;
  }
  slot.replaceChildren(fundCard(fund));
  slot.hidden = false;
}

/**
 * Fill the config-backed settings in from data/config.json.
 *
 * These few live on disk rather than in localStorage, so the browser has no
 * copy of them to render -- which left the Backup folder box looking empty
 * even when a folder was set. An empty box invites you to type a path from
 * memory instead of correcting the one already there.
 */
/**
 * Bring the Storage row up to date.
 *
 * Deliberately an indicator and not an error: a drive that is unplugged is a
 * fact about the desk, not a fault in the settings, and it explains an empty
 * archive at a glance.
 */
export async function refreshVolume() {
  const badge = panel?.querySelector('[data-setting="volumeStatus"] .st-status-pill');
  if (!badge) return;
  const info = await api.config().catch(() => null);
  const volume = info?.volume;
  if (!volume) {
    badge.dataset.state = 'unknown';
    badge.textContent = 'Unknown';
    return;
  }
  badge.textContent = volume.summary || 'Unknown';
  badge.dataset.state = volume.connected
    ? 'ok'
    : (volume.kind === 'detached' ? 'away' : 'bad');
}

async function hydrateFromConfig() {
  if (!isWeb) {
    refreshVolume();
    migrateWallpaper();
  }
  const info = await api.config().catch(() => null);
  const config = info?.config;
  if (!config) return;
  const disk = {
    selfId: config.self?.id ?? '',
    selfName: config.self?.name ?? '',
  };
  // The website has no path to show: a browser never reveals one.
  if (!isWeb) disk.backupRoot = info.resolved_root ?? config.backup_root ?? '';
  for (const [id, value] of Object.entries(disk)) {
    if (!value || state.get(id) === value) continue;
    state.set(id, value);
    const field = panel.querySelector(`[data-setting="${id}"] input`);
    // Never overwrite a box being typed into; the save on blur would lose it.
    if (field && document.activeElement !== field) field.value = value;
  }
}

function status(message, tone = 'ok') {
  const bar = panel.querySelector('.st-status');
  bar.textContent = message;
  bar.dataset.tone = tone;
  bar.hidden = false;
  clearTimeout(statusTimer);
  // Failures stay put. They tend to be instructions -- which System Settings
  // pane to open, which switch to turn on -- and six seconds is not long
  // enough to read one, let alone act on it.
  if (tone === 'ok') statusTimer = setTimeout(() => { bar.hidden = true; }, 6000);
}

// ---- rendering -----------------------------------------------------------

function render(query) {
  const body = panel.querySelector('.st-body');
  body.replaceChildren();

  configWatch?.();
  configWatch = null;
  const visible = SETTINGS.filter((s) => available(s) && matches(s, query));
  const showPrivacy = !query.trim() || PRIVACY_WORDS.test(query);
  if (!visible.length && !showPrivacy) {
    body.append(Object.assign(document.createElement('p'), {
      className: 'hint', textContent: `Nothing matches “${query}”.`,
    }));
    return;
  }

  for (const group of GROUPS) {
    const items = visible.filter((s) => s.group === group);
    if (!items.length) continue;

    const section = document.createElement('div');
    section.className = 'st-group';
    section.append(Object.assign(document.createElement('h3'), {
      textContent: group,
    }));
    for (const setting of items) section.append(rowFor(setting));
    body.append(section);
  }
  // Where everything above ends up, said plainly at the bottom.
  if (showPrivacy) body.append(privacyStatement());
  // Rendering rebuilds every row, so anything filled in asynchronously has to
  // be filled in again — searching would otherwise leave "Checking…" forever.
  if (!isWeb) refreshVolume();
}

/** Scroll a setting into view and flash it, for links from elsewhere. */
export function reveal(id) {
  const row = panel?.querySelector(`[data-setting="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('st-flash');
  void row.offsetWidth;   // restart the animation if it is already running
  row.classList.add('st-flash');
  row.querySelector('input, button')?.focus();
}

function rowFor(setting) {
  const row = document.createElement('div');
  row.className = 'st-row';
  row.dataset.setting = setting.id;
  if (setting.type === 'action') row.classList.add('st-action-row');

  const label = document.createElement('div');
  label.className = 'st-label';
  label.append(Object.assign(document.createElement('b'), {
    textContent: setting.label,
  }));
  if (setting.help) {
    label.append(Object.assign(document.createElement('span'), {
      textContent: setting.help,
    }));
  }

  const control = document.createElement('div');
  control.className = 'st-control';
  control.append(controlFor(setting));

  row.append(label, control);
  return row;
}

function controlFor(setting) {
  const value = state.get(setting.id);

  switch (setting.type) {
    case 'toggle': {
      const button = document.createElement('button');
      button.className = 'st-toggle';
      button.setAttribute('role', 'switch');
      button.setAttribute('aria-checked', String(!!value));
      button.onclick = () => {
        const next = !state.get(setting.id);
        state.set(setting.id, next);
        button.setAttribute('aria-checked', String(next));
      };
      return button;
    }

    case 'select': {
      const select = document.createElement('select');
      select.className = 'st-select';
      for (const [key, text] of setting.options) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = text;
        option.selected = key === value;
        select.append(option);
      }
      select.onchange = () => state.set(setting.id, select.value);
      return select;
    }

    case 'range': {
      const wrap = document.createElement('div');
      wrap.className = 'st-range';
      const input = document.createElement('input');
      Object.assign(input, {
        type: 'range', min: setting.min, max: setting.max,
        step: setting.step, value,
      });
      const readout = document.createElement('span');
      readout.textContent = `${value}${setting.unit ?? ''}`;
      input.oninput = () => {
        readout.textContent = `${input.value}${setting.unit ?? ''}`;
        state.set(setting.id, Number(input.value));
      };
      wrap.append(input, readout);
      return wrap;
    }

    case 'color': {
      const wrap = document.createElement('div');
      wrap.className = 'st-color';
      for (const preset of setting.presets ?? []) {
        const dot = document.createElement('button');
        dot.className = 'st-swatch';
        dot.style.background = preset;
        dot.title = preset;
        dot.onclick = () => { state.set(setting.id, preset); input.value = preset; };
        wrap.append(dot);
      }
      const input = document.createElement('input');
      input.type = 'color';
      input.value = value;
      input.oninput = () => state.set(setting.id, input.value);
      wrap.append(input);
      return wrap;
    }

    case 'text': {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'st-text';
      input.value = value ?? '';
      input.readOnly = !!setting.readonly;
      input.placeholder = setting.readonly ? '(from data/config.json)' : '';
      input.onchange = () => {
        const value = input.value.trim();
        state.set(setting.id, value);
        if (setting.saveTo === 'config') saveToConfig(setting.id, value);
      };
      if (!setting.browse) return input;

      // Typing a path from memory is the worst part of this setting, so the
      // field keeps working but is no longer the only way in.
      const wrap = document.createElement('div');
      wrap.className = 'st-path';
      const browse = document.createElement('button');
      browse.className = 'st-btn';
      browse.textContent = 'Browse…';
      browse.onclick = async () => {
        // The system dialog is a separate window and can open behind this
        // one, which leaves the button looking dead. Say what is happening.
        const previous = browse.textContent;
        browse.textContent = 'Waiting…';
        browse.disabled = true;
        status('Choose a folder in the window that just opened. '
             + 'If you cannot see it, look behind this window.');
        try {
          const chosen = await picker.choose(input.value.trim());
          if (!chosen || chosen === input.value.trim()) return;
          input.value = chosen;
          state.set(setting.id, chosen);
          saveToConfig(setting.id, chosen);
        } finally {
          browse.textContent = previous;
          browse.disabled = false;
        }
      };
      wrap.append(input, browse);
      return wrap;
    }

    case 'wallpaper': {
      const wrap = document.createElement('div');
      wrap.className = 'st-wallpaper';

      const select = document.createElement('select');
      select.className = 'st-select';
      for (const [key, text] of setting.options) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = text;
        option.selected = key === value;
        // "Your photo" only becomes selectable once one has been uploaded.
        option.disabled = key === 'custom' && !state.get('customWallpaper');
        select.append(option);
      }
      select.onchange = () => state.set(setting.id, select.value);

      const upload = document.createElement('button');
      upload.className = 'st-button';
      upload.textContent = state.get('customWallpaper') ? 'Replace photo…' : 'Upload photo…';
      upload.onclick = () => pickFile('image/*', async (file) => {
        try {
          const url = await storeWallpaper(await downscale(file));
          state.merge({ customWallpaper: url, wallpaper: 'custom' });
          status('Background updated.');
          render(panel.querySelector('#st-search').value);
        } catch (error) {
          status(`Could not use that image: ${error.message}`, 'bad');
        }
      });

      wrap.append(select, upload);
      if (state.get('customWallpaper')) {
        const clear = document.createElement('button');
        clear.className = 'st-button';
        clear.textContent = 'Remove';
        clear.onclick = async () => {
          await api.clearWallpaper();
          state.merge({ customWallpaper: null, wallpaper: 'default' });
          status('Custom background removed.');
          render(panel.querySelector('#st-search').value);
        };
        wrap.append(clear);
      }
      return wrap;
    }

    case 'folder': {
      const wrap = document.createElement('div');
      wrap.className = 'st-path';
      const name = document.createElement('span');
      name.className = 'st-folder-name';
      name.textContent = webFolder.active()?.name ?? 'No folder open';
      const change = document.createElement('button');
      change.className = 'st-btn';
      change.textContent = 'Change…';
      change.onclick = () => webBoot.changeFolder();
      wrap.append(name, change);
      return wrap;
    }

    case 'configfile':
      return configFileControl();

    case 'action': {
      const button = document.createElement('button');
      button.className = 'st-button' + (setting.danger ? ' st-danger' : '');
      button.textContent = ACTION_LABEL[setting.action] ?? 'Run';
      button.onclick = () => ACTIONS[setting.action]?.();
      return button;
    }

    case 'status': {
      // Read-only, and filled in by refreshVolume() once the server answers.
      const badge = document.createElement('span');
      badge.className = 'st-status-pill';
      badge.dataset.state = 'unknown';
      badge.textContent = 'Checking…';
      return badge;
    }

    default:
      return document.createTextNode('');
  }
}

// ---- actions -------------------------------------------------------------

const ACTION_LABEL = {
  rebuild: 'Rebuild now',
  diagnostics: 'Save report…',
  rerunSetup: 'Run setup',
  selfAvatar: 'Choose photo…',
  importTheme: 'Choose file…',
  clearTheme: 'Clear',
  exportSettings: 'Export',
  importSettings: 'Choose file…',
  reset: 'Reset',
  openHelp: 'Open guide',
  forgetFolder: 'Forget…',
};

/**
 * The web version's settings-file row: where settings are being kept, and
 * the buttons to save or load them by hand.
 */
function configFileControl() {
  const wrap = document.createElement('div');
  wrap.className = 'st-configfile';
  const line = document.createElement('span');
  line.className = 'st-save-state';
  const buttons = document.createElement('div');
  buttons.className = 'st-buttons';
  const save = document.createElement('button');
  save.className = 'st-btn';
  const load = document.createElement('button');
  load.className = 'st-btn';
  load.textContent = 'Load file…';
  load.onclick = () => pickFile('.json,application/json', async (file) => {
    try {
      await webConfig.importFile(file);
      status('Settings loaded. Reloading…');
      setTimeout(() => webConfig.reloadWithoutPrompt(), 600);
    } catch (error) {
      status(`Could not use that file: ${error.message}`, 'bad');
    }
  });
  buttons.append(save, load);
  wrap.append(line, buttons);

  const paint = (s) => {
    const layout = webFolder.active()?.layout;
    if (s.autosave && s.problem === 'permission') {
      line.textContent = 'Saving into your folder needs your permission.';
      save.textContent = 'Allow saving';
      save.onclick = async () => {
        if (await webFolder.allowSaving()) await webConfig.save().catch(() => {});
      };
    } else if (s.autosave) {
      line.textContent = s.state === 'saving'
        ? 'Saving…'
        : (s.problem ? `Could not save: ${s.problem}` : 'Saved automatically in your folder.');
      save.textContent = s.problem ? 'Try again' : 'Save now';
      save.onclick = () => webConfig.save().catch(() => {});
    } else {
      const why = layout === 'exports'
        ? 'This folder holds your exports directly, so nothing is saved into it.'
        : 'This browser can’t save into folders.';
      line.textContent = s.dirty
        ? `${why} You have unsaved changes: press Save, then put the file in your `
          + 'Telegram Archive folder, replacing the old one.'
        : `${why} All changes are saved. Save again after changing anything.`;
      save.textContent = 'Save settings file';
      save.onclick = () => webConfig.save();
    }
    save.classList.toggle('accent', Boolean(s.dirty));
  };
  paint(webConfig.status());
  configWatch = webConfig.subscribe(paint);
  return wrap;
}

/**
 * Re-encode an uploaded image before storing it.
 *
 * The background lives in localStorage, which holds only a few megabytes, and
 * a phone photo as a raw data URL blows straight past that. Downscaling to a
 * sensible screen size and re-encoding as JPEG keeps it well inside the quota
 * while still looking right behind blurred panels.
 */
const MAX_WALLPAPER_EDGE = 2560;
const MAX_WALLPAPER_BYTES = 3_000_000;

/**
 * Put the background on disk, beside the profile pictures.
 *
 * localStorage was the wrong home for it: clearing browser data lost it, it
 * counted against a quota shared with every other setting, and it did not
 * travel with the rest of the program's own files. data/ survives updates.
 */
function storeWallpaper(dataURL) {
  // The app keeps it as a file in data/; the website keeps the image itself
  // inside your settings file, so it travels with the rest of your settings.
  return api.wallpaper(dataURL);
}

/**
 * Move a background saved by an older version onto disk.
 *
 * Runs once: earlier versions kept the picture inline in localStorage, and
 * those setups should gain the same durability without being asked to pick
 * their photo again.
 */
async function migrateWallpaper() {
  const current = state.get('customWallpaper');
  if (typeof current !== 'string' || !current.startsWith('data:')) return;
  try {
    state.set('customWallpaper', await storeWallpaper(current));
  } catch { /* leave the working data: URL alone if the move fails */ }
}

async function downscale(file) {
  if (!file.type.startsWith('image/')) throw new Error('not an image');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_WALLPAPER_EDGE / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // Step the quality down until it fits, rather than failing on a large photo.
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const dataURL = canvas.toDataURL('image/jpeg', quality);
    if (dataURL.length <= MAX_WALLPAPER_BYTES) return dataURL;
  }
  throw new Error('image is too large even re-compressed');
}

/**
 * Mirror an Archive setting into data/config.json.
 *
 * These few belong on disk rather than in localStorage: the server needs the
 * backup path, and identity should survive clearing browser data.
 */
function saveToConfig(id, value) {
  const body = id === 'backupRoot'
    ? { backup_root: value }
    : { self: { [id === 'selfId' ? 'id' : 'name']: value } };
  api.save(body).then(
    (result) => {
      // The server refuses a folder it cannot read, so say so now rather than
      // letting the next rebuild be the thing that fails.
      if (result?.error) return status(result.error, 'bad');
      if (id !== 'backupRoot') return undefined;
      // It also normalises what it accepted; show the path actually stored.
      const saved = result?.config?.backup_root;
      if (saved && saved !== value) {
        state.set('backupRoot', saved);
        const field = panel.querySelector('[data-setting="backupRoot"] input');
        if (field) field.value = saved;
      }
      refreshVolume();
      // Some folders are readable now but sit somewhere macOS guards. Saying
      // so here is the whole point: they look completely ordinary in a picker
      // and only cause trouble later, on someone else's machine.
      if (result?.caution) {
        return status(`Backup folder saved.\n\n${result.caution.message}`,
                      result.caution.severity === 'blocked' ? 'bad' : 'warn');
      }
      return status('Backup folder saved. Rebuild the index to pick up changes.');
    },
    () => status('Could not write config.json.', 'bad'),
  );
}

function pickFile(accept, handler) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = () => { if (input.files?.[0]) handler(input.files[0]); };
  input.click();
}

const ACTIONS = {
  async rebuild() {
    if (isWeb) {
      splash.onCancel(() => api.cancelIndex());
      const result = await api.reindex();
      splash.onCancel(null);
      splash.hide();
      if (result.ok) {
        status('Index rebuilt. Reloading…');
        setTimeout(() => webConfig.reloadWithoutPrompt(), 500);
      } else {
        status(result.cancelled
          ? 'Rebuild stopped. Reload the page to build the index again.'
          : `Rebuild failed.\n\n${result.error}`, 'bad');
      }
      return;
    }
    status('Rebuilding the index…');
    const result = await api
      .reindex()
      .catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (result.ok) {
      const tail = (result.output || '').trim().split('\n').filter(Boolean).slice(-3).join(' · ');
      status(`Index rebuilt. ${tail} — reload to see the changes.`);
    } else {
      // The server has already reduced this to the part worth reading; a raw
      // traceback tells the person nothing they can act on.
      status(`Rebuild failed.\n\n${result.error || 'Unknown error.'}`, 'bad');
    }
  },

  async diagnostics() {
    status('Writing the report…');
    const result = await api.diagnostics()
      .catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (!result.ok) {
      return status(`Could not write the report: ${result.error || 'unknown error'}`,
                    'bad');
    }
    if (result.downloaded) {
      return status('Report downloaded. Names were taken out of it first, and it '
        + 'has not been sent anywhere. Share it yourself if you want help.', 'warn');
    }
    return status(
      `Report saved and shown in your file manager:\n${result.path}\n\n`
      + `The full, unredacted log is always at:\n${result.raw_log}`,
      'warn');
  },

  async rerunSetup() {
    await api.save({ setup_complete: false });
    if (isWeb) webConfig.reloadWithoutPrompt();
    else location.reload();
  },

  openHelp() {
    window.open('help/', '_blank', 'noopener');
  },

  async forgetFolder() {
    const unsaved = webConfig.isDirty() && !webFolder.savableLayout();
    const sure = window.confirm('Forget this folder on this device?\n\n'
      + 'This browser will stop remembering the folder, and its index and its '
      + 'copy of your settings are deleted. Your folder, and the settings file '
      + 'inside it, are not touched.'
      + (unsaved ? '\n\nYou have settings changes that are not saved to your '
        + 'folder yet. They will be lost.' : ''));
    if (!sure) return;
    try { localStorage.clear(); } catch { /* nothing was stored there */ }
    await webFolder.forget();
    webConfig.reloadWithoutPrompt();
  },

  selfAvatar() {
    pickFile('image/*', async (file) => {
      try {
        const blob = await cropToSquare(file);
        if (!blob) return;                 // cancelled
        const saved = await api.avatar('self', blob);
        if (!saved?.url) throw new Error(saved?.error ?? 'save failed');
        status('Profile photo saved.');
      } catch (error) {
        status(`Could not save the photo: ${error.message}`, 'bad');
      }
    });
  },

  importTheme() {
    pickFile('.attheme,.tdesktop-theme,.tdesktop-palette,.zip', async (file) => {
      try {
        const theme = await importThemeFile(file);
        state.set('importedTheme', theme);
        status(
          `Imported “${theme.name}” — matched ${theme.matched} of ${theme.total} `
          + `colour keys, read as a ${theme.mode} theme`
          + `${theme.wallpaper ? ', with its background' : ''}.`,
        );
        render(panel.querySelector('#st-search').value);
      } catch (error) {
        status(`Could not read that theme: ${error.message}`, 'bad');
      }
    });
  },

  clearTheme() {
    if (!state.get('importedTheme')) { status('No theme imported.'); return; }
    state.set('importedTheme', null);
    status('Imported theme cleared.');
  },

  exportSettings() {
    const blob = new Blob([JSON.stringify(state.all(), null, 2)],
      { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'telegram-archive-settings.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    status('Settings exported.');
  },

  importSettings() {
    pickFile('.json,application/json', async (file) => {
      try {
        const values = JSON.parse(await file.text());
        if (typeof values !== 'object' || !values) throw new Error('not an object');
        state.merge(values);
        status('Settings imported.');
        render('');
      } catch (error) {
        status(`Could not read that file: ${error.message}`, 'bad');
      }
    });
  },

  async reset() {
    state.reset();
    // Clearing settings also clears the record that setup ran, so the next
    // load starts from the welcome screen -- which is what "reset" implies.
    await api.save({ setup_complete: false }).catch(() => {});
    status('Everything reset. Reloading…');
    setTimeout(() => (isWeb ? webConfig.reloadWithoutPrompt() : location.reload()), 700);
  },
};
