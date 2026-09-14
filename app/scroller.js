// The continuous-history scroller.
//
// A chat can hold years of messages, so they are never all in the DOM. The
// column instead holds one permanent <section> per chunk: materialised with
// real bubbles when near the viewport, collapsed back to a plain height when
// far from it.
//
// Two properties make this workable and both come from earlier phases:
//
//   * Media carries explicit pixel dimensions (phase 2), so a chunk's height is
//     final the moment it renders -- images loading later never resize it.
//   * Replies carry a denormalised preview (phase 1's index), so a chunk renders
//     completely on its own, with no fetch for a neighbouring chunk.
//
// Because the <section> wrappers are permanent, there is always a stable anchor
// to measure against, which is what keeps the viewport still while chunks above
// it change height.

import { loadChunk } from './api.js';
import { dayLabel, differentDay } from './format.js';
import { renderMessage, renderAlbum, fillGutter } from './message.js';
import { groupAlbums } from './media/album.js';

import * as state from './state.js';

// Messages from one sender inside this many seconds form a single visual run.
const groupWindow = () => state.get('groupWindow') ?? 300;

// How far beyond the viewport to keep chunks materialised, in screenfuls.
const BAND_BEFORE = 1;
const BAND_AFTER = 1.5;

// Ceiling on materialised chunks. At 500 messages each this is a comfortable
// DOM size while still covering fast scrolling.
const MAX_LIVE = 6;

// Starting guesses, refined from real measurements as chunks render.
const INITIAL_MSG_HEIGHT = 40;
const INITIAL_MEDIA_HEIGHT = 260;

export class Scroller {
  constructor(scrollEl, columnEl) {
    this.scrollEl = scrollEl;
    this.columnEl = columnEl;
    this.chunks = [];
    this.live = new Set();
    this.generation = 0;
    this.pending = new Set();
    this.msgHeight = INITIAL_MSG_HEIGHT;
    this.mediaHeight = INITIAL_MEDIA_HEIGHT;
    this.samples = 0;
    this.onVisibleDateChange = null;
    this.onScrollPositionChange = null;
    this.lastWidth = 0;
    // Set while a deliberate jump is moving scrollTop, so the scroll handler
    // doesn't treat the intermediate positions as user scrolling.
    this.jumping = false;

    this.handleScroll = this.handleScroll.bind(this);
    this.frame = 0;
  }

  // -- lifecycle ----------------------------------------------------------

  async mount(slug, meta, ctx) {
    const generation = ++this.generation;
    this.slug = slug;
    this.meta = meta;
    this.ctx = ctx;
    this.live.clear();
    this.pending.clear();
    this.samples = 0;
    this.msgHeight = INITIAL_MSG_HEIGHT;
    this.mediaHeight = INITIAL_MEDIA_HEIGHT;

    this.chunks = meta.chunks.map((info) => ({
      info,
      el: null,
      height: null,     // measured, once rendered
      rendered: false,
    }));

    this.columnEl.replaceChildren();
    for (const chunk of this.chunks) {
      const section = document.createElement('section');
      section.className = 'chunk';
      section.dataset.n = chunk.info.n;
      section.style.height = `${this.estimate(chunk)}px`;
      chunk.el = section;
      this.columnEl.append(section);
    }

    this.scrollEl.addEventListener('scroll', this.handleScroll, { passive: true });
    this.lastWidth = this.columnEl.clientWidth;

    // Open at the newest messages, the way the app does.
    const last = this.chunks.length - 1;
    await this.materialize(last, generation);
    if (generation !== this.generation) return;
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    await this.update();
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    this.reportPosition();
  }

  destroy() {
    this.generation += 1;
    this.scrollEl.removeEventListener('scroll', this.handleScroll);
    cancelAnimationFrame(this.frame);
    this.columnEl.replaceChildren();
    this.chunks = [];
    this.live.clear();
  }

  /** Re-measure after a width change: text rewraps, so cached heights lie. */
  handleResize() {
    if (this.columnEl.clientWidth === this.lastWidth) return;
    this.lastWidth = this.columnEl.clientWidth;
    for (const chunk of this.chunks) {
      if (chunk.rendered) {
        chunk.height = chunk.el.getBoundingClientRect().height;
      } else {
        chunk.el.style.height = `${this.estimate(chunk)}px`;
      }
    }
  }

  // -- height bookkeeping -------------------------------------------------

  estimate(chunk) {
    if (chunk.height != null) return chunk.height;
    const { count, media = 0 } = chunk.info;
    return Math.round((count - media) * this.msgHeight + media * this.mediaHeight);
  }

