#!/usr/bin/env python3
"""Refuse to publish anything that identifies the developer or their contacts.

    python3 tools/privacy_audit.py              # every file git would publish
    python3 tools/privacy_audit.py --staged     # what is about to be committed
    python3 tools/privacy_audit.py --dir site   # a built folder

What it looks for is worked out fresh on every run, from this machine: the
account name, the full name on the account, and -- the part a name-only check
misses -- the local archive's own index, which lists every chat name, every
contact's name and every Telegram user ID in it. That list only ever exists in
memory while this runs. It is never written down, which is the point: a list
of the names to keep out of the repository must not itself end up in it.

Found terms are printed masked ("Ro***n"), so running this during a screen
share does not read the names out.

It also flags anything that merely looks personal whatever this machine says:
home-folder paths, email addresses, and long Telegram user IDs, because a real
ID from an archive this script cannot see is still a real ID.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent

BINARY = {".png", ".icns", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm",
          ".ogg", ".tgs", ".zip", ".woff2", ".pdf", ".ico"}

# Too common to mean anything on their own; a contact called "Photos" is not a
# leak, but flagging every use of the word would bury the real ones.
GENERIC = {
    "users", "user", "library", "documents", "desktop", "downloads", "telegram",
    "backups", "backup", "archive", "claude", "scratch", "viewer", "chatexport",
    "cloudstorage", "volumes", "deleted", "account", "photos", "files", "stickers",
    "chats", "chat", "group", "saved", "messages", "home", "test", "export",
    "exports", "store", "file", "folder", "drive", "media", "none", "null",
    "application", "applications", "private", "public", "personal", "unknown",
}

# Invented IDs used in tests, docs and help text. Anything else shaped like a
# Telegram user ID is treated as possibly real.
FICTIONAL_IDS = {"user9000000001", "user9000000002", "user0000000000",
                 "user123456789"}
ALLOWED_EMAIL = re.compile(
    r"(noreply@anthropic\.com|dev@localhost|@example\.(com|org)|"
    r"@users\.noreply\.github\.com)$", re.I)

# Hostnames cannot contain underscores and end in a letters-only TLD, which is
# what keeps Telegram's photo names ("photo_1@01-01-2024_00-00-00.jpg") from
# reading as addresses.
EMAIL = re.compile(r"[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
TELEGRAM_ID = re.compile(r"\buser\d{7,}\b")
HOME_PATH = re.compile(r"/(?:Users|home)/([A-Za-z0-9._-]+)/")


def _add(terms: dict, value, category: str) -> None:
    if not value:
        return
    for part in re.split(r"[/\\]+", str(value)):
        part = part.strip()
        if len(part) >= 4 and part.lower() not in GENERIC:
            terms.setdefault(part, category)


def personal_terms() -> dict:
    """Everything on this machine that would identify its owner or contacts."""
    terms: dict = {}
    for name in (getpass.getuser(), Path.home().name):
        _add(terms, name, "account name")
    try:
        import pwd
        full = pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0]
        for word in re.split(r"[\s.]+", full):
            _add(terms, word, "full name")
    except (ImportError, KeyError, AttributeError):
        pass
    for key in ("user.name", "user.email"):
        found = subprocess.run(["git", "config", "--global", key],
                               capture_output=True, text=True).stdout.strip()
        if found:
            _add(terms, found.split("@")[0], "git identity")

    installs = [APP_DIR, Path.home() / "Telegram Archive"]
    for base in installs:
        try:
            config = json.loads((base / "data" / "config.json").read_text("utf-8"))
        except (OSError, ValueError):
            config = {}
        me = config.get("self") or {}
        _add(terms, me.get("id"), "your Telegram ID")
        _add(terms, me.get("name"), "your display name")
        _add(terms, me.get("username"), "your username")
        for segment in str(config.get("backup_root") or "").split("/")[-4:]:
            _add(terms, segment, "backup folder path")

        try:
            manifest = json.loads(
                (base / "data" / "index" / "manifest.json").read_text("utf-8"))
        except (OSError, ValueError):
            continue
        _add(terms, manifest.get("self_id"), "your Telegram ID")
        for chat in manifest.get("chats", []):
            _add(terms, chat.get("name"), "chat name")
            _add(terms, chat.get("folder"), "chat name")
            for peer in chat.get("peers", []):
                _add(terms, peer.get("name"), "contact name")
                _add(terms, peer.get("id"), "contact ID")
    return terms


def mask(term: str) -> str:
    return term if len(term) <= 3 else f"{term[:2]}***{term[-1]}"


def _publishable() -> list:
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=APP_DIR, capture_output=True, text=True).stdout.split("\n")
    return [(name, lambda n=name: (APP_DIR / n).read_text("utf-8", "ignore"))
            for name in listed if name]


def _staged() -> list:
    listed = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        cwd=APP_DIR, capture_output=True, text=True).stdout.split("\n")
    def reader(name):
        return subprocess.run(["git", "show", f":{name}"], cwd=APP_DIR,
                              capture_output=True).stdout.decode("utf-8", "ignore")
    return [(name, lambda n=name: reader(n)) for name in listed if name]


def _directory(folder: Path) -> list:
    return [(str(path.relative_to(folder)),
             lambda p=path: p.read_text("utf-8", "ignore"))
            for path in sorted(folder.rglob("*")) if path.is_file()]


def scan(sources: list, terms: dict) -> list:
    """(file, line, reason) for every problem found."""
    patterns = [(re.compile(re.escape(t), re.I), t, c) for t, c in terms.items()]
    problems = []
    for name, read in sources:
        if Path(name).suffix.lower() in BINARY:
            continue
        # The audit's own rules mention the fictional IDs and the allowed
        # addresses by design; nothing personal can live in it.
        if Path(name).name == "privacy_audit.py":
            continue
        try:
            text = read()
        except OSError:
            continue
        lines = text.split("\n")
        for number, line in enumerate(lines, 1):
            for pattern, term, category in patterns:
                if pattern.search(line):
                    problems.append((name, number, f"{category}: {mask(term)}"))
            for found in TELEGRAM_ID.findall(line):
                if found not in FICTIONAL_IDS:
                    problems.append((name, number,
                                     f"Telegram user ID {mask(found)} — "
                                     "use an invented one"))
            for found in EMAIL.findall(line):
                if not ALLOWED_EMAIL.search(found):
                    problems.append((name, number, f"email address {mask(found)}"))
            for found in HOME_PATH.findall(line):
                if found not in {"you", "me", "name", "username", "runner"}:
                    problems.append((name, number,
                                     f"home folder path for {mask(found)}"))
    # One report per file, line and reason, however many patterns matched.
    return sorted(set(problems))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--dir")
    args = parser.parse_args(argv)

    terms = personal_terms()
    if args.dir:
        sources = _directory(Path(args.dir))
    elif args.staged:
        sources = _staged()
    else:
        sources = _publishable()

    problems = scan(sources, terms)
    if not problems:
        print(f"privacy audit: clean ({len(sources)} files, "
              f"{len(terms)} personal terms checked)")
        return 0

    print("privacy audit: personal information found — not safe to publish.\n")
    for name, line, reason in problems:
        print(f"  {name}:{line}  {reason}")
    print(f"\n{len(problems)} problem(s). Replace these with invented values.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
