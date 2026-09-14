"""The promise that matters most: your exports are only ever read.

Someone pointing this at a NAS is trusting that claim with an irreplaceable
archive, so it is pinned down here rather than left to a line in the README.

Every write this program performs goes to its index directory or its own data
folder. So the guarantee reduces to one property: the index can never be
placed inside the backup folder. That is asserted from both ends -- the API
that sets it, and the indexer that uses it.

    python3 -m unittest tools.tests.test_readonly
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import serve  # noqa: E402
from tools.tgindex.__main__ import _overlaps  # noqa: E402

APP_DIR = Path(__file__).resolve().parents[2]


class ReadOnlyTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.archive = self.tmp / "Telegram backup"
        export = self.archive / "Mum" / "ChatExport_2026-01-01"
        export.mkdir(parents=True)
        (export / "result.json").write_text(
            json.dumps({"name": "Mum", "messages": []}), encoding="utf-8")
        (export / "photo.jpg").write_bytes(os.urandom(1024))

    def fingerprint(self) -> dict:
        """Contents, size, mtime and mode for everything in the archive."""
        found = {}
        for path in sorted(self.archive.rglob("*")):
            stat = path.lstat()
            found[str(path.relative_to(self.archive))] = (
                hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "DIR",
                stat.st_size, stat.st_mtime_ns, stat.st_mode)
        return found

    # ---- the indexer's own refusal --------------------------------------

    def test_index_inside_the_archive_is_refused(self) -> None:
        self.assertIsNotNone(_overlaps(self.archive, self.archive))

    def test_index_in_an_archive_subfolder_is_refused(self) -> None:
        self.assertIsNotNone(_overlaps(self.archive / "index", self.archive))

    def test_a_symlink_pointing_back_into_the_archive_is_refused(self) -> None:
        """Comparing unresolved paths would miss this one entirely."""
        link = self.tmp / "link"
        os.symlink(str(self.archive / "index"), str(link))
        self.assertIsNotNone(_overlaps(link, self.archive))

    def test_a_separate_index_location_is_allowed(self) -> None:
        self.assertIsNone(_overlaps(self.tmp / "index", self.archive))

    def test_archive_nested_under_the_index_is_still_allowed(self) -> None:
        """Only writes reaching the archive matter; the reverse is harmless."""
        self.assertIsNone(_overlaps(self.tmp, self.archive))

    # ---- the API that sets it -------------------------------------------

    def test_api_refuses_an_index_outside_the_program(self) -> None:
        for bad in (str(self.archive), str(self.archive / "x"), str(self.tmp)):
            with self.assertRaises(ValueError, msg=bad):
                serve._validated_index_dir(bad)

    def test_api_accepts_the_programs_own_data_folder(self) -> None:
        self.assertEqual(serve._validated_index_dir("data/index"), "data/index")

    # ---- end to end ------------------------------------------------------

    def test_a_full_index_run_changes_nothing_in_the_archive(self) -> None:
        """Bytes, timestamps and permissions all identical afterwards."""
        before = self.fingerprint()
        config = self.tmp / "config.json"
        config.write_text(json.dumps({
            "backup_root": str(self.archive),
            "index_dir": str(self.tmp / "index"),
        }), encoding="utf-8")

        done = subprocess.run(
            [sys.executable, "-m", "tools.tgindex", "--config", str(config)],
            cwd=str(APP_DIR), capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)

        self.assertEqual(self.fingerprint(), before)
        self.assertTrue((self.tmp / "index" / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
