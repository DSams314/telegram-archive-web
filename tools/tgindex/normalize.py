"""Turn raw Telegram export messages into the viewer's message schema.

Pure functions over dicts: no filesystem access, no knowledge of where an export
lives.  Media paths come out *relative to the export folder*; resolving them to
real files (and detecting missing ones) is `resolve.py`'s job.
"""

from __future__ import annotations

from datetime import datetime

from .model import (
    HANDLED_MESSAGE_FIELDS,
    LINK_ENTITY_TYPES,
    MEDIA_TYPE_KIND,
    NOT_INCLUDED_PREFIX,
)


def parse_date(msg: dict) -> int | None:
    """Unix seconds for a message.

    `date_unixtime` is authoritative and timezone-free.  `date` is local wall
    time with no offset, so it is only a fallback.
    """
    raw = msg.get("date_unixtime")
    if raw is not None:
        try:
            return int(raw)
        except (TypeError, ValueError):
            pass
    text = msg.get("date")
    if isinstance(text, str):
        try:
            return int(datetime.fromisoformat(text).timestamp())
        except ValueError:
            pass
    return None


def _edited_at(msg: dict) -> int | None:
    raw = msg.get("edited_unixtime")
    if raw is not None:
        try:
            return int(raw)
        except (TypeError, ValueError):
            pass
    text = msg.get("edited")
    if isinstance(text, str):
        try:
            return int(datetime.fromisoformat(text).timestamp())
        except ValueError:
            pass
    return None


def normalize_entities(msg: dict) -> list[dict]:
    """Text as a list of typed entities.

    `text_entities` is preferred: it is always a list and always typed.  `text`
    is a string for plain messages and a mixed list otherwise, so it is only
    used when `text_entities` is absent (very old exports).
    """
    entities = msg.get("text_entities")
    if isinstance(entities, list) and entities:
        return [e for e in entities if isinstance(e, dict) and e.get("text") != ""]

    text = msg.get("text")
    if isinstance(text, str):
        return [{"type": "plain", "text": text}] if text else []
    if isinstance(text, list):
        out = []
        for part in text:
            if isinstance(part, str):
                if part:
                    out.append({"type": "plain", "text": part})
            elif isinstance(part, dict) and part.get("text"):
                out.append(part)
        return out
    return []


def plain_text(entities: list[dict]) -> str:
    """Flatten entities to a searchable / previewable string."""
    return "".join(e.get("text", "") for e in entities)


def extract_links(entities: list[dict]) -> list[str]:
    """URLs mentioned in a message, for the profile panel's Links tab."""
    out = []
    for e in entities:
        if e.get("type") not in LINK_ENTITY_TYPES:
            continue
        url = e.get("href") or e.get("text")
        if url:
            out.append(url)
    return out


def normalize_reactions(msg: dict) -> list[dict] | None:
    """Reactions as [{emoji, count, from:[id]}].

    The JSON export records who reacted and when in `recent`; the HTML export
    does not, which is one more reason the index is JSON-first.
    """
    raw = msg.get("reactions")
    if not isinstance(raw, list) or not raw:
        return None

    out = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        entry: dict = {"count": r.get("count", 0)}
        if r.get("type") == "custom_emoji":
            entry["custom_emoji_id"] = r.get("document_id")
            entry["emoji"] = r.get("emoji") or ""
        else:
            entry["emoji"] = r.get("emoji") or ""
        senders = [
            rec.get("from_id")
            for rec in r.get("recent", [])
            if isinstance(rec, dict) and rec.get("from_id")
        ]
        if senders:
            entry["from"] = senders
        out.append(entry)
    return out or None


def _media_kind(msg: dict) -> str | None:
    """Which renderer this message needs, or None if it has no media."""
    if "photo" in msg:
        return "photo"

    media_type = msg.get("media_type")
    if media_type:
        return MEDIA_TYPE_KIND.get(media_type, "unknown")

    if "file" in msg:
        # A document with no media_type: a plain attachment. Telegram also uses
        # this shape for exported profile photos and stickers in old exports.
        mime = (msg.get("mime_type") or "").lower()
        if mime.startswith("image/"):
            return "photo"
        if mime.startswith("video/"):
            return "video"
        if mime.startswith("audio/"):
            return "music"
        return "file"

    return None


