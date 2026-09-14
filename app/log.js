// What happens in the page, written to the same log as everything else.
//
// Without this, half of any failure is invisible: a JavaScript error that
// blanks the window leaves no trace, and the person who hit it can only
// describe what they saw. Events are batched so a busy moment does not turn
// into a flood of writes.
//
// Where the log goes depends on how Telegram Archive is running:
//
//   downloadable app   to its own local server, into data/logs on this computer
//   website            into this browser's own storage, on this device
//
// The website never sends a log anywhere. It has no server to send one to,
// and it must not quietly acquire one: the default below talks only to the
// downloadable app's local server, and the website swaps it out before
// anything is logged.

const queue = [];
let timer = 0;
let sending = false;

async function toLocalServer(batch) {
  await fetch('api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: batch }),
  });
}

let transport = toLocalServer;

/** Route the log somewhere else -- the website points it at browser storage. */
export function useTransport(send) {
  transport = send;
}

function enqueue(event, level, fields) {
  queue.push({ event, level, ...fields });
  if (queue.length > 500) queue.splice(0, queue.length - 500);
  if (!timer) timer = setTimeout(flush, level === 'error' ? 150 : 1500);
}

async function flush() {
  timer = 0;
  if (sending || !queue.length) return;
  sending = true;
  const batch = queue.splice(0, queue.length);
  try {
    await transport(batch);
  } catch {
    // There is nowhere else to put these; losing a few lines is acceptable.
  } finally {
    sending = false;
    if (queue.length && !timer) timer = setTimeout(flush, 1500);
  }
}

export const info = (event, fields = {}) => enqueue(event, 'info', fields);
export const warn = (event, fields = {}) => enqueue(event, 'warn', fields);
export const error = (event, fields = {}) => enqueue(event, 'error', fields);

/**
 * Catch what nobody thought to log.
 *
 * The failures worth having are the ones nobody predicted, so the blanket
 * handlers matter more than any individual call above.
 */
export function init() {
  window.addEventListener('error', (event) => {
    error('app.error', {
      message: String(event.message || ''),
      source: `${event.filename || ''}:${event.lineno || 0}`,
      stack: String(event.error?.stack || '').slice(0, 2000),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    error('app.unhandled_rejection', {
      reason: String(event.reason?.message || event.reason || '').slice(0, 500),
      stack: String(event.reason?.stack || '').slice(0, 2000),
    });
  });

  info('app.loaded', {
    agent: navigator.userAgent,
    screen: `${window.innerWidth}x${window.innerHeight}`,
    language: navigator.language,
  });

  // A closing page should still deliver what it has. Only the downloadable
  // app's local server gets a beacon; anything else is a best-effort write.
  window.addEventListener('pagehide', () => {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    if (transport === toLocalServer) {
      try {
        navigator.sendBeacon('api/log', new Blob(
          [JSON.stringify({ entries: batch })], { type: 'application/json' }));
      } catch { /* nothing more to try at this point */ }
    } else {
      transport(batch).catch(() => {});
    }
  });
}
