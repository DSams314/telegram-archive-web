// Right pane: chat header, the scrolling history, the in-chat search bar, and
// the two floating controls that ride over the messages.

import { loadMeta } from './api.js';
import { dayLabel, rangeLabel, clock } from './format.js';
import { avatarNode, plainText } from './message.js';
import { Scroller } from './scroller.js';
import { icons } from './icons.js';
import { search, snippet } from './search.js';
import * as profile from './profile.js';
import { colorFor, assignForChat } from './peers.js';

const headEl = document.getElementById('chat-head');
const scrollEl = document.getElementById('message-scroll');
const columnEl = document.getElementById('message-column');
const emptyEl = document.getElementById('chat-empty');
const dateBadge = document.getElementById('date-badge');
const toBottom = document.getElementById('to-bottom');
const searchBar = document.getElementById('chat-search');
const searchInput = document.getElementById('chat-search-input');
const searchStatus = document.getElementById('chat-search-status');
const searchResults = document.getElementById('chat-search-results');

const scroller = new Scroller(scrollEl, columnEl);

let current = null;
let manifest = null;
let badgeTimer = 0;
let searchState = { hits: [], tokens: [], at: -1 };

toBottom.innerHTML = icons.chevronDown;
toBottom.onclick = () => scroller.scrollToBottom();

scroller.onVisibleDateChange = (unix) => {
  const label = dayLabel(unix);
  if (dateBadge.textContent !== label) dateBadge.textContent = label;
  dateBadge.classList.add('visible');
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => dateBadge.classList.remove('visible'), 1100);
};

scroller.onScrollPositionChange = (distanceFromBottom) => {
  toBottom.classList.toggle('visible', distanceFromBottom > 500);
};

const observer = new ResizeObserver(() => scroller.handleResize());
observer.observe(columnEl);

export function init(loadedManifest) {
  manifest = loadedManifest;
  initSearchBar();
}

export async function open(chat, selfId) {
  current = chat;
  emptyEl.hidden = true;
  closeSearch();
  profile.close();

  const meta = await loadMeta(chat.slug);
  if (current?.slug !== chat.slug) return;

  renderHeader(chat);

  const isGroup = profile.isGroup(chat);
  // Colours are per-chat so nobody in this conversation shares one.
  assignForChat(chat);
  await scroller.mount(chat.slug, meta, {
    selfId,
    isGroup,
    // A one-to-one chat never labels the sender -- there are only two people
    // and the side of the column already says which.
    showSender: chat.type !== 'personal_chat',
    // Names for reaction tooltips, without another lookup per pill.
    peerNames: new Map((chat.peers ?? []).map((p) => [p.id, p.name])),
    onReplyClick: (id) => scroller.jumpToMessage(id),
    // Straight to the person's card. Opening the group panel first and then
    // navigating would race: both paths await a fetch, and the group's would
    // finish last and paint over the card.
    onPeerClick: (peerId, name) => profile.openMember(peerId, name, chat),
  });
}

export const jumpToLatest = () => scroller.scrollToBottom();
export const jumpToStart = () => scroller.jumpToDate(0);
export const scrollByScreen = (dir) =>
  scrollEl.scrollBy({ top: dir * scrollEl.clientHeight * 0.9, behavior: 'smooth' });
export const currentChat = () => current;
export const openProfile = () => {
  if (!current) return;
  if (profile.isOpen()) profile.close();
  else profile.open(current, (id) => scroller.jumpToMessage(id));
};

/** Re-render the open chat, after a setting that changes how messages look. */
export async function reopen(selfId) {
  if (!current) return;
  const at = scrollEl.scrollTop;
  await open(current, selfId);
  scrollEl.scrollTop = at;
}

/** Used by global search to open a chat straight at a specific message. */
export async function openAt(chat, selfId, messageId) {
  await open(chat, selfId);
  await scroller.jumpToMessage(messageId);
}