def normalize_media(msg: dict) -> dict | None:
    """Media descriptor with export-relative paths, or None.

    `src`/`thumb` may be None when Telegram excluded the file from the export.
    `w`/`h` are preserved regardless, because the viewer needs them to draw a
    correctly-shaped placeholder for media that isn't on disk.
    """
    kind = _media_kind(msg)
    if kind is None:
        return None

    raw_src = msg.get("photo") if kind == "photo" and "photo" in msg else msg.get("file")
    raw_thumb = msg.get("thumbnail")

    # Telegram writes "(File not included. Change data exporting settings to
    # download.)" in place of a path when media was excluded.
    excluded = isinstance(raw_src, str) and raw_src.startswith(NOT_INCLUDED_PREFIX)
    src = None if excluded or not isinstance(raw_src, str) else raw_src
    thumb = (
        raw_thumb
        if isinstance(raw_thumb, str) and not raw_thumb.startswith(NOT_INCLUDED_PREFIX)
        else None
    )

    media: dict = {"kind": kind, "src": src, "thumb": thumb}

    if excluded:
        media["excluded"] = True  # not on disk *by export setting*, not by loss

    # Sent hidden behind a tap-to-reveal blur.
    if msg.get("media_spoiler"):
        media["spoiler"] = True

    for src_key, dst_key in (
        ("width", "w"),
        ("height", "h"),
        ("duration_seconds", "duration"),
        ("file_name", "name"),
        ("mime_type", "mime"),
        ("sticker_emoji", "emoji"),
        ("title", "title"),
        ("performer", "performer"),
    ):
        value = msg.get(src_key)
        if value not in (None, ""):
            media[dst_key] = value

    size = msg.get("file_size") if kind != "photo" else msg.get("photo_file_size")
    if isinstance(size, int):
        media["size"] = size

    return media


def normalize_message(msg: dict, unhandled: dict[str, int]) -> dict | None:
    """One raw export message -> one index message.

    `unhandled` accumulates field names this normalizer ignores, so an export
    containing something unfamiliar shows up in the run report instead of being
    silently dropped.
    """
    msg_id = msg.get("id")
    if not isinstance(msg_id, int):
        return None

    for key in msg:
        if key not in HANDLED_MESSAGE_FIELDS:
            unhandled[key] = unhandled.get(key, 0) + 1

    date = parse_date(msg)
    if date is None:
        return None

    entities = normalize_entities(msg)
    out: dict = {"id": msg_id, "date": date}

    if msg.get("type") == "service":
        out["service"] = msg.get("action") or "unknown"
        out["from"] = msg.get("actor_id") or msg.get("from_id")
        if msg.get("actor"):
            out["from_name"] = msg["actor"]
        # Service actions carry their payload in ad-hoc fields; keep the ones
        # the viewer renders and let the rest surface via `unhandled`.
        for key in ("duration_seconds", "message_id"):
            if key in msg:
                out[key] = msg[key]
        # invite_members / remove_members name who was involved.
        if isinstance(msg.get("members"), list):
            out["members"] = [m for m in msg["members"] if isinstance(m, str)]
    else:
        out["from"] = msg.get("from_id")
        if msg.get("from"):
            out["from_name"] = msg["from"]

    if entities:
        out["text"] = entities

    edited = _edited_at(msg)
    if edited:
        out["edited"] = edited

    reply_to = msg.get("reply_to_message_id")
    if isinstance(reply_to, int):
        out["reply_to"] = reply_to

    reactions = normalize_reactions(msg)
    if reactions:
        out["reactions"] = reactions

    if msg.get("forwarded_from"):
        out["forwarded_from"] = msg["forwarded_from"]
        # The id lets the viewer colour the label with that person's colour.
        if msg.get("forwarded_from_id"):
            out["forwarded_from_id"] = msg["forwarded_from_id"]
    if msg.get("via_bot"):
        out["via_bot"] = msg["via_bot"]

    media = normalize_media(msg)
    if media:
        out["media"] = media

    return out


def completeness(message: dict) -> tuple:
    """Sort key for picking the best copy of a message seen in several exports.

    Later exports usually win, but an older export can hold media that a newer
    one skipped (export settings differ per run), so having a resolvable file
    outranks recency.  Compared lexicographically, higher is better.
    """
    media = message.get("media") or {}
    return (
        1 if media.get("src") else 0,
        1 if media.get("thumb") else 0,
        1 if message.get("reactions") else 0,
        1 if message.get("text") else 0,
        len(message),
    )
