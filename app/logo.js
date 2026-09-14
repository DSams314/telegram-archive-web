// The app mark: three layered rounded squares on a purple-to-orange gradient.
//
// Read it as paper airplanes unfolded and stacked — the back two show only
// their folded corner, the front one is opened out with its crease lines
// radiating from the nose. A nod to Telegram's paper plane without copying it.
//
// Pure vector so it stays crisp at any size, and it is the single definition
// used by the setup wizard, the shutdown dialog and the generated app icon.

/** Inner marks only, on a transparent ground, in `currentColor`. */
export const LOGO_MARKS = `
  <g fill="none" stroke="currentColor" stroke-linecap="round"
     stroke-linejoin="round">
    <!-- The two sheets behind show only their folded corner. -->
    <path d="M21 68 V34 a12 12 0 0 1 12-12 H67" stroke-width="10"/>
    <path d="M40 87 V53 a12 12 0 0 1 12-12 H86" stroke-width="10"/>
    <!-- The front sheet is opened out. -->
    <rect x="59" y="59" width="45" height="45" rx="12" stroke-width="10"/>
    <!-- Creases fanning from the nose out to the far corners: the shape a
         paper plane leaves behind once it has been unfolded. -->
    <path d="M81.5 62 L63 101 M81.5 62 L72 103 M81.5 62 L81.5 103
             M81.5 62 L91 103 M81.5 62 L100 101" stroke-width="4"/>
  </g>`;

/**
 * The full mark.
 * @param size    rendered box, in px
 * @param rounded draw the gradient tile behind the marks
 */
export function logoSVG(size = 96, rounded = true) {
  const id = `lg${Math.random().toString(36).slice(2, 8)}`;
  return `
<svg viewBox="0 0 124 124" width="${size}" height="${size}"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0"    stop-color="#b9a3e3"/>
      <stop offset="0.45" stop-color="#d9b6d2"/>
      <stop offset="1"    stop-color="#efb183"/>
    </linearGradient>
  </defs>
  ${rounded ? `<rect x="2" y="2" width="120" height="120" rx="30" fill="url(#${id})"/>` : ''}
  <g color="#fdf6e3">${LOGO_MARKS}</g>
</svg>`;
}
