// A small, invented archive so people can try Telegram Archive without first
// exporting their own chats.
//
// It flows through the exact same path a real folder does: it is handed to the
// app as a list of files (the way Safari and Firefox pass a folder), indexed
// in the browser, and shown. Nothing here is real, nothing is saved, and
// nothing touches your disk -- the pictures are drawn on the spot with a
// canvas, so there are no image files to ship either.
//
// The structure below is plain data with no browser APIs in it, so the tests
// can index this same archive under Node and confirm it comes out right.

export const DEMO_SELF = { id: 'user-demo-you', name: 'You' };

// A distinct look, so demo mode feels like a preview rather than your setup.
export const DEMO_CONFIG = {
  app: 'telegram-archive',
  format: 1,
  saved_at: null,
  setup_complete: true,
  self: DEMO_SELF,
  settings: { accent: '#7c6cf0', wallpaper: 'deep' },
  avatars: {},
};

const YOU = ['You', 'user-demo-you'];
const ROBIN = ['Robin', 'user-demo-robin'];
const SKY = ['Sky', 'user-demo-sky'];
const KAI = ['Kai', 'user-demo-kai'];
const BASE = 1715000000;   // mid-May 2024, so the dates read naturally

const line = (text) => ({ type: 'plain', text });

function say(id, offset, who, text, extra = {}) {
  return {
    id, type: 'message', date_unixtime: String(BASE + offset),
    from: who[0], from_id: who[1], text,
    text_entities: text ? [line(text)] : [],
    ...extra,
  };
}

const reaction = (emoji, people) => ({
  type: 'emoji', count: people.length, emoji,
  recent: people.map((p) => ({ from: p[0], from_id: p[1] })),
});

/** Each export's result.json, keyed by its path inside the demo folder. */
export function demoResultJsons() {
  const day = 86400;
  return {
    'Backups/Robin/ChatExport_2024-05-02/result.json': {
      name: 'Robin', type: 'personal_chat', id: 1,
      messages: [
        say(1, 0, ROBIN, 'did you catch the sunset last night??'),
        say(2, 60, YOU, 'no! send a pic'),
        say(3, 120, ROBIN, '', {
          photo: 'photos/sunset.jpg', photo_file_size: 48000, width: 480, height: 320,
        }),
        say(4, 180, YOU, 'whoa 😍', {
          reply_to_message_id: 3, reactions: [reaction('🔥', [ROBIN])],
        }),
        say(5, 240, ROBIN, "right?? 🌅"),
        say(6, 300, YOU, "that's my new wallpaper for sure"),
        say(7, 360, ROBIN, '', {
          file: 'stickers/wave.png', file_name: 'wave.png', file_size: 12000,
          media_type: 'sticker', mime_type: 'image/png', sticker_emoji: '👋',
          width: 256, height: 256,
        }),
        say(8, 420, YOU, '👋 see you Saturday'),
      ],
    },
    'Backups/Weekend Crew/ChatExport_2024-05-10/result.json': {
      name: 'Weekend Crew', type: 'private_group', id: 2,
      messages: [
        say(1, 3 * day, SKY, "who's in for the hike Saturday? 🥾"),
        say(2, 3 * day + 45, KAI, 'me!'),
        say(3, 3 * day + 90, ROBIN, 'in'),
        say(4, 3 * day + 140, YOU, 'count me in'),
        say(5, 3 * day + 300, SKY, 'here was the trail last time', {
          photo: 'photos/trail.jpg', photo_file_size: 52000, width: 480, height: 320,
        }),
        say(6, 3 * day + 360, KAI, 'gorgeous 😮', {
          reply_to_message_id: 5, reactions: [reaction('❤️', [YOU, ROBIN])],
        }),
        say(7, 3 * day + 420, YOU, "can't wait"),
        say(8, 3 * day + 480, ROBIN, 'bringing snacks 🍫'),
      ],
    },
    'Backups/Sky/ChatExport_2024-05-11/result.json': {
      name: 'Sky', type: 'personal_chat', id: 3,
      messages: [
        say(1, 4 * day, SKY, 'thanks for organizing today 🙌'),
        say(2, 4 * day + 50, YOU, 'anytime! that was fun'),
        say(3, 4 * day + 110, SKY, 'same time next month?'),
        say(4, 4 * day + 160, YOU, 'you know it', {
          reactions: [reaction('🎉', [SKY])],
        }),
      ],
    },
  };
}

// The media files those messages point at -- drawn, never shipped.
export const DEMO_MEDIA = {
  'Backups/Robin/ChatExport_2024-05-02/photos/sunset.jpg': { kind: 'photo', w: 480, h: 320, style: 'sunset' },
  'Backups/Robin/ChatExport_2024-05-02/stickers/wave.png': { kind: 'sticker', w: 256, h: 256, emoji: '👋' },
  'Backups/Weekend Crew/ChatExport_2024-05-10/photos/trail.jpg': { kind: 'photo', w: 480, h: 320, style: 'trail' },
};

// ---- turning it into files, in the browser -----------------------------------

function paint(spec) {
  const canvas = document.createElement('canvas');
  canvas.width = spec.w;
  canvas.height = spec.h;
  const g = canvas.getContext('2d');

  if (spec.kind === 'sticker') {
    g.clearRect(0, 0, spec.w, spec.h);
    g.font = `${Math.round(spec.h * 0.7)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(spec.emoji || '⭐', spec.w / 2, spec.h * 0.56);
    return blobOf(canvas, 'image/png');
  }

  const grad = g.createLinearGradient(0, 0, spec.w, spec.h);
  if (spec.style === 'sunset') {
    grad.addColorStop(0, '#ff9a5a');
    grad.addColorStop(0.55, '#d1518f');
    grad.addColorStop(1, '#4b3a6e');
    g.fillStyle = grad;
    g.fillRect(0, 0, spec.w, spec.h);
    g.fillStyle = 'rgba(255,240,205,0.92)';
    g.beginPath();
    g.arc(spec.w * 0.7, spec.h * 0.6, spec.h * 0.16, 0, Math.PI * 2);
    g.fill();
  } else {
    grad.addColorStop(0, '#3ea88f');
    grad.addColorStop(1, '#1b2f4a');
    g.fillStyle = grad;
    g.fillRect(0, 0, spec.w, spec.h);
    g.fillStyle = 'rgba(18,28,48,0.85)';
    for (const [x, peak] of [[0.35, 0.45], [0.72, 0.32]]) {
      g.beginPath();
      g.moveTo(spec.w * (x - 0.35), spec.h);
      g.lineTo(spec.w * x, spec.h * peak);
      g.lineTo(spec.w * (x + 0.3), spec.h);
      g.closePath();
      g.fill();
    }
  }
  return blobOf(canvas, 'image/jpeg');
}

function blobOf(canvas, type) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
}

/** Build the demo as {name, entries, config}, ready to open like a folder. */
export async function buildDemoArchive() {
  const entries = [];
  for (const [path, obj] of Object.entries(demoResultJsons())) {
    entries.push([path, new File([JSON.stringify(obj)], 'result.json',
      { type: 'application/json' })]);
  }
  for (const [path, spec] of Object.entries(DEMO_MEDIA)) {
    const blob = await paint(spec);
    const name = path.slice(path.lastIndexOf('/') + 1);
    entries.push([path, new File([blob], name, { type: blob.type })]);
  }
  return { name: 'Demo archive', entries, config: structuredClone(DEMO_CONFIG) };
}
