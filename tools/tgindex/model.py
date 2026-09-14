"""Shared constants and the normalized on-disk schema for the viewer index.

The index format is the contract between the indexer (Python, this package) and
the viewer (static JS).  Everything the viewer renders comes from here; it never
reads a raw Telegram export.  Keep this module free of I/O so the schema is easy
to read in one sitting.
"""

SCHEMA_VERSION = 1

# Sub-folders a Telegram Desktop export writes that hold *user* media.
MEDIA_DIRS = (
    "photos",
    "video_files",
    "voice_messages",
    "round_video_messages",
    "stickers",
    "files",
    "audio_files",
    "chat_photos",
    "profile_pictures",
)

# Sub-folders that belong to the HTML export's own template, not the chat.
CHROME_DIRS = ("css", "js", "images")

# Telegram writes this string into `file`/`photo` when the media was excluded by
# the export settings.  The path is absent rather than broken.
NOT_INCLUDED_PREFIX = "("

# media_type -> our media kind.  Kinds drive both bubble rendering and the
# profile panel's library tabs.
MEDIA_TYPE_KIND = {
    "sticker": "sticker",
    "animation": "gif",
    "video_file": "video",
    "voice_message": "voice",
    "audio_file": "music",
    "video_message": "round",
}

# Every kind the viewer knows how to render.  "unknown" is a deliberate escape
# hatch: an unrecognised export is shown as a generic file rather than dropped.
KINDS = (
    "photo",
    "video",
    "gif",
    "sticker",
    "voice",
    "music",
    "round",
    "file",
    "unknown",
)

# Library tabs in the profile panel, in display order, and which kinds feed them.
LIBRARY_TABS = {
    "media": ("photo", "video", "round"),
    "files": ("file", "unknown"),
    "links": (),  # built from text entities, not media
    "music": ("music",),
    "voice": ("voice",),
    "gifs": ("gif",),
    "stickers": ("sticker",),
}

# Kinds whose library tab should collapse byte-identical duplicates.  Stickers
# and GIFs are re-downloaded into every export and re-sent constantly, so the
# raw list is mostly repeats; photos and videos should stay chronological.
DEDUPE_TABS = ("stickers", "gifs")

# Text entity types Telegram emits.  Anything outside this set still round-trips
# to the viewer, it just renders as plain text.
KNOWN_ENTITY_TYPES = (
    "plain",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "spoiler",
    "code",
    "pre",
    "blockquote",
    "link",
    "text_link",
    "mention",
    "mention_name",
    "hashtag",
    "cashtag",
    "bot_command",
    "email",
    "phone",
    "bank_card",
    "custom_emoji",
)

LINK_ENTITY_TYPES = ("link", "text_link")

# Message fields the normalizer consumes.  Anything on a message that is not in
# here gets counted in the run report so unfamiliar exports surface loudly
# instead of being silently dropped.
HANDLED_MESSAGE_FIELDS = frozenset(
    {
        "id",
        "type",
        "date",
        "date_unixtime",
        "from",
        "from_id",
        "actor",
        "actor_id",
        "action",
        "text",
        "text_entities",
        "edited",
        "edited_unixtime",
        "reply_to_message_id",
        "reply_to_peer_id",
        "reactions",
        "file",
        "file_name",
        "file_size",
        "photo",
        "photo_file_size",
        "thumbnail",
        "thumbnail_file_size",
        "media_type",
        "mime_type",
        "sticker_emoji",
        "width",
        "height",
        "duration_seconds",
        "forwarded_from",
        "saved_from",
        "via_bot",
        "author",
        "title",
        "performer",
        "message_id",
        "self_destruct_period_seconds",
        # Group chats
        "forwarded_from_id",
        "members",
        "inline_bot_buttons",
        "media_spoiler",
        "title",
        "photo_file_size",
    }
)

# How many messages go in one chunk file.  Small enough that a cold jump into
# the middle of a chat is a single small fetch; large enough that scrolling a
# year doesn't turn into thousands of requests.
CHUNK_SIZE = 500

# Files larger than this get a cheap composite digest (size + head + tail)
# instead of a full read.  Dedupe only matters for stickers and GIFs, which are
# always small, so this keeps a 20 GB archive from taking an hour to index.
FULL_HASH_LIMIT = 4 * 1024 * 1024
HASH_EDGE = 64 * 1024

# Search tokens shorter than this are dropped from the index.
MIN_TOKEN_LEN = 2
