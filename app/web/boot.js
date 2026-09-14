// Starting the website version, from a blank page to your chats.
//
//   1. Start the service worker -- the part that keeps every request local.
//   2. Show your theme straight away, from this browser's copy of your settings.
//   3. Get the folder: reopen last visit's (Chrome, Edge) or ask for it.
//   4. Read your settings file from it, and re-index only if it has changed.
//   5. The first time only, ask which person in the chats is you. Then open.

import * as folder from './folder.js';
import * as config from './config.js';
import * as indexing from './indexing.js';
import * as bridge from './bridge.js';
import * as store from './store.js';
import * as state from '../state.js';
import * as splash from '../splash.js';
import * as log from '../log.js';
import * as setup from '../setup.js';
import * as demo from './demo.js';
import { loadManifest } from '../api.js';
import { logoSVG } from '../logo.js';
import { privacyStatement } from '../privacy.js';

let bootApp = null;
let gateNode = null;

class Unsupported extends Error {}

/**
 * Everything that has to be in place before anything is logged or fetched:
 * the log goes to this browser's storage, and media is answered by this page.
 */
export function prepare() {
  log.useTransport((batch) => store.appendLog(batch.map((entry) => ({
    t: new Date().toISOString(), src: 'app', ...entry,
  }))));
  bridge.install();
  indexing.present({ show: splash.show, stalled: splash.stalled });
}

// ---- the service worker ------------------------------------------------------

async function startServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    throw new Unsupported('This browser window does not allow the part of '
      + 'Telegram Archive that keeps your archive on your device. Private '
      + 'windows often turn it off. Open this page in a normal window of '
      + 'Chrome, Edge, Firefox or Safari.');
  }
  await navigator.serviceWorker.register('sw.js', { scope: './' });
  if (navigator.serviceWorker.controller) return;

  // First visit, or a hard reload that bypassed it: wait for it to take over.
  const claimed = new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
  });
  const ready = await navigator.serviceWorker.ready;
  ready.active?.postMessage({ type: 'claim' });
  await Promise.race([claimed, new Promise((resolve) => setTimeout(resolve, 8000))]);
  if (!navigator.serviceWorker.controller) {
    throw new Unsupported('Telegram Archive could not finish starting. Reload '
      + 'the page; if this keeps happening, try a different browser.');
  }
}

// ---- the screens before the app -----------------------------------------------

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function button(label, kind, onClick) {
  return el('button', { className: `su-btn ${kind}`, textContent: label, onclick: onClick });
}

function link(label, href) {
  return el('a', { className: 'gate-link', href, target: '_blank', rel: 'noopener', textContent: label });
}

function heading(title, sub) {
  const wrap = el('div', { className: 'su-head' }, el('h1', { textContent: title }));
  if (sub) wrap.append(el('p', { textContent: sub }));
  return wrap;
}

function logo() {
  const node = el('div', { className: 'su-logo' });
  node.innerHTML = logoSVG(84);
  return node;
}

function gate(...children) {
  if (!gateNode) {
    gateNode = el('div', { id: 'gate' });
    // A folder can be dropped anywhere on these screens.
    gateNode.addEventListener('dragover', (event) => {
      event.preventDefault();
      gateNode.classList.add('dropping');
    });
    gateNode.addEventListener('dragleave', () => gateNode.classList.remove('dropping'));
    gateNode.addEventListener('drop', (event) => {
      event.preventDefault();
      gateNode.classList.remove('dropping');
      const pending = folder.fromDrop(event.dataTransfer);   // must be synchronous
      pending.then((choice) => (choice ? openFolder(choice) : null));
    });
    document.body.append(gateNode);
  }
  gateNode.hidden = false;
  const card = el('div', { className: 'su-card gate-card' }, ...children);
  gateNode.replaceChildren(card);
  return card;
}

function hideGate() {
  if (gateNode) gateNode.hidden = true;
}

const isChromium = () => Boolean(navigator.userAgentData?.brands?.some((b) => /Chromium/.test(b.brand)))
  || /Chrome\//.test(navigator.userAgent);

function browserNote() {
  if (folder.canUseHandles()) {
    return 'Your browser will ask to let this page view the folder. That stays '
      + 'on this device, and next time it can open the folder again for you.';
  }
  if (isChromium()) {
    return 'Your browser will ask to “upload” the folder. Nothing is uploaded: '
      + 'that is only its word for letting a page read files. You will choose the '
      + 'folder again on each visit, and use Save (bottom left) after changing settings.';
  }
  return 'This browser opens the folder for this visit only, so you will choose '
    + 'it again next time. It cannot save into the folder, so use Save (bottom '
    + 'left) after changing settings.';
}

