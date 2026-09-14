"""CLI entry point:  python3 tools/tgindex  [--root DIR] [--out DIR]

Reads Telegram chat exports and writes the viewer's index. The backup folder is
opened read-only; every file this writes lands under the program's own data
directory.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

from .build import (
    Report,
    build_chat,
    build_search,
    collect_search_text,
    write_manifest,
)
from tools import logbook
from tools.logbook import log
from .discover import ArchiveError, discover
from .resolve import HashCache, MediaResolver

APP_DIR = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = APP_DIR / "data" / "config.json"


def load_config(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def detect_self_id(chats: list[dict]) -> str | None:
    """The one participant present in every conversation is the account owner.

    Falls back to None when it is ambiguous (a single chat, or no overlap), in
    which case first-run setup asks.
    """
    peer_sets = [
        {p["id"] for p in chat["peers"] if p["id"]}
        for chat in chats
        if chat.get("peers")
    ]
    if len(peer_sets) < 2:
        return None
    common = set.intersection(*peer_sets)
    return next(iter(common)) if len(common) == 1 else None


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def _overlaps(out_dir: Path, root: Path) -> str | None:
    """Refuse an index location that would write into the archive.

    Returns the reason to stop, or None when the two are safely separate.
    Compared after resolving, so a symlink pointing back into the backup
    folder is caught as well as a plainly nested path.
    """
    try:
        index_at = out_dir.expanduser().resolve()
        archive_at = root.expanduser().resolve()
    except OSError:
        return None  # unreadable paths fail later, with a better message

    if index_at == archive_at or archive_at in index_at.parents:
        return (
            f"Refusing to run: the index would be written inside your backup "
            f"folder.\n"
            f"  index:  {index_at}\n"
            f"  backup: {archive_at}\n"
            "Your exports are only ever read, so the index has to live "
            "somewhere else. Set it back to the program's own data folder."
        )
    return None


def progress(phase: str, **fields) -> None:
    """Emit a line the server can parse to drive the loading screen.

    Prefixed and flushed so it survives being read line-by-line from a pipe;
    a person watching the terminal just sees one extra tidy line per phase.
    """
    print("@@progress " + json.dumps({"phase": phase, **fields}), flush=True)


def _pid_file(out_dir: Path) -> Path:
    return out_dir.parent / "indexer.pid"


def _is_index_run(pid: int) -> bool:
    """Whether `pid` is a live indexer, rather than any process that reused it."""
    if pid == os.getpid():
        return False
    try:
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    if os.name == "nt":
        return True
    try:
        import subprocess
        command = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                 capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return True
    return "tools.tgindex" in command


def other_index_run(out_dir: Path) -> int | None:
    """The process id of an index run already going, if there is one."""
    try:
        pid = int(_pid_file(out_dir).read_text().strip())
    except (OSError, ValueError):
        return None
    return pid if _is_index_run(pid) else None


def claim_index(out_dir: Path) -> None:
    marker = _pid_file(out_dir)
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        return
    import atexit

    def release() -> None:
        try:
            if marker.read_text().strip() == str(os.getpid()):
                marker.unlink()
        except OSError:
            pass
    atexit.register(release)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tgindex", description=__doc__)
    parser.add_argument("--root", help="Backup folder holding one dir per conversation")
    parser.add_argument("--out", help="Where to write the index")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument(
        "--self-id", help="Your Telegram from_id, e.g. user123456789"
    )
    parser.add_argument(
        "--no-hash",
        action="store_true",
        help="Skip content hashing (faster; disables duplicate collapsing)",
    )
    args = parser.parse_args(argv)

    config_path = Path(args.config)
    config = load_config(config_path)

    root = Path(
        args.root or config.get("backup_root") or (APP_DIR.parent / "Backups")
    ).expanduser()
    out_dir = Path(
        args.out or config.get("index_dir") or (APP_DIR / "data" / "index")
    ).expanduser()

    # The one invariant worth checking every single run: the index must never
    # be written anywhere inside the archive. Every write in this program goes
    # to out_dir, so if out_dir cannot land in the backup folder, nothing can.
    # Checked here rather than only where the value is set, because a
    # hand-edited config.json and a stray --out both bypass that.
    conflict = _overlaps(out_dir, root)
    if conflict:
        log("index.refused", level="error", reason="index inside the archive",
            out=out_dir, root=root)
        print(f"error: {conflict}", file=sys.stderr)
        return 1

    logbook.configure("indexer")

    # One index run at a time. Two at once wrote the same files over each
    # other -- which is what a second launch during a slow first one did.
    running = other_index_run(out_dir)
    if running:
        log("index.refused", level="warn", reason="already running", pid=running)
        print(f"error: another index run (process {running}) is already "
              "writing this index. Wait for it to finish, or close Telegram "
              "Archive and open it again.", file=sys.stderr)
        return 1
    claim_index(out_dir)
    log("index.start", root=root, out=out_dir)

    started = time.time()
    print(f"Backup folder : {root}")
    print(f"Index output  : {out_dir}\n")

    try:
        conversations = discover(root)
    except ArchiveError as problem:
        # Deliberately not a traceback: this is read by whoever is using the
        # program, and every one of these is something they can act on.
        log("index.refused", level="error", reason=problem)
        print(f"error: {problem}", file=sys.stderr)
        return 1
    if not conversations:
        # An empty backup folder is a legitimate state, not a failure: it is
        # what you get the moment you point somewhere new. Carrying on writes
        # an empty manifest and clears out the old chats, which is the whole
        # point -- bailing here used to leave the *previous* folder's index in
        # place, so the app went on showing chats that were no longer there.
        print("No exports found in this folder.")
        print("Expected: <root>/<Conversation>/<ChatExport_*>/result.json\n")

    out_dir.mkdir(parents=True, exist_ok=True)
    cache = HashCache(out_dir / ".hashcache.json")
    resolver = MediaResolver(root, cache)
    if args.no_hash:
        resolver.hash_for = lambda rel: None  # type: ignore[assignment]

    report = Report()
    manifest_chats: list[dict] = []

    progress("discover", done=0, total=len(conversations))
    for position, conv in enumerate(conversations, 1):
        progress("chats", done=position - 1, total=len(conversations),
                 name=conv.name)
        entry = build_chat(conv, root, resolver, out_dir, report)
        if entry is None:
            print(f"  {conv.name}: no messages, skipped")
            continue
        manifest_chats.append(entry)
        print(
            f"  {entry['name']:<28} {entry['messages']:>7} msgs  "
            f"{entry['chunks']:>3} chunks  {len(conv.exports)} export(s)"
        )

    cache.save()

    # Drop index folders for conversations that are no longer in the backup
    # folder, so a removed chat doesn't linger as orphaned files.
    live = {c["slug"] for c in manifest_chats}
    chats_dir = out_dir / "chats"
    if chats_dir.is_dir():
        for stale in chats_dir.iterdir():
            if stale.is_dir() and stale.name not in live:
                shutil.rmtree(stale, ignore_errors=True)
                print(f"  removed stale index for '{stale.name}'")

    manifest_chats.sort(key=lambda c: -(c["last_date"] or 0))
    self_id = args.self_id or config.get("self", {}).get("id") or detect_self_id(
        manifest_chats
    )

    progress("search", done=len(manifest_chats), total=len(manifest_chats))
    print("\nBuilding search index...")
    chat_texts = []
    for index, chat in enumerate(manifest_chats):
        chat_texts.append(
            (index, collect_search_text(out_dir / "chats" / chat["slug"]))
        )
    shard_count = build_search(chat_texts, out_dir)

    write_manifest(out_dir, manifest_chats, self_id)

    index_bytes = sum(p.stat().st_size for p in out_dir.rglob("*.json"))
    elapsed = time.time() - started

    print(f"\n{'─' * 58}")
    print(f"Chats            {report.chats}")
    print(f"Exports read     {report.exports}")
    print(f"Messages         {report.messages:,}")
    print(f"Merged dupes     {report.duplicates_merged:,}")
    print(f"Media            {report.media_total:,}")
    print(
        f"  missing        {report.media_missing:,}"
        + (f"  ({report.media_excluded:,} excluded by export settings)"
           if report.media_excluded else "")
    )
    if report.media_from_sibling_export:
        print(f"  other export   {report.media_from_sibling_export:,}")
    if report.media_recovered_from_html:
        print(f"  from HTML map  {report.media_recovered_from_html:,}")
    if report.media_recovered_by_signature:
        note = ""
        if report.media_recovered_ambiguous:
            note = f" ({report.media_recovered_ambiguous:,} matched by order)"
        print(
            f"  recovered      {report.media_recovered_by_signature:,}{note}"
            "  — listed as not-included, but found by size + dimensions"
        )
    print(f"Search shards    {shard_count}")
    print(f"Index size       {human_size(index_bytes)}")
    print(f"Hash cache       {cache.hits:,} hits / {cache.misses:,} new")
    print(f"Self id          {self_id or 'UNRESOLVED — set during first-run setup'}")
    print(f"Elapsed          {elapsed:.1f}s")

    progress("done", done=1, total=1)
    log("index.finished", chats=report.chats, messages=report.messages,
        media=report.media_total, media_missing=report.media_missing,
        seconds=round(elapsed, 1), index_bytes=index_bytes,
        self_id_resolved=bool(self_id))

    if report.service_actions:
        print("\nService messages seen:")
        for action, count in report.service_actions.most_common():
            print(f"  {action:<28} {count}")
    if report.unknown_media:
        print("\nUnrecognised media (renders as a generic file):")
        for kind, count in report.unknown_media.most_common():
            print(f"  {kind:<28} {count}")
    if report.unhandled_fields:
        print("\nExport fields not yet handled:")
        for field, count in report.unhandled_fields.most_common(20):
            print(f"  {field:<28} {count}")
    for warning in report.warnings:
        print(f"\nwarning: {warning}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
