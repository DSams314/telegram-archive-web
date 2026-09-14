#!/usr/bin/env python3
"""Install Telegram Archive for the current user, then offer to start it.

Driven by the per-platform launchers in the distribution, but usable directly:

    python3 tools/install.py            # install to the platform's default
    python3 tools/install.py --to DIR
    python3 tools/install.py --check    # preflight only, change nothing

Per-user, never system-wide: no administrator rights, no services, nothing
outside your home folder.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.preflight import default_install_dir, run as preflight  # noqa: E402

SOURCE = Path(__file__).resolve().parent.parent

# Never copied into an install: generated state, and the installers themselves.
SKIP_NAMES = {"data", "__pycache__", ".DS_Store", ".git"}
SKIP_SUFFIXES = {".pyc"}


def banner(text: str) -> None:
    print(f"\n{text}\n{'─' * len(text)}")


def copy_tree(source: Path, dest: Path) -> int:
    copied = 0
    for item in source.rglob("*"):
        if any(part in SKIP_NAMES for part in item.relative_to(source).parts):
            continue
        if item.suffix in SKIP_SUFFIXES:
            continue
        target = dest / item.relative_to(source)
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
            copied += 1
    return copied


def make_desktop_entry(install_dir: Path, suffix: str = "") -> Path | None:
    """A menu entry on Linux, so it appears alongside other applications.

    `suffix` keeps a side-by-side install from overwriting the menu entry of
    the copy it was meant to sit beside -- which would leave two programs and
    one way to start them, pointed at the newer.
    """
    applications = Path.home() / ".local" / "share" / "applications"
    applications.mkdir(parents=True, exist_ok=True)
    slug = f"telegram-archive{'-' + suffix if suffix else ''}.desktop"
    entry = applications / slug
    entry.write_text(
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name=Telegram Archive{' ' + suffix if suffix else ''}\n"
        "Comment=Offline reader for your Telegram chat exports\n"
        f'Exec=sh -c \'cd "{install_dir}" && python3 -m tools.tgindex; '
        "exec python3 serve.py'\n"
        "Terminal=false\n"
        "Categories=Utility;Archiving;\n",
        encoding="utf-8",
    )
    entry.chmod(0o755)
    return entry


def make_start_menu_shortcut(install_dir: Path, suffix: str = "") -> Path | None:
    """A Start Menu entry on Windows, created via the shell's own API."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return None
    folder = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    folder.mkdir(parents=True, exist_ok=True)
    link = folder / f"Telegram Archive{' ' + suffix if suffix else ''}.lnk"
    target = install_dir / "Telegram Archive.vbs"
    script = (
        'Set s = CreateObject("WScript.Shell")\n'
        f'Set l = s.CreateShortcut("{link}")\n'
        f'l.TargetPath = "{target}"\n'
        f'l.WorkingDirectory = "{install_dir}"\n'
        'l.Description = "Telegram Archive"\n'
        "l.Save\n"
    )
    helper = install_dir / "_shortcut.vbs"
    helper.write_text(script, encoding="utf-8")
    try:
        subprocess.run(["cscript", "//nologo", str(helper)],
                       capture_output=True, check=False)
    finally:
        helper.unlink(missing_ok=True)
    return link if link.exists() else None


BACKUPS_README = """Put your Telegram chat exports in this folder.

One folder per conversation, and inside each one the export folder that
Telegram produced. Like this:

    Backups/
        Mum/
            ChatExport_2026_03_01/
                result.json
                photos/
                video_files/
        Work group/
            ChatExport_2026_07_14/
                result.json

You can also just drag a whole ChatExport folder in here on its own and it
will be picked up.

Export from Telegram Desktop with:
    Settings > Advanced > Export Telegram data
    Format: MACHINE-READABLE JSON   (not HTML)

After adding anything new, open Telegram Archive and choose
Settings > Archive > Rebuild the index.

Nothing in this folder is ever modified or deleted by the program. It only
reads.
"""


def prepare_backups(install_dir: Path, share_from: Path | None = None) -> Path:
    """Create the Backups folder and point the program at it.

    Doing this at install time removes the only real decision from first run:
    the wizard opens already pointing at a folder that exists, in a location
    macOS is happy to read, with a note inside explaining what goes there.

    A side-by-side install instead points at the *existing* copy's Backups and
    creates nothing. Both versions then read one archive: no duplicate of a
    20 GB folder, no second place to remember to add exports to, and no risk to
    the originals, which are only ever read.
    """
    if share_from is not None:
        shared = share_from / "Backups"
        if shared.is_dir():
            seed_config(install_dir, shared)
            print(f"  reading the exports already in {shared}")
            return shared

    backups = install_dir / "Backups"
    backups.mkdir(parents=True, exist_ok=True)
    readme = backups / "PUT YOUR EXPORTS HERE.txt"
    if not readme.exists():
        readme.write_text(BACKUPS_README, encoding="utf-8")

    seed_config(install_dir, backups)
    return backups


