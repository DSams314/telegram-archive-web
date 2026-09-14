"""Walk the backup root and work out what exports exist.

Expected layout (one folder per conversation, one sub-folder per export run):

    Backups/
      Robin/
        ChatExport_2024-03-01/   result.json  photos/ ...
        ChatExport_2026-07-26/   result.json  stickers/ ...
      Book Club/
        ChatExport_2026-07-26/   result.json  messages.html  ...

A conversation folder that *is itself* an export (result.json sitting directly
in it) is also accepted, since that's what you get if you unzip a single export
straight into the backup root.
"""

from __future__ import annotations

import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

EXPORT_DATE_RE = re.compile(r"(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})")


class ArchiveError(Exception):
    """A problem the user can act on, phrased for them rather than for a log."""


CLOUD_ROOT = "Library/CloudStorage"
CLOUD_NAMES = {
    "synologydrive": "Synology Drive", "icloud": "iCloud Drive",
    "dropbox": "Dropbox", "onedrive": "OneDrive",
    "googledrive": "Google Drive", "box": "Box", "pcloud": "pCloud",
    "megasync": "MEGA", "nextcloud": "Nextcloud", "proton": "Proton Drive",
}


def _cloud_provider(path: Path) -> str | None:
    """Which sync service manages this folder, if any.

    macOS mounts every file-provider service under ~/Library/CloudStorage as
    ``<Provider>-<account>``. Naming the actual service matters: the fix lives
    in that app's own settings, not anywhere in Telegram Archive.
    """
    text = str(path)
    marker = f"/{CLOUD_ROOT}/"
    if marker not in text:
        return None
    domain = text.split(marker, 1)[1].split("/")[0]
    simple = re.sub(r"[^a-z]", "", domain.lower())
    for key, label in CLOUD_NAMES.items():
        if simple.startswith(key):
            return label
    # An unrecognised provider still deserves its name rather than a shrug.
    return domain.split("-")[0] or "your cloud storage"


def protected_location(path: Path) -> tuple[str, str] | None:
    """Whether macOS guards this folder, and what that means in practice.

    Returns (severity, explanation), where severity is "blocked" for places
    with no per-folder permission at all, and "asks" for the ones macOS will
    offer to allow. None means the folder is ordinary and nothing will ever
    stand in the way.

    Said at the moment of choosing rather than at the next rebuild: the whole
    problem with these locations is that they look completely normal in a file
    picker and only fail later.
    """
    if sys.platform != "darwin":
        return None

    cloud = _cloud_provider(path)
    if cloud is not None:
        return ("blocked",
                f"This folder is managed by {cloud}. macOS keeps cloud "
                "storage behind a permission that cannot be granted per "
                "folder, so Telegram Archive is likely to be refused. A plain "
                "folder in your Home folder always works.")

    where = str(path)
    if where.startswith("/Volumes/"):
        return ("asks",
                "This is on an external or network drive. macOS will ask for "
                "permission the first time it is read — allow it and this "
                "works fine. If the drive is unplugged, the archive simply "
                "shows as unavailable until it is back.")

    try:
        top = path.resolve().relative_to(Path.home()).parts[0]
    except (ValueError, IndexError, OSError):
        return None
    if top in ("Documents", "Desktop", "Downloads"):
        return ("asks",
                f"macOS protects your {top} folder. It will ask for "
                "permission, and an app opened from the Dock is sometimes "
                "refused without asking at all. Somewhere else in your Home "
                "folder avoids the question entirely.")
    return None


