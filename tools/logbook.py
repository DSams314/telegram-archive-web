#!/usr/bin/env python3
"""One timeline of everything the program does, written to disk as it happens.

    from tools.logbook import log
    log("server.start", port=8730)

The point is a failure someone else hit. Four separate pieces run during a
normal launch -- the launcher script, the server, the indexer, and the page in
the browser -- and until now each one's output went somewhere different, or
nowhere. A single file they can send back is the difference between fixing a
report and guessing at one.

Written from the first line of the launcher onward, so a program that never
manages to open a window has already said why. One JSON object per line: easy
to append to safely, and readable without any tooling.

Nothing here is ever sent anywhere. It is a local file, like everything else.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
LOG_DIR = APP_DIR / "data" / "logs"
LOG_FILE = LOG_DIR / "archive.jsonl"

# Big enough to hold a long indexing run, small enough to send by email.
MAX_BYTES = 4 * 1024 * 1024
KEEP = 3

_lock = threading.Lock()
_source = "python"
_session = ""


def session_id() -> str:
    """Stable per-run id, so one launch can be picked out of a long file."""
    global _session
    if not _session:
        _session = os.environ.get("TG_SESSION") or f"{int(time.time())}-{os.getpid()}"
    return _session


def configure(source: str) -> None:
    """Name whichever part of the program is doing the logging."""
    global _source
    _source = source


def _rotate() -> None:
    if not LOG_FILE.exists() or LOG_FILE.stat().st_size < MAX_BYTES:
        return
    for index in range(KEEP - 1, 0, -1):
        older = LOG_FILE.with_suffix(f".{index}.jsonl")
        newer = LOG_FILE.with_suffix(f".{index + 1}.jsonl")
        if older.exists():
            older.replace(newer)
    LOG_FILE.replace(LOG_FILE.with_suffix(".1.jsonl"))


def log(event: str, level: str = "info", **fields) -> None:
    """Append one event. Never raises -- logging must not break the program."""
    record = {
        "t": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "level": level,
        "src": _source,
        "pid": os.getpid(),
        "session": session_id(),
        "event": event,
    }
    for key, value in fields.items():
        # Paths and exceptions are not JSON; keep them readable rather than
        # dropping the record that explains what went wrong.
        record[key] = value if _plain(value) else str(value)

    try:
        with _lock:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            _rotate()
            with LOG_FILE.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass  # a full or read-only disk must not take the app down with it


def _plain(value) -> bool:
    return isinstance(value, (str, int, float, bool, type(None), list, dict))


def boot_snapshot(**extra) -> None:
    """Everything about this machine worth knowing when reading a report later.

    Recorded once per launch. Most support questions ("which version?", "did
    it even find Python?", "was the drive plugged in?") are answered here
    without another round trip.
    """
    try:
        version = (APP_DIR / "app" / "version.js").read_text(encoding="utf-8")
        number = version.split("VERSION = '")[1].split("'")[0]
    except (OSError, IndexError):
        number = "unknown"

    log(
        "boot",
        app_version=number,
        platform=sys.platform,
        os_release=platform.platform(),
        machine=platform.machine(),
        python=sys.version.split()[0],
        python_path=sys.executable,
        app_dir=str(APP_DIR),
        quarantined=_quarantined(),
        **extra,
    )


def _quarantined() -> bool | None:
    """Whether macOS has flagged this copy as downloaded.

    Worth knowing: a quarantined copy behaves differently from one built on
    the machine, which is exactly the gap between a developer's Mac and
    everyone else's.
    """
    if sys.platform != "darwin":
        return None
    try:
        import subprocess
        done = subprocess.run(["xattr", str(APP_DIR)],
                              capture_output=True, text=True, timeout=5)
        return "com.apple.quarantine" in done.stdout
    except (OSError, subprocess.SubprocessError):
        return None


def read_recent(limit: int = 5000) -> list[dict]:
    """The most recent records, oldest first, across rotated files."""
    records: list[dict] = []
    files = [LOG_FILE.with_suffix(f".{i}.jsonl") for i in range(KEEP, 0, -1)]
    files.append(LOG_FILE)
    for path in files:
        if not path.exists():
            continue
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except ValueError:
                    records.append({"event": "unparsed", "raw": line[:400]})
        except OSError:
            continue
    return records[-limit:]


if __name__ == "__main__":
    configure("cli")
    boot_snapshot()
    print(LOG_FILE)
