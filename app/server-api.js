// The downloadable app's operations: requests to its own local server,
// which runs on this computer and answers on 127.0.0.1 only.

const json = (response) => response.json();
const post = (path, body, type = 'application/json') => fetch(path, {
  method: 'POST',
  headers: { 'Content-Type': type },
  body,
});

export const serverApi = {
  config: () => fetch('api/config').then(json),

  browse: (path) =>
    fetch(`api/browse?path=${encodeURIComponent(path ?? '')}`).then(json),

  save: (body) => post('api/config', JSON.stringify(body)).then(json),

  reindex: () => fetch('api/reindex', { method: 'POST' }).then(json),

  avatar: (slug, blob) =>
    post(`api/avatar?slug=${encodeURIComponent(slug)}`, blob, blob.type).then(json),

  /** Store the chat background; returns the URL to show it from. */
  async wallpaper(dataURL) {
    const blob = await (await fetch(dataURL)).blob();
    const result = await post('api/wallpaper', blob, blob.type).then(json);
    if (!result.ok) throw new Error(result.error || 'could not be saved');
    return result.url;
  },

  clearWallpaper: () => fetch('api/wallpaper?clear=1', { method: 'POST' }).catch(() => {}),

  diagnostics: () => fetch('api/diagnostics', { method: 'POST' }).then(json),

  /** Nothing to do: the server saves every change the moment it is made. */
  persist: async () => ({ ok: true }),

  savesAutomatically: () => true,

  cancelIndex: () => fetch('api/index/cancel', { method: 'POST' }).catch(() => {}),
};
