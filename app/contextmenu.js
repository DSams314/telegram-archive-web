// A small right-click menu, shared by media tiles and message bubbles.

let menu = null;

function ensure() {
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.hidden = true;
  document.body.append(menu);

  // Any interaction elsewhere dismisses it -- but never the click that is
  // choosing an item.
  window.addEventListener('pointerdown', (e) => {
    if (!menu.contains(e.target)) close();
  }, true);
  window.addEventListener('wheel', () => close(), true);

  // No capture on blur. `blur` does not bubble, but a capturing listener on
  // window still sees every element's blur -- so clicking a menu item, which
  // blurs whatever was focused, would hide the menu on mousedown and the click
  // would never land on the button.
  window.addEventListener('blur', () => close());

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return menu;
}

export function close() {
  if (menu) menu.hidden = true;
}

/**
 * Open a menu at the pointer.
 * @param items [{ label, onSelect, danger }] — a null entry draws a separator.
 */
export function open(event, items) {
  event.preventDefault();
  const node = ensure();
  node.replaceChildren();

  for (const item of items) {
    if (!item) {
      node.append(Object.assign(document.createElement('div'), { className: 'cm-sep' }));
      continue;
    }
    const button = document.createElement('button');
    button.className = 'cm-item' + (item.danger ? ' cm-danger' : '');
    button.textContent = item.label;
    button.onclick = () => { close(); item.onSelect(); };
    node.append(button);
  }

  // Measure before placing so the menu can flip near a screen edge.
  node.hidden = false;
  node.style.left = '0px';
  node.style.top = '0px';
  const box = node.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - box.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - box.height - 8);
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${Math.max(8, y)}px`;
}

/** Attach a menu to an element, built fresh on each right-click. */
export function attach(element, build) {
  element.addEventListener('contextmenu', (event) => {
    const items = build();
    if (items?.length) open(event, items);
  });
}
