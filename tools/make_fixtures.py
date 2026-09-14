#!/usr/bin/env python3
"""Generate a synthetic chat exercising every media type the viewer renders.

Real exports rarely contain one of everything, so this builds a chat with
albums, a GIF, a video, a voice message, a .webm sticker, a .tgs sticker, a
document and a deliberately-missing file -- useful for checking rendering after
a change without touching real data.

    python3 tools/make_fixtures.py            # write into ../Backups/_MediaTest
    python3 tools/make_fixtures.py --out DIR
    python3 tools/make_fixtures.py --remove

Needs ffmpeg for the audio/video clips. Photos and the .tgs are borrowed from
whatever real exports are already in the backup folder; the chat is skipped if
none are found.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
ME = ("Alex", "user9000000001")
THEM = ("Rae", "user9000000002")


def run(*args: str) -> None:
    subprocess.run(args, check=True, capture_output=True)


def dims(path: Path) -> tuple:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    width, height = out.split(",")[:2]
    return int(width), int(height)


def borrow(backups: Path, pattern: str, limit: int) -> list:
    """Pull real files out of whatever exports already exist."""
    found = []
    for path in sorted(backups.rglob(pattern)):
        if "_MediaTest" in path.parts:
            continue
        found.append(path)
        if len(found) >= limit:
            break
    return found


def build(out: Path, backups: Path) -> int:
    for sub in ("photos", "video_files", "voice_messages", "stickers", "files"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    photos = borrow(backups, "photos/photo_*.jpg", 6)
    if len(photos) < 6:
        print("error: need at least 6 photos in the backup folder", file=sys.stderr)
        return 1
    for i, src in enumerate(photos):
        shutil.copy(src, out / "photos" / f"{chr(ord('a') + i)}.jpg")

    gifs = borrow(backups, "video_files/*.mp4", 1)
    if gifs:
        shutil.copy(gifs[0], out / "video_files" / "loop.mp4")

    tgs = borrow(backups, "stickers/*.tgs", 1)
    if tgs:
        shutil.copy(tgs[0], out / "stickers" / "animated.tgs")
        thumb = tgs[0].with_name(tgs[0].name + "_thumb.jpg")
        if thumb.exists():
            shutil.copy(thumb, out / "stickers" / "animated.tgs_thumb.jpg")

    # A voice note with a real amplitude envelope, so the waveform has
    # something to show rather than a flat bar.
    run("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "aevalsrc='0.95*sin(2*PI*300*t)*(0.05+0.95*abs(sin(1.7*t))*abs(sin(0.6*t)))'"
        ":d=7:s=48000",
        "-c:a", "libopus", "-b:a", "48k",
        str(out / "voice_messages" / "note.ogg"), "-y")

    # A VP9 sticker with alpha, the modern animated-sticker format.
    run("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "testsrc2=size=320x320:duration=3:rate=30",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "200k",
        str(out / "stickers" / "animated.webm"), "-y")

    run("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "testsrc2=size=480x270:duration=4:rate=25",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        str(out / "video_files" / "clip.mp4"), "-y")

    (out / "files" / "notes.txt").write_text("archive notes\n", encoding="utf-8")

    messages: list = []
    state = {"t": 1785000000, "id": 900000}

    def add(who, extra, text="", gap=45):
        state["t"] += gap
        state["id"] += 1
        msg = {
            "id": state["id"], "type": "message",
            "date_unixtime": str(state["t"]),
            "from": who[0], "from_id": who[1],
            "text": text,
            "text_entities": [{"type": "plain", "text": text}] if text else [],
        }
        msg.update(extra)
        messages.append(msg)

    def photo(name, gap=45):
        path = out / "photos" / name
        w, h = dims(path)
        return {"photo": f"photos/{name}", "width": w, "height": h,
                "photo_file_size": path.stat().st_size}, gap

    add(ME, {}, "Every media type the viewer knows, below.")

    # An album is several media messages sharing a sender and an exact send
    # time -- there is no album field in the export.
    for name in "abcd":
        spec, _ = photo(f"{name}.jpg")
        add(ME, spec, gap=0)
    add(THEM, {}, "four-up album above")
    for name in "ef":
        spec, _ = photo(f"{name}.jpg")
        add(THEM, spec, gap=0)

    if gifs:
        w, h = dims(out / "video_files" / "loop.mp4")
        add(THEM, {"file": "video_files/loop.mp4", "file_name": "loop.mp4",
                   "media_type": "animation", "mime_type": "video/mp4",
                   "duration_seconds": 2, "width": w, "height": h}, "GIF above")

    w, h = dims(out / "video_files" / "clip.mp4")
    add(ME, {"file": "video_files/clip.mp4", "file_name": "clip.mp4",
             "media_type": "video_file", "mime_type": "video/mp4",
             "duration_seconds": 4, "width": w, "height": h})

    add(ME, {"file": "voice_messages/note.ogg", "file_name": "note.ogg",
             "media_type": "voice_message", "mime_type": "audio/ogg",
             "duration_seconds": 7,
             "file_size": (out / "voice_messages" / "note.ogg").stat().st_size})

    w, h = dims(out / "stickers" / "animated.webm")
    add(THEM, {"file": "stickers/animated.webm", "file_name": "animated.webm",
               "media_type": "sticker", "mime_type": "video/webm",
               "width": w, "height": h, "sticker_emoji": "✨"})

    if tgs:
        add(THEM, {"file": "stickers/animated.tgs", "file_name": "animated.tgs",
                   "thumbnail": "stickers/animated.tgs_thumb.jpg",
                   "media_type": "sticker",
                   "mime_type": "application/x-tgsticker",
                   "width": 512, "height": 512, "sticker_emoji": "👋"})

    add(ME, {"file": "files/notes.txt", "file_name": "notes.txt",
             "mime_type": "text/plain",
             "file_size": (out / "files" / "notes.txt").stat().st_size})

    # Referenced but absent: should draw a 16:9 shimmer placeholder.
    add(ME, {"file": "video_files/deleted.mp4", "media_type": "video_file",
             "mime_type": "video/mp4", "width": 1920, "height": 1080,
             "duration_seconds": 30}, "the next one is missing on purpose")

    (out / "result.json").write_text(
        json.dumps({"name": "_MediaTest", "type": "personal_chat",
                    "id": 77, "messages": messages}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"wrote {len(messages)} messages to {out}")
    print("now run:  python3 -m tools.tgindex")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backups", default=str(APP_DIR.parent / "Backups"))
    parser.add_argument("--out")
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()

    backups = Path(args.backups).expanduser()
    out = Path(args.out) if args.out else backups / "_MediaTest" / "ChatExport_2026-07-26"

    if args.remove:
        target = out.parent
        if target.exists():
            shutil.rmtree(target)
            print(f"removed {target}")
        else:
            print("nothing to remove")
        return 0

    if not backups.is_dir():
        print(f"error: no backup folder at {backups}", file=sys.stderr)
        return 1
    if shutil.which("ffmpeg") is None:
        print("error: ffmpeg is required", file=sys.stderr)
        return 1

    return build(out, backups)


if __name__ == "__main__":
    raise SystemExit(main())
