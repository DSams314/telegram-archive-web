// Telegram animated stickers (.tgs).
//
// A .tgs is a gzipped Lottie JSON document. Inflating it needs no library at
// all -- DecompressionStream('gzip') is built into the browser, which keeps the
// program free of vendored code and of any network access.
//
// *Playing* Lottie is the other half, and that does need a renderer. Even a
// simple wave-hand sticker uses nested precompositions, layer parenting, bezier
// keyframes, trim paths and gradient strokes; a faithful player is a project in
// its own right. So this module is built around a pluggable renderer:
//
//   * If a renderer has been registered (see `registerRenderer`), stickers
//     animate.
//   * Otherwise they show the thumbnail Telegram already exported alongside
//     the .tgs -- which is exactly the frame the app itself displays before an
//     animation loads, so the fallback looks intentional rather than broken.

import { mediaURL } from '../api.js';
import { watch } from './visibility.js';

let renderer = null;

/**
 * Install a Lottie player. Expected shape:
 *   renderer({ container, animationData, loop }) -> { play, pause, destroy }
 */
export function registerRenderer(fn) {
  renderer = fn;
}

export const hasRenderer = () => renderer !== null;

const cache = new Map();

/** Fetch and inflate a .tgs into its Lottie document. */
export async function loadTGS(url) {
  if (cache.has(url)) return cache.get(url);

  const promise = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${url}`);

    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream unavailable');
    }
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).json();
  })().catch((err) => {
    cache.delete(url);
    throw err;
  });

  cache.set(url, promise);
  return promise;
}

/**
 * Build the element for a .tgs sticker, sized to `box`.
 * Animates when a renderer is available, otherwise shows the exported thumb.
 */
export function renderTGS(media, box) {
  const wrap = document.createElement('div');
  wrap.className = 'tgs';
  wrap.style.width = `${box.w}px`;
  wrap.style.height = `${box.h}px`;

  // The exported thumbnail is the poster frame in both paths: it shows
  // immediately, and an animation simply replaces it once ready.
  if (media.thumb) {
    const poster = document.createElement('img');
    poster.className = 'tgs-poster';
    poster.src = mediaURL(media.thumb);
    poster.alt = media.emoji ?? '';
    poster.loading = 'lazy';
    wrap.append(poster);
  } else {
    wrap.classList.add('tgs-bare');
    wrap.textContent = media.emoji ?? '';
  }

  if (!renderer) {
    wrap.classList.add('tgs-static');
    wrap.title = 'Animated sticker — showing its exported still frame';
    return wrap;
  }

  // Only decode once the sticker is actually on screen, and stop when it
  // leaves: a chat can hold hundreds of these.
  let instance = null;
  let loading = false;

  watch(wrap, async (visible) => {
    if (!visible) {
      instance?.pause();
      return;
    }
    if (instance) { instance.play(); return; }
    if (loading) return;
    loading = true;
    try {
      const animationData = await loadTGS(mediaURL(media.src));
      if (!wrap.isConnected) return;
      instance = renderer({ container: wrap, animationData, loop: true });
      wrap.classList.add('tgs-live');
    } catch {
      wrap.classList.add('tgs-static');
    } finally {
      loading = false;
    }
  });

  return wrap;
}