def explain_denial(path: Path) -> str:
    """Explain a folder the system refuses to open, in terms of the fix.

    On macOS, errno 1 here almost never means the file mode is wrong -- it
    means the system withheld access. *Which* permission was withheld depends
    on where the folder lives, and naming the right toggle is the difference
    between a fix and a shrug. External and network drives sit behind their
    own switch, separate from the Documents/Desktop/Downloads ones.

    Shared with the server so the folder picker and the indexer never explain
    the same refusal two different ways.
    """
    where = str(path)
    if sys.platform != "darwin":
        return f"No permission to read {where}. Check the folder's permissions."

    cloud = _cloud_provider(path)
    if cloud is not None:
        # A different permission entirely, and one no Files-and-Folders switch
        # covers -- so the usual advice sends people hunting for a row that
        # will never appear.
        nas = "Synology" in cloud or "Nextcloud" in cloud
        options = []
        if nas:
            options.append(
                "Connect to the server directly instead. In Finder: Go > "
                "Connect to Server, then smb://your-nas, and pick the share. "
                "It appears under /Volumes, which Telegram Archive can ask "
                "for permission to read — and nothing has to sync or download "
                "to your Mac at all."
            )
        options.append(
            f"Have {cloud} keep a real copy on this Mac. An on-demand or "
            "online-only folder is a placeholder rather than files, so set up "
            "a normal sync for this folder and point Telegram Archive at "
            "where that lands (usually a plain folder in your Home folder, "
            "not this one)."
        )
        options.append(
            "Or grant Telegram Archive Full Disk Access under System Settings "
            "> Privacy & Security. It is the only switch that covers cloud "
            "storage — there is no narrower one to turn on."
        )

        listed = "\n\n".join(
            f"  {n}. {text}" for n, text in enumerate(options, 1)
        )
        return (
            f"macOS is blocking access to {where}.\n"
            f"That folder is managed by {cloud}. Cloud storage sits behind a "
            "permission of its own, which is why Telegram Archive never "
            "appears under Files and Folders for it — no switch there covers "
            "this.\n"
            "\n"
            f"{listed}"
        )

    spot = None
    if where.startswith("/Volumes/"):
        spot = ("on an external or network drive", "Removable Volumes")
    else:
        try:
            top = path.resolve().relative_to(Path.home()).parts[0]
            if top in ("Documents", "Desktop", "Downloads"):
                spot = (f"in your {top} folder", top)
        except (ValueError, IndexError, OSError):
            pass

    if spot is None:
        return (
            f"macOS is blocking access to {where}.\n"
            "Grant access under System Settings > Privacy & Security > "
            "Files and Folders, or keep your exports somewhere else."
        )

    place, toggle = spot
    return (
        f"macOS is blocking access to {where}.\n"
        f"It is {place}, which apps cannot read until you say so.\n"
        "\n"
        "Telegram Archive asks for this when it starts. If that prompt was "
        'missed or answered "Don\'t Allow", turn it on by hand:\n'
        "\n"
        "    System Settings > Privacy & Security > Files and Folders\n"
        f'    > Telegram Archive > "{toggle}"\n'
        "\n"
        "If Telegram Archive is not listed there at all, quit it and open it "
        "again — it is only listed once it has asked, and it asks the first "
        "time it reads the folder."
    )


def _unreadable(root: Path) -> ArchiveError:
    return ArchiveError(explain_denial(root))


@dataclass
class Export:
    """One export run: a folder containing a result.json and/or messages*.html."""

    path: Path  # absolute
    rel: str  # POSIX path relative to the backup root, used to build media URLs
    result_json: Path | None
    html_files: list[Path] = field(default_factory=list)
    exported_at: float | None = None  # unix seconds, best effort

    @property
    def name(self) -> str:
        return self.path.name


@dataclass
class Conversation:
    """One chat: a display name plus every export run found for it."""

    name: str
    slug: str
    path: Path
    exports: list[Export] = field(default_factory=list)


def slugify(name: str, taken: set[str]) -> str:
    """Filesystem- and URL-safe id for a conversation, unique within the run."""
    norm = unicodedata.normalize("NFKD", name)
    ascii_only = norm.encode("ascii", "ignore").decode("ascii")
    base = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_only).strip("-").lower()
    if not base:
        # Non-latin names ascii-fold to nothing; fall back to a stable hash.
        base = "chat-" + format(abs(hash(name)) % 0xFFFFFF, "06x")
    slug = base
    n = 2
    while slug in taken:
        slug = f"{base}-{n}"
        n += 1
    taken.add(slug)
    return slug


