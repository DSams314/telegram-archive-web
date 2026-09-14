// The window's connection to the server: one open stream, held for as long as
// this window is open.
//
// Closing the tab drops the socket, and the server finds out from the
// operating system. Nothing has to be remembered on the way out, which is why
// this replaced a timer: browsers throttle timers in background tabs to about
// once a minute, so switching tabs looked identical to closing the window and
// the server shut down under someone who was still using it.
//
// The same stream carries indexing progress, so the loading screen does not
// need a second channel or any polling.

import * as log from './log.js';

let source = null;
const listeners = new Set();
let latest = null;

/** Called with the indexer's state whenever it changes. */
export function onStatus(fn) {
  listeners.add(fn);
  if (latest) fn(latest);
  return () => listeners.delete(fn);
}

export function status() {
  return latest;
}

export function init() {
  connect();
  // A page being restored from the back/forward cache has a dead stream.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) connect();
  });
}

function connect() {
  if (source && source.readyState !== EventSource.CLOSED) return;
  try {
    source = new EventSource('api/session');
  } catch (error) {
    log.warn('session.unavailable', { error: String(error) });
    return;
  }

  source.addEventListener('status', (event) => {
    try {
      latest = JSON.parse(event.data);
      for (const fn of listeners) fn(latest);
    } catch { /* a malformed frame is not worth breaking the app over */ }
  });

  source.addEventListener('error', () => {
    // EventSource reconnects on its own. The only case worth acting on is the
    // server having gone for good, which the shutdown screen already covers.
    if (source.readyState === EventSource.CLOSED) {
      log.warn('session.closed');
    }
  });
}

/** Drop the stream deliberately, e.g. when shutting down from the UI. */
export function stop() {
  if (source) source.close();
  source = null;
}
