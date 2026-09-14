"""The website's safety promises, checked in the code itself.

The web version makes three promises that have to stay true however the code
changes later:

  1. It only ever reads your exports. The one file it writes is its settings
     file, and it can make one empty Backups folder -- nothing else, and
     nothing is ever deleted, renamed or moved.
  2. Nothing from your archive leaves your device.
  3. It loads nothing from anywhere but its own site.

These tests read the source and fail if a change would break any of them --
before that change can ever be published.

    python3 -m unittest tools.tests.test_web_safety
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
WEB_SOURCES = sorted((APP_DIR / "app").rglob("*.js")) + [APP_DIR / "sw.js"]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def code_only(text: str) -> str:
    """The source without its comments, so a mention in prose is not a call."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    # "(^|\s)//" leaves the "//" inside web addresses alone.
    return re.sub(r"(^|\s)//[^\n]*", r"\1", text)


def occurrences(pattern: str) -> dict:
    """file -> count, for every web source the pattern appears in."""
    found = {}
    for path in WEB_SOURCES:
        count = len(re.findall(pattern, read(path)))
        if count:
            found[path.relative_to(APP_DIR).as_posix()] = count
    return found


class OnlyReadsTestCase(unittest.TestCase):
    """Promise 1: it reads your folder; it does not change it."""

    def test_nothing_can_delete_anything(self) -> None:
        self.assertEqual(occurrences(r"\bremoveEntry\b"), {})

    def test_nothing_can_move_or_rename_anything(self) -> None:
        self.assertEqual(occurrences(r"\.move\s*\("), {})

    def test_exactly_one_place_writes_a_file(self) -> None:
        self.assertEqual(occurrences(r"\bcreateWritable\b"), {"app/web/folder.js": 1})

    def test_only_the_settings_file_and_backups_folder_can_be_created(self) -> None:
        self.assertEqual(occurrences(r"create:\s*true"), {"app/web/folder.js": 2})
        source = read(APP_DIR / "app" / "web" / "folder.js")
        self.assertIn("getFileHandle(CONFIG_NAME, { create: true })", source)
        self.assertIn("getDirectoryHandle(BACKUPS, { create: true })", source)

    def test_the_settings_file_is_only_written_into_an_archive_folder(self) -> None:
        """Never in among the exports: only a folder with Backups inside it."""
        source = read(APP_DIR / "app" / "web" / "folder.js")
        write = source[source.index("export async function writeConfigFile"):]
        write = write[:write.index("\n}\n")]
        self.assertIn("savableLayout()", write)
        self.assertIn("current.layout === 'archive'", source)

    def test_indexing_never_opens_a_media_file(self) -> None:
        """Only result.json and the HTML pages are read while indexing."""
        build = code_only(read(APP_DIR / "app" / "indexer" / "build.js"))
        discover = code_only(read(APP_DIR / "app" / "indexer" / "discover.js"))
        self.assertEqual(re.findall(r"source\.text\(([^)]*)\)", build),
                         ["exp.resultJson", "rel"])
        self.assertIn("for (const rel of exp.htmlFiles)", build)
        self.assertNotIn(".text(", discover)
        self.assertNotIn(".file(", build + discover)


