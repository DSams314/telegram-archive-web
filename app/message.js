// Rendering one message: bubble, reply header, text entities, media, reactions.

import { mediaURL } from './api.js';
import { avatarNode, bumpAvatarVersion } from './avatar.js';
import { clock, duration, fileSize } from './format.js';
import { icons } from './icons.js';
import { autoplayWhenVisible } from './media/visibility.js';
import { renderTGS } from './media/tgs.js';
import { renderVoice } from './media/waveform.js';
import { albumLayout } from './media/album.js';
import { wrapSpoiler } from './media/spoiler.js';
import * as lightbox from './lightbox.js';
import * as state from './state.js';
import { colorFor, peerAvatar } from './peers.js';

// Media caps, in CSS pixels, both adjustable in settings. Stickers are
// deliberately small and un-bubbled.
const photoMax = () => {
  const w = state.get('mediaWidth') ?? 420;
  return { w, h: w };
};
const stickerMax = () => {
  const w = state.get('stickerSize') ?? 180;
  return { w, h: w };
};

/**
 * Scale w x h to fit inside a box while keeping the ratio exact.
 *
 * This is the whole fix for squashed media: clamping with CSS max-width and
 * max-height together constrains each axis independently, so a 512x512 sticker
 * in a 180x340 box comes out 180x340. Computing the fit here yields exact
 * pixel dimensions, which also reserves the right space before the file loads
 * and keeps the phase 3 scroller from jumping.
 */
export function fitMedia(w, h, max) {
  if (!w || !h) return { w: max.w, h: Math.round(max.w * 0.62) };
  const scale = Math.min(max.w / w, max.h / h, 1);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};


// ---- text ----------------------------------------------------------------

/** Flatten a message's entities to a plain string, for previews and search. */
export { avatarNode, bumpAvatarVersion };

export const plainText = (entities) =>
  (entities ?? []).map((e) => e.text ?? '').join('');

const ENTITY_TAG = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
  strikethrough: 's',
  code: 'code',
  pre: 'code',
};

function renderText(entities) {
  const wrap = el('div', 'text');
  for (const entity of entities) {
    const { type, text = '' } = entity;

    if (type === 'link' || type === 'text_link') {
      const a = el('a', null, text);
      a.href = entity.href ?? text;
      // Opening an external link is the one thing that would leave the
      // machine, so it is an explicit user action in a new tab, never inline.
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      wrap.append(a);
      continue;
    }

    if (type === 'spoiler') {
      const span = el('span', 'spoiler', text);
      span.onclick = () => span.classList.toggle('revealed');
      wrap.append(span);
      continue;
    }

    const tag = ENTITY_TAG[type];
    wrap.append(tag ? el(tag, null, text) : document.createTextNode(text));
  }
  return wrap;
}

// ---- media ---------------------------------------------------------------

const ABSENT_LABEL = {
  photo: 'Photo file',
  video: 'Video file',
  gif: 'GIF',
  sticker: 'Sticker',
  voice: 'Voice message',
  music: 'Audio file',
  round: 'Video message',
  file: 'File',
};

function renderAbsent(media) {
  const max = media.kind === 'sticker' ? stickerMax() : photoMax();
  const box = fitMedia(media.w, media.h, max);
  const node = el('div', 'absent');
  node.style.width = `${box.w}px`;
  node.style.height = `${box.h}px`;
  const label = ABSENT_LABEL[media.kind] ?? 'File';
  node.append(el('span', null, `${label} absent`));
  return node;
}

function renderMedia(media, options = {}) {
  const node = renderMediaBody(media, options);
  if (!media.spoiler || media.missing) return node;
  const box = options.box
    ?? fitMedia(media.w, media.h,
                media.kind === 'sticker' ? stickerMax() : photoMax());
  return wrapSpoiler(node, box);
}

