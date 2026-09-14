#!/usr/bin/env python3
"""Build the distributable zip.

    python3 tools/make_dist.py            # -> dist/TelegramArchive-<version>.zip
    python3 tools/make_dist.py --out DIR

What ships is the program and nothing else: no index, no config, no uploaded
pictures, no caches. Those all live in data/, which is generated on the
recipient's machine by their own first run.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent

# Everything here is either generated, personal, or development-only.
EXCLUDE_DIRS = {"data", "__pycache__", ".git", ".github", "dist", "site", "tools/tests"}
EXCLUDE_NAMES = {
    ".DS_Store", "launch.log",
    # Build-only tooling. It is how the distribution and its guide are made,
    # not part of the program -- and make_guide.py imports reportlab, which
    # would otherwise be the one third-party name in a shipped file.
    "make_dist.py", "make_guide.py", "make_icon.py", "make_fixtures.py",
    # The repository's own tooling and paperwork, not the program.
    "privacy_audit.py", "build_site.py", "install_hooks.py", "GITHUB-GUIDE.md",
}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".log"}

# Files that must arrive executable; zip does not preserve the bit by default.
EXECUTABLE = {
    "Install (macOS).command",
    "Install (Linux).sh",
    "Start Viewer.command",
    "start-viewer.sh",
    "Uninstall (macOS).command",
    "Uninstall (Linux).sh",
    "Telegram Archive.app/Contents/MacOS/TelegramArchive",
    "Telegram Archive.desktop",
}


def version() -> str:
    source = (APP_DIR / "app" / "version.js").read_text(encoding="utf-8")
    found = re.search(r"VERSION = '([^']+)'", source)
    return found.group(1) if found else "0.0"


def stamp_bundle_version(bundle: Path, number: str) -> None:
    """Write `number` into the bundle's Info.plist, in both version keys."""
    plist = bundle / "Contents" / "Info.plist"
    if not plist.exists():
        return
    text = plist.read_text(encoding="utf-8")
    for key in ("CFBundleVersion", "CFBundleShortVersionString"):
        text = re.sub(
            rf"(<key>{key}</key>\s*<string>)[^<]*(</string>)",
            rf"\g<1>{number}\g<2>",
            text,
        )
    plist.write_text(text, encoding="utf-8")


def included(relative: Path) -> bool:
    parts = relative.parts
    if any(part in EXCLUDE_NAMES for part in parts):
        return False
    if relative.suffix in EXCLUDE_SUFFIXES:
        return False
    joined = "/".join(parts)
    return not any(
        joined == skip or joined.startswith(skip + "/") or skip in parts
        for skip in EXCLUDE_DIRS
    )


def identifying_terms() -> list:
    """Words that would identify whoever is building this.

    Derived from the machine rather than hardcoded, so the check protects any
    builder and no real name has to be written into the source to detect it.
    """
    terms = set()
    for candidate in (getpass.getuser(), Path.home().name):
        if candidate and len(candidate) >= 4:
            terms.add(candidate.lower())
    try:
        import pwd
        full = pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0]
        for word in re.split(r"[\s.]+", full):
            if len(word) >= 4:
                terms.add(word.lower())
    except (ImportError, KeyError, AttributeError, OSError):
        pass
    return sorted(terms)


BINARY_SUFFIXES = {".png", ".icns", ".jpg", ".jpeg", ".webp", ".gif",
                   ".mp4", ".webm", ".ogg", ".tgs", ".zip", ".woff2"}


def audit(files: list) -> list:
    """Refuse to ship anything that identifies the builder -- or anyone else.

    Hands over to tools/privacy_audit.py, which checks for far more than the
    builder's own name: every chat and contact name and Telegram ID in the
    local archive, email addresses and home-folder paths. The name-only check
    this replaced missed a real Telegram ID sitting in five files.
    """
    sys.path.insert(0, str(APP_DIR))
    from tools import privacy_audit
    terms = privacy_audit.personal_terms()
    sources = [(str(path.relative_to(APP_DIR)),
                lambda path=path: path.read_text(encoding="utf-8", errors="ignore"))
               for path in files]
    return [f"{name}:{line}  {reason}"
            for name, line, reason in privacy_audit.scan(sources, terms)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(APP_DIR / "dist"))
    args = parser.parse_args()

    name = f"TelegramArchive-{version()}"
    out_dir = Path(args.out)
    staging = out_dir / name
    archive = out_dir / f"{name}.zip"

    files = [
        path for path in sorted(APP_DIR.rglob("*"))
        if path.is_file() and included(path.relative_to(APP_DIR))
    ]

    problems = audit(files)
    if problems:
        print("Refusing to build; personal data would ship:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    for path in files:
        target = staging / path.relative_to(APP_DIR)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)

    # The guide travels with the program: whoever receives the zip should not
    # have to be sent a second file to know what to do with the first.
    guide = APP_DIR / "dist" / "Telegram Archive - Install Guide.pdf"
    if guide.exists():
        shutil.copy2(guide, staging / guide.name)
        print(f"  including {guide.name}")

    # The bundle carries its own copy of the version, and a second copy of a
    # number is a second chance to be wrong -- it sat at 1.1 through a 1.2
    # build. Stamp it from version.js at build time instead of by hand.
    stamp_bundle_version(staging / "Telegram Archive.app", version())

    # Re-sign after copying: the seal covers the bundle's contents.
    if sys.platform == "darwin":
        subprocess.run(
            ["codesign", "--force", "--deep", "--sign", "-",
             str(staging / "Telegram Archive.app")],
            capture_output=True, check=False,
        )

    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(staging.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(staging)
            info = zipfile.ZipInfo.from_file(path, f"{name}/{relative}")
            # Preserve the executable bit so launchers work after unzipping.
            mode = 0o755 if str(relative) in EXECUTABLE else 0o644
            info.external_attr = (mode & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, path.read_bytes())

    shutil.rmtree(staging, ignore_errors=True)
    size = archive.stat().st_size / (1024 * 1024)
    print(f"{archive}  ({size:.1f} MB, {len(files)} files)")
    print("\nContains no index, config or pictures — the recipient's first run")
    print("builds those from their own exports.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