def seed_config(install_dir: Path, backups: Path) -> None:
    """Point a fresh install at `backups`, leaving any existing config alone.

    The "leave it alone" half matters most: an update must not undo the
    settings and chosen folder of the copy it is replacing.
    """
    config_path = install_dir / "data" / "config.json"
    if config_path.exists():
        return
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({
        "schema": 1,
        "setup_complete": False,
        "backup_root": str(backups),
        "index_dir": "data/index",
        "self": {"id": None, "name": None, "username": None, "avatar": None},
    }, indent=2), encoding="utf-8")


def sign_bundle(install_dir: Path) -> None:
    """Ad-hoc sign the macOS bundle so granted permissions stick to it."""
    bundle = install_dir / "Telegram Archive.app"
    if sys.platform != "darwin" or not bundle.exists():
        return
    subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", str(bundle)],
        capture_output=True, check=False,
    )


def installed_version(folder: Path) -> str | None:
    """The version of an existing install, or None if that is not one."""
    marker = folder / "app" / "version.js"
    if not (folder / "serve.py").exists() or not marker.exists():
        return None
    try:
        found = re.search(r"VERSION = '([^']+)'", marker.read_text(encoding="utf-8"))
    except OSError:
        return None
    return found.group(1) if found else "unknown"


def side_by_side_dir(base: Path, number: str) -> Path:
    """A free folder next to `base`, named for the version going into it."""
    candidate = base.parent / f"{base.name} {number}"
    suffix = 2
    while candidate.exists():
        candidate = base.parent / f"{base.name} {number} ({suffix})"
        suffix += 1
    return candidate


def choose_destination(install_dir: Path, incoming: str, mode: str) -> Path | None:
    """Update in place, install alongside, or stop. None means stop.

    Reinstalling over an existing copy is the right default -- it is what
    "install the new version" usually means, and it keeps that copy's settings
    and Backups. But it is not reversible, so when there is something there and
    a person to ask, ask.
    """
    existing = installed_version(install_dir)
    if existing is None:
        return install_dir

    print(f"\nTelegram Archive {existing} is already installed at:")
    print(f"  {install_dir}")

    if mode == "update":
        return install_dir
    if mode == "side-by-side":
        return side_by_side_dir(install_dir, incoming)
    if not sys.stdin.isatty():
        # Nobody to ask. Updating preserves both data and Backups, so it is
        # the safe assumption; installing alongside silently would not be.
        print("  Updating it (run with --side-by-side to keep both).")
        return install_dir

    alongside = side_by_side_dir(install_dir, incoming)
    choices = [
        (f"Update it to {incoming}", "keeps your settings and Backups"),
        ("Keep both", f"installs {incoming} to “{alongside.name}”"),
        ("Cancel", "changes nothing"),
    ]
    width = max(len(label) for label, _ in choices)
    print()
    for number, (label, detail) in enumerate(choices, 1):
        print(f"  {number}  {label:<{width}}   ({detail})")
    print("\nYour exports are never touched, whichever you pick.")
    while True:
        answer = input("\nChoose 1, 2 or 3 [1]: ").strip() or "1"
        if answer == "1":
            return install_dir
        if answer == "2":
            return alongside
        if answer == "3":
            return None
        print("  Please type 1, 2 or 3.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--to", help="install location")
    parser.add_argument("--check", action="store_true", help="preflight only")
    parser.add_argument("--no-start", action="store_true")
    parser.add_argument("--keep-source", action="store_true",
                        help="leave the unzipped folder in place")
    parser.add_argument("--update", dest="mode", action="store_const",
                        const="update", default="ask",
                        help="replace an existing install without asking")
    parser.add_argument("--side-by-side", dest="mode", action="store_const",
                        const="side-by-side",
                        help="install alongside an existing version")
    args = parser.parse_args()

    install_dir = Path(args.to).expanduser() if args.to else default_install_dir()

    banner("Telegram Archive — system check")
    checks = preflight(install_dir)
    for check in checks:
        mark = "OK  " if check.ok else ("!!  " if check.fatal else " ~  ")
        print(f"  {mark}{check.name}: {check.detail}")

    blocking = [c for c in checks if not c.ok and c.fatal]
    if blocking:
        print("\nCannot install:")
        for check in blocking:
            print(f"  - {check.detail}")
        return 1
    if args.check:
        return 0

    incoming = installed_version(SOURCE) or "new"
    previous = install_dir
    destination = choose_destination(install_dir, incoming, args.mode)
    if destination is None:
        print("\nCancelled. Nothing was changed.")
        return 0
    share_backups_with = previous if destination != previous else None
    install_dir = destination

    banner(f"Installing to {install_dir}")

    # Reinstalling replaces the program and NOTHING else. `data` holds the
    # index and settings; `Backups` holds the user's actual chat exports and
    # lives inside the install folder -- so a blind rmtree here would delete
    # the very archive the program exists to read. Both are moved aside first.
    PRESERVE = ("data", "Backups")
    stash = None
    if install_dir.exists():
        stash = install_dir.parent / f".{install_dir.name}.keep"
        shutil.rmtree(stash, ignore_errors=True)
        stash.mkdir(parents=True)
        for name in PRESERVE:
            existing = install_dir / name
            if existing.exists():
                shutil.move(str(existing), str(stash / name))
                print(f"  keeping your existing {name}")
        # Only program files remain; clearing them drops anything since removed.
        shutil.rmtree(install_dir, ignore_errors=True)

    install_dir.mkdir(parents=True, exist_ok=True)
    count = copy_tree(SOURCE, install_dir)
    print(f"  copied {count} files")

    if stash is not None:
        for name in PRESERVE:
            saved = stash / name
            if saved.exists():
                shutil.move(str(saved), str(install_dir / name))
        shutil.rmtree(stash, ignore_errors=True)

    for name in ("Start Viewer.command", "start-viewer.sh",
                 "Install to Applications.command",
                 "Telegram Archive.app/Contents/MacOS/TelegramArchive"):
        path = install_dir / name
        if path.exists():
            path.chmod(0o755)

    sign_bundle(install_dir)
    backups = prepare_backups(install_dir, share_backups_with)

    # Only a side-by-side install needs distinguishing; an update should keep
    # the one menu entry people already have.
    suffix = incoming if share_backups_with is not None else ""
    extras = []
    if sys.platform.startswith("linux"):
        entry = make_desktop_entry(install_dir, suffix)
        if entry:
            extras.append(f"menu entry at {entry}")
    elif os.name == "nt":
        link = make_start_menu_shortcut(install_dir, suffix)
        if link:
            extras.append(f"Start Menu shortcut at {link}")

    banner("Installed")
    if sys.platform == "darwin":
        print(f"  Open:  {install_dir / 'Telegram Archive.app'}")
        print("  Tip:   drag that app to your Dock")
    elif os.name == "nt":
        print(f"  Open:  {install_dir / 'Telegram Archive.vbs'}")
    else:
        print("  Open:  Telegram Archive, from your applications menu")
    for extra in extras:
        print(f"  Also:  {extra}")

    warnings = [c for c in checks if not c.ok and not c.fatal]
    for check in warnings:
        print(f"\n  Note: {check.detail}")

    print(f"\n  Put your chat exports in:  {backups}")
    print("  Then open the app; the first launch walks you through the rest.")

    if not args.keep_source:
        tidy_up(install_dir)

    if not args.no_start:
        print("\nStarting it now…")
        launch(install_dir)
    return 0


