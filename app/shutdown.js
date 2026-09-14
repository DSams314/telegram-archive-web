// Stopping the program from inside it.
//
// The viewer is a web page in front of a local server, so "quitting" means
// stopping that server. Closing the tab alone would leave it running, which is
// the thing people forget — hence a real button.

import { icons } from './icons.js';
import { logoSVG } from './logo.js';

let dialog = null;

function build() {
  dialog = document.createElement('div');
  dialog.id = 'shutdown';
  dialog.hidden = true;
  dialog.innerHTML = `
    <div class="sd-card" role="alertdialog" aria-labelledby="sd-title">
      <div class="sd-icon">${icons.power}</div>
      <h2 id="sd-title">Shut down Telegram Archive?</h2>
      <p>The local server stops and this page goes offline.
         Nothing in your archive changes.</p>
      <div class="sd-actions">
        <button class="sd-btn ghost">Cancel</button>
        <button class="sd-btn danger">Shut down</button>
      </div>
    </div>`;

  dialog.querySelector('.ghost').onclick = close;
  dialog.querySelector('.danger').onclick = confirmShutdown;
  // Clicking the backdrop is a cancel; clicking the card is not.
  dialog.onclick = (event) => { if (event.target === dialog) close(); };
  window.addEventListener('keydown', (event) => {
    if (dialog.hidden) return;
    if (event.key === 'Escape') close();
  });
  document.body.append(dialog);
}

export function open() {
  if (!dialog) build();
  dialog.hidden = false;
  dialog.querySelector('.danger').focus();
}

export function close() {
  if (dialog) dialog.hidden = true;
}

export const isOpen = () => dialog != null && !dialog.hidden;

async function confirmShutdown() {
  const card = dialog.querySelector('.sd-card');
  try {
    await fetch('api/shutdown', { method: 'POST' });
  } catch {
    // The server may drop the connection as it goes down; that is a success.
  }
  card.innerHTML = `
    <div class="sd-logo">${logoSVG(56)}</div>
    <h2>Telegram Archive has stopped</h2>
    <p>You can close this tab. Start it again with
       <code>Start Viewer</code> in the program folder.</p>`;
}
