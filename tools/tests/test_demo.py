"""The built-in demo archive must index into a real, complete set of chats.

The demo runs through the same in-browser indexer a real folder does, so if it
is well-formed here it will render in the app. This also guards the promise
that the demo is safe: it is marked as a demo, which switches off every path
that could write to disk.

    python3 -m unittest tools.tests.test_demo
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is not installed")
class DemoArchiveTestCase(unittest.TestCase):
    def test_demo_indexes_into_three_example_chats(self) -> None:
        done = subprocess.run(
            [NODE, str(APP_DIR / "tools" / "tests" / "demo_index_check.mjs")],
            cwd=str(APP_DIR), capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        data = json.loads(done.stdout.strip().splitlines()[-1])

        self.assertEqual(data["chats"], 3)
        self.assertEqual(data["selfId"], "user-demo-you")
        for name in ("Robin", "Weekend Crew", "Sky"):
            self.assertIn(name, data["names"])
        # Every picture the demo points at resolves; none show as missing.
        self.assertEqual(data["missing"], 0)
        counts = data["media"].values()
        self.assertTrue(any(m.get("photo") for m in counts), "no photo indexed")
        self.assertTrue(any(m.get("sticker") for m in counts), "no sticker indexed")


class DemoIsNeverSavedTestCase(unittest.TestCase):
    """Demo mode must not be able to write anything."""

    def test_config_switches_saving_off_in_demo(self) -> None:
        config = (APP_DIR / "app" / "web" / "config.js").read_text(encoding="utf-8")
        self.assertIn("export const isDemo", config)
        # save() returns before doing anything when in demo.
        save = config[config.index("export async function save"):]
        save = save[:save.index("\n}\n")]
        self.assertIn("if (demoMode) return true;", save)

    def test_demo_content_builds_no_markup(self) -> None:
        demo = (APP_DIR / "app" / "web" / "demo.js").read_text(encoding="utf-8")
        self.assertNotIn("innerHTML", demo)


if __name__ == "__main__":
    unittest.main(verbosity=2)
