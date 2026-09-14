"""Tests for working out what kind of disk a folder is on.

The indicator these feed exists to answer one question at a glance: is the
drive there? Getting "not connected" wrong in either direction is worse than
saying nothing, so the distinctions are pinned down here.

    python3 -m unittest tools.tests.test_volumes
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools import volumes  # noqa: E402


class VolumeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_real_local_folder_is_internal_and_connected(self) -> None:
        info = volumes.describe(self.tmp)
        self.assertEqual(info["kind"], volumes.INTERNAL)
        self.assertTrue(info["connected"])
        self.assertIn("connected", volumes.summary(info))

    def test_nothing_configured_says_so(self) -> None:
        info = volumes.describe(None)
        self.assertEqual(info["kind"], volumes.UNKNOWN)
        self.assertEqual(volumes.summary(info), "Backup folder not set")

    def test_unmounted_drive_is_detached_not_internal(self) -> None:
        """The trap: /Volumes lives on the boot disk, so climbing to an
        existing ancestor reports an unplugged drive as 'on this computer'."""
        if sys.platform != "darwin":
            self.skipTest("path convention is macOS-specific")
        info = volumes.describe("/Volumes/Nothing Is Mounted Here/backups")
        self.assertEqual(info["kind"], volumes.DETACHED)
        self.assertFalse(info["connected"])
        self.assertTrue(info["volume_missing"])
        self.assertIn("not connected", volumes.summary(info))

    def test_a_missing_folder_on_a_present_disk_is_not_a_missing_drive(self) -> None:
        """The drive answered; it is the folder that is gone."""
        info = volumes.describe(self.tmp / "no-such-folder")
        self.assertFalse(info["connected"])
        self.assertFalse(info.get("volume_missing"))
        self.assertIn("folder is missing", volumes.summary(info))

    def test_network_filesystems_are_recognised(self) -> None:
        self.assertIn("smbfs", volumes.NETWORK_FS)
        self.assertIn("nfs", volumes.NETWORK_FS)
        self.assertIn("afpfs", volumes.NETWORK_FS)

    def test_description_never_raises_on_nonsense(self) -> None:
        """An indicator must not be able to take the settings panel down."""
        for value in ("", "\x00", "relative/path", "~/nowhere", "/" * 300):
            self.assertIn("kind", volumes.describe(value))


if __name__ == "__main__":
    unittest.main()