def _exported_at(path: Path) -> float | None:
    """When this export was taken, as a unix timestamp.

    Telegram names export folders ``ChatExport_2026-07-26``, which pins the
    date but carries no time of day. That date is a *local* calendar date, so
    it is resolved against local midnight -- building it in UTC would render a
    day early for anyone west of Greenwich.

    mtime supplies the time of day, but only when it agrees with the name's
    date: copying or unzipping a folder rewrites mtime, and a disagreement
    means it can no longer be trusted.
    """
    mtime: float | None = None
    try:
        mtime = path.stat().st_mtime
    except OSError:
        pass

    match = EXPORT_DATE_RE.search(path.name)
    if not match:
        return mtime

    try:
        year, month, day = (int(g) for g in match.groups())
        midnight = datetime(year, month, day)  # naive == local time
    except ValueError:
        return mtime

    if mtime is not None:
        stamped = datetime.fromtimestamp(mtime)
        if (stamped.year, stamped.month, stamped.day) == (year, month, day):
            return mtime

    return midnight.timestamp()


def _scan_export(path: Path, root: Path) -> Export | None:
    """Return an Export if this folder looks like an export run, else None.

    Both probes below reach inside the folder, so both can be refused. A folder
    that cannot be looked into is treated as "not an export" rather than as a
    failure: one unreadable folder must not cost you the rest of the archive.
    """
    result = path / "result.json"
    try:
        htmls = sorted(
            (p for p in path.glob("messages*.html")),
            # messages.html, messages2.html, ... messages10.html sorts naturally.
            key=lambda p: int(re.sub(r"\D", "", p.stem) or 0),
        )
        has_json = result.exists()
    except OSError:
        return None
    if not has_json and not htmls:
        return None
    return Export(
        path=path,
        rel=path.relative_to(root).as_posix(),
        result_json=result if has_json else None,
        html_files=htmls,
        exported_at=_exported_at(path),
    )


def discover(root: Path) -> list[Conversation]:
    """Find every conversation under `root`, newest export last."""
    try:
        root = root.resolve()
        exists = root.is_dir()
    except PermissionError:
        raise _unreadable(root) from None
    if not exists:
        raise ArchiveError(
            f"There is no folder at {root}.\n"
            "If it is on an external drive, check the drive is plugged in and "
            "mounted, then try again."
        )

    conversations: list[Conversation] = []
    taken: set[str] = set()

    try:
        top_level = sorted(root.iterdir(), key=lambda p: p.name.lower())
    except PermissionError:
        raise _unreadable(root) from None

    for entry in top_level:
        if not entry.is_dir() or entry.name.startswith("."):
            continue

        # Case 1: the conversation folder is itself a single export.
        direct = _scan_export(entry, root)
        if direct is not None:
            conv = Conversation(entry.name, slugify(entry.name, taken), entry, [direct])
            conversations.append(conv)
            continue

        # Case 2: the normal layout, one sub-folder per export run.
        exports = []
        try:
            children = sorted(entry.iterdir(), key=lambda p: p.name.lower())
        except (PermissionError, OSError):
            continue   # one unreadable conversation must not stop the rest
        for sub in children:
            if not sub.is_dir() or sub.name.startswith("."):
                continue
            found = _scan_export(sub, root)
            if found is not None:
                exports.append(found)
        if not exports:
            continue
        exports.sort(key=lambda e: (e.exported_at or 0, e.name))
        conversations.append(
            Conversation(entry.name, slugify(entry.name, taken), entry, exports)
        )

    return conversations


def relpath_under(root: Path, target: Path) -> str | None:
    """POSIX path of `target` relative to `root`, or None if it escapes the root.

    Used for every media URL, so it doubles as the guard that the index can only
    ever point at files inside the backup folder.
    """
    try:
        rel = os.path.relpath(target.resolve(), root.resolve()).replace(os.sep, "/")
    except (ValueError, OSError):
        return None
    if rel == ".." or rel.startswith("../"):
        return None
    return rel