function renderMediaBody(media, options = {}) {
  if (media.missing) {
    return state.get('showAbsent') ? renderAbsent(media) : el('span');
  }

  const { kind } = media;
  const src = mediaURL(media.src);
  const isSticker = kind === 'sticker';
  const box = options.box
    ?? fitMedia(media.w, media.h, isSticker ? stickerMax() : photoMax());
  const lower = media.src.toLowerCase();

  // A .tgs is gzipped Lottie; a .webm sticker is just a video with alpha.
  if (isSticker && lower.endsWith('.tgs')) return renderTGS(media, box);

  if (isSticker && (lower.endsWith('.webm') || media.mime === 'video/webm')) {
    const video = el('video', 'media sticker-video');
    video.src = src;
    video.style.width = `${box.w}px`;
    video.style.height = `${box.h}px`;
    Object.assign(video, { loop: true, muted: true, playsInline: true });
    video.preload = 'none';
    autoplayWhenVisible(video, 'sticker');
    return video;
  }

  if (kind === 'photo' || isSticker) {
    const img = el('img', 'media');
    img.src = src;
    img.alt = media.emoji ?? '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.style.width = `${box.w}px`;
    img.style.height = `${box.h}px`;
    if (isSticker) img.style.objectFit = 'contain';
    else {
      img.classList.add('zoomable');
      img.onclick = () => lightbox.open(media, options.album);
    }
    return img;
  }

  if (kind === 'video' || kind === 'gif' || kind === 'round') {
    const wrap = el('div', 'media-frame');
    wrap.style.width = `${box.w}px`;
    wrap.style.height = `${box.h}px`;

    const video = el('video', 'media');
    video.src = src;
    video.style.width = `${box.w}px`;
    video.style.height = `${box.h}px`;
    if (media.thumb) video.poster = mediaURL(media.thumb);
    video.preload = 'none';

    if (kind === 'gif') {
      // Muted + playsInline is what makes autoplay permissible at all; the
      // observer keeps only on-screen GIFs decoding.
      Object.assign(video, { loop: true, muted: true, playsInline: true });
      autoplayWhenVisible(video);
      wrap.append(video, el('div', 'badge', 'GIF'));
    } else {
      video.controls = true;
      video.classList.add('zoomable');
      wrap.append(video);
      if (media.duration) wrap.append(el('div', 'duration', duration(media.duration)));
    }
    if (kind === 'round') {
      video.style.borderRadius = '50%';
      Object.assign(video, { loop: true, muted: true, playsInline: true });
      autoplayWhenVisible(video);
    }
    return wrap;
  }

  if (kind === 'voice') return renderVoice(media, src);

  if (kind === 'music') {
    const row = el('div', 'file-row');
    const glyph = el('div', 'glyph');
    glyph.innerHTML = icons.music;
    const info = el('div', 'info');
    info.append(el('b', null, media.title ?? media.name ?? 'Audio'));
    info.append(el('span', null,
      [media.performer, duration(media.duration), fileSize(media.size)]
        .filter(Boolean).join(' · ')));
    row.append(glyph, info);

    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.src = src;
    audio.className = 'inline-audio';

    const wrap = el('div');
    wrap.append(row, audio);
    return wrap;
  }

  const row = el('div', 'file-row');
  const glyph = el('div', 'glyph');
  glyph.innerHTML = icons.file;
  const info = el('div', 'info');
  const link = el('a', null, media.name ?? media.src.split('/').pop());
  link.href = src;
  link.download = media.name ?? '';
  link.style.color = 'inherit';
  const name = el('b');
  name.append(link);
  info.append(name, el('span', null, fileSize(media.size)));
  row.append(glyph, info);
  return row;
}

// ---- message -------------------------------------------------------------

/**
 * An album: several photos/videos sent as one action, drawn as one tiled
 * bubble. The members are separate messages in the export, so the group takes
 * its id and timestamp from the first and its caption from whichever member
 * carries text.
 */
/**
 * Put the sender's picture in a row's gutter. Called once per chunk, after the
 * tail of each run is known.
 */
export function fillGutter(row, ctx) {
  const gutter = row.querySelector(':scope > .msg-gutter');
  if (!gutter || gutter.childElementCount) return;
  const peerId = row.dataset.from;
  const name = row.dataset.fromName;
  const face = peerAvatar(peerId, name, 32);
  face.classList.add('msg-face');
  face.title = name ?? peerId ?? '';
  face.onclick = () => ctx.onPeerClick?.(peerId, name);
  gutter.append(face);
}