function chooser() {
  const wrap = el('div', { className: 'gate-choose' });
  const pick = button('Choose your Telegram Archive folder…', 'primary', async () => {
    const choice = folder.canUseHandles()
      ? await folder.pickWithHandle().catch(() => null)
      : await folder.pickWithInput();
    if (choice) await openFolder(choice);
  });
  const tryDemo = button('Try a demo instead', 'ghost', () => enterDemo());
  tryDemo.classList.add('gate-demo');
  wrap.append(
    pick,
    el('p', { className: 'gate-drop', textContent: 'or drag the folder onto this window' }),
    el('p', { className: 'su-note', textContent: browserNote() }),
    el('p', { className: 'gate-or', textContent: 'No exports yet? Look around an example first.' }),
    tryDemo,
  );
  return wrap;
}

function guides() {
  return el('div', { className: 'gate-guides' },
    el('b', { textContent: 'Before you start' }),
    el('ol', {},
      el('li', {}, 'Export your chats from Telegram Desktop as JSON. ',
        link('How to export', 'help/#export')),
      el('li', {}, 'Put them in a folder: Telegram Archive › Backups › one folder per chat. ',
        link('Where to put them', 'help/#folder'))));
}

function showWelcome() {
  gate(
    logo(),
    heading('Telegram Archive',
      'A private reader for your Telegram chat exports, right here in your browser.'),
    privacyStatement({ heading: true }),
    guides(),
    chooser(),
  );
}

function showWelcomeBack() {
  const details = el('details', { className: 'gate-privacy' },
    el('summary', { textContent: 'Your privacy' }), privacyStatement({ heading: false }));
  gate(
    logo(),
    heading('Welcome back', 'Open your Telegram Archive folder to carry on.'),
    chooser(),
    details,
    el('p', { className: 'su-note' }, link('How to export more chats', 'help/#export')),
  );
}

function showReconnect(handle) {
  gate(
    logo(),
    heading('Welcome back', `Carry on with “${handle.name}”.`),
    el('div', { className: 'su-actions' },
      button('Choose a different folder', 'ghost', () => showWelcomeBack()),
      button('Continue', 'primary', async () => {
        const access = await folder.askPermission(handle, 'read');
        if (access === 'granted') await openFolder({ kind: 'handle', name: handle.name, handle });
      })),
    el('p', { className: 'su-note',
      textContent: 'Your browser asks once per visit before this page can read the folder again.' }),
  );
}

function showBusy(text) {
  gate(logo(), heading(text));
}

function showUnsupported(message) {
  gate(logo(), heading('This window can’t run Telegram Archive'),
    el('p', { className: 'gate-message', textContent: message }));
}

function showFailed(message, { cancelled = false } = {}) {
  gate(
    heading(cancelled ? 'Indexing stopped' : 'Your archive could not be read'),
    el('p', { className: 'gate-message', textContent: message }),
    el('p', { className: 'su-note', textContent: 'Nothing in your folder was changed.' }),
    el('div', { className: 'su-actions' },
      button('Choose a different folder', 'ghost', () => showWelcomeBack()),
      button('Try again', 'primary', () => ensureIndexThenBoot())),
  );
}

function showEmpty(active) {
  const actions = el('div', { className: 'su-actions' },
    button('Choose a different folder', 'ghost', () => showWelcomeBack()));
  if (active.kind === 'handle') {
    actions.append(button('Create a Backups folder here', 'primary', async () => {
      if (await folder.createBackupsFolder()) showReadyForExports();
    }));
  }
  gate(
    heading('This folder is empty',
      'Telegram Archive keeps your exports in a folder called Backups, inside '
      + 'the folder you choose.'),
    el('p', { className: 'gate-message', textContent: active.kind === 'handle'
      ? 'It can make that Backups folder for you, or you can choose a folder '
        + 'that already has your exports in it.'
      : 'Make a folder called Backups inside it, put your exports there, then '
        + 'choose this folder again.' }),
    el('p', { className: 'su-note' }, link('How to export your chats', 'help/#export')),
    actions,
  );
}

function showReadyForExports() {
  gate(
    heading('Backups folder created',
      'Put your exported chats in it, one folder per chat, then press Continue.'),
    el('p', { className: 'su-note' }, link('How to export your chats', 'help/#export')),
    el('div', { className: 'su-actions' },
      button('Continue', 'primary', async () => {
        await folder.refresh();
        await config.load();
        await ensureIndexThenBoot();
      })),
  );
}

// ---- the demo --------------------------------------------------------------------

/**
 * Load the built-in example archive. It opens like a folder you picked, so it
 * runs through the same indexer and viewer -- but it is marked as a demo, so
 * nothing is saved and nothing touches your disk.
 */
