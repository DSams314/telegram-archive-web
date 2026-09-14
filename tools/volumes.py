#!/usr/bin/env python3
"""Work out what kind of disk a folder lives on.

    python3 -m tools.volumes /path/to/folder

Used for the indicator beside the backup folder, so "the drive isn't plugged
in" reads as a fact about your desk rather than as a fault in the program.

Everything here is read-only and comes from the standard library: the mount
table on Linux, `statfs` on macOS, `GetDriveType` on Windows. No shelling out,
no third-party packages, and nothing is mounted, scanned or enumerated -- the
question asked is only ever "what is *this* path sitting on".
"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

INTERNAL, EXTERNAL, NETWORK = "internal", "external", "network"
DETACHED, UNKNOWN = "detached", "unknown"

# Filesystems that are somebody else's disk, reached over the network.
NETWORK_FS = {
    "nfs", "nfs4", "cifs", "smbfs", "smb", "smb2", "afpfs", "webdav", "ftp",
    "sshfs", "fuse.sshfs", "davfs", "davfs2", "9p", "afs", "ncpfs",
}
# Where removable media conventionally appears.
EXTERNAL_PREFIXES = ("/Volumes/", "/media/", "/mnt/", "/run/media/")

MNT_LOCAL = 0x00001000  # macOS: the filesystem is on locally attached hardware


class _StatfsDarwin(ctypes.Structure):
    """macOS `struct statfs`, 64-bit-inode layout (the only one since 10.6)."""

    _fields_ = [
        ("f_bsize", ctypes.c_uint32), ("f_iosize", ctypes.c_int32),
        ("f_blocks", ctypes.c_uint64), ("f_bfree", ctypes.c_uint64),
        ("f_bavail", ctypes.c_uint64), ("f_files", ctypes.c_uint64),
        ("f_ffree", ctypes.c_uint64), ("f_fsid", ctypes.c_int32 * 2),
        ("f_owner", ctypes.c_uint32), ("f_type", ctypes.c_uint32),
        ("f_flags", ctypes.c_uint32), ("f_fssubtype", ctypes.c_uint32),
        ("f_fstypename", ctypes.c_char * 16),
        ("f_mntonname", ctypes.c_char * 1024),
        ("f_mntfromname", ctypes.c_char * 1024),
        ("f_flags_ext", ctypes.c_uint32), ("f_reserved", ctypes.c_uint32 * 7),
    ]


def _darwin(path: Path) -> tuple[str, str, str] | None:
    """(kind, filesystem, mount point) from statfs, or None if it fails."""
    libc = ctypes.CDLL("libc.dylib", use_errno=True)
    call = getattr(libc, "statfs$INODE64", None) or getattr(libc, "statfs", None)
    if call is None:
        return None
    buf = _StatfsDarwin()
    if call(str(path).encode(), ctypes.byref(buf)) != 0:
        return None

    fstype = buf.f_fstypename.decode(errors="replace")
    mount = buf.f_mntonname.decode(errors="replace")
    if fstype in NETWORK_FS or not (buf.f_flags & MNT_LOCAL):
        return NETWORK, fstype, mount
    # Locally attached but not the boot volume: an external disk or an image.
    if mount != "/" and mount.startswith("/Volumes/"):
        return EXTERNAL, fstype, mount
    return INTERNAL, fstype, mount


def _linux(path: Path) -> tuple[str, str, str] | None:
    """Longest matching entry in the mount table wins, as the kernel does it."""
    try:
        table = Path("/proc/self/mounts").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    resolved = str(path)
    best: tuple[int, str, str] | None = None
    for line in table:
        parts = line.split()
        if len(parts) < 3:
            continue
        mount, fstype = parts[1].replace("\\040", " "), parts[2]
        if resolved == mount or resolved.startswith(mount.rstrip("/") + "/"):
            if best is None or len(mount) > best[0]:
                best = (len(mount), fstype, mount)
    if best is None:
        return None
    _, fstype, mount = best
    if fstype in NETWORK_FS or fstype.startswith("fuse.") and "ssh" in fstype:
        return NETWORK, fstype, mount
    if mount != "/" and mount.startswith(EXTERNAL_PREFIXES):
        return EXTERNAL, fstype, mount
    return INTERNAL, fstype, mount


def _windows(path: Path) -> tuple[str, str, str] | None:
    """GetDriveType on the path's root; UNC paths are network by definition."""
    text = str(path)
    if text.startswith("\\\\"):
        return NETWORK, "unc", text[:text.find("\\", 2)] if "\\" in text[2:] else text
    drive = os.path.splitdrive(text)[0]
    if not drive:
        return None
    kind = ctypes.windll.kernel32.GetDriveTypeW(drive + "\\")  # type: ignore[attr-defined]
    mapping = {2: EXTERNAL, 3: INTERNAL, 4: NETWORK, 5: EXTERNAL, 6: INTERNAL}
    return mapping.get(kind, UNKNOWN), f"drivetype{kind}", drive


