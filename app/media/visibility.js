// One shared IntersectionObserver for every element that should only do work
// while it is on screen: GIFs, video stickers, waveform decoding.
//
// A chat can hold thousands of animations. Letting them all decode at once is
// what turns a scroll into a slideshow, so nothing plays until it is visible
// and everything stops as soon as it leaves.

import * as state from '../state.js';

const callbacks = new WeakMap();

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const fn = callbacks.get(entry.target);
      if (fn) fn(entry.isIntersecting, entry.target);
    }
  },
  {
    // Start slightly before the element arrives so it is already running by the
    // time it scrolls into view.
    rootMargin: '200px 0px',
    threshold: 0,
  },
);

export function watch(element, onChange) {
  callbacks.set(element, onChange);
  observer.observe(element);
}

export function unwatch(element) {
  observer.unobserve(element);
  callbacks.delete(element);
}

/**
 * Play only while visible. `preload="none"` keeps the file untouched until
 * then, so a chat full of GIFs costs nothing to scroll past.
 */
export function autoplayWhenVisible(video, kind = 'gif') {
  const allowed = () =>
    state.get(kind === 'sticker' ? 'autoplayStickers' : 'autoplayGifs');

  // A paused-by-setting video still shows its first frame, so it reads as
  // deliberate rather than broken.
  if (!allowed()) video.preload = 'metadata';

  watch(video, (visible) => {
    if (visible && allowed()) {
      // play() rejects if the element is detached mid-scroll; that is normal.
      video.play().catch(() => {});
    } else {
      video.pause();
      // Rewind so a re-entry restarts the loop rather than resuming mid-frame.
      if (video.currentTime > 0) video.currentTime = 0;
    }
  });
}
