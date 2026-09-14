#!/usr/bin/env python3
"""Ask the operating system for a folder, using its own chooser.

    python3 -m tools.nativepicker [start-folder]

A web page cannot open a real file dialog: a file input hands back contents,
never a location, and nothing in a browser can return a path. But the server
is a normal local process on the same machine, so it can put up the system's
own folder chooser and pass back what was picked.

Falls back cleanly -- `available()` says whether a chooser exists at all, so
the in-app browser can still be offered on a machine with neither zenity nor
kdialog installed.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

PROMPT = "Choose the folder that holds your Telegram exports"
TIMEOUT = 300  # a person may take a while; a stuck dialog must not wedge us


class Cancelled(Exception):
    """The dialog was dismissed without choosing anything."""


def _mac(start: Path | None) -> str:
    """The standard macOS folder panel, and deliberately nothing more.

    An earlier version wrapped this in `tell application "System Events"` to
    bring the panel to the front. That worked, but it made macOS ask for
    permission to *control System Events* -- an alarming prompt to see, and a
    fair one: that permission covers UI scripting and synthetic keystrokes,
    which is far more than opening a folder panel warrants.

    `choose folder` on its own is a plain scripting addition owned by osascript
    itself. It needs no permission and grants none. The cost is that the panel
    can open behind the window, which the button says out loud instead.
    """
    location = ""
    if start is not None:
        escaped = str(start).replace("\\", "\\\\").replace('"', '\\"')
        location = f' default location POSIX file "{escaped}"'
    script = (
        f'POSIX path of (choose folder with prompt "{PROMPT}"{location})'
    )
    done = subprocess.run(["osascript", "-e", script],
                          capture_output=True, text=True, timeout=TIMEOUT)
    if done.returncode != 0:
        # -128 is the standard "user cancelled" code across AppleScript.
        if "-128" in done.stderr or "cancel" in done.stderr.lower():
            raise Cancelled
        raise RuntimeError(done.stderr.strip() or "the chooser could not open")
    return done.stdout.strip()


def _windows(start: Path | None) -> str:
    initial = f"$dialog.SelectedPath = '{start}'\n" if start else ""
    script = (
        "Add-Type -AssemblyName System.Windows.Forms\n"
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog\n"
        f"$dialog.Description = '{PROMPT}'\n"
        f"{initial}"
        "if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }\n"
    )
    done = subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-Command", script],
        capture_output=True, text=True, timeout=TIMEOUT)
    picked = done.stdout.strip()
    if not picked:
        raise Cancelled
    return picked


def _linux(start: Path | None) -> str:
    if shutil.which("zenity"):
        command = ["zenity", "--file-selection", "--directory",
                   f"--title={PROMPT}"]
        if start:
            command.append(f"--filename={start}/")
    elif shutil.which("kdialog"):
        command = ["kdialog", "--getexistingdirectory", str(start or Path.home())]
    else:
        raise RuntimeError("no folder chooser installed")

    done = subprocess.run(command, capture_output=True, text=True, timeout=TIMEOUT)
    picked = done.stdout.strip()
    if done.returncode != 0 or not picked:
        raise Cancelled
    return picked


def available() -> bool:
    """Whether this machine has a folder chooser we can drive."""
    if sys.platform == "darwin":
        return bool(shutil.which("osascript"))
    if os.name == "nt":
        return bool(shutil.which("powershell"))
    if sys.platform.startswith("linux"):
        return bool(shutil.which("zenity") or shutil.which("kdialog"))
    return False


def choose(start: str | os.PathLike | None = None) -> str:
    """Show the system folder chooser. Raises Cancelled if dismissed."""
    where = Path(start).expanduser() if start else None
    if where is not None and not where.is_dir():
        where = None   # a stale path would open the dialog nowhere useful

    if sys.platform == "darwin":
        return _mac(where)
    if os.name == "nt":
        return _windows(where)
    if sys.platform.startswith("linux"):
        return _linux(where)
    raise RuntimeError("no folder chooser on this platform")


if __name__ == "__main__":
    try:
        print(choose(sys.argv[1] if len(sys.argv) > 1 else None))
    except Cancelled:
        print("cancelled")
    except (RuntimeError, subprocess.TimeoutExpired) as problem:
        print(f"error: {problem}", file=sys.stderr)
        raise SystemExit(1)
