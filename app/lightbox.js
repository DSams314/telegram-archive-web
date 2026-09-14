// Full-screen viewer for photos and videos, with arrow-key stepping through
// whatever set was opened (an album, or every image in the loaded history).

import { mediaURL } from './api.js';
import { icons } from './icons.js';

let overlay = null;
let items = [];
let index = 0;

function build() {
  overlay = document.createElement('div');
  overlay.id = 'lightbox';
  overlay.hidden = true;
  overlay.innerHTML = `
    <button class="lb-close" aria-label="Close">${icons.close}</button>
    <button class="lb-prev" aria-label="Previous">${icons.chevronLeft}</button>
    <div class="lb-stage"></div>
    <button class="lb-next" aria-label="Next">${icons.chevronRight}</button>
    <div class="lb-caption"></div>`;

  overlay.querySelector('.lb-close').onclick = close;
  overlay.querySelector('.lb-prev').onclick = () => step(-1);
  overlay.querySelector('.lb-next').onclick = () => step(1);
  // Clicking the backdrop closes; clicking the media itself must not.
  overlay.onclick = (event) => {
    if (event.target === overlay || event.target.classList.contains('lb-stage')) close();
  };

  document.body.append(overlay);
  window.addEventListener('keydown', onKey);
}

function onKey(event) {
  if (overlay?.hidden) return;
  if (event.key === 'Escape') close();
  else if (event.key === 'ArrowLeft') step(-1);
  else if (event.key === 'ArrowRight') step(1);
}

function show() {
  const media = items[index];
  const stage = overlay.querySelector('.lb-stage');
  stage.replaceChildren();

  if (media.kind === 'video' || media.kind === 'gif' || media.kind === 'round') {
    const video = document.createElement('video');
    video.src = mediaURL(media.src);
    video.controls = true;
    video.autoplay = true;
    video.loop = media.kind === 'gif';
    if (media.thumb) video.poster = mediaURL(media.thumb);
    stage.append(video);
  } else {
    const img = document.createElement('img');
    img.src = mediaURL(media.src);
    img.alt = '';
    stage.append(img);
  }

  overlay.querySelector('.lb-caption').textContent =
    items.length > 1 ? `${index + 1} of ${items.length}` : '';
  overlay.querySelector('.lb-prev').hidden = items.length < 2;
  overlay.querySelector('.lb-next').hidden = items.length < 2;
}

function step(delta) {
  if (items.length < 2) return;
  index = (index + delta + items.length) % items.length;
  show();
}

/** Open the viewer on `media`, optionally within a set to step through. */
export function open(media, set = null) {
  if (!overlay) build();
  items = set?.length ? set : [media];
  index = Math.max(0, items.indexOf(media));
  overlay.hidden = false;
  show();
}

export function close() {
  if (!overlay) return;
  overlay.querySelector('.lb-stage').replaceChildren(); // stop any playback
  overlay.hidden = true;
}
