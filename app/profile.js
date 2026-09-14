// The right-hand profile panel: who this chat is with, what the backup holds,
// and a browsable library of everything they ever sent.
//
// The seven tabs come straight from `media.json`, which the indexer already
// built and de-duplicated — stickers and GIFs collapse byte-identical repeats,
// because the same sticker is re-downloaded into every export under a new
// ` (N)` name and would otherwise fill the tab with copies.

import { loadMedia, mediaURL } from './api.js';
import { avatarNode } from './message.js';
import { duration, fileSize, rangeLabel, backedUpLabel, dayLabel } from './format.js';
import { icons } from './icons.js';
import { autoplayWhenVisible } from './media/visibility.js';
import * as lightbox from './lightbox.js';
import * as contextmenu from './contextmenu.js';
import { api } from './platform.js';
import { cropToSquare } from './cropper.js';
import { bumpAvatarVersion } from './avatar.js';
import { colorFor, setColor, PEER_COLORS, directChatFor, directory, peerAvatar } from './peers.js';

const TABS = [
  ['members', 'Members'],
  ['media', 'Media'],
  ['files', 'Files'],
  ['links', 'Links'],
  ['music', 'Music'],
  ['voice', 'Voice'],
  ['gifs', 'GIFs'],
  ['stickers', 'Stickers'],
];

// How many library entries to add per batch as the tab is scrolled.
const BATCH = 60;

let panel = null;
let state = { chat: null, catalogs: null, tab: 'media', shown: 0, onJump: null };
// Set while showing one person inside a group's panel, so Back can return.
let memberView = null;
// Bumped by every navigation. Both open paths await a fetch, so without this a
// slower one can finish last and paint over whatever the user asked for next.
let view = 0;
let handlers = { onOpenChat: null, selfId: null };

export function configure(options) {
  handlers = { ...handlers, ...options };
}

