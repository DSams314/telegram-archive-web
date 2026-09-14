#!/usr/bin/env python3
"""Check that this machine can run Telegram Archive, and say so plainly.

Run by the installers before they copy anything, and available on its own:

    python3 tools/preflight.py

The program needs exactly one thing that isn't already on the machine --
Python 3.9 or newer -- so most of the work here is failing usefully when that
is missing rather than checking a long list.
"""

from __future__ import annotations

import os
import shutil
import socket
import sys
from pathlib import Path

MIN_PYTHON = (3, 9)

# Folders macOS guards. An app launched from the Dock is denied access to these
# without a prompt, so both the program and the archive want to live elsewhere.
MAC_PROTECTED = ("Documents", "Desktop", "Downloads")


class Check:
    def __init__(self, name: str, ok: bool, detail: str = "", fatal: bool = False):
        self.name = name
        self.ok = ok
        self.detail = detail
        self.fatal = fatal


def check_python() -> Check:
    version = sys.version_info[:3]
    ok = version >= MIN_PYTHON
    pretty = ".".join(str(part) for part in version)
    if ok:
        return Check("Python", True, f"{pretty} at {sys.executable}")
    return Check(
        "Python", False,
        f"{pretty} is too old; 3.9 or newer is needed. Install from python.org.",
        fatal=True,
    )


def check_port(port: int = 8730) -> Check:
    """Whether the default port is free. Not fatal -- the server walks upward."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
            return Check("Port", True, f"{port} is free")
        except OSError:
            return Check(
                "Port", True,
                f"{port} is busy; the next free port will be used instead.",
            )


def check_writable(target: Path) -> Check:
    """Whether we can create the install folder."""
    probe = target if target.exists() else target.parent
    try:
        probe.mkdir(parents=True, exist_ok=True)
        test = probe / ".tgwrite"
        test.write_text("ok", encoding="utf-8")
        test.unlink()
        return Check("Install location", True, str(target))
    except OSError as exc:
        return Check("Install location", False, f"{target}: {exc}", fatal=True)


def check_protected(path: Path) -> Check:
    """Warn when a path sits somewhere macOS will block."""
    if sys.platform != "darwin":
        return Check("Folder access", True, "not applicable on this platform")
    home = Path.home()
    try:
        relative = path.resolve().relative_to(home)
    except ValueError:
        return Check("Folder access", True, "outside the protected folders")
    top = relative.parts[0] if relative.parts else ""
    if top in MAC_PROTECTED:
        return Check(
            "Folder access", False,
            f"{path} is inside ~/{top}, which macOS blocks for apps opened "
            "from the Dock. Use a different folder, or launch with "
            "\"Start Viewer.command\".",
        )
    return Check("Folder access", True, "outside the protected folders")


def check_disk(target: Path, need_mb: int = 60) -> Check:
    try:
        free = shutil.disk_usage(target if target.exists() else target.parent).free
    except OSError:
        return Check("Disk space", True, "could not be measured")
    free_mb = free // (1024 * 1024)
    if free_mb < need_mb:
        return Check("Disk space", False, f"only {free_mb} MB free", fatal=True)
    return Check("Disk space", True, f"{free_mb / 1024:.1f} GB free")


def run(target: Path | None = None) -> list:
    target = target or default_install_dir()
    return [
        check_python(),
        check_writable(target),
        check_disk(target),
        check_protected(target),
        check_port(),
    ]


def default_install_dir() -> Path:
    """Where the program lives: one folder in the home directory.

    The same place on every platform, deliberately. It sidesteps the macOS
    restriction on Documents, Desktop and Downloads, it needs no admin rights
    anywhere, and it means one sentence of instructions instead of three. The
    archive lives in a Backups folder right beside it, so everything is in one
    place you can move, back up, or delete as a unit.
    """
    return Path.home() / "Telegram Archive"


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else default_install_dir()
    checks = run(target)

    print("Telegram Archive — system check\n")
    for check in checks:
        mark = "OK  " if check.ok else ("!!  " if check.fatal else " ~  ")
        print(f"  {mark}{check.name}: {check.detail}")

    blocking = [c for c in checks if not c.ok and c.fatal]
    warnings = [c for c in checks if not c.ok and not c.fatal]

    if blocking:
        print("\nCannot continue:")
        for check in blocking:
            print(f"  - {check.name}: {check.detail}")
        return 1
    if warnings:
        print("\nWorth knowing:")
        for check in warnings:
            print(f"  - {check.detail}")
    print("\nReady to install." if not warnings else "\nReady to install.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