class StaysOnDeviceTestCase(unittest.TestCase):
    """Promise 2: nothing from your archive leaves your device."""

    def test_no_web_address_is_written_into_the_code(self) -> None:
        # The SVG namespace is an identifier inside the drawing, not a request.
        found = {}
        for path in WEB_SOURCES:
            for url in re.findall(r"https?://[^\s'\"`)]+", read(path)):
                if not url.startswith("http://www.w3.org/2000/svg"):
                    found.setdefault(path.name, []).append(url)
        self.assertEqual(found, {})

    def test_the_log_is_only_ever_sent_to_the_local_app(self) -> None:
        log = read(APP_DIR / "app" / "log.js")
        self.assertEqual(occurrences(r"\bsendBeacon\b"), {"app/log.js": 1})
        self.assertIn("if (transport === toLocalServer)", log)
        boot = read(APP_DIR / "app" / "web" / "boot.js")
        self.assertIn("log.useTransport(", boot)
        self.assertIn("store.appendLog", boot)

    def test_the_service_worker_refuses_anything_but_the_apps_files(self) -> None:
        worker = read(APP_DIR / "sw.js")
        self.assertIn("url.origin !== self.location.origin", worker)
        self.assertIn("Response.error()", worker)
        self.assertIn("refuse(405)", worker)
        # It fetches only named files, never the page's own request -- so an
        # address can never carry data out inside its query string.
        self.assertEqual(re.findall(r"fetch\((request|event\.request)", worker), [])
        for call in re.findall(r"fetch\(([^,)]+)", worker):
            self.assertIn(call.strip(), {"SHELL_LIST", "file", "path"})

    def test_the_diagnostic_report_is_redacted_and_never_sent(self) -> None:
        api = read(APP_DIR / "app" / "web" / "api.js")
        section = api[api.index("async diagnostics()"):]
        section = section[:section.index("\n  },")]
        self.assertIn("redactor()", section)
        self.assertIn("download(", section)
        self.assertNotIn("fetch(", section)


class LoadsNothingElseTestCase(unittest.TestCase):
    """Promise 3: nothing is loaded from any other website."""

    def policy(self, page: str) -> str:
        text = read(APP_DIR / page)
        match = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', text)
        self.assertIsNotNone(match, f"{page} has no security policy")
        return match.group(1)

    def test_the_app_page_allows_only_itself(self) -> None:
        policy = self.policy("index.html")
        for rule in ("default-src 'self'", "script-src 'self'", "connect-src 'self'",
                     "object-src 'none'", "frame-src 'none'", "form-action 'none'"):
            self.assertIn(rule, policy)
        self.assertNotRegex(policy, r"https?:|\*")

    def test_the_guide_page_runs_no_code_at_all(self) -> None:
        self.assertIn("script-src 'none'", self.policy("help/index.html"))

    def test_links_out_give_away_nothing(self) -> None:
        self.assertIn('name="referrer" content="no-referrer"', read(APP_DIR / "index.html"))
        fund = read(APP_DIR / "app" / "fund.js")
        self.assertIn("noopener noreferrer", fund)
        for url in re.findall(r'href="(https?://[^"]+)"[^>]*>',
                              read(APP_DIR / "help" / "index.html")):
            with self.subTest(url=url):
                self.assertRegex(read(APP_DIR / "help" / "index.html"),
                                 re.escape(url) + r'"[^>]*rel="noopener noreferrer"')

    def test_panel_text_from_the_config_file_is_never_treated_as_markup(self) -> None:
        for name in ("fund.js", "privacy.js"):
            self.assertNotIn("innerHTML", read(APP_DIR / "app" / name))


class SiteConfigTestCase(unittest.TestCase):
    """site-config.json is edited by hand on GitHub; a mistake must be caught."""

    def test_it_parses_and_makes_sense(self) -> None:
        config = json.loads(read(APP_DIR / "site-config.json"))
        fund = config["fund"]
        self.assertIsInstance(fund["show"], bool)
        self.assertIsInstance(fund["raised"], (int, float))
        self.assertIsInstance(fund["goal"], (int, float))
        self.assertGreaterEqual(fund["raised"], 0)
        self.assertGreater(fund["goal"], 0)
        self.assertTrue(fund["donate_url"] == "" or fund["donate_url"].startswith("https://"),
                        "donate_url must be empty or start with https://")

    def test_every_published_json_file_parses(self) -> None:
        for name in ("site-config.json", "manifest.webmanifest"):
            with self.subTest(file=name):
                json.loads(read(APP_DIR / name))


if __name__ == "__main__":
    unittest.main(verbosity=2)
