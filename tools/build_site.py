#!/usr/bin/env python3
"""Build the website version into site/, ready for GitHub Pages.

    python3 tools/build_site.py             # -> site/
    python3 tools/build_site.py --out DIR

Copies only what a browser needs -- the page, its code and styles, the help
page, the icons and site-config.json -- and none of the downloadable app's
Python, tests or tools. Then:

  * writes app-shell.json, the exact list of files the service worker will
    ever fetch from the website (it refuses everything else);
  * stamps sw.js with a version, which is how browsers notice an update;
  * runs the privacy audit over every file it produced, and fails the build if
    anything personal turned up.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
FILES = ["index.html", "sw.js", "manifest.webmanifest", "site-config.json"]
FOLDERS = ["app", "help"]
SKIP_NAMES = {".DS_Store"}
SKIP_SUFFIXES = {".py", ".pyc", ".map", ".md"}
MARKER = ".telegram-archive-site"


def collect() -> list[Path]:
    found = [APP_DIR / name for name in FILES]
    for folder in FOLDERS:
        for path in sorted((APP_DIR / folder).rglob("*")):
            if path.is_file() and path.name not in SKIP_NAMES \
                    and path.suffix not in SKIP_SUFFIXES:
                found.append(path)
    return found


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", default=str(APP_DIR / "site"))
    args = parser.parse_args(argv)
    out = Path(args.out).resolve()

    # Only ever clear a folder this script made: a mistyped --out must never
    # cost anyone a directory.
    if out.exists():
        if not (out / MARKER).exists():
            print(f"Refusing to replace {out}: it was not made by this script.",
                  file=sys.stderr)
            return 1
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / MARKER).write_text("built by tools/build_site.py\n", encoding="utf-8")
    # Tells GitHub Pages to serve the files as they are, without Jekyll.
    (out / ".nojekyll").write_text("", encoding="utf-8")

    shell = []
    digest = hashlib.sha256()
    for source in collect():
        rel = source.relative_to(APP_DIR).as_posix()
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if rel != "sw.js":
            shell.append(rel)
            digest.update(rel.encode())
            digest.update(source.read_bytes())

    version = digest.hexdigest()[:12]
    (out / "app-shell.json").write_text(
        json.dumps({"version": version, "files": sorted(shell)}, indent=1),
        encoding="utf-8")

    worker = out / "sw.js"
    text = worker.read_text(encoding="utf-8")
    stamp = "const VERSION = 'dev';"
    if text.count(stamp) != 1:
        print("sw.js no longer has the version line this build stamps.", file=sys.stderr)
        return 1
    worker.write_text(text.replace(stamp, f"const VERSION = '{version}';"),
                      encoding="utf-8")

    print(f"built {out.relative_to(APP_DIR) if out.is_relative_to(APP_DIR) else out}: "
          f"{len(shell) + 1} files, version {version}")

    audit = subprocess.run(
        [sys.executable, str(APP_DIR / "tools" / "privacy_audit.py"), "--dir", str(out)])
    return audit.returncode


if __name__ == "__main__":
    raise SystemExit(main())
