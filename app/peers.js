// Per-person identity: colour, picture, and where their one-to-one chat lives.
//
// In a group every participant needs to be visually distinct — their name, the
// stripe on their bubbles, and any quote of their message all take the same
// colour. Telegram derives that colour from the account id; here it is derived
// the same way and can then be overridden per person and saved.

import { avatarNode } from './avatar.js';

// Telegram's own participant palette, in its usual order.
export const PEER_COLORS = [
  '#e17076', // red
  '#7bc862', // green
  '#e5ca77', // yellow
  '#65aadd', // blue
  '#a695e7', // purple
  '#ee7aae', // pink
  '#6ec9cb', // cyan
  '#faa774', // orange
];

const overrides = new Map();   // peer id -> colour, chosen by the user
let assigned = new Map();      // peer id -> colour, for the open chat
let manifest = null;

export function init(loadedManifest, savedColors) {
  manifest = loadedManifest;
  overrides.clear();
  for (const [id, colour] of Object.entries(savedColors ?? {})) {
    if (colour) overrides.set(id, colour);
  }
}

function hashColor(peerId) {
  let hash = 0;
  for (let i = 0; i < peerId.length; i += 1) {
    hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % PEER_COLORS.length;
}

/**
 * Give every participant of one chat a distinct colour.
 *
 * Hashing the id alone is stable but collides: in a four-person group two
 * people landing on the same colour is likely, and that defeats the whole
 * point of colouring names at all. So each chat gets its own assignment — the
 * hash is a preference, and a colour already taken rolls forward to the next
 * free one.
 */
export function assignForChat(chat) {
  assigned = new Map();
  const members = [...(chat?.peers ?? [])]
    .filter((p) => p.id)
    // Busiest first, so the people you see most keep their preferred colour
    // and any compromise lands on someone who barely speaks.
    .sort((a, b) => b.messages - a.messages);

  const taken = new Set();
  for (const member of members) {
    if (overrides.has(member.id)) continue;   // the user's choice is untouchable
    let index = hashColor(member.id);
    for (let step = 0; step < PEER_COLORS.length && taken.has(index); step += 1) {
      index = (index + 1) % PEER_COLORS.length;
    }
    taken.add(index);
    assigned.set(member.id, PEER_COLORS[index]);
  }
}

/** The colour for a participant: their own choice, else this chat's assignment. */
export function colorFor(peerId) {
  if (!peerId) return PEER_COLORS[0];
  return overrides.get(peerId)
    ?? assigned.get(peerId)
    ?? PEER_COLORS[hashColor(peerId)];
}

export function setColor(peerId, colour) {
  if (colour) overrides.set(peerId, colour);
  else overrides.delete(peerId);
}

export const allOverrides = () => Object.fromEntries(overrides);

/** Every participant seen across the archive, by id. */
export function directory() {
  const out = new Map();
  for (const chat of manifest?.chats ?? []) {
    for (const peer of chat.peers ?? []) {
      if (!peer.id) continue;
      const at = out.get(peer.id) ?? { id: peer.id, name: peer.name, messages: 0, chats: [] };
      at.messages += peer.messages;
      at.chats.push(chat.slug);
      if (peer.name && peer.name !== peer.id) at.name = peer.name;
      out.set(peer.id, at);
    }
  }
  return out;
}

/**
 * The one-to-one chat with this person, if the archive has one.
 *
 * Matched on participant id rather than name: display names change, and two
 * people can share one.
 */
export function directChatFor(peerId, selfId) {
  // You have no one-to-one chat with yourself, and asking for one must not
  // match the first chat that merely contains you.
  if (!peerId || peerId === selfId) return null;
  return (manifest?.chats ?? []).find((chat) => {
    if (chat.type !== 'personal_chat') return false;
    const others = (chat.peers ?? []).map((p) => p.id).filter((id) => id !== selfId);
    return others.length === 1 && others[0] === peerId;
  }) ?? null;
}

/** Small circular avatar for a participant, used beside messages. */
export function peerAvatar(peerId, name, size = 32) {
  // Pictures are keyed by the participant id, so one upload follows that person
  // into every chat they appear in.
  const node = avatarNode(name ?? peerId ?? '?', size, null, peerId, colorFor(peerId));
  node.dataset.peer = peerId ?? '';
  return node;
}