async function enterDemo() {
  showBusy('Loading the demo…');
  try {
    const { name, entries, config: demoConfig } = await demo.buildDemoArchive();
    await folder.open({ kind: 'files', name, entries });
    config.enterDemo(demoConfig);
    state.adopt(demoConfig.settings);
    log.info('demo.entered');
    await ensureIndexThenBoot();
    showDemoBar();
  } catch (error) {
    log.warn('demo.failed', { reason: error?.message ?? null });
    showFailed('The demo could not be loaded. Try reloading the page.');
  }
}

/** A pill over the app while the demo is open, with the way back out. */
function showDemoBar() {
  if (document.getElementById('demo-bar')) return;
  const bar = el('div', { id: 'demo-bar' },
    el('span', { className: 'demo-label' },
      'Demo — an example archive. Nothing here is yours, and nothing is saved.'),
    button('Exit demo', 'primary', () => location.reload()));
  document.body.append(bar);
}

// ---- opening the folder ---------------------------------------------------------

async function openFolder(choice) {
  showBusy('Opening your folder…');
  let active;
  try {
    active = await folder.open(choice);
  } catch (error) {
    log.warn('folder.open_failed', { kind: error?.name ?? null });
    showFailed('That folder could not be opened. Check it is still there, then choose it again.');
    return;
  }
  log.info('folder.opened', { kind: active.kind, layout: active.layout });
  if (active.layout === 'empty') {
    showEmpty(active);
    return;
  }

  await config.load();
  state.adopt(config.get().settings);
  wireSaveButton();
  await ensureIndexThenBoot();
}

async function ensureIndexThenBoot() {
  if (!(await indexing.isCurrent())) {
    hideGate();
    splash.onCancel(() => indexing.cancel());
    const result = await indexing.run({ selfId: config.get().self.id });
    splash.onCancel(null);
    if (!result.ok) {
      splash.hide();
      log.warn('index.stopped', { cancelled: Boolean(result.cancelled), kind: result.kind ?? null });
      showFailed(result.error, { cancelled: Boolean(result.cancelled) });
      return;
    }
    log.info('index.finished', { chats: result.chats, seconds: result.seconds, ...result.report });
  }
  splash.hide();
  hideGate();

  if (!config.get().setup_complete) {
    const manifest = await loadManifest().catch(() => null);
    setup.start({ onFinish: () => bootApp(), startAt: 'identity', manifest });
    return;
  }
  await bootApp();
}

// ---- saving where the browser will not ----------------------------------------

let saveWired = false;

/** The Save button in the sidebar, for browsers that cannot save by themselves. */
function wireSaveButton() {
  config.guardUnsaved();
  const button = document.getElementById('btn-save');
  if (!button || saveWired) return;
  saveWired = true;

  const refresh = (s = config.status()) => {
    const byHand = !s.autosave || s.problem === 'permission';
    button.hidden = !byHand;
    button.classList.toggle('dirty', s.dirty);
    button.title = s.autosave
      ? 'Allow saving into your folder'
      : (s.dirty ? 'Save your settings file — you have unsaved changes' : 'Save your settings file');
  };
  config.subscribe(refresh);
  refresh();

  button.onclick = async () => {
    const s = config.status();
    if (s.autosave) {
      if (await folder.allowSaving()) await config.save().catch(() => {});
    } else {
      await config.save();
    }
  };
}

// ---- start ------------------------------------------------------------------------

export async function start(app) {
  bootApp = app;
  try {
    await startServiceWorker();
  } catch (error) {
    log.warn('sw.unavailable', { reason: error?.message ?? null });
    showUnsupported(error instanceof Unsupported ? error.message : String(error?.message ?? error));
    return;
  }

  const cached = await config.cachedSettings().catch(() => null);
  if (cached) state.adopt(cached);

  const remembered = await folder.recall();
  if (remembered) {
    const access = await folder.permission(remembered, 'read');
    if (access === 'granted') {
      await openFolder({ kind: 'handle', name: remembered.name, handle: remembered });
      return;
    }
    showReconnect(remembered);
    return;
  }
  if (cached) showWelcomeBack();
  else showWelcome();
}

// Exported so an automated check can open a folder it already holds, the
// same way a picked or dropped folder is opened. It grants nothing extra:
// the caller must already have the folder.
export { openFolder };

/** Called from Settings: pick a different folder and start again from it. */
export async function changeFolder() {
  const choice = folder.canUseHandles()
    ? await folder.pickWithHandle().catch(() => null)
    : await folder.pickWithInput();
  if (!choice) return false;
  await folder.open(choice);
  await config.load();
  config.reloadWithoutPrompt();
  return true;
}
