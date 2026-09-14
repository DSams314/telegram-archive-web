"""The browser indexer must build exactly what the Python indexer builds.

The web version of Telegram Archive indexes inside the browser, in
JavaScript. The viewer reads one index format and cannot tell which indexer
wrote it -- which only stays true if the two agree, file for file, on the
same archive. This builds one archive with every awkward case in it, runs
both, and compares everything they write.

It also checks the rule the browser version exists to keep: indexing opens
result.json and the HTML export pages, and never a photo, video, sticker or
any other media file. On a cloud or network drive, opening one downloads it.

    python3 -m unittest tools.tests.test_web_parity
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
RUNNER = APP_DIR / "tools" / "tests" / "run_web_indexer.mjs"
NODE = shutil.which("node")

# Invented people. The IDs are fictional by construction.
ME = ("Alex", "user9000000001")
RAE = ("Rae", "user9000000002")
KIM = ("Kim", "user3")
SKY = ("Sky", "user4")
EXCLUDED = "(File not included. Change data exporting settings to download.)"


def message(msg_id, when, who, text="", **extra):
    out = {
        "id": msg_id, "type": "message", "date_unixtime": str(when),
        "from": who[0], "from_id": who[1], "text": text,
        "text_entities": [{"type": "plain", "text": text}] if text else [],
    }
    out.update(extra)
    return out


def write_export(folder: Path, name: str, chat_type: str, messages: list,
                 media: dict | None = None, direct: bool = False) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "result.json").write_text(json.dumps({
        "name": name, "type": chat_type, "id": abs(hash(name)) % 10000,
        "messages": messages,
    }), encoding="utf-8")
    for rel, payload in (media or {}).items():
        target = folder / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)


def build_fixture(root: Path) -> None:
    """One archive that walks every path through both indexers."""
    base = 1709300000

    # -- Jordan: two overlapping exports, one chat long enough to chunk ------
    early = []
    for i in range(1, 1101):
        who = ME if i % 2 else RAE
        early.append(message(i, base + i * 60, who,
                             f"message {i} café Привет 東京 café"))
    early[4] = message(5, base + 300, ME, "", photo="photos/photo_5.jpg",
                       photo_file_size=11, width=800, height=600)
    early[5] = message(6, base + 360, RAE, "", file="stickers/sticker.webp",
                       file_name="sticker.webp", file_size=20,
                       media_type="sticker", mime_type="image/webp",
                       sticker_emoji="👋", width=512, height=512)
    early[6] = message(7, base + 420, ME, "", file="video_files/gone.mp4",
                       media_type="video_file", mime_type="video/mp4",
                       file_size=30, width=640, height=360, duration_seconds=3)
    early[7] = message(8, base + 480, RAE, "", photo=EXCLUDED,
                       photo_file_size=999, width=10, height=10)
    early[8] = {"id": 9, "type": "service", "date_unixtime": str(base + 540),
                "actor": ME[0], "actor_id": ME[1], "action": "invite_members",
                "members": ["Rae"], "text": "", "text_entities": []}
    early[9] = message(
        10, base + 600, RAE, "see https://example.com/x",
        reply_to_message_id=5, edited_unixtime=str(base + 700),
        reactions=[{"type": "emoji", "count": 2, "emoji": "❤",
                    "recent": [{"from": ME[0], "from_id": ME[1]}]}],
        text_entities=[{"type": "plain", "text": "see "},
                       {"type": "link", "text": "https://example.com/x"}])
    early[10] = message(11, base + 660, ME, "forwarded words",
                        forwarded_from="Somebody", forwarded_from_id="channel7")
    early[11] = message(12, base + 720, RAE, "", file="files/report.pdf",
                        file_name="report.pdf", file_size=40,
                        mime_type="application/pdf")
    early[12] = message(13, base + 780, ME, "", file="voice_messages/audio_1.ogg",
                        media_type="voice_message", mime_type="audio/ogg",
                        file_size=50, duration_seconds=5)
    early[13] = message(14, base + 840, RAE, "", file="files/thing.bin",
                        media_type="future_thing", file_size=5)
    old_style = message(15, base + 900, ME)
    old_style["text"] = ["hello ", {"type": "bold", "text": "world"}]
    del old_style["text_entities"]
    early[14] = old_style
    early[15] = message(16, base + 960, RAE, "odd", some_future_field={"a": 1})
    # The same sticker sent again, for the library's repeat handling.
    early[16] = message(17, base + 1020, ME, "", file="stickers/sticker (1).webp",
                        file_name="sticker.webp", file_size=20,
                        media_type="sticker", mime_type="image/webp",
                        sticker_emoji="👋", width=512, height=512)

    write_export(root / "Jordan" / "ChatExport_2024-03-01", "Jordan",
                 "personal_chat", early, media={
                     "photos/photo_5.jpg": b"P" * 11,
                     "stickers/sticker.webp": b"S" * 20,
                     "stickers/sticker (1).webp": b"S" * 20,
                     "files/report.pdf": b"D" * 40,
                     "files/thing.bin": b"T" * 5,
                 })

    later = [message(i, base + i * 60, ME if i % 2 else RAE, f"later {i}")
             for i in range(1000, 1301)]
    # A copy of an overlapping message that is more complete than the first.
    later[50] = message(1050, base + 1050 * 60, RAE, "later 1050",
                        reactions=[{"type": "emoji", "count": 1, "emoji": "👍"}])
    write_export(root / "Jordan" / "ChatExport_2024-06-15", "Jordan",
                 "personal_chat", later, media={
                     # Only this export holds the voice note from the first.
                     "voice_messages/audio_1.ogg": b"V" * 50,
                     "profile_pictures/photo_1.jpg": b"A",
                     "profile_pictures/photo_2.jpg": b"B",
                 })

    # -- Book Club: a group, with media only an HTML export can locate ------
    group = [message(1, base + 10, ME, "welcome everyone"),
             message(2, base + 20, RAE, "hi"),
             message(3, base + 30, KIM, "hello"),
             message(4242, base + 40, KIM, "", file="stickers/sticker (7).webp",
                     file_name="sticker.webp", file_size=20,
                     media_type="sticker", mime_type="image/webp",
                     sticker_emoji="😀", width=512, height=512)]
    write_export(root / "Book Club" / "ChatExport_2024-05-01", "Book Club",
                 "private_group", group)

    html_only = root / "Book Club" / "ChatExport_2024-01-01"
    (html_only / "stickers").mkdir(parents=True)
    (html_only / "stickers" / "sticker (2).webp").write_bytes(b"R" * 20)
    (html_only / "stickers" / "sticker (2)_thumb.webp").write_bytes(b"r")
    (html_only / "messages.html").write_text(
        '<div class="message default clearfix" id="message4242">'
        '<a href="stickers/sticker%20(2).webp">'
        '<img src="stickers/sticker (2)_thumb.webp"/></a></div>',
        encoding="utf-8")
    (html_only / "messages2.html").write_text(
        '<div class="message default clearfix" id="message9999">'
        '<a href="photos/nothing.jpg"></a></div>', encoding="utf-8")

    # -- Robin: an export unzipped straight into the archive ----------------
    write_export(root / "Robin", "Robin", "personal_chat",
                 [message(1, base + 5, ME, "direct one"),
                  message(2, base + 6, SKY, "direct two")])

    # "Robin" has no date in its name, so both indexers fall back to a file
    # time -- Python the folder's, the browser result.json's, since a browser
    # cannot see folder times. On disk the two differ by microseconds; pinning
    # both to one moment keeps that cosmetic gap out of the comparison.
    robin = root / "Robin"
    moment = base + 864000
    os.utime(robin / "result.json", (moment, moment))
    os.utime(robin, (moment, moment))

    # -- things that must be ignored ------------------------------------------
    (root / "Notes").mkdir()
    (root / "Notes" / "readme.txt").write_text("not an export")
    write_export(root / ".hidden" / "ChatExport_2024-01-01", "Hidden",
                 "personal_chat", [message(1, base, ME, "should not appear")])


def index_tree(folder: Path) -> dict:
    return {
        p.relative_to(folder).as_posix(): json.loads(p.read_text("utf-8"))
        for p in folder.rglob("*.json") if not p.name.startswith(".")
    }


@unittest.skipUnless(NODE, "node is not installed")
class WebParityTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="ta-parity-"))
        root = cls.tmp / "Backups"
        build_fixture(root)
        python_out = cls.tmp / "python"
        js_out = cls.tmp / "js"

        subprocess.run(
            [sys.executable, "-m", "tools.tgindex", "--root", str(root),
             "--out", str(python_out), "--config", str(cls.tmp / "none.json"),
             "--no-hash"],
            cwd=APP_DIR, check=True, capture_output=True)
        # Python cannot skip de-duplication without hashing, and the browser
        # never hashes; with both switched off the outputs must be identical.
        done = subprocess.run(
            [NODE, str(RUNNER), str(root), str(js_out), "--no-dedupe"],
            cwd=APP_DIR, capture_output=True, text=True)
        if done.returncode:
            raise AssertionError(f"web indexer failed:\n{done.stderr}")

        cls.web = json.loads(done.stdout)
        cls.python = index_tree(python_out)
        cls.js = index_tree(js_out)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_both_write_the_same_files(self) -> None:
        self.assertEqual(sorted(self.js), sorted(self.python))

    def test_manifest_matches(self) -> None:
        python = dict(self.python["manifest.json"])
        js = dict(self.js["manifest.json"])
        python.pop("generated")
        js.pop("generated")
        self.assertEqual(js, python)

    def test_every_chat_file_matches(self) -> None:
        for name in self.python:
            if name.startswith("chats/"):
                with self.subTest(file=name):
                    self.assertEqual(self.js.get(name), self.python[name])

    def test_search_index_matches(self) -> None:
        for name in self.python:
            if name.startswith("search/"):
                with self.subTest(file=name):
                    self.assertEqual(self.js.get(name), self.python[name])

    def test_media_is_never_opened(self) -> None:
        """The rule behind the whole web version: read text, never media."""
        allowed = re.compile(r"(^|/)(result\.json|messages\d*\.html)$")
        opened = self.web["opened"]
        self.assertTrue(opened, "the indexer opened nothing at all")
        self.assertEqual([p for p in opened if not allowed.search(p)], [])

    def test_the_fixture_reaches_the_hard_cases(self) -> None:
        """Parity on an archive that avoided the hard paths would prove little."""
        report = self.web["report"]
        self.assertEqual(self.web["chats"], 3)
        self.assertEqual(self.web["selfId"], ME[1])
        self.assertGreater(report["duplicates_merged"], 0)
        self.assertGreater(report["media_from_sibling_export"], 0)
        self.assertGreater(report["media_recovered_from_html"], 0)
        self.assertGreater(report["media_missing"], 0)
        self.assertGreater(report["media_excluded"], 0)
        self.assertIn("some_future_field", report["unhandled_fields"])
        chunks = [n for n in self.js if n.startswith("chats/jordan/chunk-")]
        self.assertGreaterEqual(len(chunks), 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
