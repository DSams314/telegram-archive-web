#!/usr/bin/env python3
"""Bundle the log into something safe to send to whoever wrote this.

    python3 -m tools.diagnostics            # -> data/diagnostics-<date>.txt

The raw log is always on disk at data/logs/archive.jsonl and can be sent as
it is. This produces the version meant for sending: the same events with the
identifying parts taken out, because a log is full of a person's home folder,
their account name, and the names of everyone they talk to.

Redaction is deliberately blunt. Losing a little detail is a fair price for
being able to hand the file over without reading every line of it first.
"""

from __future__ import annotations

import getpass
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools import logbook  # noqa: E402

APP_DIR = Path(__file__).resolve().parent.parent

# Fields whose whole value is a person's name and never diagnostic.
NAME_FIELDS = {"name", "chat", "chat_name", "self_name", "username"}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")


def _replacements() -> list[tuple[re.Pattern, str]]:
    """Patterns that identify this machine's owner, longest first.

    Longest first matters: the home directory contains the account name, so
    replacing the shorter one first would leave a half-redacted path behind.
    """
    home = str(Path.home())
    try:
        user = getpass.getuser()
    except Exception:  # noqa: BLE001
        user = ""

    pairs = [(home, "~")]
    if user and len(user) >= 3:
        pairs.append((user, "<user>"))
    pairs.sort(key=lambda pair: len(pair[0]), reverse=True)
    return [(re.compile(re.escape(text)), token) for text, token in pairs]


def redact(value, patterns) -> object:
    """Strip identifying text from a value of any shape."""
    if isinstance(value, str):
        cleaned = value
        for pattern, token in patterns:
            cleaned = pattern.sub(token, cleaned)
        return EMAIL.sub("<email>", cleaned)
    if isinstance(value, list):
        return [redact(item, patterns) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, patterns) for key, item in value.items()}
    return value


def scrub(record: dict, patterns) -> dict:
    """One log record, with names dropped and paths made anonymous."""
    out = {}
    for key, value in record.items():
        if key in NAME_FIELDS and isinstance(value, str) and value:
            # Kept as a length so "it failed on a chat with a long name" is
            # still visible, without saying whose chat it was.
            out[key] = f"<name:{len(value)}>"
            continue
        out[key] = redact(value, patterns)
    return out


def build(limit: int = 4000) -> str:
    patterns = _replacements()
    records = logbook.read_recent(limit)

    header = [
        "Telegram Archive diagnostics",
        f"generated {datetime.now().isoformat(timespec='seconds')}",
        f"{len(records)} events",
        "",
        "Home folder shown as ~, account name as <user>, chat and contact",
        "names replaced with their length. Nothing here was sent anywhere;",
        "this file was written locally and is yours to share or delete.",
        "-" * 62,
        "",
    ]
    lines = [json.dumps(scrub(record, patterns), ensure_ascii=False)
             for record in records]
    return "\n".join(header + lines) + "\n"


def write(destination: Path | None = None) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    target = destination or (APP_DIR / "data" / f"diagnostics-{stamp}.txt")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(build(), encoding="utf-8")
    return target


if __name__ == "__main__":
    print(write())
