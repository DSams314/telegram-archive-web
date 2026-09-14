"""Tests for folders the system refuses to open.

The case these come from: an external drive at /Volumes/..., which macOS keeps
behind its own permission switch. The archive is fine, the path is right, and
the program still cannot read it -- so what it says at that moment is the whole
of the user's experience. It used to print a Python traceback.

chmod 000 stands in for the real thing here. The errno differs from a TCC
refusal (13 rather than 1) but the shape is identical: the folder stats fine
and listing it raises PermissionError.

    python3 -m unittest tools.tests.test_permissions
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import serve  # noqa: E402
from tools.tgindex.discover import (  # noqa: E402
    ArchiveError, _cloud_provider, discover, explain_denial,
)


class Unreadable:
    """A directory that exists but cannot be listed, restored on the way out."""

    def __init__(self, path: Path):
        self.path = path

    def __enter__(self) -> Path:
        os.chmod(self.path, 0o000)
        return self.path

    def __exit__(self, *exc) -> None:
        os.chmod(self.path, 0o755)


class PermissionTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def export(self, *parts: str) -> Path:
        """Create a minimal but genuine export at <tmp>/<parts...>."""
        folder = self.tmp.joinpath(*parts)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "result.json").write_text(
            json.dumps({"name": parts[-2], "messages": []}), encoding="utf-8"
        )
        return folder

    # ---- discover ------------------------------------------------------

    def test_blocked_root_explains_instead_of_crashing(self) -> None:
        """The friend's case: no traceback, and the message names the fix."""
        root = self.tmp / "root"
        root.mkdir()
        with Unreadable(root):
            with self.assertRaises(ArchiveError) as caught:
                discover(root)
        self.assertNotIn("Traceback", str(caught.exception))
        self.assertIn(str(root), str(caught.exception))

    def test_missing_root_is_not_reported_as_a_permission_problem(self) -> None:
        """An unplugged drive and a blocked one need different advice."""
        with self.assertRaises(ArchiveError) as caught:
            discover(self.tmp / "never-existed")
        message = str(caught.exception)
        self.assertIn("no folder", message)
        self.assertNotIn("blocking", message)

    def test_one_blocked_conversation_does_not_lose_the_others(self) -> None:
        """A single unreadable folder must not cost you the whole archive."""
        root = self.tmp / "root"
        self.export("root", "Readable", "ChatExport_2026-01-01")
        self.export("root", "Blocked", "ChatExport_2026-01-01")
        with Unreadable(root / "Blocked"):
            found = discover(root)
        self.assertEqual([c.name for c in found], ["Readable"])

    def test_external_drive_names_the_removable_volumes_switch(self) -> None:
        """/Volumes sits behind a different toggle than Documents does."""
        if sys.platform != "darwin":
            self.skipTest("macOS-specific wording")
        message = explain_denial(Path("/Volumes/My Book/Telegram backup"))
        self.assertIn("Removable Volumes", message)
        self.assertNotIn("Documents", message)

    # ---- cloud storage --------------------------------------------------

    def test_cloud_folders_are_not_blamed_on_files_and_folders(self) -> None:
        """The trap that sent someone hunting through the wrong pane.

        ~/Library/CloudStorage is a file-provider domain, guarded by its own
        permission. Nothing under Files and Folders covers it, so advice
        pointing there is advice to look for a row that never appears.
        """
        path = Path.home() / "Library/CloudStorage/SynologyDrive-on_demand/tg"
        message = explain_denial(path)
        self.assertIn("Synology Drive", message)
        self.assertIn("Full Disk Access", message)
        self.assertNotIn("Removable Volumes", message)

    def test_each_provider_is_named(self) -> None:
        """Naming the service matters: the fix is in that app's settings."""
        cases = {
            "SynologyDrive-on_demand_sync": "Synology Drive",
            "Dropbox": "Dropbox",
            "GoogleDrive-someone@example.com": "Google Drive",
            "OneDrive-Personal": "OneDrive",
            "iCloudDrive": "iCloud Drive",
        }
        for domain, expected in cases.items():
            found = _cloud_provider(Path.home() / "Library/CloudStorage" / domain / "x")
            self.assertEqual(found, expected, domain)

    def test_an_unknown_provider_still_gets_named(self) -> None:
        found = _cloud_provider(
            Path.home() / "Library/CloudStorage/SomeVendor-account/x")
        self.assertEqual(found, "SomeVendor")

    def test_ordinary_folders_are_not_mistaken_for_cloud_ones(self) -> None:
        self.assertIsNone(_cloud_provider(Path.home() / "Documents/tg"))
        self.assertIsNone(_cloud_provider(Path("/Volumes/My Book/tg")))

    # ---- the settings API ----------------------------------------------

    def test_unreadable_folder_is_refused_before_it_is_saved(self) -> None:
        """Storing it would only move the failure to the next rebuild."""
        root = self.tmp / "root"
        root.mkdir()
        with Unreadable(root):
            with self.assertRaises(ValueError):
                serve._validated_root(str(root))

    def test_accepted_folder_is_stored_absolute(self) -> None:
        """Relative paths would resolve against the server's own directory."""
        stored = serve._validated_root(str(self.tmp))
        self.assertTrue(Path(stored).is_absolute())

    def test_relative_path_is_refused_with_a_hint(self) -> None:
        """A dropped leading slash is the likeliest way to arrive here."""
        with self.assertRaises(ValueError) as caught:
            serve._validated_root("Volumes/My Book/Telegram backup")
        self.assertIn("full path", str(caught.exception))

    # ---- what reaches the panel ----------------------------------------

    def test_indexer_error_is_forwarded_whole(self) -> None:
        """These run to several lines; truncating drops the instructions."""
        stderr = (
            "error: macOS is blocking access to /Volumes/My Book.\n"
            "It is on an external or network drive.\n"
            "\n"
            "To allow it: System Settings > Privacy & Security > ...\n"
        )
        summary = serve._failure_summary(stderr, "")
        self.assertTrue(summary.startswith("macOS is blocking"))
        self.assertIn("System Settings", summary)

    def test_unexpected_crash_reports_its_last_line_only(self) -> None:
        """No explanation to forward, so give the one informative line."""
        traceback = (
            "Traceback (most recent call last):\n"
            '  File "x.py", line 1, in <module>\n'
            "ValueError: something went wrong\n"
        )
        self.assertEqual(
            serve._failure_summary(traceback, ""),
            "ValueError: something went wrong",
        )


if __name__ == "__main__":
    unittest.main()
