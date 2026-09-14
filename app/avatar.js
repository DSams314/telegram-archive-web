// Avatars, shared by the chat list, headers, message rows and the profile panel.
//
// Lives on its own so `peers.js` and `message.js` can both use it without an
// import cycle.

import { mediaURL } from './api.js';
import { initials, avatarColor } from './format.js';

const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

// Bumped after an upload so the browser re-fetches a URL that never changes.
let avatarVersion = 0;
export const bumpAvatarVersion = () => { avatarVersion = Date.now(); };

/**
 * Avatar for a person or chat.
 *
 * Order of preference: a picture the user set (data/avatars/<key>.jpg), then
 * whatever the export happened to include, then coloured initials. The user
 * picture is probed with an <img> error fallback rather than a directory
 * listing, so a subject with no custom picture costs one 404 and nothing else.
 *
 * `key` is a chat slug or a participant id -- a picture set for a person
 * therefore follows them into every chat they appear in.
 */
export function avatarNode(name, size, src, key, color) {
  const node = el('div', 'avatar');
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  node.style.fontSize = `${Math.round(size * 0.38)}px`;

  const initialsFallback = () => {
    node.replaceChildren();
    node.style.background = color ?? avatarColor(name);
    node.textContent = initials(name);
  };

  const showImage = (url, onFail) => {
    const img = el('img');
    img.alt = '';
    img.onerror = onFail;
    img.src = url;
    node.style.background = 'none';
    node.replaceChildren(img);
  };

  if (key) {
    showImage(`data/avatars/${encodeURIComponent(key)}.jpg?v=${avatarVersion}`,
      () => (src ? showImage(mediaURL(src), initialsFallback) : initialsFallback()));
  } else if (src) {
    showImage(mediaURL(src), initialsFallback);
  } else {
    initialsFallback();
  }
  return node;
}
