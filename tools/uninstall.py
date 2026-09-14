#!/usr/bin/env python3
"""Remove Telegram Archive, keeping your chat exports.

    python3 tools/uninstall.py             # ask first, keep Backups
    python3 tools/uninstall.py --yes       # no prompt
    python3 tools/uninstall.py --from DIR

Your exports live in a Backups folder *inside* the install folder, so deleting
that folder wholesale would destroy the archive the program exists to read.
This removes the program and its index, and deliberately leaves Backups where
it is. Nothing in it is read, moved or rewritten -- the program never had write
access to it in the first place.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.preflight import default_install_dir  # noqa: E402

# Kept no matter what. Everything else in the install folder is the program.
KEEP = {"Backups"}


def human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def measure(folder: Path) -> tuple:
    """(file count, total bytes) below `folder`."""
    count = 0
    total = 0
    for path in folder.rglob("*"):
        if path.is_file():
            count += 1
            try:
                total += path.stat().st_size
            except OSError:
                pass
    return count, total


def stop_server(port: int = 8730) -> bool:
    """Ask a running copy to shut down, so no files are in use."""
    for candidate in range(port, port + 20):
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{candidate}/api/shutdown", method="POST")
            urllib.request.urlopen(request, timeout=2)
            return True
        except urllib.error.HTTPError:
            continue
        except OSError:
            continue
    return False


def remove_shortcuts() -> list:
    """Menu entries the installer created outside the install folder."""
    removed = []
    entry = Path.home() / ".local" / "share" / "applications" / "telegram-archive.desktop"
    if entry.exists():
        entry.unlink()
        removed.append(str(entry))

    appdata = os.environ.get("APPDATA")
    if appdata:
        link = (Path(appdata) / "Microsoft" / "Windows" / "Start Menu"
                / "Programs" / "Telegram Archive.lnk")
        if link.exists():
            link.unlink()
            removed.append(str(link))
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="source", help="install folder")
    parser.add_argument("--yes", action="store_true", help="skip the prompt")
    parser.add_argument("--delete-backups", action="store_true",
                        help="also delete your exports (asks again first)")
    args = parser.parse_args()

    install_dir = (Path(args.source).expanduser() if args.source
                   else default_install_dir())

    if not install_dir.exists():
        print(f"Nothing installed at {install_dir}")
        return 0

    backups = install_dir / "Backups"
    has_backups = backups.is_dir()
    backup_count, backup_size = measure(backups) if has_backups else (0, 0)

    print(f"\nTelegram Archive at {install_dir}\n")
    if has_backups:
        print(f"  Your exports:  {backup_count:,} files, {human(backup_size)}")
        if args.delete_backups:
            print("                 WILL BE DELETED (you asked for --delete-backups)")
        else:
            print("                 will be KEPT, exactly where they are")
    print("  The program:   will be removed")
    print("  Index/settings: will be removed (rebuilt if you reinstall)")

    if not args.yes:
        prompt = "\nRemove Telegram Archive? [y/N] "
        if args.delete_backups and has_backups:
            prompt = ("\nThis DELETES your chat exports too and cannot be "
                      "undone.\nType DELETE to confirm: ")
        try:
            answer = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print("\nCancelled.")
            return 1
        expected = "DELETE" if (args.delete_backups and has_backups) else None
        if expected:
            if answer != expected:
                print("Cancelled.")
                return 1
        elif answer.lower() not in ("y", "yes"):
            print("Cancelled.")
            return 1

    if stop_server():
        print("\n  stopped the running copy")

    keep = set() if args.delete_backups else KEEP
    removed = 0
    for item in sorted(install_dir.iterdir()):
        if item.name in keep:
            continue
        try:
            if item.is_dir() and not item.is_symlink():
                shutil.rmtree(item)
            else:
                item.unlink()
            removed += 1
        except OSError as exc:
            print(f"  could not remove {item.name}: {exc}")

    for path in remove_shortcuts():
        print(f"  removed {path}")

    # An empty Backups is not worth preserving -- the placeholder note the
    # installer wrote does not count as content. Clear it so someone who never
    # added any exports is left with nothing at all.
    if backups.is_dir() and not args.delete_backups:
        real_files = [
            path for path in backups.rglob("*")
            if path.is_file() and path.name != "PUT YOUR EXPORTS HERE.txt"
        ]
        if not real_files:
            shutil.rmtree(backups, ignore_errors=True)
            has_backups = False

    # If nothing is left worth keeping, take the folder itself too.
    if not list(install_dir.iterdir()):
        install_dir.rmdir()
        print(f"\nRemoved {install_dir}")
        print("Telegram Archive is gone. Nothing else was installed anywhere.")
        return 0

    print(f"\nRemoved {removed} items from {install_dir}")
    if has_backups and not args.delete_backups:
        print(f"\nYour chat exports are untouched:\n  {backups}")
        print(f"  {backup_count:,} files, {human(backup_size)}")
        print("\nThey are exactly as Telegram exported them -- this program only")
        print("ever read from that folder. Move it anywhere you like, or delete")
        print("it yourself when you no longer want it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
