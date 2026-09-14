"""Extract a message-id -> media-path map from an HTML export.

Why this exists: Telegram names sticker files after the sticker's own filename
attribute, which is literally ``sticker.webp`` for most packs.  Every send
collides on write and gets a ` (N)` suffix, and the numbering is assigned in
export order *per run*.  So the same sticker is `sticker (5).webp` in one export
and `sticker (12).webp` in the next, and a JSON export dropped into a folder
that already holds media will re-download rather than reuse.

That makes an already-downloaded HTML export folder valuable on its own: it is a
complete, correct mapping from message id to the bytes on disk.  This module
reads it so a fresh JSON export can supply the structure while an older (perhaps
hand-pruned) HTML folder supplies the files -- no re-download, no lost curation.

Deliberately a regex scan, not a real parser: these files run to hundreds of MB
and the markup is machine-generated and rigidly uniform.
"""

from __future__ import annotations

import html
import re
import urllib.parse
from pathlib import Path

from .model import MEDIA_DIRS

# <div class="message default clearfix" id="message171376">
MESSAGE_RE = re.compile(r'<div class="message[^"]*"\s+id="message(-?\d+)"')

# href/src pointing into one of the export's media folders.
_MEDIA_DIR_ALT = "|".join(re.escape(d) for d in MEDIA_DIRS)
ASSET_RE = re.compile(
    r'(?:href|src)="((?:%s)/[^"]+)"' % _MEDIA_DIR_ALT,
    re.IGNORECASE,
)

# Telegram writes thumbnails next to the real file under two different
# conventions depending on which exporter produced them.
THUMB_SUFFIXES = ("_thumb.jpg", "_thumb.png", "_thumb.webp")


def _is_thumb(path: str) -> bool:
    lowered = path.lower()
    if any(lowered.endswith(s) for s in THUMB_SUFFIXES):
        return True
    # `sticker (2)_thumb (3).webp` -- a de-duplicated thumbnail.
    return re.search(r"_thumb(?: \(\d+\))?\.\w+$", lowered) is not None


def _clean(raw: str) -> str:
    """Turn an href into a path relative to the export folder."""
    return urllib.parse.unquote(html.unescape(raw))


def parse_media_map(html_files: list[Path]) -> dict[int, dict[str, str]]:
    """Map message id -> {"src": path, "thumb": path} for one export folder.

    Paths are relative to the export folder, matching how result.json stores
    them.  Messages with no media are absent from the map.
    """
    out: dict[int, dict[str, str]] = {}

    for path in html_files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        # Split on message boundaries so each asset is attributed to the message
        # that contains it.  finditer + slice avoids materialising a copy per
        # message the way re.split would.
        marks = [(m.start(), int(m.group(1))) for m in MESSAGE_RE.finditer(text)]
        for i, (start, msg_id) in enumerate(marks):
            end = marks[i + 1][0] if i + 1 < len(marks) else len(text)
            block = text[start:end]

            src: str | None = None
            thumb: str | None = None
            for asset in ASSET_RE.finditer(block):
                candidate = _clean(asset.group(1))
                if _is_thumb(candidate):
                    thumb = thumb or candidate
                else:
                    src = src or candidate

            if src or thumb:
                entry: dict[str, str] = {}
                if src:
                    entry["src"] = src
                if thumb:
                    entry["thumb"] = thumb
                # Later files win only if they add something; a message never
                # legitimately appears in two HTML pages of the same export.
                out.setdefault(msg_id, entry)

    return out