function build() {
  panel = document.createElement('aside');
  panel.id = 'profile';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="pf-head">
      <button class="icon-btn pf-close" aria-label="Close">${icons.close}</button>
      <button class="icon-btn pf-back" aria-label="Back to group" hidden>
        ${icons.chevronLeft}</button>
      <span class="pf-title">Info</span>
    </div>
    <div class="pf-scroll scroll">
      <div class="pf-hero"></div>
      <div class="pf-facts"></div>
      <div class="pf-tabs" role="tablist"></div>
      <div class="pf-body"></div>
    </div>`;

  panel.querySelector('.pf-close').onclick = close;
  panel.querySelector('.pf-back').onclick = backToGroup;
  document.getElementById('app').append(panel);

  // Infinite scroll: extend the current tab as its end comes into view.
  panel.querySelector('.pf-scroll').addEventListener('scroll', (event) => {
    const el = event.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) fill();
  }, { passive: true });
}

export function isOpen() {
  return panel != null && !panel.hidden;
}

export function close() {
  if (!panel) return;
  panel.classList.remove('open');
  // Let the slide-out finish before it leaves the layout.
  setTimeout(() => { if (!panel.classList.contains('open')) panel.hidden = true; }, 260);
}

export async function open(chat, onJump, onAvatarChange) {
  if (!panel) build();
  const mine = ++view;
  memberView = null;
  state = { chat, catalogs: null, tab: 'media', shown: 0, onJump, onAvatarChange };

  panel.hidden = false;
  // Next frame, so the transition has a starting state to animate from.
  requestAnimationFrame(() => panel.classList.add('open'));

  panel.querySelector('.pf-title').textContent = isGroup(chat) ? 'Group info' : 'Info';
  showBack(false);
  renderHero(chat);
  renderFacts(chat);
  panel.querySelector('.pf-body').replaceChildren(hint('Loading…'));

  const catalogs = await loadMedia(chat.slug);
  if (mine !== view) return;   // the user has navigated on
  state.catalogs = catalogs;

  renderTabs();
  selectTab(isGroup(chat) ? 'members' : firstNonEmptyTab(catalogs));
}

export const isGroup = (chat) =>
  !!chat && chat.type !== 'personal_chat' && (chat.peers ?? []).length > 2;

/**
 * Show one participant inside the group's panel: their colour, their picture,
 * and -- when the archive has a one-to-one chat with them -- that chat's own
 * media library rather than the group's.
 */
export async function openMember(peerId, name, groupOverride) {
  if (!panel) build();
  const mine = ++view;
  const group = groupOverride ?? memberView?.group ?? state.chat;
  const direct = directChatFor(peerId, handlers.selfId);
  memberView = { group, peerId, name, direct };

  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('open'));

  panel.querySelector('.pf-title').textContent = 'Member';
  showBack(true);
  renderMemberHero(peerId, name, direct);
  renderMemberFacts(peerId, name, direct);

  if (!direct) {
    panel.querySelector('.pf-tabs').replaceChildren();
    panel.querySelector('.pf-body').className = 'pf-body';
    panel.querySelector('.pf-body').replaceChildren(
      hint('No one-on-one chat history with this person in your archive.'));
    return;
  }

  // Borrow the direct chat's catalogues, so a member card shows *their* media
  // rather than the group's.
  state = { ...state, chat: direct, catalogs: null, tab: 'media', shown: 0 };
  panel.querySelector('.pf-body').replaceChildren(hint('Loading…'));
  const catalogs = await loadMedia(direct.slug);
  if (mine !== view) return;
  state.catalogs = catalogs;
  renderTabs();
  selectTab(firstNonEmptyTab(catalogs));
}

function backToGroup() {
  const group = memberView?.group;
  memberView = null;
  if (group) open(group, state.onJump, state.onAvatarChange);
}

function showBack(on) {
  const button = panel.querySelector('.pf-back');
  button.hidden = !on;
}

function firstNonEmptyTab(catalogs) {
  for (const [key] of TABS) if (catalogs[key]?.length) return key;
  return 'media';
}

function renderHero(chat) {
  const hero = panel.querySelector('.pf-hero');
  hero.replaceChildren();

  // Exports rarely include a profile picture, so the panel is where you set
  // one. It is stored beside the index, never in the backup folder.
  const holder = document.createElement('div');
  holder.className = 'pf-avatar-edit pf-avatar';
  holder.title = 'Set a picture for this chat';
  const avatar = avatarNode(chat.name, 96, chat.avatar, chat.slug);
  holder.append(avatar);
  holder.onclick = () => pickAvatar(chat, holder);

  const name = document.createElement('h2');
  name.textContent = chat.name;
  const sub = document.createElement('p');
  sub.textContent = backedUpLabel(chat.backed_up_at);
  hero.append(holder, name, sub);
}

function pickAvatar(chat, holder) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const blob = await cropToSquare(file);
      if (!blob) return;                   // cancelled
      const saved = await api.avatar(chat.slug, blob);
      if (!saved?.url) throw new Error(saved?.error ?? 'save failed');
      // The URL never changes, so bump a version token to defeat the cache.
      bumpAvatarVersion();
      holder.replaceChildren(avatarNode(chat.name, 96, chat.avatar, chat.slug));
      state.onAvatarChange?.();
    } catch (error) {
      holder.title = `Could not save: ${error.message}`;
    }
  };
  input.click();
}

function renderFacts(chat) {
  const facts = panel.querySelector('.pf-facts');
  facts.replaceChildren();

  const rows = [
    ['messages', chat.messages.toLocaleString()],
    ['covers', rangeLabel(chat.first_date, chat.last_date)],
  ];
  const others = (chat.peers ?? []).filter((p) => p.messages);
  if (isGroup(chat)) {
    rows.push(['members', `${others.length}`]);
  } else if (others.length) {
    rows.push(['participants',
      others.map((p) => `${p.name} (${p.messages.toLocaleString()})`).join(', ')]);
  }
  // Which export runs this chat was assembled from — an archive-specific fact
  // with no equivalent in the app, but the one people actually want here.
  rows.push(['backed up from', `${chat.exports ?? 1} export folder(s)`]);

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'pf-row';
    const l = document.createElement('span');
    l.className = 'pf-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'pf-value';
    v.textContent = value;
    row.append(l, v);
    facts.append(row);
  }

  // Colours belong to the person, not the group, so a one-to-one chat is a
  // perfectly good place to change the other person's.
  if (!isGroup(chat)) {
    const other = (chat.peers ?? []).find((p) => p.id && p.id !== handlers.selfId);
    if (other) {
      facts.append(colorPicker(other.id, other.name, () => {
        renderFacts(chat);
        renderHero(chat);
      }));
    }
  }
}

/** The eight-swatch row used by both member cards and one-to-one panels. */
function colorPicker(peerId, name, onPick) {
  const row = document.createElement('div');
  row.className = 'pf-row pf-colors';
  row.append(Object.assign(document.createElement('span'),
    { className: 'pf-label', textContent: `${name ?? 'their'} colour` }));

  const swatches = document.createElement('div');
  swatches.className = 'pf-swatches';
  const current = colorFor(peerId);
  for (const colour of PEER_COLORS) {
    const dot = document.createElement('button');
    dot.className = 'pf-swatch' + (colour.toLowerCase() === current.toLowerCase() ? ' on' : '');
    dot.style.background = colour;
    dot.title = colour;
    dot.onclick = () => {
      setColor(peerId, colour);
      handlers.onColorChange?.(peerId, colour);
      onPick?.();
    };
    swatches.append(dot);
  }
  row.append(swatches);
  return row;
}

function renderTabs() {
  const bar = panel.querySelector('.pf-tabs');
  bar.replaceChildren();
  const group = memberView ? null : state.chat;
  for (const [key, label] of TABS) {
    if (key === 'members' && !isGroup(group)) continue;
    const count = key === 'members'
      ? (group?.peers ?? []).length
      : state.catalogs[key]?.length ?? 0;
    const tab = document.createElement('button');
    tab.className = 'pf-tab';
    tab.dataset.tab = key;
    tab.disabled = count === 0;
    tab.setAttribute('role', 'tab');
    tab.textContent = label;
    if (count) {
      const badge = document.createElement('span');
      badge.className = 'pf-count';
      badge.textContent = count > 999 ? '999+' : String(count);
      tab.append(badge);
    }
    tab.onclick = () => selectTab(key);
    bar.append(tab);
  }
}

function selectTab(key) {
  state.tab = key;
  state.shown = 0;
  for (const tab of panel.querySelectorAll('.pf-tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === key));
  }
  const body = panel.querySelector('.pf-body');
  body.replaceChildren();
  body.className = `pf-body pf-${key}`;
  panel.querySelector('.pf-scroll').scrollTop = 0;
  fill();
}

/** Append the next batch of the current tab. */
function fill() {
  if (state.tab === 'members') { fillMembers(); return; }
  const items = state.catalogs?.[state.tab];
  if (!items || state.shown >= items.length) return;

  const body = panel.querySelector('.pf-body');
  const slice = items.slice(state.shown, state.shown + BATCH);
  const fragment = document.createDocumentFragment();
  for (const item of slice) fragment.append(entryFor(state.tab, item, items));
  body.append(fragment);
  state.shown += slice.length;

  if (!body.children.length) body.append(hint('Nothing here.'));
}

function entryFor(tab, item, all) {
  const node = (() => {
    switch (tab) {
      case 'media': return tile(item, all);
      case 'gifs': return gifTile(item);
      case 'stickers': return stickerTile(item);
      case 'links': return linkRow(item);
      case 'music':
      case 'voice': return audioRow(item, tab);
      default: return fileRow(item);
    }
  })();

  // Right-click any library entry to jump to where it was sent.
  contextmenu.attach(node, () => {
    const items = [{ label: 'Show in Chat', onSelect: () => state.onJump?.(item.id) }];
    if (item.src && ['media', 'gifs'].includes(tab)) {
      items.push({
        label: 'Open full size',
        onSelect: () => lightbox.open(item, all.filter((m) => m.src)),
      });
    }
    if (item.url) {
      items.push({ label: 'Copy link', onSelect: () => copy(item.url) });
    } else if (item.src) {
      items.push(null);
      items.push({ label: 'Copy file path', onSelect: () => copy(item.src) });
    }
    return items;
  });

  return node;
}

function copy(text) {
  // Clipboard access can be refused; nothing here depends on it succeeding.
  navigator.clipboard?.writeText(text).catch(() => {});
}

function tile(item, all) {
  const cell = document.createElement('button');
  cell.className = 'pf-tile';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = mediaURL(item.thumb ?? item.src);
  img.alt = '';
  cell.append(img);

  if (item.kind === 'video' || item.kind === 'round') {
    const badge = document.createElement('span');
    badge.className = 'pf-tile-badge';
    badge.textContent = duration(item.duration) || '▶';
    cell.append(badge);
  }
  // A photo opens the viewer; the whole tab becomes the gallery to page through.
  cell.onclick = () => lightbox.open(item, all.filter((m) => m.src));
  return cell;
}

function gifTile(item) {
  const cell = document.createElement('div');
  cell.className = 'pf-tile pf-gif';
  const video = document.createElement('video');
  video.src = mediaURL(item.src);
  Object.assign(video, { loop: true, muted: true, playsInline: true });
  video.preload = 'none';
  autoplayWhenVisible(video);
  cell.append(video);
  cell.onclick = () => state.onJump?.(item.id);
  return cell;
}

function stickerTile(item) {
  const cell = document.createElement('button');
  cell.className = 'pf-tile pf-sticker';
  const lower = (item.src ?? '').toLowerCase();

  if (lower.endsWith('.webm')) {
    const video = document.createElement('video');
    video.src = mediaURL(item.src);
    Object.assign(video, { loop: true, muted: true, playsInline: true });
    video.preload = 'none';
    autoplayWhenVisible(video);
    cell.append(video);
  } else {
    const img = document.createElement('img');
    // A .tgs has no still of its own beyond the exported thumbnail.
    img.src = mediaURL(lower.endsWith('.tgs') ? (item.thumb ?? item.src) : item.src);
    img.loading = 'lazy';
    img.alt = item.emoji ?? '';
    cell.append(img);
  }
  cell.title = item.emoji ?? '';
  cell.onclick = () => state.onJump?.(item.id);
  return cell;
}

function linkRow(item) {
  const row = document.createElement('div');
  row.className = 'pf-row-item';
  const body = document.createElement('div');
  body.className = 'pf-row-body';

  const link = document.createElement('a');
  link.href = item.url;
  link.textContent = item.url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.className = 'pf-link';

  const when = document.createElement('span');
  when.className = 'pf-when';
  when.textContent = dayLabel(item.date);

  body.append(link, when);
  row.append(body);
  row.onclick = (event) => {
    if (event.target !== link) state.onJump?.(item.id);
  };
  return row;
}

function audioRow(item, tab) {
  const row = document.createElement('div');
  row.className = 'pf-row-item';
  const glyph = document.createElement('div');
  glyph.className = 'pf-glyph';
  glyph.innerHTML = tab === 'voice' ? icons.mic : icons.music;

  const body = document.createElement('div');
  body.className = 'pf-row-body';
  const title = document.createElement('b');
  title.textContent = item.name ?? (tab === 'voice' ? 'Voice message' : 'Audio');
  const meta = document.createElement('span');
  meta.className = 'pf-when';
  meta.textContent = [duration(item.duration), fileSize(item.size), dayLabel(item.date)]
    .filter(Boolean).join(' · ');
  body.append(title, meta);

  row.append(glyph, body);
  row.onclick = () => state.onJump?.(item.id);
  return row;
}

function fileRow(item) {
  const row = document.createElement('div');
  row.className = 'pf-row-item';
  const glyph = document.createElement('div');
  glyph.className = 'pf-glyph';
  glyph.innerHTML = icons.file;

  const body = document.createElement('div');
  body.className = 'pf-row-body';
  const title = document.createElement('b');
  title.textContent = item.name ?? item.src?.split('/').pop() ?? 'File';
  const meta = document.createElement('span');
  meta.className = 'pf-when';
  meta.textContent = [fileSize(item.size), dayLabel(item.date)].filter(Boolean).join(' · ');
  body.append(title, meta);

  row.append(glyph, body);
  row.onclick = () => state.onJump?.(item.id);
  return row;
}

/** The Members tab: everyone who ever spoke in this group. */
function fillMembers() {
  const body = panel.querySelector('.pf-body');
  body.replaceChildren();
  const members = [...(state.chat?.peers ?? [])]
    .sort((a, b) => b.messages - a.messages);

  for (const member of members) {
    const row = document.createElement('div');
    row.className = 'pf-member';

    const face = peerAvatar(member.id, member.name, 40);
    // The picture opens their card; the name jumps to their own chat. Two
    // targets, because those are genuinely different intentions.
    face.onclick = () => openMember(member.id, member.name);

    const body2 = document.createElement('div');
    body2.className = 'pf-row-body';
    const name = document.createElement('b');
    name.textContent = member.name;
    name.style.color = colorFor(member.id);
    name.className = 'pf-member-name';
    name.onclick = () => openMember(member.id, member.name);
    const meta = document.createElement('span');
    meta.className = 'pf-when';
    meta.textContent = `${member.messages.toLocaleString()} message`
      + (member.messages === 1 ? '' : 's');
    body2.append(name, meta);

    const info = document.createElement('button');
    info.className = 'icon-btn pf-member-info';
    info.title = 'Member info';
    info.innerHTML = icons.chevronRight;
    info.onclick = () => openMember(member.id, member.name);

    if (member.id === handlers.selfId) {
      const you = document.createElement('span');
      you.className = 'pf-badge';
      you.textContent = 'you';
      body2.append(you);
    }

    row.append(face, body2, info);
    body.append(row);
  }
  state.shown = members.length;
}

/** Open this person's own chat, or say so when the archive has none. */
function goToDirectChat(peerId, name, anchor) {
  const direct = directChatFor(peerId, handlers.selfId);
  if (direct) {
    handlers.onOpenChat?.(direct);
    return;
  }
  toast(anchor, `No one-on-one chat history with ${name}.`);
}

/** A small message that slides up from the row that triggered it. */
function toast(anchor, message) {
  const existing = panel.querySelector('.pf-toast');
  if (existing) existing.remove();
  const note = document.createElement('div');
  note.className = 'pf-toast';
  note.textContent = message;
  (anchor ?? panel).append(note);
  requestAnimationFrame(() => note.classList.add('in'));
  setTimeout(() => {
    note.classList.remove('in');
    setTimeout(() => note.remove(), 300);
  }, 2600);
}

function renderMemberHero(peerId, name, direct) {
  const hero = panel.querySelector('.pf-hero');
  hero.replaceChildren();

  const holder = document.createElement('div');
  holder.className = 'pf-avatar-edit pf-avatar';
  holder.title = 'Set a picture for this person';
  holder.append(peerAvatar(peerId, name, 96));
  holder.onclick = () => pickPeerAvatar(peerId, name, holder);

  const title = document.createElement('h2');
  title.textContent = name ?? peerId;
  title.style.color = colorFor(peerId);
  title.className = 'pf-peer-name';
  title.title = direct ? `Open chat with ${name}` : '';
  title.onclick = () => goToDirectChat(peerId, name ?? peerId, hero);

  const sub = document.createElement('p');
  sub.textContent = direct
    ? `${direct.messages.toLocaleString()} messages one-on-one`
    : 'No one-on-one chat in this archive';

  hero.append(holder, title, sub);
}

function renderMemberFacts(peerId, name, direct) {
  const facts = panel.querySelector('.pf-facts');
  facts.replaceChildren();

  const known = directory().get(peerId);
  const rows = [['id', peerId]];
  if (known) {
    rows.push(['seen in', `${known.chats.length} chat`
      + (known.chats.length === 1 ? '' : 's')
      + ` · ${known.messages.toLocaleString()} messages total`]);
  }
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'pf-row';
    row.append(
      Object.assign(document.createElement('span'), { className: 'pf-label', textContent: label }),
      Object.assign(document.createElement('span'), { className: 'pf-value', textContent: value }),
    );
    facts.append(row);
  }

  // Their colour is what makes them legible in a busy group, so it is editable
  // right here rather than buried in settings. It applies everywhere they
  // appear, not just this chat.
  facts.append(colorPicker(peerId, name, () => {
    renderMemberHero(peerId, name, direct);
    renderMemberFacts(peerId, name, direct);
  }));

  if (direct) {
    const open = document.createElement('button');
    open.className = 'pf-open-chat';
    open.textContent = `Open chat with ${name}`;
    open.onclick = () => handlers.onOpenChat?.(direct);
    facts.append(open);
  }
}

function pickPeerAvatar(peerId, name, holder) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const blob = await cropToSquare(file);
      if (!blob) return;                   // cancelled
      const saved = await api.avatar(peerId, blob);
      if (!saved?.url) throw new Error(saved?.error ?? 'save failed');
      bumpAvatarVersion();
      holder.replaceChildren(peerAvatar(peerId, name, 96));
      state.onAvatarChange?.();
    } catch (error) {
      holder.title = `Could not save: ${error.message}`;
    }
  };
  input.click();
}

function hint(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}
