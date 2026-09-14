"""Read image and video dimensions from file headers.

Only the first few hundred bytes of a file are touched, and only the standard
library is used -- the whole program has no third-party dependencies and this
is not the place to start.

Dimensions matter because they are half of the signature used to recover media
that an export listed as "(File not included...)" while the file is actually
sitting right there on disk.
"""

from __future__ import annotations

import struct
from pathlib import Path

# JPEG frame markers that carry the dimensions. Everything else is skipped.
_JPEG_SOF = {
    0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
    0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
}


def _jpeg(fh) -> tuple | None:
    if fh.read(2) != b"\xff\xd8":
        return None
    while True:
        byte = fh.read(1)
        while byte and byte != b"\xff":
            byte = fh.read(1)
        if not byte:
            return None
        marker = fh.read(1)
        while marker == b"\xff":
            marker = fh.read(1)
        if not marker:
            return None
        code = marker[0]
        if code in _JPEG_SOF:
            fh.read(3)  # length (2) + precision (1)
            raw = fh.read(4)
            if len(raw) < 4:
                return None
            height, width = struct.unpack(">HH", raw)
            return width, height
        if code in (0xD8, 0xD9) or 0xD0 <= code <= 0xD7:
            continue
        raw = fh.read(2)
        if len(raw) < 2:
            return None
        fh.seek(struct.unpack(">H", raw)[0] - 2, 1)


def _png(fh) -> tuple | None:
    header = fh.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", header[16:24])


def _gif(fh) -> tuple | None:
    header = fh.read(10)
    if len(header) < 10 or header[:3] != b"GIF":
        return None
    return struct.unpack("<HH", header[6:10])


def _webp(fh) -> tuple | None:
    header = fh.read(30)
    if len(header) < 30 or header[:4] != b"RIFF" or header[8:12] != b"WEBP":
        return None
    chunk = header[12:16]
    if chunk == b"VP8 ":
        width, height = struct.unpack("<HH", header[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L":
        bits = struct.unpack("<I", header[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        w = header[24] | (header[25] << 8) | (header[26] << 16)
        h = header[27] | (header[28] << 8) | (header[29] << 16)
        return w + 1, h + 1
    return None


def dimensions(path: Path) -> tuple | None:
    """(width, height) for an image, or None if it can't be determined.

    Dispatch is on the file's magic bytes, not its extension. Telegram writes
    sticker thumbnails as WebP but names them `<sticker>.webp_thumb.jpg`, so
    trusting the extension silently fails on a whole class of real files.
    """
    try:
        with path.open("rb") as fh:
            magic = fh.read(12)
            fh.seek(0)
            if magic[:2] == b"\xff\xd8":
                return _jpeg(fh)
            if magic[:8] == b"\x89PNG\r\n\x1a\n":
                return _png(fh)
            if magic[:3] == b"GIF":
                return _gif(fh)
            if magic[:4] == b"RIFF" and magic[8:12] == b"WEBP":
                return _webp(fh)
    except (OSError, struct.error, ValueError):
        return None
    return None


# Files worth fingerprinting when hunting for media an export said it skipped.
RECOVERABLE_SUFFIXES = frozenset({
    ".jpg", ".jpeg", ".png", ".gif", ".webp",
    ".mp4", ".webm", ".mov", ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".tgs",
})
