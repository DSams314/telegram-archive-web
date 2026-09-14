// Voice messages: a real waveform, a scrubber, and a play button.
//
// Telegram's export throws the waveform away -- the .ogg is all there is. So
// the peaks are computed here with WebAudio the first time a message is played,
// then cached. Until then the bars render at a neutral height, which is both
// honest and instant.

import { duration } from '../format.js';
import { icons } from '../icons.js';

const BARS = 48;
const peakCache = new Map();

let audioContext = null;
const context = () => {
  // Created lazily: constructing an AudioContext before a user gesture leaves
  // it suspended, and there is no reason to hold one open for a chat with no
  // voice messages in it.
  audioContext ??= new (window.AudioContext ?? window.webkitAudioContext)();
  return audioContext;
};

/**
 * Decode `url` and reduce it to `BARS` normalised peaks (0..1).
 * Returns null when the browser can't decode the codec.
 */
async function computePeaks(url) {
  if (peakCache.has(url)) return peakCache.get(url);

  const promise = (async () => {
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    const buffer = await context().decodeAudioData(bytes);

    const channel = buffer.getChannelData(0);
    const per = Math.floor(channel.length / BARS) || 1;
    const peaks = [];
    for (let i = 0; i < BARS; i += 1) {
      let max = 0;
      const start = i * per;
      for (let j = start; j < start + per && j < channel.length; j += 1) {
        const value = Math.abs(channel[j]);
        if (value > max) max = value;
      }
      peaks.push(max);
    }
    const loudest = Math.max(...peaks, 0.01);
    return peaks.map((p) => p / loudest);
  })().catch(() => {
    // Safari has historically not decoded Opus-in-Ogg. A flat waveform is a
    // fine outcome; the audio itself still plays through the <audio> element.
    peakCache.set(url, null);
    return null;
  });

  peakCache.set(url, promise);
  return promise;
}

function drawBars(canvas, peaks, progress) {
  const ctx = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const styles = getComputedStyle(canvas);
  const played = styles.getPropertyValue('--wave-played').trim() || '#fff';
  const rest = styles.getPropertyValue('--wave-rest').trim() || 'rgba(255,255,255,.4)';

  const gap = 2;
  const barWidth = Math.max(1.5, (width - gap * (BARS - 1)) / BARS);

  for (let i = 0; i < BARS; i += 1) {
    const value = peaks ? peaks[i] : 0.45;
    const barHeight = Math.max(2, value * height);
    const x = i * (barWidth + gap);
    const y = (height - barHeight) / 2;
    ctx.fillStyle = (i / BARS) < progress ? played : rest;
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, barHeight, barWidth / 2);
    ctx.fill();
  }
}

/** Build the voice-message player element. */
export function renderVoice(media, src) {
  const wrap = document.createElement('div');
  wrap.className = 'voice';

  const button = document.createElement('button');
  button.className = 'voice-play';
  button.innerHTML = icons.play;
  button.setAttribute('aria-label', 'Play voice message');

  const body = document.createElement('div');
  body.className = 'voice-body';

  const canvas = document.createElement('canvas');
  canvas.className = 'voice-wave';

  const time = document.createElement('span');
  time.className = 'voice-time';
  time.textContent = duration(media.duration);

  body.append(canvas, time);
  wrap.append(button, body);

  const audio = new Audio();
  audio.preload = 'none';
  audio.src = src;

  let peaks = null;
  let progress = 0;
  const repaint = () => drawBars(canvas, peaks, progress);

  // The canvas has no intrinsic size until it is laid out.
  requestAnimationFrame(repaint);
  new ResizeObserver(repaint).observe(canvas);

  button.onclick = async () => {
    if (audio.paused) {
      button.innerHTML = icons.pause;
      audio.play().catch(() => {});
      if (peaks === null) {
        peaks = await computePeaks(src);
        repaint();
      }
    } else {
      audio.pause();
      button.innerHTML = icons.play;
    }
  };

  audio.addEventListener('timeupdate', () => {
    progress = audio.duration ? audio.currentTime / audio.duration : 0;
    time.textContent = duration(audio.currentTime);
    repaint();
  });

  audio.addEventListener('ended', () => {
    progress = 0;
    button.innerHTML = icons.play;
    time.textContent = duration(media.duration);
    repaint();
  });

  // Click the waveform to seek.
  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    if (audio.duration) audio.currentTime = audio.duration * fraction;
  };

  return wrap;
}
