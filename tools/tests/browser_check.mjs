#!/usr/bin/env node
// End-to-end check of the website version, in a real browser.
//
//   python3 tools/build_site.py
//   node tools/tests/browser_check.mjs [--browser PATH] [--shots DIR]
//
// What it does, in order:
//
//   1. Serves site/ on this computer, and writes down every single request
//      that reaches that server.
//   2. Starts a Chrome-family browser (Chrome, Chromium, Edge or Brave) with a
//      brand-new profile in a temporary folder -- never your own browser
//      profile -- in headless mode.
//   3. Makes a small invented archive inside the browser's private storage and
//      opens it the way a folder you picked is opened.
//   4. Goes through setup, then checks that the chats and a photo appear and
//      that the settings file was written into the folder, and nothing else was.
//   5. Does it again the way Safari, Firefox and Brave work -- no saving into
//      the folder -- and checks the settings file is offered as a download and
//      that unsaved changes are tracked.
//   6. Fails if any request tried to reach another website, or if anything but
//      the app's own published files ever reached the web server. That last
//      check is the proof that nothing from an archive leaves the browser.

import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = path.join(APP_DIR, 'site');

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};

const failures = [];
const passes = [];
const check = (ok, label, detail = '') => {
  (ok ? passes : failures).push(detail ? `${label} — ${detail}` : label);
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// ---- the web server, which remembers everything asked of it ------------------

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const received = [];

function serve() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    received.push({ method: request.method, path: url.pathname, query: url.search });
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(SITE, rel);
    if (!file.startsWith(SITE + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- a browser with a throwaway profile ----------------------------------------

function findBrowser() {
  const given = flag('--browser') ?? process.env.BROWSER;
  if (given) return given;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function launch(binary, profile) {
  const child = spawn(binary, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--window-size=1280,860',
    'about:blank',
  ], { stdio: 'ignore' });

  // The browser writes the port it picked into the profile folder.
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i += 1) {
    try {
      const [port] = (await fs.readFile(portFile, 'utf8')).split('\n');
      if (port) return { child, port: Number(port) };
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('the browser did not start');
}

// ---- talking to it ---------------------------------------------------------------

class Session {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const fn of this.listeners.get(message.method) ?? []) fn(message.params, message.sessionId);
      }
    };
    return this;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  close() {
    this.socket.close();
  }
}

/** One tab, in its own storage compartment, with everything it does recorded. */
class Tab {
  constructor(browser, contextId, targetId, sessionId) {
    Object.assign(this, { browser, contextId, targetId, sessionId });
    this.requests = [];
    this.problems = [];
    this.dialogs = [];
  }

  static async open(browser, label) {
    const { browserContextId } = await browser.send('Target.createBrowserContext');
    const { targetId } = await browser.send('Target.createTarget',
      { url: 'about:blank', browserContextId });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(browser, browserContextId, targetId, sessionId);
    tab.label = label;
    for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await tab.send(`${domain}.enable`);
    browser.on('Network.requestWillBeSent', (params, from) => {
      if (from === sessionId) tab.requests.push(params.request.url);
    });
    browser.on('Runtime.exceptionThrown', (params, from) => {
      if (from === sessionId) tab.problems.push(params.exceptionDetails?.exception?.description
        ?? params.exceptionDetails?.text ?? 'exception');
    });
    browser.on('Runtime.consoleAPICalled', (params, from) => {
      if (from === sessionId && params.type === 'error') {
        tab.problems.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    browser.on('Log.entryAdded', (params, from) => {
      const { entry } = params;
      // A 404 is how the viewer learns a picture has not been set; not a fault.
      if (from === sessionId && entry.level === 'error' && !/status of 404/.test(entry.text)) {
        tab.problems.push(entry.text);
      }
    });
    browser.on('Page.javascriptDialogOpening', (params, from) => {
      if (from === sessionId) tab.dialogs.push(params.type);
    });
    return tab;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  async run(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async waitFor(expression, what, timeout = 20000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try {
        if (await this.run(`Boolean(${expression})`)) return true;
      } catch { /* the page may be mid-navigation */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async go(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor(`document.readyState === 'complete'`, 'the page to load');
  }

  async shot(dir, name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(dir, `${name}.png`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    return file;
  }

  close() {
    return this.browser.send('Target.disposeBrowserContext', { browserContextId: this.contextId });
  }
}

// ---- the invented archive ---------------------------------------------------------

// Runs inside the page. Builds Telegram Archive/Backups/... in the browser's
// private storage and returns a list of every path in it, for comparing later.
const MAKE_ARCHIVE = `(async () => {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
  const dir = async (parent, name) => parent.getDirectoryHandle(name, { create: true });
  const put = async (parent, name, data) => {
    const w = await (await parent.getFileHandle(name, { create: true })).createWritable();
    await w.write(data); await w.close();
  };
  const archive = await dir(root, 'Telegram Archive');
  const backups = await dir(archive, 'Backups');

  const canvas = new OffscreenCanvas(320, 200);
  const g = canvas.getContext('2d');
  g.fillStyle = '#3e8ef7'; g.fillRect(0, 0, 320, 200);
  g.fillStyle = '#ffffff'; g.font = 'bold 40px sans-serif'; g.fillText('a photo', 80, 115);
  const png = await canvas.convertToBlob({ type: 'image/png' });

  const me = ['Alex', 'user9000000001'];
  const say = (id, at, who, text, extra = {}) => ({
    id, type: 'message', date_unixtime: String(at), from: who[0], from_id: who[1],
    text, text_entities: text ? [{ type: 'plain', text }] : [], ...extra,
  });

  const robin = ['Robin', 'user9000000002'];
  const robinExport = await dir(await dir(backups, 'Robin'), 'ChatExport_2024-03-01');
  const photos = await dir(robinExport, 'photos');
  await put(photos, 'photo_1.png', png);
  const robinMessages = [];
  for (let i = 1; i <= 40; i += 1) {
    robinMessages.push(say(i, 1709300000 + i * 90, i % 2 ? me : robin, 'message number ' + i));
  }
  robinMessages.push(say(41, 1709300000 + 41 * 90, robin, '', {
    photo: 'photos/photo_1.png', photo_file_size: png.size, width: 320, height: 200 }));
  robinMessages.push(say(42, 1709300000 + 42 * 90, me, 'lovely', { reply_to_message_id: 41 }));
  await put(robinExport, 'result.json', JSON.stringify({
    name: 'Robin', type: 'personal_chat', id: 1, messages: robinMessages }));

  const jordan = ['Jordan', 'user3'];
  const jordanExport = await dir(await dir(backups, 'Jordan'), 'ChatExport_2024-02-01');
  await put(jordanExport, 'result.json', JSON.stringify({
    name: 'Jordan', type: 'personal_chat', id: 2,
    messages: [say(1, 1706000000, jordan, 'hello there'), say(2, 1706000100, me, 'hi')] }));

  return true;
})()`;

const LIST_ARCHIVE = `(async () => {
  const root = await navigator.storage.getDirectory();
  const out = [];
  const walk = async (handle, prefix) => {
    for await (const [name, child] of handle.entries()) {
      const rel = prefix ? prefix + '/' + name : name;
      if (child.kind === 'directory') await walk(child, rel); else out.push(rel);
    }
  };
  await walk(await root.getDirectoryHandle('Telegram Archive'), '');
  return out.sort();
})()`;

const READ_CONFIG = `(async () => {
  const root = await navigator.storage.getDirectory();
  const archive = await root.getDirectoryHandle('Telegram Archive');
  const handle = await archive.getFileHandle('telegram-archive-config.json');
  return JSON.parse(await (await handle.getFile()).text());
})()`;

const clickButton = (scope, label) => `(() => {
  const button = [...document.querySelectorAll('${scope} button')]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled);
  if (!button) throw new Error('no button: ' + ${JSON.stringify(label)});
  button.click();
  return true;
})()`;

// ---- the two walk-throughs -------------------------------------------------------

async function autosaving(browser, base, shots) {
  console.log('\nChrome and Edge: a folder that can be saved into');
  const tab = await Tab.open(browser, 'autosave');
  await tab.go(base);
  await tab.waitFor(`document.querySelector('#gate .gate-choose')`, 'the welcome screen');
  check(true, 'service worker took charge and the welcome screen appeared');
  const welcome = await tab.run(`document.querySelector('#gate').innerText`);
  check(/Your privacy/.test(welcome) && /cannot send them anywhere/.test(welcome),
    'the privacy statement is on the welcome screen');
  check(/How to export/.test(welcome) && /Where to put them/.test(welcome),
    'the export instructions are linked from the welcome screen');
  await tab.shot(shots, '1-welcome');

  await tab.run(MAKE_ARCHIVE);
  const before = await tab.run(LIST_ARCHIVE);
  await tab.run(`(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getDirectoryHandle('Telegram Archive');
    const boot = await import('./app/web/boot.js');
    boot.openFolder({ kind: 'handle', name: handle.name, handle });
    return true;
  })()`);

  await tab.waitFor(`document.querySelector('#setup .su-peers')`, 'the "which one is you" step', 30000);
  check(true, 'the folder was indexed and setup asked who you are');
  const suggested = await tab.run(`document.querySelector('#setup .su-peer.on b')?.textContent`);
  check(suggested === 'Alex', 'it worked out which person is you', `picked ${suggested}`);
  await tab.shot(shots, '2-identity');
  await tab.run(clickButton('#setup', 'Continue'));
  await tab.waitFor(`[...document.querySelectorAll('#setup button')].some((b) => b.textContent.includes("Let's go"))`, 'the last setup step');
  await tab.run(clickButton('#setup', "Let's go"));

  await tab.waitFor(`document.querySelectorAll('#chat-list > *').length >= 2`, 'the chat list');
  const chats = await tab.run(`[...document.querySelectorAll('#chat-list > *')].map((n) => n.innerText.split('\\n')[0])`);
  check(chats.includes('Robin') && chats.includes('Jordan'), 'both chats are listed', chats.join(', '));
  await tab.waitFor(`[...document.querySelectorAll('#message-column img')].some((i) => i.src.includes('/media/') && i.naturalWidth > 0)`,
    'the photo to load', 15000);
  check(true, 'a photo from the folder loaded, straight from disk');
  await tab.shot(shots, '3-chat');

  await new Promise((resolve) => setTimeout(resolve, 1200));    // autosave settles
  const config = await tab.run(READ_CONFIG);
  check(config.setup_complete === true && config.self.id === 'user9000000001',
    'the settings file was written into the folder', 'telegram-archive-config.json');
  const after = await tab.run(LIST_ARCHIVE);
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  check(added.length === 1 && added[0] === 'telegram-archive-config.json' && !removed.length,
    'nothing else in the folder changed', added.length ? `added: ${added.join(', ')}` : 'nothing added');
  const buttonHidden = await tab.run(`document.getElementById('btn-save').hidden`);
  check(buttonHidden, 'no Save button is needed where saving is automatic');

  await tab.run(`document.getElementById('btn-settings').click()`);
  await tab.waitFor(`document.querySelector('#settings .fund')`, 'the fund panel');
  const fund = await tab.run(`document.querySelector('#settings .fund').innerText`);
  check(/Apple Developer License Fund/.test(fund) && /\\$0 of \\$99/.test(fund),
    'the fund panel shows at the top of Settings', fund.replace(/\\n/g, ' / '));
  const bottom = await tab.run(`(() => {
    const body = document.querySelector('#settings .st-body');
    body.scrollTop = body.scrollHeight;
    return body.lastElementChild?.className;
  })()`);
  check(bottom === 'privacy', 'the privacy statement is at the bottom of Settings');
  await tab.shot(shots, '4-settings-bottom');
  await tab.run(`(() => { const b = document.querySelector('#settings .st-body'); b.scrollTop = 0; })()`);
  await tab.shot(shots, '5-settings-top');

  await tab.close();
  return tab;
}

async function byHand(browser, base, shots) {
  console.log('\nSafari, Firefox and Brave: settings saved by hand');
  const tab = await Tab.open(browser, 'by-hand');
  const downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'ta-downloads-'));
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloads, browserContextId: tab.contextId,
  });
  await tab.go(base);
  await tab.waitFor(`document.querySelector('#gate .gate-choose')`, 'the welcome screen');
  await tab.run(MAKE_ARCHIVE);

  // The shape a picked or dropped folder takes in those browsers: a list of files.
  await tab.run(`(async () => {
    const root = await navigator.storage.getDirectory();
    const top = await root.getDirectoryHandle('Telegram Archive');
    const entries = [];
    const walk = async (handle, prefix) => {
      for await (const [name, child] of handle.entries()) {
        const rel = prefix ? prefix + '/' + name : name;
        if (child.kind === 'directory') await walk(child, rel);
        else entries.push([rel, await child.getFile()]);
      }
    };
    await walk(top, '');
    const boot = await import('./app/web/boot.js');
    boot.openFolder({ kind: 'files', name: 'Telegram Archive', entries });
    return true;
  })()`);

  await tab.waitFor(`document.querySelector('#setup .su-peers')`, 'setup', 30000);
  await tab.run(clickButton('#setup', 'Continue'));
  await tab.waitFor(`[...document.querySelectorAll('#setup button')].some((b) => b.textContent.includes('Download settings'))`,
    'the download-and-start button');
  const note = await tab.run(`document.querySelector('#setup').innerText`);
  check(/can’t save into your folder/.test(note), 'setup explains the settings file will be downloaded');
  await tab.run(clickButton('#setup', 'Download settings & start'));
  await tab.waitFor(`document.querySelectorAll('#chat-list > *').length >= 2`, 'the chat list');

  let downloaded = null;
  for (let i = 0; i < 50 && !downloaded; i += 1) {
    const names = await fs.readdir(downloads).catch(() => []);
    const found = names.find((n) => n.startsWith('telegram-archive-config') && n.endsWith('.json'));
    if (found) downloaded = JSON.parse(await fs.readFile(path.join(downloads, found), 'utf8'));
    else await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check(downloaded?.setup_complete === true, 'the settings file was handed over as a download');

  const visible = await tab.run(`!document.getElementById('btn-save').hidden`);
  check(visible, 'the Save button is shown in the sidebar');
  await tab.run(`(async () => {
    const state = await import('./app/state.js');
    state.set('bubbleRadius', 20);
    return true;
  })()`);
  await tab.waitFor(`document.getElementById('btn-save').classList.contains('dirty')`,
    'the unsaved-changes dot', 5000);
  check(true, 'a changed setting is marked unsaved on the Save button');
  await tab.shot(shots, '6-unsaved');

  await tab.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  check(tab.dialogs.includes('beforeunload'), 'leaving with unsaved changes asks first');
  if (tab.dialogs.length) await tab.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});

  await tab.close();
  await fs.rm(downloads, { recursive: true, force: true });
  return tab;
}

// ---- run it -------------------------------------------------------------------------

async function main() {
  if (!existsSync(path.join(SITE, 'app-shell.json'))) {
    console.error('Build the site first: python3 tools/build_site.py');
    return 2;
  }
  const binary = findBrowser();
  if (!binary) {
    console.log('No Chrome-family browser found; skipping the browser check.');
    return 0;
  }
  const shots = flag('--shots') ?? await fs.mkdtemp(path.join(os.tmpdir(), 'ta-shots-'));
  await fs.mkdir(shots, { recursive: true });

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ta-profile-'));
  const { child, port } = await launch(binary, profile);
  console.log(`browser: ${path.basename(binary)} (throwaway profile)\nsite:    ${base}`);

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = await new Session(version.webSocketDebuggerUrl).open();
  const tabs = [];
  try {
    tabs.push(await autosaving(browser, base, shots));
    tabs.push(await byHand(browser, base, shots));
  } catch (error) {
    check(false, 'walk-through finished', error.message);
  } finally {
    // ---- what the web server and the pages saw ----
    console.log('\nWhat left the browser');
    const shell = JSON.parse(await fs.readFile(path.join(SITE, 'app-shell.json'), 'utf8'));
    const allowed = new Set(['', 'index.html', 'sw.js', 'app-shell.json', ...shell.files]);
    const strays = received.filter((r) => r.method !== 'GET'
      || !allowed.has(decodeURIComponent(r.path).replace(/^\/+/, '')) || r.query);
    check(!strays.length, 'the web server was asked only for the app\'s own files',
      strays.length ? strays.map((r) => `${r.method} ${r.path}${r.query}`).join(', ')
        : `${received.length} requests, all app files`);
    const archiveish = received.filter((r) => /^\/(media|data)\//.test(r.path));
    check(!archiveish.length, 'no index, media or picture request ever reached the server');

    const origin = new URL(base).origin;
    for (const tab of tabs) {
      const foreign = tab.requests.filter((u) => !u.startsWith(origin)
        && !u.startsWith('data:') && !u.startsWith('blob:') && u !== 'about:blank');
      check(!foreign.length, `no request to any other website (${tab.label})`,
        foreign.slice(0, 5).join(', '));
      check(!tab.problems.length, `no errors in the page (${tab.label})`,
        tab.problems.slice(0, 3).join(' | '));
    }

    browser.close();
    child.kill();
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passes.length} passed, ${failures.length} failed. Screenshots: ${shots}`);
  return failures.length ? 1 : 0;
}

process.exitCode = await main();