def _absent_volume_root(path: Path) -> str | None:
    """The drive this path belongs to, if that drive is not mounted.

    `/Volumes/My Book/backups` names a drive in its second segment. When
    `/Volumes/My Book` itself is gone, the drive is unplugged -- a different
    thing from a folder that was deleted, and the only one worth mentioning.
    """
    text = str(path)
    if os.name == "nt":
        drive = os.path.splitdrive(text)[0]
        if drive and not Path(drive + "\\").is_dir():
            return drive
        return None
    for prefix in EXTERNAL_PREFIXES:
        if not text.startswith(prefix):
            continue
        rest = text[len(prefix):].split("/")
        if not rest or not rest[0]:
            return None
        # /run/media/<user>/<label> and /media/<user>/<label> nest one deeper.
        depth = 2 if prefix in ("/media/", "/run/media/") and len(rest) > 1 else 1
        root = prefix + "/".join(rest[:depth])
        return None if Path(root).is_dir() else root
    return None


def describe(raw: str | os.PathLike | None) -> dict:
    """What kind of disk `raw` is on, and whether it is there right now.

    `connected` is the useful part: a path that simply is not there, on a
    mount point that is also not there, is the shape of an unplugged drive --
    worth saying out loud rather than reporting as a missing folder.
    """
    if not raw:
        return {"kind": UNKNOWN, "connected": False, "path": None,
                "filesystem": None, "mount": None}

    path = Path(raw).expanduser()
    connected = path.is_dir()

    # A path on a drive that is not mounted has to be answered before walking
    # up to an existing ancestor -- /Volumes and /media live on the boot disk,
    # so climbing to them reports an unplugged drive as "on this computer".
    absent = _absent_volume_root(path)
    if absent is not None:
        return {"kind": DETACHED, "connected": False, "path": str(path),
                "filesystem": None, "mount": absent, "volume_missing": True}

    # An absent folder still has an existing ancestor to ask about; that is
    # what distinguishes "drive unplugged" from "folder deleted".
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent

    found = None
    try:
        if sys.platform == "darwin":
            found = _darwin(probe)
        elif sys.platform.startswith("linux"):
            found = _linux(probe)
        elif os.name == "nt":
            found = _windows(probe)
    except (OSError, AttributeError, ValueError):
        found = None

    kind, filesystem, mount = found or (UNKNOWN, None, None)
    return {
        "kind": kind,
        "connected": connected,
        "path": str(path),
        "filesystem": filesystem,
        "mount": mount,
        # True when the drive itself has gone away, rather than just the folder.
        "volume_missing": bool(mount and not connected and not Path(mount).is_dir()),
    }


WHERE = {
    INTERNAL: "On this computer",
    EXTERNAL: "External drive",
    NETWORK: "Network drive",
}


def summary(info: dict) -> str:
    """One line for the indicator, e.g. 'External drive — connected'."""
    kind = info["kind"]
    if kind == DETACHED:
        name = (info["mount"] or "").rstrip("/").rsplit("/", 1)[-1]
        return f"Drive “{name}” is not connected" if name else "Drive not connected"
    if kind == UNKNOWN:
        return "Backup folder not set" if not info["path"] else "Location unknown"
    where = WHERE[kind]
    if info["connected"]:
        return f"{where} — connected"
    # The drive answered, so it is present; it is the folder that is not.
    return f"{where} — folder is missing"


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else str(Path.cwd())
    detail = describe(target)
    print(summary(detail))
    for key, value in detail.items():
        print(f"  {key:16} {value}")
