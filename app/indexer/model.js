// Constants and the index schema, mirrored from tools/tgindex/model.py.
//
// The browser builds the same index the Python indexer does, so nothing in the
// viewer needs to know which of the two produced it. The two are kept in step
// by tools/tests/test_web_parity.py, which runs both on one archive and fails
// on any difference in what they write.

export const SCHEMA_VERSION = 1;

// Sub-folders a Telegram Desktop export writes that hold the chat's own media.
export const MEDIA_DIRS = [
  'photos',
  'video_files',
  'voice_messages',
  'round_video_messages',
  'stickers',
  'files',
  'audio_files',
  'chat_photos',
  'profile_pictures',
];

// Telegram writes "(File not included...)" where media was left out of the
// export by its settings. The path is absent rather than broken.
export const NOT_INCLUDED_PREFIX = '(';

export const MEDIA_TYPE_KIND = {
  sticker: 'sticker',
  animation: 'gif',
  video_file: 'video',
  voice_message: 'voice',
  audio_file: 'music',
  video_message: 'round',
};

// Profile-panel tabs, in display order, and which media kinds feed each one.
export const LIBRARY_TABS = [
  ['media', ['photo', 'video', 'round']],
  ['files', ['file', 'unknown']],
  ['links', []],
  ['music', ['music']],
  ['voice', ['voice']],
  ['gifs', ['gif']],
  ['stickers', ['sticker']],
];

// Tabs that collapse repeats: stickers and GIFs are re-sent constantly.
export const DEDUPE_TABS = ['stickers', 'gifs'];

export const LINK_ENTITY_TYPES = ['link', 'text_link'];

// Message fields the normalizer consumes. Anything else is counted, so an
// unfamiliar export shows up in the report instead of vanishing silently.
export const HANDLED_MESSAGE_FIELDS = new Set([
  'id', 'type', 'date', 'date_unixtime', 'from', 'from_id', 'actor',
  'actor_id', 'action', 'text', 'text_entities', 'edited', 'edited_unixtime',
  'reply_to_message_id', 'reply_to_peer_id', 'reactions', 'file', 'file_name',
  'file_size', 'photo', 'photo_file_size', 'thumbnail', 'thumbnail_file_size',
  'media_type', 'mime_type', 'sticker_emoji', 'width', 'height',
  'duration_seconds', 'forwarded_from', 'saved_from', 'via_bot', 'author',
  'title', 'performer', 'message_id', 'self_destruct_period_seconds',
  'forwarded_from_id', 'members', 'inline_bot_buttons', 'media_spoiler',
]);

export const CHUNK_SIZE = 500;
export const MIN_TOKEN_LEN = 2;

// Telegram's own avatar exports, newest-looking first.
export const AVATAR_DIRS = ['profile_pictures', 'chat_photos'];
export const AVATAR_SUFFIXES = ['.jpg', '.jpeg', '.png', '.webp'];