  /**
   * Fold a real measurement into the running averages so unrendered chunks
   * get better estimates -- and the scrollbar becomes progressively honest.
   */
  learn(chunk, height) {
    const { count, media = 0 } = chunk.info;
    if (!count) return;
    const plain = Math.max(1, count - media);
    // Attribute the media portion at the current media estimate, then solve
    // for the plain-message height from what's left.
    const perPlain = Math.max(12, (height - media * this.mediaHeight) / plain);
    this.samples += 1;
    const weight = 1 / Math.min(this.samples, 8);
    this.msgHeight += (perPlain - this.msgHeight) * weight;

    for (const other of this.chunks) {
      if (!other.rendered && other.height == null) {
        other.el.style.height = `${this.estimate(other)}px`;
      }
    }
  }

  // -- anchoring ----------------------------------------------------------

  /**
   * Capture the viewport's position relative to a chunk that will still exist
   * after the coming mutation. Chunk sections are permanent, so this is always
   * safe -- which is the whole reason they are never removed.
   */
  captureAnchor() {
    const { scrollTop } = this.scrollEl;
    let anchor = this.chunks[0];
    for (const chunk of this.chunks) {
      if (chunk.el.offsetTop <= scrollTop) anchor = chunk;
      else break;
    }
    return { el: anchor.el, delta: scrollTop - anchor.el.offsetTop };
  }

  restoreAnchor(anchor) {
    if (!anchor) return;
    this.scrollEl.scrollTop = anchor.el.offsetTop + anchor.delta;
  }

  // -- materialisation ----------------------------------------------------

  async materialize(index, generation) {
    const chunk = this.chunks[index];
    if (!chunk || chunk.rendered || this.pending.has(index)) return;
    this.pending.add(index);

    let messages;
    try {
      messages = await loadChunk(this.slug, chunk.info.n);
    } catch {
      this.pending.delete(index);
      chunk.el.style.height = '0px';
      return;
    } finally {
      this.pending.delete(index);
    }
    if (generation !== this.generation) return;

    const anchor = this.captureAnchor();

    const previous = index > 0 ? this.chunks[index - 1].info : null;
    chunk.el.replaceChildren(this.buildChunk(messages, previous));
    chunk.el.style.height = '';
    chunk.rendered = true;
    this.live.add(index);

    const height = chunk.el.getBoundingClientRect().height;
    chunk.height = height;
    this.learn(chunk, height);

    this.restoreAnchor(anchor);
  }

  dematerialize(index) {
    const chunk = this.chunks[index];
    if (!chunk || !chunk.rendered) return;
    const anchor = this.captureAnchor();
    // Pin the measured height before emptying, so the page doesn't collapse.
    chunk.el.style.height = `${chunk.height ?? this.estimate(chunk)}px`;
    chunk.el.replaceChildren();
    chunk.rendered = false;
    this.live.delete(index);
    this.restoreAnchor(anchor);
  }

  buildChunk(messages, previousChunk) {
    const fragment = document.createDocumentFragment();
    let previous = previousChunk
      ? { date: previousChunk.last_date, from: previousChunk.last_from }
      : null;

    const rows = [];
    // Consecutive photos/videos sharing a sender and send time were one album
    // in the app, so they collapse back into a single tiled bubble.
    for (const entry of groupAlbums(messages)) {
      const head = entry.album ? entry.album[0] : entry.message;
      const newDay = !previous || differentDay(previous.date, head.date);
      if (newDay) fragment.append(pill(dayLabel(head.date)));

      const lead = !previous
        || previous.from !== head.from
        || head.date - previous.date > groupWindow()
        || newDay;

      const node = entry.album
        ? renderAlbum(entry.album, this.ctx, { lead })
        : renderMessage(head, this.ctx, { lead });
      fragment.append(node);
      if (!head.service) rows.push(node);
      previous = head.service ? null : { date: head.date, from: head.from };
    }

    // The last bubble of each run gets the tucked corner -- and, in a group,
    // the sender's picture in its gutter.
    rows.forEach((row, i) => {
      const next = rows[i + 1];
      const endsRun = !next
        || next.classList.contains('lead')
        || next.classList.contains('out') !== row.classList.contains('out');
      if (!endsRun) return;
      const out = row.classList.contains('out');
      row.classList.add(out ? 'tail-out' : 'tail-in');
      if (!out && this.ctx.isGroup) fillGutter(row, this.ctx);
    });

    return fragment;
  }

  // -- the scroll loop ----------------------------------------------------

