"""The downloadable app must not download a cloud archive just by opening it.

Opening the archive once pulled around 100 GB off a NAS: the archive sat in
a Synology Drive "on-demand" folder, where every file is a placeholder until
it is opened, and indexing opened every photo -- to fingerprint stickers and
to read image sizes. Then a second launch started a second indexer doing the
same, because the first was still running with no window attached to it.

These pin down both fixes:

  * placeholder files, and everything on a network drive, are never opened;
  * only one index run can write the index at a time.

    python3 -m unittest tools.tests.test_placeholders
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.tgindex import resolve  # noqa: E402
from tools.tgindex.__main__ import other_index_run  # noqa: E402

APP_DIR = Path(__file__).resolve().parents[2]


def refuse_to_read(*_args, **_kwargs):
    raise AssertionError("a file was opened that must not be")


class PlaceholderTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ta-placeholder-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "Chat" / "Export" / "stickers").mkdir(parents=True)
        (self.tmp / "Chat" / "Export" / "stickers" / "a.webp").write_bytes(b"x" * 10)
        self.rel = "Chat/Export/stickers/a.webp"

    def resolver(self) -> resolve.MediaResolver:
        return resolve.MediaResolver(self.tmp, resolve.HashCache(self.tmp / "cache.json"))

    def test_the_macos_placeholder_flag_is_recognised(self) -> None:
        self.assertTrue(resolve.is_placeholder(SimpleNamespace(st_flags=resolve.SF_DATALESS)))
        self.assertFalse(resolve.is_placeholder(SimpleNamespace(st_flags=0)))
        self.assertFalse(resolve.is_placeholder(SimpleNamespace()))   # other systems

    def test_a_placeholder_is_never_hashed(self) -> None:
        resolver = self.resolver()
        self.assertTrue(resolver.exists(self.rel))   # its listing still counts
        resolver.placeholders.add(self.rel)
        with mock.patch.object(resolve, "digest_file", refuse_to_read):
            self.assertIsNone(resolver.hash_for(self.rel))
        self.assertEqual(resolver.skipped_reads, 1)

    def test_nothing_on_a_network_drive_is_opened(self) -> None:
        with mock.patch.object(resolve, "on_network_drive", return_value=True):
            resolver = self.resolver()
        with mock.patch.object(resolve, "digest_file", refuse_to_read), \
                mock.patch.object(resolve, "dimensions", refuse_to_read):
            self.assertIsNone(resolver.hash_for(self.rel))
            self.assertEqual(resolver.signature_index(["Chat/Export"]), {})

    def test_image_sizes_are_not_read_from_placeholders(self) -> None:
        (self.tmp / "Chat" / "Export" / "photos").mkdir()
        (self.tmp / "Chat" / "Export" / "photos" / "p.jpg").write_bytes(b"\xff\xd8" + b"0" * 30)
        resolver = self.resolver()
        with mock.patch.object(resolve, "is_placeholder", return_value=True), \
                mock.patch.object(resolve, "dimensions", refuse_to_read):
            self.assertEqual(resolver.signature_index(["Chat/Export"]), {})
        self.assertGreater(resolver.skipped_reads, 0)

    def test_ordinary_local_files_are_still_fingerprinted(self) -> None:
        """The fix must not quietly switch sticker de-duplication off for everyone."""
        resolver = self.resolver()
        resolver.read_contents = True
        self.assertIsNotNone(resolver.hash_for(self.rel))


class OneRunAtATimeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ta-onerun-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.out = self.tmp / "data" / "index"
        self.out.mkdir(parents=True)
        self.marker = self.tmp / "data" / "indexer.pid"

    def test_no_record_means_nothing_is_running(self) -> None:
        self.assertIsNone(other_index_run(self.out))

    def test_a_finished_run_does_not_block_the_next(self) -> None:
        finished = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"],
                                  capture_output=True, text=True).stdout.strip()
        self.marker.write_text(finished)
        self.assertIsNone(other_index_run(self.out))

    def test_an_unrelated_process_reusing_the_number_does_not_block(self) -> None:
        self.marker.write_text(str(os.getppid()))
        self.assertIsNone(other_index_run(self.out))

    def test_a_second_run_refuses_while_the_first_is_going(self) -> None:
        # Stands in for an indexer still running: its command line says so.
        first = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)", "tools.tgindex"])
        self.addCleanup(first.kill)
        time.sleep(0.3)
        self.marker.write_text(str(first.pid))
        self.assertEqual(other_index_run(self.out), first.pid)

        backups = self.tmp / "Backups"
        (backups / "Chat" / "Export").mkdir(parents=True)
        (backups / "Chat" / "Export" / "result.json").write_text(
            json.dumps({"name": "Chat", "messages": []}))
        second = subprocess.run(
            [sys.executable, "-m", "tools.tgindex", "--root", str(backups),
             "--out", str(self.out), "--config", str(self.tmp / "none.json")],
            cwd=APP_DIR, capture_output=True, text=True, timeout=60)
        self.assertEqual(second.returncode, 1)
        self.assertIn("already", second.stderr)
        self.assertFalse((self.out / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
