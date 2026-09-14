// Pick the square out of a picture yourself, instead of taking the middle.
//
// A centre crop is wrong more often than it is right — faces sit off-centre,
// and group photos need one person picked out. This shows the image with a
// circular mask, lets you drag to position and zoom to scale, and exports
// exactly what is under the mask.

const OUTPUT = 512;      // stored size, in px
const VIEW = 300;        // editing area, in px
const MAX_ZOOM = 5;

let overlay = null;

function build() {
  overlay = document.createElement('div');
  overlay.id = 'cropper';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="cr-card">
      <h2>Position the picture</h2>
      <p>Drag to move, scroll or use the slider to zoom.</p>
      <div class="cr-stage">
        <canvas class="cr-canvas" width="${VIEW}" height="${VIEW}"></canvas>
        <div class="cr-mask"></div>
      </div>
      <div class="cr-zoom">
        <span>Zoom</span>
        <input type="range" min="100" max="${MAX_ZOOM * 100}" value="100">
      </div>
      <div class="cr-actions">
        <button class="cr-btn ghost">Cancel</button>
        <button class="cr-btn primary">Use photo</button>
      </div>
    </div>`;
  document.body.append(overlay);
  return overlay;
}

/**
 * Show the cropper for `file`.
 * @returns a square JPEG Blob, or null if cancelled.
 */
export async function cropToSquare(file) {
  if (!overlay) build();
  const bitmap = await createImageBitmap(file);

  const canvas = overlay.querySelector('.cr-canvas');
  const ctx = canvas.getContext('2d');
  const slider = overlay.querySelector('input[type=range]');

  // Start at the smallest scale that still covers the whole view, so there is
  // never a gap at the edges however the picture is shaped.
  const cover = Math.max(VIEW / bitmap.width, VIEW / bitmap.height);
  const view = { scale: 1, x: 0, y: 0 };

  const clamp = () => {
    const w = bitmap.width * cover * view.scale;
    const h = bitmap.height * cover * view.scale;
    // Never let the image pull away from an edge of the frame.
    const limitX = Math.max(0, (w - VIEW) / 2);
    const limitY = Math.max(0, (h - VIEW) / 2);
    view.x = Math.min(limitX, Math.max(-limitX, view.x));
    view.y = Math.min(limitY, Math.max(-limitY, view.y));
  };

  const draw = () => {
    clamp();
    const w = bitmap.width * cover * view.scale;
    const h = bitmap.height * cover * view.scale;
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.drawImage(bitmap, (VIEW - w) / 2 + view.x, (VIEW - h) / 2 + view.y, w, h);
  };

  slider.value = 100;
  draw();

  slider.oninput = () => { view.scale = Number(slider.value) / 100; draw(); };

  const stage = overlay.querySelector('.cr-stage');
  const onWheel = (event) => {
    event.preventDefault();
    view.scale = Math.min(MAX_ZOOM, Math.max(1, view.scale - event.deltaY * 0.002));
    slider.value = Math.round(view.scale * 100);
    draw();
  };
  stage.addEventListener('wheel', onWheel, { passive: false });

  let dragging = null;
  stage.onpointerdown = (event) => {
    dragging = { x: event.clientX - view.x, y: event.clientY - view.y };
    stage.setPointerCapture(event.pointerId);
  };
  stage.onpointermove = (event) => {
    if (!dragging) return;
    view.x = event.clientX - dragging.x;
    view.y = event.clientY - dragging.y;
    draw();
  };
  stage.onpointerup = () => { dragging = null; };

  overlay.hidden = false;

  const result = await new Promise((resolve) => {
    const finish = (value) => {
      overlay.hidden = true;
      stage.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') finish(null);
      if (event.key === 'Enter') finish(exportSquare());
    };

    const exportSquare = () => {
      // Redraw at full output size using the same geometry, so what was on
      // screen is exactly what gets saved.
      const out = document.createElement('canvas');
      out.width = out.height = OUTPUT;
      const octx = out.getContext('2d');
      const ratio = OUTPUT / VIEW;
      const w = bitmap.width * cover * view.scale * ratio;
      const h = bitmap.height * cover * view.scale * ratio;
      octx.drawImage(bitmap,
        (OUTPUT - w) / 2 + view.x * ratio, (OUTPUT - h) / 2 + view.y * ratio, w, h);
      return new Promise((res) => out.toBlob(res, 'image/jpeg', 0.9));
    };

    overlay.querySelector('.ghost').onclick = () => finish(null);
    overlay.querySelector('.primary').onclick = async () => finish(await exportSquare());
    overlay.onclick = (event) => { if (event.target === overlay) finish(null); };
    window.addEventListener('keydown', onKey);
  });

  bitmap.close();
  return result;
}