export function renderAlbum(members, ctx, position = {}) {
  const head = members[0];
  const isOut = head.from === ctx.selfId;
  const row = el('div', `msg ${isOut ? 'out' : 'in'} album`);
  if (position.lead) row.classList.add('lead');
  row.dataset.id = head.id;
  row.dataset.date = head.date;

  const bubble = el('div', 'bubble media-only');
  const caption = members.find((m) => m.text?.length)?.text;
  if (caption) bubble.classList.remove('media-only');

  const layout = albumLayout(members, photoMax().w);
  const grid = el('div', 'album-grid');
  grid.style.width = `${layout.width}px`;
  grid.style.gridTemplateColumns = `repeat(${layout.columns}, 1fr)`;
  grid.style.gap = `${layout.gap}px`;

  const gallery = members.map((m) => m.media).filter((m) => m && !m.missing);

  for (const member of members) {
    const cell = el('div', 'album-cell');
    cell.style.height = `${layout.cellHeight}px`;
    const cellBox = {
      w: Math.round((layout.width - layout.gap * (layout.columns - 1)) / layout.columns),
      h: layout.cellHeight,
    };
    cell.append(renderMedia(member.media, { box: cellBox, album: gallery }));
    grid.append(cell);
  }

  bubble.append(grid);
  if (caption) bubble.append(renderText(caption));

  const meta = el('div', 'meta');
  meta.append(document.createTextNode(clock(head.date)));
  bubble.append(meta);

  if (ctx.isGroup && !isOut) {
    row.append(el('div', 'msg-gutter'));
    if (head.from) row.dataset.from = head.from;
    if (head.from_name) row.dataset.fromName = head.from_name;
  }

  row.append(bubble);
  return row;
}

/**
 * @param msg      normalized message from a chunk
 * @param ctx      { selfId, peers, byId, onReplyClick }
 * @param position { lead, tail } — where this sits in a run from one sender
 */
export function renderMessage(msg, ctx, position = {}) {
  if (msg.service) {
    return el('div', 'service', serviceText(msg, ctx));
  }

  const isOut = msg.from === ctx.selfId;
  const row = el('div', `msg ${isOut ? 'out' : 'in'}`);
  if (position.lead) row.classList.add('lead');
  if (position.tail) row.classList.add(isOut ? 'tail-out' : 'tail-in');
  row.dataset.id = msg.id;
  row.dataset.date = msg.date;
  if (msg.reply_to) row.dataset.replyTo = msg.reply_to;

  const bubble = el('div', 'bubble');
  const media = msg.media;
  const hasText = (msg.text?.length ?? 0) > 0;
  const isSticker = media?.kind === 'sticker';

  if (isSticker && !hasText) bubble.classList.add('sticker-only');
  else if (media && !hasText && media.kind !== 'file' && media.kind !== 'voice'
           && media.kind !== 'music' && media.kind !== 'unknown') {
    bubble.classList.add('media-only');
  }

  // A run of messages from one sender only names them once, at the top.
  if (position.lead && !isOut && (ctx.showSender || state.get('showSenderNames'))) {
    const sender = el('div', 'sender', msg.from_name ?? msg.from ?? '');
    // In a group the name is the main way to tell people apart, so it carries
    // their colour -- and clicking it opens their card.
    sender.style.color = colorFor(msg.from);
    if (ctx.isGroup) {
      sender.classList.add('clickable');
      sender.onclick = () => ctx.onPeerClick?.(msg.from, msg.from_name);
    }
    bubble.append(sender);
  }

  if (msg.forwarded_from) {
    const fwd = el('div', 'forwarded');
    fwd.append(el('span', null, 'Forwarded from '));
    const who = el('b', null, msg.forwarded_from);
    who.style.color = colorFor(msg.forwarded_from_id ?? msg.forwarded_from);
    fwd.append(who);
    bubble.append(fwd);
  }

  if (msg.reply_to && state.get('showReplyPreviews')) {
    bubble.append(renderReply(msg, ctx));
  }
  if (media) bubble.append(renderMedia(media));
  if (hasText) bubble.append(renderText(msg.text));

  const meta = el('div', 'meta');
  if (state.get('showMessageIds')) {
    meta.append(el('span', 'msgid', `#${msg.id}`));
  }
  if (msg.edited && state.get('showEdited')) {
    meta.append(el('span', 'edited', 'edited'));
  }
  meta.append(document.createTextNode(clock(msg.date)));
  bubble.append(meta);

  if (msg.reactions?.length && state.get('showReactions')) {
    bubble.append(renderReactions(msg.reactions, ctx));
  }

  // In a group, incoming rows reserve a gutter so every bubble shares one left
  // edge. The picture goes in only on the last row of a run -- and which row
  // that is isn't known until the whole chunk is laid out, so `fillGutter`
  // populates it afterwards.
  if (ctx.isGroup && !isOut) {
    row.append(el('div', 'msg-gutter'));
    if (msg.from) row.dataset.from = msg.from;
    if (msg.from_name) row.dataset.fromName = msg.from_name;
  }

  row.append(bubble);
  return row;
}

