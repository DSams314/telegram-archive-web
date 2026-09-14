// The page's side of a conversation with the service worker.
//
// When the viewer shows a photo, the browser asks for "media/<path>". The
// service worker intercepts that request and asks this page for the file,
// because only the page holds the folder you chose. The file goes straight
// from your disk into the picture on screen -- it never touches the network.

import * as folder from './folder.js';
import * as config from './config.js';

/** A path inside the archive, or null if it tries to climb out of it. */
function inside(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function toBlob(dataURL) {
  const comma = dataURL.indexOf(',');
  const mime = /^data:([^;,]+)/.exec(dataURL)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataURL.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function answer(message) {
  if (message?.type === 'media') {
    const rel = inside(message.rel);
    if (!rel) return { ok: false };
    return { ok: true, file: await folder.mediaFile(rel) };
  }
  if (message?.type === 'avatar') {
    const picture = config.get().avatars?.[message.key];
    return picture ? { ok: true, blob: toBlob(picture) } : { ok: false };
  }
  return { ok: false };
}

export function install() {
  navigator.serviceWorker?.addEventListener('message', async (event) => {
    const port = event.ports?.[0];
    if (!port) return;
    try {
      port.postMessage(await answer(event.data));
    } catch {
      port.postMessage({ ok: false });
    }
  });
}
