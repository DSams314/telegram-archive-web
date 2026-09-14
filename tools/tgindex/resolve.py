"""Resolve media paths to real files, and fingerprint them for de-duplication.

The indexer never writes to the backup folder; this module only stats and reads.

And it reads as little as it can. Two kinds of file are never opened at all:

  * placeholders -- files a cloud service (Synology Drive, iCloud, Dropbox...)
    keeps "online only". macOS marks them, and opening one downloads the whole
    file. Hashing a folder of them is how one launch pulled ~100 GB off a NAS.
  * anything on a network drive, where every byte read crosses the network.

For those, whether a file exists is still known from its listing, and
duplicates in the sticker and GIF tabs are simply not collapsed.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .imagesize import RECOVERABLE_SUFFIXES, dimensions
from .model import FULL_HASH_LIMIT, HASH_EDGE, MEDIA_DIRS

# macOS's flag for a file whose contents are not on this computer yet.
SF_DATALESS = 0x40000000


def is_placeholder(stat_result) -> bool:
    """Whether opening this file would make a sync service download it."""
    return bool(getattr(stat_result, "st_flags", 0) & SF_DATALESS)


def on_network_drive(root: Path) -> bool:
    """Whether every read of this folder would cross the network."""
    try:
        from tools import volumes
        return volumes.describe(root).get("kind") in ("network", "detached")
    except Exception:  # noqa: BLE001 - a guess is not worth failing over
        return False


class HashCache:
    """Persisted (path, size, mtime) -> digest map.

    Re-indexing a large archive should not re-read it.  The cache lives in the
    program's own data folder, never in the backup folder.
    """

    def __init__(self, path: Path):
        self.path = path
        self._data: dict[str, str] = {}
        self._dirty = False
        self.hits = 0
        self.misses = 0
        if path.exists():
            try:
                self._data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self._data = {}

    @staticmethod
    def _key(rel: str, size: int, mtime_ns: int) -> str:
        return f"{rel}\x00{size}\x00{mtime_ns}"

    def get(self, rel: str, size: int, mtime_ns: int) -> str | None:
        value = self._data.get(self._key(rel, size, mtime_ns))
        if value is not None:
            self.hits += 1
        return value

    def put(self, rel: str, size: int, mtime_ns: int, digest: str) -> None:
        self._data[self._key(rel, size, mtime_ns)] = digest
        self._dirty = True
        self.misses += 1

    def save(self) -> None:
        if not self._dirty:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data), encoding="utf-8")
        tmp.replace(self.path)
        self._dirty = False


def digest_file(path: Path, size: int) -> str:
    """Content fingerprint.

    Small files are hashed in full.  Large ones get size + first 64 KB + last
    64 KB, which is enough to collapse re-downloads of the same file without
    reading gigabytes.  De-duplication only actually matters for stickers and
    GIFs, and those are always small.
    """
    h = hashlib.blake2b(digest_size=16)
    h.update(str(size).encode())
    with path.open("rb") as fh:
        if size <= FULL_HASH_LIMIT:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        else:
            h.update(fh.read(HASH_EDGE))
            fh.seek(-HASH_EDGE, 2)
            h.update(fh.read(HASH_EDGE))
    return h.hexdigest()


class MediaResolver:
    """Turns export-relative media paths into backup-root-relative URLs.

    Resolution order for a message's media:

    1. the path result.json gives, inside the export the message came from;
    2. the same path inside any *other* export of the same conversation, since
       a run with different download settings may hold the file;
    3. the message-id -> path map recovered from an HTML export in the same
       conversation, which is the only way to reuse a hand-pruned HTML folder.

    Anything still unresolved is marked missing, with width/height preserved so
    the viewer can draw a correctly-shaped placeholder.
    """

    def __init__(self, backup_root: Path, cache: HashCache):
        self.root = backup_root.resolve()
        self.cache = cache
        self.stat_cache: dict[str, tuple[int, int] | None] = {}
        self.placeholders: set[str] = set()
        # On a network drive nothing is opened: listings only.
        self.read_contents = not on_network_drive(self.root)
        self.skipped_reads = 0

    def _stat(self, rel: str) -> tuple[int, int] | None:
        """(size, mtime_ns) for a backup-root-relative path, or None."""
        if rel in self.stat_cache:
            return self.stat_cache[rel]
        result: tuple[int, int] | None = None
        candidate = (self.root / rel).resolve()
        # Guard against a path in an export escaping the backup root. Compared
        # as parts, not strings, so a sibling like /Backups-old can't pass.
        if candidate.parts[: len(self.root.parts)] == self.root.parts:
            try:
                st = candidate.stat()
                result = (st.st_size, st.st_mtime_ns)
                if is_placeholder(st):
                    self.placeholders.add(rel)
            except OSError:
                result = None
        self.stat_cache[rel] = result
        return result

    def may_read(self, rel: str) -> bool:
        """Whether opening this file is safe: local, and really on this disk."""
        if not self.read_contents or rel in self.placeholders:
            self.skipped_reads += 1
            return False
        return True

    def exists(self, rel: str) -> bool:
        return self._stat(rel) is not None

    def hash_for(self, rel: str) -> str | None:
        st = self._stat(rel)
        if st is None:
            return None
        size, mtime_ns = st
        cached = self.cache.get(rel, size, mtime_ns)
        if cached:
            return cached
        if not self.may_read(rel):
            return None
        try:
            digest = digest_file(self.root / rel, size)
        except OSError:
            return None
        self.cache.put(rel, size, mtime_ns, digest)
        return digest

    def signature_index(self, export_rels: list[str]) -> dict:
        """Fingerprint every media file in these exports as (size, w, h).

        Built once per conversation and only when something needs recovering,
        because it opens the header of every image in the folder.
        """
        index: dict = {}
        if not self.read_contents:
            return index
        for rel in export_rels:
            for folder in MEDIA_DIRS:
                directory = self.root / rel / folder
                if not directory.is_dir():
                    continue
                for path in sorted(directory.iterdir()):
                    if not path.is_file():
                        continue
                    if path.suffix.lower() not in RECOVERABLE_SUFFIXES:
                        continue
                    try:
                        st = path.stat()
                    except OSError:
                        continue
                    size = st.st_size
                    # Reading the header of a placeholder downloads the file.
                    if is_placeholder(st):
                        self.skipped_reads += 1
                        continue
                    width, height = dimensions(path) or (None, None)
                    key = (size, width, height)
                    # Stored export-relative, the same shape result.json uses,
                    # so a recovered path flows through the normal resolution
                    # chain instead of needing a second code path.
                    index.setdefault(key, []).append(
                        (f"{rel}/{folder}/{path.name}", f"{folder}/{path.name}")
                    )
        return index

    def resolve(
        self,
        media: dict,
        origin_rel: str,
        sibling_rels: list[str],
        html_media: dict[int, dict[str, str]],
        msg_id: int,
    ) -> dict:
        """Rewrite `media` in place; return how each slot was resolved.

        The returned `{"src": via, "thumb": via}` uses "json" when the path in
        result.json worked as-is, "sibling" when another export of the same
        conversation held the file, "html" when only the HTML map knew where it
        was, and None when nothing did.
        """
        media["src"], src_via = self._locate(
            media.get("src"), origin_rel, sibling_rels, html_media, msg_id, "src"
        )
        media["thumb"], thumb_via = self._locate(
            media.get("thumb"), origin_rel, sibling_rels, html_media, msg_id, "thumb"
        )

        if media["src"] is None and media["thumb"] is None:
            media["missing"] = True
        else:
            found = media["src"] or media["thumb"]
            digest = self.hash_for(found)
            if digest:
                media["hash"] = digest
            st = self._stat(found)
            if st and "size" not in media:
                media["size"] = st[0]

        if media["src"] is None:
            media.pop("src")
        if media["thumb"] is None:
            media.pop("thumb")

        return {"src": src_via, "thumb": thumb_via}

    def _locate(
        self,
        path: str | None,
        origin_rel: str,
        sibling_rels: list[str],
        html_media: dict[int, dict[str, str]],
        msg_id: int,
        slot: str,
    ) -> tuple:
        """Try each known home for this file, nearest first. -> (path, via)."""
        candidates: list[tuple] = []

        if path:
            candidates.append((f"{origin_rel}/{path}", "json"))
            candidates.extend(
                (f"{rel}/{path}", "sibling")
                for rel in sibling_rels
                if rel != origin_rel
            )

        # An HTML export in this conversation may know where the bytes are even
        # when the JSON's own path is wrong -- the ` (N)` suffixes Telegram
        # assigns on filename collision are numbered per export run, so the same
        # sticker has a different name in every export.
        recovered = html_media.get(msg_id, {}).get(slot)
        if recovered:
            candidates.append((f"{origin_rel}/{recovered}", "html"))
            candidates.extend(
                (f"{rel}/{recovered}", "html")
                for rel in sibling_rels
                if rel != origin_rel
            )

        for candidate, via in candidates:
            if self.exists(candidate):
                return candidate, via
        return None, None
