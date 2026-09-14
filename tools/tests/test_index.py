"""Hermetic tests for the indexer.

Fixtures are synthesised in a temp folder so these run anywhere, including on a
machine with no real backups. The scenarios mirror the ones that actually bite:
overlapping exports, media that only exists in an older run, and a hand-pruned
HTML export that is the last remaining home for the bytes.

    python3 -m tools.tests.test_index
"""

from __future__ import annotations

import json
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.tgindex.build import Report, build_chat  # noqa: E402
from tools.tgindex.discover import discover  # noqa: E402
from tools.tgindex.htmlmap import parse_media_map  # noqa: E402
from tools.tgindex.normalize import normalize_message  # noqa: E402
from tools.tgindex.resolve import HashCache, MediaResolver  # noqa: E402


def text_message(msg_id: int, unixtime: int, sender: str, body: str) -> dict:
    return {
        "id": msg_id,
        "type": "message",
        "date_unixtime": str(unixtime),
        "from": sender.split(":")[0],
        "from_id": sender.split(":")[1],
        "text": body,
        "text_entities": [{"type": "plain", "text": body}],
    }


def sticker_message(msg_id: int, unixtime: int, sender: str, path: str) -> dict:
    return {
        "id": msg_id,
        "type": "message",
        "date_unixtime": str(unixtime),
        "from": sender.split(":")[0],
        "from_id": sender.split(":")[1],
        "file": path,
        "file_name": "sticker.webp",
        "file_size": 100,
        "media_type": "sticker",
        "mime_type": "image/webp",
        "sticker_emoji": "👋",
        "width": 512,
        "height": 512,
        "text": "",
        "text_entities": [],
    }


def _jpeg_bytes(width: int, height: int, pad_to: int = 0) -> bytes:
    """A minimal valid JPEG of the given dimensions, padded to an exact size.

    Real enough for the header reader; the padding lets a test pin the file
    size, which is half of the recovery fingerprint.
    """
    data = (
        b"\xff\xd8"                                  # SOI
        + b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1)
        + b"\x01\x11\x00"                            # one component
    )
    if pad_to > len(data) + 6:
        # A comment segment absorbs the padding without breaking the file.
        # Budget 4 bytes for its own marker+length and 2 for the trailing EOI,
        # or the file lands a couple of bytes over and the size no longer
        # matches -- which is the entire point of the fixture.
        filler = pad_to - len(data) - 6
        data += b"\xff\xfe" + struct.pack(">H", filler + 2) + b"\x00" * filler
    data += b"\xff\xd9"                               # EOI
    assert not pad_to or len(data) == pad_to, f"{len(data)} != {pad_to}"
    return data


class IndexerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="tgindex-test-"))
        self.root = self.tmp / "Backups"
        self.out = self.tmp / "index"
        self.root.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write_export(
        self, chat: str, folder: str, messages: list[dict], media: dict | None = None
    ) -> Path:
        export = self.root / chat / folder
        export.mkdir(parents=True, exist_ok=True)
        (export / "result.json").write_text(
            json.dumps(
                {
                    "name": chat,
                    "type": "personal_chat",
                    "id": 999,
                    "messages": messages,
                }
            ),
            encoding="utf-8",
        )
        for rel, payload in (media or {}).items():
            target = export / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        return export

    def run_index(self) -> tuple[list[dict], Report]:
        conversations = discover(self.root)
        cache = HashCache(self.out / ".hashcache.json")
        resolver = MediaResolver(self.root, cache)
        report = Report()
        entries = [
            entry
            for conv in conversations
            if (entry := build_chat(conv, self.root, resolver, self.out, report))
        ]
        return entries, report

    def messages_for(self, slug: str) -> list[dict]:
        chat_dir = self.out / "chats" / slug
        out: list[dict] = []
        for chunk in sorted(chat_dir.glob("chunk-*.json")):
            out.extend(json.loads(chunk.read_text(encoding="utf-8")))
        return out

    # -- merging -----------------------------------------------------------

    def test_overlapping_exports_merge_without_duplicates(self) -> None:
        """Two runs covering an overlapping range produce one message list."""
        me = "Alex:user1"
        self.write_export(
            "Jordan",
            "ChatExport_2024-03-01",
            [text_message(i, 1700000000 + i, me, f"msg {i}") for i in range(1, 21)],
        )
        self.write_export(
            "Jordan",
            "ChatExport_2026-07-26",
            [text_message(i, 1700000000 + i, me, f"msg {i}") for i in range(15, 41)],
        )

        entries, report = self.run_index()

        self.assertEqual(entries[0]["messages"], 40)
        self.assertEqual(report.duplicates_merged, 6)  # ids 15..20 seen twice
        ids = [m["id"] for m in self.messages_for("jordan")]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(len(ids), len(set(ids)))

    def test_older_export_supplies_media_newer_one_lacks(self) -> None:
        """A run exported without media reuses files from an earlier run."""
        me = "Alex:user1"
        self.write_export(
            "Jordan",
            "ChatExport_2024-03-01",
            [sticker_message(1, 1700000001, me, "stickers/sticker.webp")],
            media={"stickers/sticker.webp": b"STICKER-BYTES"},
        )
        # Same message, exported later with media downloads turned off.
        self.write_export(
            "Jordan",
            "ChatExport_2026-07-26",
            [sticker_message(1, 1700000001, me, "stickers/sticker.webp")],
        )

        self.run_index()
        media = self.messages_for("jordan")[0]["media"]

        self.assertNotIn("missing", media)
        self.assertEqual(
            media["src"], "Jordan/ChatExport_2024-03-01/stickers/sticker.webp"
        )

    # -- missing media -----------------------------------------------------

    def test_missing_media_keeps_dimensions_for_placeholder(self) -> None:
        """Nothing on disk: flagged missing, but w/h survive for the shimmer box."""
        me = "Alex:user1"
        self.write_export(
            "Jordan",
            "ChatExport_2026-07-26",
            [
                {
                    "id": 1,
                    "type": "message",
                    "date_unixtime": "1700000001",
                    "from": "Alex",
                    "from_id": "user1",
                    "file": "video_files/gone.mp4",
                    "media_type": "video_file",
                    "mime_type": "video/mp4",
                    "width": 1920,
                    "height": 1080,
                    "duration_seconds": 12,
                    "text": "",
                    "text_entities": [],
                }
            ],
        )

        _, report = self.run_index()
        media = self.messages_for("jordan")[0]["media"]

        self.assertTrue(media["missing"])
        self.assertNotIn("src", media)
        self.assertEqual((media["w"], media["h"]), (1920, 1080))
        self.assertEqual(media["kind"], "video")
        self.assertEqual(report.media_missing, 1)

    def test_export_excluded_media_is_distinguished_from_lost(self) -> None:
        """Telegram's "(File not included...)" is a settings choice, not data loss."""
        me = "Alex:user1"
        self.write_export(
            "Jordan",
            "ChatExport_2026-07-26",
            [
                {
                    "id": 1,
                    "type": "message",
                    "date_unixtime": "1700000001",
                    "from": "Alex",
                    "from_id": "user1",
                    "photo": "(File not included. Change data exporting settings to download.)",
                    "width": 800,
                    "height": 600,
                    "text": "",
                    "text_entities": [],
                }
            ],
        )

        _, report = self.run_index()
        media = self.messages_for("jordan")[0]["media"]

        self.assertTrue(media["missing"])
        self.assertTrue(media["excluded"])
        self.assertEqual(report.media_excluded, 1)

    # -- HTML recovery -----------------------------------------------------

    def test_html_export_recovers_media_json_cannot_find(self) -> None:
        """The pruned-20GB-archive path: JSON gives structure, HTML gives bytes.

        A fresh JSON export names the sticker `sticker (7).webp` because that is
        where its own numbering landed. The bytes actually live in an older HTML
        export under `sticker (2).webp`. Only the HTML's id -> path map can
        bridge that.
        """
        me = "Alex:user1"
        self.write_export(
            "Jordan",
            "ChatExport_2026-07-26",
            [sticker_message(4242, 1700000001, me, "stickers/sticker (7).webp")],
        )

        html_export = self.root / "Jordan" / "ChatExport_2024-03-01"
        (html_export / "stickers").mkdir(parents=True)
        (html_export / "stickers" / "sticker (2).webp").write_bytes(b"REAL-BYTES")
        (html_export / "messages.html").write_text(
            """
            <div class="message default clearfix" id="message4242">
              <div class="sticker_wrap clearfix pull_left">
                <a class="sticker_wrap" href="stickers/sticker (2).webp">
                  <img class="sticker" src="stickers/sticker (2)_thumb.webp"/>
                </a>
              </div>
            </div>
            """,
            encoding="utf-8",
        )

        _, report = self.run_index()
        media = self.messages_for("jordan")[0]["media"]

        self.assertNotIn("missing", media)
        self.assertEqual(
            media["src"], "Jordan/ChatExport_2024-03-01/stickers/sticker (2).webp"
        )
        self.assertEqual(report.media_recovered_from_html, 1)

    def test_html_map_separates_full_media_from_thumbnails(self) -> None:
        export = self.root / "Jordan" / "ChatExport_2024-03-01"
        export.mkdir(parents=True)
        page = export / "messages.html"
        page.write_text(
            """
            <div class="message default clearfix" id="message100">
              <a class="photo_wrap" href="photos/photo_1@01-01-2024_00-00-00.jpg">
                <img class="photo" src="photos/photo_1@01-01-2024_00-00-00_thumb.jpg"/>
              </a>
            </div>
            <div class="message default clearfix" id="message101">
              <a href="stickers/sticker (2).webp">
                <img src="stickers/sticker (2)_thumb (3).webp"/>
              </a>
            </div>
            """,
            encoding="utf-8",
        )

        mapping = parse_media_map([page])

        self.assertEqual(
            mapping[100]["src"], "photos/photo_1@01-01-2024_00-00-00.jpg"
        )
        self.assertEqual(
            mapping[100]["thumb"], "photos/photo_1@01-01-2024_00-00-00_thumb.jpg"
        )
        # `_thumb (3)` is a de-duplicated thumbnail, not a second real file.
        self.assertEqual(mapping[101]["src"], "stickers/sticker (2).webp")
        self.assertEqual(mapping[101]["thumb"], "stickers/sticker (2)_thumb (3).webp")

    # -- recovering media an export claimed it skipped ---------------------

    def test_excluded_media_recovered_by_size_and_dimensions(self) -> None:
        """The real 20 GB case: the file is present, the JSON denies it.

        An interrupted export writes "(File not included...)" while still
        recording photo_file_size, width and height -- and the photo is sitting
        in photos/ regardless. Those three values are a strong enough
        fingerprint to reunite them without any filename.
        """
        export = self.root / "Big" / "ChatExport_2026-07-11"
        (export / "photos").mkdir(parents=True)
        real = _jpeg_bytes(803, 1280, pad_to=16545)
        (export / "photos" / "photo_9@11-07-2026_01-26-40.jpg").write_bytes(real)

        (export / "result.json").write_text(json.dumps({
            "name": "Big", "type": "personal_chat", "id": 3, "messages": [{
                "id": 174823, "type": "message", "date_unixtime": "1783747600",
                "from": "Alex", "from_id": "user9000000001",
                "photo": "(File not included. Change data exporting settings to download.)",
                "photo_file_size": 16545, "width": 803, "height": 1280,
                "text": "", "text_entities": [],
            }]}), encoding="utf-8")

        _, report = self.run_index()
        media = self.messages_for("big")[0]["media"]

        self.assertNotIn("missing", media)
        self.assertNotIn("excluded", media)
        self.assertEqual(
            media["src"], "Big/ChatExport_2026-07-11/photos/photo_9@11-07-2026_01-26-40.jpg")
        self.assertEqual(report.media_recovered_by_signature, 1)

    def test_same_second_photos_are_not_swapped(self) -> None:
        """Several photos sent at once cannot be told apart by timestamp.

        Distinct sizes still separate them; identical ones fall back to order,
        which matches how Telegram numbers the files it writes.
        """
        export = self.root / "Burst" / "ChatExport_2026-07-11"
        (export / "photos").mkdir(parents=True)
        specs = [(800, 600, 5000), (640, 480, 7000), (640, 480, 7000)]
        for i, (w, h, size) in enumerate(specs, start=1):
            (export / "photos" / f"photo_{i}@11-07-2026_01-00-00.jpg").write_bytes(
                _jpeg_bytes(w, h, pad_to=size))

        messages = []
        for i, (w, h, size) in enumerate(specs):
            messages.append({
                "id": 500 + i, "type": "message",
                "date_unixtime": "1783747600",   # all the same second
                "from": "Alex", "from_id": "user9000000001",
                "photo": "(File not included. Change data exporting settings to download.)",
                "photo_file_size": size, "width": w, "height": h,
                "text": "", "text_entities": [],
            })
        (export / "result.json").write_text(json.dumps({
            "name": "Burst", "type": "personal_chat", "id": 4, "messages": messages,
        }), encoding="utf-8")

        _, report = self.run_index()
        found = [m["media"].get("src") for m in self.messages_for("burst")]

        self.assertEqual(report.media_recovered_by_signature, 3)
        # Every message got a different file -- none claimed twice.
        self.assertEqual(len(set(found)), 3)
        # The uniquely-sized one is matched exactly, not by position.
        self.assertTrue(found[0].endswith("photo_1@11-07-2026_01-00-00.jpg"))

    # -- library de-duplication -------------------------------------------

    def test_sticker_library_collapses_identical_bytes(self) -> None:
        """The same sticker under three export-assigned names is one entry."""
        me = "Alex:user1"
        self.write_export(
            "Jordan",
            "ChatExport_2026-07-26",
            [
                sticker_message(1, 1700000001, me, "stickers/sticker.webp"),
                sticker_message(2, 1700000002, me, "stickers/sticker (1).webp"),
                sticker_message(3, 1700000003, me, "stickers/sticker (2).webp"),
                sticker_message(4, 1700000004, me, "stickers/sticker (3).webp"),
            ],
            media={
                "stickers/sticker.webp": b"WAVE",
                "stickers/sticker (1).webp": b"WAVE",
                "stickers/sticker (2).webp": b"WAVE",
                "stickers/sticker (3).webp": b"DIFFERENT",
            },
        )

        entries, _ = self.run_index()
        catalogs = json.loads(
            (self.out / "chats" / "jordan" / "media.json").read_text(encoding="utf-8")
        )

        self.assertEqual(entries[0]["media_counts"]["sticker"], 4)
        self.assertEqual(len(catalogs["stickers"]), 2)

    # -- normalization -----------------------------------------------------

    def test_reply_reaction_and_edit_survive_normalization(self) -> None:
        raw = {
            "id": 2,
            "type": "message",
            "date_unixtime": "1700000002",
            "from": "Robin",
            "from_id": "user2",
            "edited_unixtime": "1700000500",
            "reply_to_message_id": 1,
            "text": "sure",
            "text_entities": [{"type": "plain", "text": "sure"}],
            "reactions": [
                {
                    "type": "emoji",
                    "count": 1,
                    "emoji": "❤",
                    "recent": [{"from": "Alex", "from_id": "user1"}],
                }
            ],
        }

        out = normalize_message(raw, {})

        self.assertEqual(out["reply_to"], 1)
        self.assertEqual(out["edited"], 1700000500)
        self.assertEqual(out["reactions"], [{"count": 1, "emoji": "❤", "from": ["user1"]}])

    def test_unhandled_fields_are_reported_not_swallowed(self) -> None:
        unhandled: dict = {}
        normalize_message(
            {
                "id": 1,
                "type": "message",
                "date_unixtime": "1700000001",
                "from_id": "user1",
                "text": "",
                "text_entities": [],
                "some_future_field": {"a": 1},
            },
            unhandled,
        )
        self.assertEqual(unhandled, {"some_future_field": 1})

    def test_symlinked_backup_root_still_finds_avatars(self) -> None:
        """A backup folder reached through a symlink must not crash indexing.

        discover() resolves the root, so conversation paths come back in their
        real location; the avatar lookup compared them with the path as given.
        On macOS /var is itself a link to /private/var, and any chat with a
        profile picture stopped the whole run.
        """
        real = self.tmp / "real-backups"
        link = self.tmp / "linked-backups"
        export = real / "Jordan" / "ChatExport_2026-07-26"
        (export / "profile_pictures").mkdir(parents=True)
        (export / "profile_pictures" / "photo_1.jpg").write_bytes(b"x")
        (export / "result.json").write_text(json.dumps({
            "name": "Jordan", "type": "personal_chat", "id": 1,
            "messages": [text_message(1, 1700000001, "Alex:user1", "hi")],
        }), encoding="utf-8")
        link.symlink_to(real, target_is_directory=True)

        conversations = discover(link)
        resolver = MediaResolver(link, HashCache(self.out / ".hashcache.json"))
        entry = build_chat(conversations[0], link, resolver, self.out, Report())

        self.assertEqual(
            entry["avatar"],
            "Jordan/ChatExport_2026-07-26/profile_pictures/photo_1.jpg")

    def test_conversation_folder_that_is_itself_an_export(self) -> None:
        """Unzipping one export straight into the backup root still works."""
        export = self.root / "Blitzz"
        export.mkdir(parents=True)
        (export / "result.json").write_text(
            json.dumps(
                {
                    "name": "Blitzz",
                    "type": "personal_chat",
                    "id": 5,
                    "messages": [text_message(1, 1700000001, "Alex:user1", "hi")],
                }
            ),
            encoding="utf-8",
        )

        entries, _ = self.run_index()
        self.assertEqual([e["name"] for e in entries], ["Blitzz"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
