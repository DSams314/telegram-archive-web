// Spoiler media: a blurred image under drifting particles, revealed by a
// circle that grows from wherever you click.
//
// Telegram covers spoilers with a dense field of pale specks over a heavy
// blur. Reproduced here with one <canvas> of particles above a CSS-blurred
// copy of the media, because a static noise texture reads as a broken image
// while movement reads as deliberately hidden.

import { watch, unwatch } from './visibility.js';

// Particles per 10 000 px². Dense enough to obscure, sparse enough to stay
// cheap on a wall of spoilers.
const DENSITY = 26;
const MAX_PARTICLES = 1400;

/**
 * Wrap a media element in a spoiler cover.
 * @returns the wrapper to insert in place of `element`
 */
export function wrapSpoiler(element, box) {
  const wrap = document.createElement('div');
  wrap.className = 'spoiler';
  wrap.style.width = `${box.w}px`;
  wrap.style.height = `${box.h}px`;

  // The media itself is blurred rather than hidden, so the reveal has
  // something to uncover and the shape stays honest.
  element.classList.add('spoiler-media');
  wrap.append(element);

  const canvas = document.createElement('canvas');
  canvas.className = 'spoiler-sand';
  wrap.append(canvas);

  const label = document.createElement('span');
  label.className = 'spoiler-hint';
  label.textContent = 'Spoiler';
  wrap.append(label);

  const sand = new Sand(canvas, box);
  // Only animate while on screen; a chat full of spoilers should cost nothing
  // to scroll past.
  watch(wrap, (visible) => (visible ? sand.start() : sand.stop()));

  wrap.addEventListener('click', (event) => {
    if (wrap.classList.contains('revealed')) return;
    event.stopPropagation();   // don't also open the lightbox on this click

    // The reveal grows from the point of contact out to the furthest corner,
    // so wherever you touch is where it clears first.
    const rect = wrap.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const reach = Math.max(
      Math.hypot(x, y), Math.hypot(rect.width - x, y),
      Math.hypot(x, rect.height - y), Math.hypot(rect.width - x, rect.height - y),
    );
    wrap.style.setProperty('--reveal-x', `${x}px`);
    wrap.style.setProperty('--reveal-y', `${y}px`);
    wrap.style.setProperty('--reveal-r', `${Math.ceil(reach)}px`);
    wrap.classList.add('revealed');

    sand.dissolve(x, y, reach, () => {
      sand.stop();
      unwatch(wrap);
      canvas.remove();
    });
  }, true);

  return wrap;
}

/** The drifting particle field, and its outward dissolve. */
class Sand {
  constructor(canvas, box) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = Math.max(1, box.w);
    this.h = Math.max(1, box.h);
    this.frame = 0;
    this.running = false;
    this.wave = null;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(this.w * ratio);
    canvas.height = Math.round(this.h * ratio);
    this.ctx.scale(ratio, ratio);

    const count = Math.min(
      MAX_PARTICLES,
      Math.round((this.w * this.h) / 10000 * DENSITY),
    );
    this.particles = Array.from({ length: count }, () => this.spawn());
    this.draw();
  }

  spawn(atEdge = false) {
    return {
      x: Math.random() * this.w,
      y: atEdge ? this.h + Math.random() * 8 : Math.random() * this.h,
      r: 0.4 + Math.random() * 1.1,
      // Mostly upward, with a slight drift, like settling dust in reverse.
      vx: (Math.random() - 0.5) * 0.18,
      vy: -0.10 - Math.random() * 0.28,
      a: 0.25 + Math.random() * 0.7,
      gone: 0,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.step();
      this.draw();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  step() {
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -4) Object.assign(p, this.spawn(true));
      if (p.x < -4) p.x = this.w + 4;
      if (p.x > this.w + 4) p.x = -4;
    }
    if (this.wave) {
      this.wave.r += this.wave.speed;
      // Particles inside the expanding front fade and blow outward.
      for (const p of this.particles) {
        if (p.gone) { p.gone = Math.max(0, p.gone - 0.06); continue; }
        const d = Math.hypot(p.x - this.wave.x, p.y - this.wave.y);
        if (d < this.wave.r) {
          p.gone = 1;
          const angle = Math.atan2(p.y - this.wave.y, p.x - this.wave.x);
          p.vx = Math.cos(angle) * 1.7;
          p.vy = Math.sin(angle) * 1.7;
        }
      }
      if (this.wave.r > this.wave.reach + 40) {
        const done = this.wave.done;
        this.wave = null;
        done?.();
      }
    }
  }

  draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const p of this.particles) {
      const alpha = p.gone ? p.a * p.gone : p.a;
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  dissolve(x, y, reach, done) {
    this.start();          // in case it was paused off screen
    this.wave = { x, y, r: 0, reach, speed: Math.max(6, reach / 26), done };
  }
}
