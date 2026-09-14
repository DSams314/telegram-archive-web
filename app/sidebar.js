// Left pane: the chat list, its filter box, and the drag-to-resize handle.

import * as state from './state.js';
import { backedUpLabel, listDate } from './format.js';
import { avatarNode } from './message.js';
import { search, hydrate } from './search.js';
import { resultRow } from './chat.js';

const listEl = document.getElementById('chat-list');
const searchEl = document.getElementById('search');
const sidebarEl = document.getElementById('sidebar');
const resizerEl = document.getElementById('resizer');

let chats = [];
let selected = null;
let onSelect = () => {};
let onOpenAt = () => {};
let searchToken = 0;

export function init(manifest, handlers) {
  chats = manifest.chats;
  onSelect = handlers.onSelect;
  onOpenAt = handlers.onOpenAt;
  applyWidth(state.get('sidebarWidth'));
  initResizer();

  let debounce = 0;
  searchEl.addEventListener('input', () => {
    // Chat-name filtering is instant; the message index waits for a pause.
    render(searchEl.value);
    clearTimeout(debounce);
    debounce = setTimeout(() => runGlobalSearch(searchEl.value), 200);
  });
  searchEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { searchEl.value = ''; render(''); }
  });

  render('');
}

/** Move the selection by `delta` chats, wrapping at both ends. */
export function step(delta) {
  if (!chats.length) return;
  const at = chats.findIndex((c) => c.slug === selected);
  const next = chats[(at + delta + chats.length) % chats.length];
  select(next.slug);
  onSelect(next);
  listEl.querySelector(`.chat-row[data-slug="${next.slug}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

/** Drop back to the chat list, e.g. after opening a search result. */
export function clearSearch() {
  if (!searchEl.value) return;
  searchEl.value = '';
  searchToken += 1;
  listEl.onscroll = null;
  render('');
}

export function select(slug) {
  selected = slug;
  for (const row of listEl.children) {
    row.setAttribute?.('aria-selected', String(row.dataset.slug === slug));
  }
}

function render(query) {
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? chats.filter((c) => c.name.toLowerCase().includes(needle))
    : chats;

  listEl.replaceChildren();
  searchToken += 1; // invalidate any message search still in flight

  if (!needle) {
    for (const chat of chats) listEl.append(row(chat));
    return;
  }

  if (visible.length) {
    listEl.append(sectionLabel('Chats'));
    for (const chat of visible) listEl.append(row(chat));
  }
  // The message section is appended by runGlobalSearch once the index answers.
  listEl.append(Object.assign(document.createElement('div'), {
    id: 'global-results',
  }));
}

/** Search every message in every chat, newest first. */
async function runGlobalSearch(query) {
  const mine = ++searchToken;
  const holder = document.getElementById('global-results');
  if (!holder || !query.trim()) return;

  holder.replaceChildren(sectionLabel('Messages'), hint('Searching…'));

  const { hits, tokens } = await search(query);
  if (mine !== searchToken) return;

  if (!hits.length) {
    holder.replaceChildren(sectionLabel('Messages'), hint('No messages found.'));
    return;
  }

  holder.replaceChildren(
    sectionLabel(`Messages · ${hits.length.toLocaleString()}`),
  );

  let offset = 0;
  let loading = false;
  let done = false;

  const more = async () => {
    if (loading || done) return;
    loading = true;
    // Only the page being displayed is hydrated, so a query matching thousands
    // of messages still touches just a handful of chunks.
    const { results, done: finished } = await hydrate(hits, { chats }, offset);
    if (mine !== searchToken) return;
    for (const { chat, message } of results) {
      holder.append(resultRow(chat, message, tokens, onOpenAt));
    }
    offset += results.length;
    done = finished || !results.length;
    loading = false;
  };

  await more();

  // Infinite scroll for the remaining pages.
  listEl.onscroll = () => {
    if (mine !== searchToken) return;
    if (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 300) more();
  };
}

const sectionLabel = (text) =>
  Object.assign(document.createElement('div'), {
    className: 'list-section', textContent: text,
  });

const hint = (text) =>
  Object.assign(document.createElement('p'), { className: 'hint', textContent: text });

function row(chat) {
  const node = document.createElement('div');
  node.className = 'chat-row';
  node.dataset.slug = chat.slug;
  node.setAttribute('role', 'option');
  node.setAttribute('aria-selected', String(chat.slug === selected));

  node.append(avatarNode(chat.name, 46, chat.avatar, chat.slug));

  const top = document.createElement('div');
  top.className = 'top';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = chat.name;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = listDate(chat.last_date);
  top.append(name, when);

  // Where a messenger would preview the last message, an archive says how far
  // the backup reaches.
  const backup = document.createElement('div');
  backup.className = 'backup';
  backup.textContent = backedUpLabel(chat.backed_up_at);
  backup.title = `${chat.messages.toLocaleString()} messages`;

  node.append(top, backup);
  node.onclick = () => {
    select(chat.slug);
    onSelect(chat);
  };
  return node;
}

// ---- resizing ------------------------------------------------------------

function clampWidth(px) {
  const styles = getComputedStyle(document.documentElement);
  const min = parseInt(styles.getPropertyValue('--sidebar-min'), 10) || 220;
  const max = parseInt(styles.getPropertyValue('--sidebar-max'), 10) || 520;
  return Math.max(min, Math.min(max, Math.round(px)));
}

// The width the user asked for, which is not always the width they get: in a
// narrow window flex shrinks the sidebar so the message column can keep its
// minimum. Persisting the *rendered* width would let one drag in a small
// window permanently shrink the preference, so the request is what's stored
// and the sidebar springs back when there's room again.
let requestedWidth = 320;

function applyWidth(px) {
  requestedWidth = clampWidth(px);
  document.documentElement.style.setProperty('--sidebar-w', `${requestedWidth}px`);
}

function initResizer() {
  let startX = 0;
  let startWidth = 0;

  const onMove = (event) => {
    applyWidth(startWidth + (event.clientX - startX));
  };

  const onUp = () => {
    document.body.classList.remove('resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    state.set('sidebarWidth', requestedWidth);
  };

  resizerEl.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startX = event.clientX;
    // Start from the rendered width so the handle doesn't jump when the
    // sidebar is currently being squeezed below its requested size.
    startWidth = sidebarEl.getBoundingClientRect().width;
    // The class kills the width transition so the edge tracks the pointer
    // exactly instead of easing behind it.
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  // Double-click the handle to return to the default width.
  resizerEl.addEventListener('dblclick', () => {
    applyWidth(320);
    state.set('sidebarWidth', 320);
  });
}