  handleScroll() {
    if (this.jumping) return;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.update();
      this.reportVisibleDate();
      this.reportPosition();
    });
  }

  /** Materialise what's near the viewport, release what isn't. */
  async update() {
    const generation = this.generation;
    const { scrollTop, clientHeight } = this.scrollEl;
    const top = scrollTop - clientHeight * BAND_BEFORE;
    const bottom = scrollTop + clientHeight * (1 + BAND_AFTER);

    const wanted = [];
    for (let i = 0; i < this.chunks.length; i += 1) {
      const el = this.chunks[i].el;
      const start = el.offsetTop;
      const end = start + (this.chunks[i].rendered
        ? el.getBoundingClientRect().height
        : this.estimate(this.chunks[i]));
      if (end >= top && start <= bottom) wanted.push(i);
    }
    if (!wanted.length) return;

    // A very tall viewport can want more than the budget; keep the ones
    // closest to the middle of the band.
    const centre = (wanted[0] + wanted[wanted.length - 1]) / 2;
    const keep = wanted.length <= MAX_LIVE
      ? wanted
      : [...wanted]
          .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre))
          .slice(0, MAX_LIVE)
          .sort((a, b) => a - b);

    for (const index of [...this.live]) {
      if (!keep.includes(index)) this.dematerialize(index);
    }

    for (const index of keep) {
      if (generation !== this.generation) return;
      await this.materialize(index, generation);
    }
  }

  // -- navigation ---------------------------------------------------------

  /** Centre `row` in the viewport without animating. */
  centreOn(row) {
    const offset = row.offsetTop - (this.scrollEl.clientHeight - row.offsetHeight) / 2;
    this.scrollEl.scrollTop = Math.max(0, offset);
  }

  /**
   * Bring a message on screen, loading its chunk if needed, and flash it.
   *
   * Smooth scrolling is only safe for a target that is already rendered and
   * close by. Over a long distance it fights this class: every chunk that
   * materialises en route assigns scrollTop to hold the anchor, and assigning
   * scrollTop cancels a smooth scroll -- so the animation dies partway and the
   * destination gets released again for being outside the band. Long jumps are
   * therefore instant, which is also what the desktop app does.
   */
  async jumpToMessage(id) {
    const target = this.meta.chunks.find((c) => id >= c.first_id && id <= c.last_id);
    if (!target) return false;

    const existing = this.columnEl.querySelector(`.msg[data-id="${id}"]`);
    if (existing) {
      const distance = Math.abs(existing.offsetTop - this.scrollEl.scrollTop);
      if (distance < this.scrollEl.clientHeight * 2) {
        existing.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(existing);
        return true;
      }
    }

    const generation = this.generation;
    const index = this.chunks.findIndex((c) => c.info.n === target.n);

    // Hold off the scroll handler: the jump moves scrollTop deliberately, and
    // update() reacting to each intermediate position would undo it.
    this.jumping = true;
    try {
      await this.materialize(index, generation);
      if (generation !== this.generation) return false;
      // Neighbours too, so a target at a chunk edge doesn't sit against a gap.
      await this.materialize(index - 1, generation);
      await this.materialize(index + 1, generation);

      const row = this.columnEl.querySelector(`.msg[data-id="${id}"]`);
      if (!row) return false;
      this.centreOn(row);
    } finally {
      this.jumping = false;
    }

    // Now settle the window around the new position, then re-find the row:
    // update() may have released and rebuilt neighbouring chunks.
    await this.update();
    if (generation !== this.generation) return false;

    const row = this.columnEl.querySelector(`.msg[data-id="${id}"]`);
    if (!row) return false;
    this.centreOn(row);
    flash(row);
    this.reportPosition();
    return true;
  }

  async jumpToDate(unix) {
    const target = this.meta.chunks.find((c) => unix <= c.last_date)
      ?? this.meta.chunks[this.meta.chunks.length - 1];
    const index = this.chunks.findIndex((c) => c.info.n === target.n);
    const generation = this.generation;
    await this.materialize(index, generation);
    if (generation !== this.generation) return;

    const rows = [...this.columnEl.querySelectorAll('.msg[data-date]')];
    const row = rows.find((node) => Number(node.dataset.date) >= unix) ?? rows[0];
    row?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  scrollToBottom() {
    this.scrollEl.scrollTo({ top: this.scrollEl.scrollHeight, behavior: 'smooth' });
  }

  // -- reporting ----------------------------------------------------------

  reportVisibleDate() {
    if (!this.onVisibleDateChange) return;
    const { scrollTop } = this.scrollEl;
    let found = null;
    for (const index of [...this.live].sort((a, b) => a - b)) {
      for (const row of this.chunks[index].el.querySelectorAll('.msg[data-date]')) {
        if (row.offsetTop + row.offsetHeight >= scrollTop) { found = row; break; }
      }
      if (found) break;
    }
    if (found) this.onVisibleDateChange(Number(found.dataset.date));
  }

  reportPosition() {
    if (!this.onScrollPositionChange) return;
    const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
    this.onScrollPositionChange(scrollHeight - scrollTop - clientHeight);
  }
}

function pill(text) {
  const node = document.createElement('div');
  node.className = 'day-pill';
  node.textContent = text;
  return node;
}

function flash(row) {
  const bubble = row.querySelector('.bubble') ?? row;
  bubble.animate(
    [
      { filter: 'brightness(1)' },
      { filter: 'brightness(1.5)' },
      { filter: 'brightness(1)' },
    ],
    { duration: 1000, easing: 'ease-in-out' },
  );
}