function renderReply(msg, ctx) {
  const button = el('button', 'reply');
  // The indexer denormalises this preview onto the replying message, so the
  // quote renders without fetching the chunk the target lives in.
  const preview = msg.reply_preview;

  if (preview) {
    const colour = colorFor(preview.from);
    button.style.borderLeftColor = colour;
    const who = el('b', null, preview.from_name ?? preview.from ?? 'Reply');
    who.style.color = colour;
    button.append(who);
    button.append(el('span', null,
      preview.text ?? `[${ABSENT_LABEL[preview.kind] ?? 'media'}]`));
  } else {
    // The target predates this backup, or was deleted before it was taken.
    button.append(el('b', null, 'Reply'));
    button.append(el('span', null, 'message not in this backup'));
    button.disabled = true;
  }

  button.onclick = () => ctx.onReplyClick?.(msg.reply_to);
  return button;
}

function renderReactions(reactions, ctx) {
  const wrap = el('div', 'reactions');
  for (const reaction of reactions) {
    const pill = el('div', 'reaction');
    pill.append(el('span', 'reaction-emoji', reaction.emoji || '•'));

    // With several people in a chat an emoji alone says nothing about who
    // reacted, so their faces go in the pill.
    const who = (reaction.from ?? []).slice(0, 3);
    if (ctx?.isGroup && who.length) {
      const faces = el('div', 'reaction-faces');
      for (const peerId of who) {
        faces.append(peerAvatar(peerId, ctx.peerNames?.get(peerId), 16));
      }
      pill.append(faces);
      pill.title = who
        .map((id) => ctx.peerNames?.get(id) ?? id)
        .join(', ') + (reaction.count > who.length ? ` +${reaction.count - who.length}` : '');
    }

    if (reaction.count > 1) pill.append(el('span', null, String(reaction.count)));
    wrap.append(pill);
  }
  return wrap;
}

const SERVICE_PHRASE = {
  invite_members: (msg) => `invited ${(msg.members ?? []).join(', ') || 'someone'}`,
  remove_members: (msg) => `removed ${(msg.members ?? []).join(', ') || 'someone'}`,
  join_group_by_link: () => 'joined the group',
  edit_group_photo: () => 'changed the group photo',
  edit_group_title: (msg) => `changed the group name${msg.title ? ` to ${msg.title}` : ''}`,
  pin_message: () => 'pinned a message',
  create_group: (msg) => `created the group${msg.title ? ` ${msg.title}` : ''}`,
  phone_call: (msg) => (msg.duration_seconds
    ? `called for ${Math.round(msg.duration_seconds / 60)} min`
    : 'called'),
};

function serviceText(msg, ctx) {
  const who = msg.from_name ?? (msg.from === ctx.selfId ? 'You' : 'Someone');
  const phrase = SERVICE_PHRASE[msg.service];
  return `${who} ${phrase ? phrase(msg) : String(msg.service).replace(/_/g, ' ')}`;
}