function renderHeader(chat) {
  headEl.replaceChildren();

  // Two separate cards, as in the app: who you're reading, and what you can do.
  const identity = document.createElement('div');
  identity.className = 'head-card';

  const peer = document.createElement('button');
  peer.className = 'peer';
  peer.title = 'Open profile';
  peer.append(avatarNode(chat.name, 38, chat.avatar, chat.slug));

  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('b');
  name.textContent = chat.name;
  const sub = document.createElement('span');
  const members = (chat.peers ?? []).length;
  sub.textContent = profile.isGroup(chat)
    ? `${members} members · ${chat.messages.toLocaleString()} messages`
    : `${chat.messages.toLocaleString()} messages · `
      + rangeLabel(chat.first_date, chat.last_date);
  who.append(name, sub);
  peer.append(who);
  peer.onclick = () => openProfileFor(chat);
  identity.append(peer);

  const actions = document.createElement('div');
  actions.className = 'head-card actions';
  const searchButton = action('search', 'Search this chat (⌘F)');
  searchButton.onclick = openSearch;
  const infoButton = action('more', 'Profile (I)');
  infoButton.onclick = () => openProfileFor(chat);
  actions.append(searchButton, infoButton);

  headEl.append(identity, actions);
  headEl.hidden = false;
}

function openProfileFor(chat) {
  profile.open(chat, (id) => scroller.jumpToMessage(id), () => refreshAvatars(chat));
}

/** Re-draw the avatars after the user sets a new picture for this chat. */
function refreshAvatars(chat) {
  renderHeader(chat);
  document.dispatchEvent(new CustomEvent('avatar-changed', { detail: chat.slug }));
}

document.addEventListener('avatar-changed', () => {
  if (current) renderHeader(current);
});

// ---- in-chat search ------------------------------------------------------

function initSearchBar() {
  document.getElementById('chat-search-close').onclick = closeSearch;
  document.getElementById('chat-search-prev').onclick = () => step(-1);
  document.getElementById('chat-search-next').onclick = () => step(1);

  let debounce = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 180);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSearch();
    else if (event.key === 'Enter') step(event.shiftKey ? -1 : 1);
  });

  // The app's own shortcut for search-in-chat.
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault();
      openSearch();
    }
  });
}

function openSearch() {
  if (!current) return;
  searchBar.hidden = false;
  requestAnimationFrame(() => searchBar.classList.add('open'));
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.classList.remove('open');
  searchBar.hidden = true;
  searchInput.value = '';
  searchResults.replaceChildren();
  searchStatus.textContent = '';
  searchState = { hits: [], tokens: [], at: -1 };
}

async function runSearch() {
  const query = searchInput.value.trim();
  searchResults.replaceChildren();
  if (!query || !current) {
    searchStatus.textContent = '';
    searchState = { hits: [], tokens: [], at: -1 };
    return;
  }

  const chatIndex = manifest.chats.findIndex((c) => c.slug === current.slug);
  const { hits, tokens } = await search(query, { chatIndex });
  searchState = { hits, tokens, at: -1 };

  searchStatus.textContent = hits.length
    ? `1 of ${hits.length.toLocaleString()}`
    : 'No matches';
  if (hits.length) step(1);
}

/** Move through matches, newest first, jumping the scroller to each. */
async function step(delta) {
  const { hits } = searchState;
  if (!hits.length) return;
  searchState.at = (searchState.at + delta + hits.length) % hits.length;
  searchStatus.textContent =
    `${searchState.at + 1} of ${hits.length.toLocaleString()}`;
  await scroller.jumpToMessage(hits[searchState.at].id);
}

function action(icon, title) {
  const button = document.createElement('button');
  button.className = 'icon-btn';
  button.title = title;
  button.innerHTML = icons[icon];
  return button;
}

/** Shared by the global-search results list in the sidebar. */
export function resultRow(chat, message, tokens, onClick) {
  const row = document.createElement('button');
  row.className = 'result-row';

  const head = document.createElement('div');
  head.className = 'result-head';
  const who = document.createElement('b');
  who.textContent = message.from_name ?? chat.name;
  const when = document.createElement('span');
  when.textContent = `${dayLabel(message.date)}, ${clock(message.date)}`;
  head.append(who, when);

  const body = document.createElement('div');
  body.className = 'result-body';
  body.append(snippet(message, tokens));

  row.append(head, body);
  row.onclick = () => onClick(chat, message.id);
  return row;
}

export { plainText };