def looks_unpacked(folder: Path) -> bool:
    """Whether this folder is an unzipped distribution and nothing else.

    The name is the deciding signal: the zip always unpacks to
    TelegramArchive-<version>. Checking only for the program's files would
    match a development checkout too, and deleting one of those would be
    unforgivable.
    """
    if not re.fullmatch(r"TelegramArchive-[\d.]+", folder.name):
        return False
    expected = ("serve.py", "index.html", "app", "tools")
    return all((folder / name).exists() for name in expected)


def tidy_up(install_dir: Path) -> None:
    """Remove the unzipped folder now that everything has been copied out.

    Copy-then-delete rather than a true move: the installer is itself running
    from inside that folder, and pulling files out from under a live script is
    a poor way to end an install.
    """
    if SOURCE.resolve() == install_dir.resolve():
        return
    if not looks_unpacked(SOURCE):
        print(f"\n  Left {SOURCE.name} where it is (not an unzipped download).")
        return
    try:
        shutil.rmtree(SOURCE)
        print(f"\n  Tidied up: removed {SOURCE}")
    except OSError as exc:
        print(f"\n  Could not remove {SOURCE}: {exc}")
        print("  You can delete that folder yourself; it is no longer needed.")


def launch(install_dir: Path) -> None:
    """Start the copy we just installed -- specifically that one.

    `open <bundle>` goes through LaunchServices, which resolves by bundle
    identifier. With the freshly-unzipped copy still sitting in Downloads,
    both bundles claim the same id and it can quite happily launch the wrong
    one. Running the bundle's executable directly bypasses that entirely.
    """
    if sys.platform == "darwin":
        binary = install_dir / "Telegram Archive.app" / "Contents" / "MacOS" / "TelegramArchive"
        if binary.exists():
            subprocess.Popen([str(binary)], cwd=str(install_dir),
                             start_new_session=True)
            return
    if os.name == "nt":
        subprocess.Popen(["wscript", str(install_dir / "Telegram Archive.vbs")],
                         cwd=str(install_dir))
        return
    subprocess.Popen([sys.executable, "serve.py"], cwd=str(install_dir),
                     start_new_session=True)


if __name__ == "__main__":
    raise SystemExit(main())
