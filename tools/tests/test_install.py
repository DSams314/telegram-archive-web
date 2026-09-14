"""Tests for installing over an existing copy.

The thing being protected here is the archive itself. An install replaces
program files; it must never replace, move, or so much as rewrite a byte of
someone's exports, whichever option they pick.

    python3 -m unittest tools.tests.test_install
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools import install  # noqa: E402


class InstallChoiceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.target = self.tmp / "Telegram Archive"

    def fake_install(self, version: str) -> Path:
        """The minimum that reads as an install: serve.py and a version."""
        (self.target / "app").mkdir(parents=True, exist_ok=True)
        (self.target / "serve.py").write_text("# server\n", encoding="utf-8")
        (self.target / "app" / "version.js").write_text(
            f"export const VERSION = '{version}';\n", encoding="utf-8"
        )
        return self.target

    # ---- recognising what is already there -----------------------------

    def test_reads_the_version_of_an_existing_install(self) -> None:
        self.fake_install("1.1")
        self.assertEqual(install.installed_version(self.target), "1.1")

    def test_an_unrelated_folder_is_not_mistaken_for_an_install(self) -> None:
        """Overwriting someone's unrelated folder would be unforgivable."""
        stray = self.tmp / "Telegram Archive"
        (stray / "app").mkdir(parents=True)
        (stray / "holiday.jpg").write_bytes(b"\xff\xd8\xff")
        self.assertIsNone(install.installed_version(stray))

    def test_a_fresh_location_needs_no_question(self) -> None:
        chosen = install.choose_destination(self.target, "1.2", "ask")
        self.assertEqual(chosen, self.target)

    # ---- the three answers ---------------------------------------------

    def test_update_replaces_in_place(self) -> None:
        self.fake_install("1.1")
        self.assertEqual(
            install.choose_destination(self.target, "1.2", "update"), self.target
        )

    def test_keep_both_picks_a_free_folder_named_for_the_version(self) -> None:
        self.fake_install("1.1")
        chosen = install.choose_destination(self.target, "1.2", "side-by-side")
        self.assertEqual(chosen.name, "Telegram Archive 1.2")
        self.assertNotEqual(chosen, self.target)

    def test_keep_both_does_not_reuse_an_occupied_name(self) -> None:
        self.fake_install("1.1")
        (self.tmp / "Telegram Archive 1.2").mkdir()
        chosen = install.choose_destination(self.target, "1.2", "side-by-side")
        self.assertFalse(chosen.exists())

    def test_without_a_terminal_it_updates_rather_than_guessing(self) -> None:
        """Updating keeps data and Backups; branching silently would not."""
        self.fake_install("1.1")
        self.assertEqual(
            install.choose_destination(self.target, "1.2", "ask"), self.target
        )

    # ---- the archive itself --------------------------------------------

    def test_side_by_side_shares_the_existing_exports_untouched(self) -> None:
        """Two copies of the program, one archive, not a byte rewritten."""
        self.fake_install("1.1")
        export = self.target / "Backups" / "Mum" / "ChatExport_2026-01-01"
        export.mkdir(parents=True)
        photo = export / "photo.jpg"
        photo.write_bytes(os.urandom(2048))
        before = hashlib.sha256(photo.read_bytes()).hexdigest()

        new_copy = self.tmp / "Telegram Archive 1.2"
        new_copy.mkdir()
        shared = install.prepare_backups(new_copy, share_from=self.target)

        self.assertEqual(shared, self.target / "Backups")
        self.assertFalse((new_copy / "Backups").exists())
        config = json.loads((new_copy / "data" / "config.json").read_text())
        self.assertEqual(config["backup_root"], str(self.target / "Backups"))
        self.assertEqual(hashlib.sha256(photo.read_bytes()).hexdigest(), before)

    def test_seeding_never_overwrites_an_existing_config(self) -> None:
        """An update must not throw away the settings it is updating."""
        (self.target / "data").mkdir(parents=True)
        config = self.target / "data" / "config.json"
        config.write_text(json.dumps({"backup_root": "/somewhere/chosen",
                                      "setup_complete": True}))
        install.seed_config(self.target, self.tmp / "elsewhere")
        self.assertEqual(
            json.loads(config.read_text())["backup_root"], "/somewhere/chosen"
        )


if __name__ == "__main__":
    unittest.main()
