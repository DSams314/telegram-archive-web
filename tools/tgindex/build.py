"""Merge every export of a conversation into the viewer's chunked index."""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from .discover import Conversation, Export
from .htmlmap import parse_media_map
from .model import (
    CHUNK_SIZE,
    DEDUPE_TABS,
    LIBRARY_TABS,
    MIN_TOKEN_LEN,
    SCHEMA_VERSION,
)
from .normalize import (
    completeness,
    extract_links,
    normalize_message,
    plain_text,
)
from .resolve import MediaResolver

TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

# Telegram's own avatar exports, newest-looking first.
AVATAR_DIRS = ("profile_pictures", "chat_photos")


class Report:
    """Everything worth telling the user after a run."""

    def __init__(self) -> None:
        self.chats = 0
        self.exports = 0
        self.messages = 0
        self.duplicates_merged = 0
        self.media_total = 0
        self.media_missing = 0
        self.media_excluded = 0
        self.media_recovered_from_html = 0
        self.media_from_sibling_export = 0
        self.media_recovered_by_signature = 0
        self.media_recovered_ambiguous = 0
        self.unhandled_fields: Counter = Counter()
        self.service_actions: Counter = Counter()
        self.unknown_media: Counter = Counter()
        self.warnings: list[str] = []


def tokenize(text: str) -> set:
    return {
        t.lower() for t in TOKEN_RE.findall(text) if len(t) >= MIN_TOKEN_LEN
    }


def _load_export(export: Export, report: Report) -> tuple[dict, list[dict]]:
    """Read one export's result.json -> (chat header, normalized messages)."""
    if export.result_json is None:
        return {}, []
    try:
        with export.result_json.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        report.warnings.append(f"{export.rel}: unreadable result.json ({exc})")
        return {}, []

    header = {k: v for k, v in data.items() if k != "messages"}
    raw = data.get("messages")
    if not isinstance(raw, list):
        report.warnings.append(f"{export.rel}: result.json has no message list")
        return header, []

    unhandled: dict = {}
    messages = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        norm = normalize_message(item, unhandled)
        if norm is None:
            continue
        norm["_export"] = export.rel
        messages.append(norm)
        if "service" in norm:
            report.service_actions[norm["service"]] += 1
        media = norm.get("media")
        if media and media["kind"] == "unknown":
            report.unknown_media[item.get("media_type") or item.get("mime_type") or "?"] += 1

    report.unhandled_fields.update(unhandled)
    return header, messages


def _has_signature(media: dict) -> bool:
    """Whether this media carries enough to be matched by fingerprint."""
    return bool(media.get("size")) and bool(media.get("w")) and bool(media.get("h"))


def _recover_by_signature(
    excluded: list, signatures: dict, claimed: set, report: Report
) -> int:
    """Match media the export skipped against files actually present.

    Unambiguous matches are taken first. Whatever is left is assigned in order
    -- messages are in date order and Telegram numbers its files in the order
    it wrote them, so a run of photos sent in the same second still lines up.
    """
    ambiguous: list = []
    found = 0

    def take(msg, full, relative):
        media = msg["media"]
        # Export-relative, so resolve() prefixes it like any other path and
        # still finds it if the file lives in a sibling export.
        media["src"] = relative
        media.pop("excluded", None)
        claimed.add(full)

    for msg in excluded:
        media = msg["media"]
        key = (media["size"], media["w"], media["h"])
        options = [c for c in signatures.get(key, []) if c[0] not in claimed]
        if len(options) == 1:
            take(msg, *options[0])
            found += 1
        elif options:
            ambiguous.append((msg, key))

    for msg, key in ambiguous:
        options = [c for c in signatures.get(key, []) if c[0] not in claimed]
        if not options:
            continue
        take(msg, *options[0])
        msg["media"]["recovered_ambiguous"] = True
        found += 1
        report.media_recovered_ambiguous += 1

    report.media_recovered_by_signature += found
    return found


def _find_avatar(conv: Conversation, root: Path) -> str | None:
    """Best-effort chat avatar from the export's own profile picture folder."""
    # discover() hands back real, resolved paths, so compare against the same.
    # A backup folder reached through a symlink -- and on macOS /var is itself
    # one -- otherwise made relative_to() fail, and any chat with a profile
    # picture took the whole index run down with it.
    base = root.resolve()
    for export in reversed(conv.exports):
        for folder in AVATAR_DIRS:
            directory = export.path / folder
            if not directory.is_dir():
                continue
            images = sorted(
                (
                    p
                    for p in directory.iterdir()
                    if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
                ),
                key=lambda p: p.name,
            )
            if images:
                return images[-1].relative_to(base).as_posix()
    return None


def build_chat(
    conv: Conversation,
    root: Path,
    resolver: MediaResolver,
    out_dir: Path,
    report: Report,
) -> dict | None:
    """Index one conversation. Returns its manifest entry, or None if empty."""
    header: dict = {}
    by_id: dict[int, dict] = {}
    duplicates = 0

    for export in conv.exports:
        export_header, messages = _load_export(export, report)
        # The newest export wins for the chat's display name and type.
        header.update({k: v for k, v in export_header.items() if v is not None})
        report.exports += 1

        for msg in messages:
            existing = by_id.get(msg["id"])
            if existing is None:
                by_id[msg["id"]] = msg
                continue
            duplicates += 1
            # Prefer whichever copy carries more; ties go to the newer export
            # because `conv.exports` is in chronological order.
            if completeness(msg) >= completeness(existing):
                by_id[msg["id"]] = msg

    if not by_id:
        return None

    report.duplicates_merged += duplicates

    # A hand-pruned HTML export is often the only place the media still lives,
    # so its id -> path map is merged across every export of this conversation.
    html_media: dict[int, dict] = {}
    for export in conv.exports:
        if export.html_files:
            for msg_id, entry in parse_media_map(export.html_files).items():
                html_media.setdefault(msg_id, entry)

    export_rels = [e.rel for e in conv.exports]
    messages = sorted(by_id.values(), key=lambda m: (m["date"], m["id"]))

    # Some exports write "(File not included...)" for media that is, in fact,
    # sitting in the folder -- a partial or interrupted export run. The file
    # size and pixel dimensions are still recorded, and together they are a
    # strong enough fingerprint to match a message to its file without any
    # filename at all.
    excluded = [
        m for m in messages
        if (m.get("media") or {}).get("excluded") and _has_signature(m["media"])
    ]
    signatures = resolver.signature_index(export_rels) if excluded else {}
    claimed: set = set()
    recovered = _recover_by_signature(excluded, signatures, claimed, report)

    peers: dict = defaultdict(lambda: {"messages": 0, "name": None})
    catalogs: dict = {tab: [] for tab in LIBRARY_TABS}
    seen_hashes: dict = {tab: set() for tab in DEDUPE_TABS}
    kind_counts: Counter = Counter()

    for index, msg in enumerate(messages):
        origin = msg.pop("_export")

        sender = msg.get("from")
        if sender:
            peer = peers[sender]
            peer["messages"] += 1
            if msg.get("from_name"):
                peer["name"] = msg["from_name"]

        media = msg.get("media")
        if media:
            via = resolver.resolve(media, origin, export_rels, html_media, msg["id"])
            report.media_total += 1
            kind_counts[media["kind"]] += 1

            if media.get("missing"):
                report.media_missing += 1
                if media.get("excluded"):
                    report.media_excluded += 1
            elif via["src"] == "html":
                report.media_recovered_from_html += 1
            elif via["src"] == "sibling":
                report.media_from_sibling_export += 1

            for tab, kinds in LIBRARY_TABS.items():
                if media["kind"] not in kinds:
                    continue
                if media.get("missing"):
                    break
                digest = media.get("hash")
                if tab in seen_hashes:
                    if digest and digest in seen_hashes[tab]:
                        break
                    if digest:
                        seen_hashes[tab].add(digest)
                entry = {
                    "id": msg["id"],
                    "date": msg["date"],
                    "kind": media["kind"],
                    "src": media.get("src"),
                }
                for key in ("thumb", "w", "h", "duration", "name", "size", "emoji"):
                    if key in media:
                        entry[key] = media[key]
                catalogs[tab].append(entry)
                break

        for url in extract_links(msg.get("text") or []):
            catalogs["links"].append(
                {"id": msg["id"], "date": msg["date"], "url": url}
            )

    # Denormalise a small preview of each reply's target into the replying
    # message. A reply very often points at a message in a different chunk, and
    # without this the viewer would have to fetch that chunk just to draw a
    # one-line quote -- for every reply on screen. ~60 bytes each buys the
    # scroller the property that a chunk is renderable entirely on its own.
    by_id_final = {m["id"]: m for m in messages}
    for msg in messages:
        target = by_id_final.get(msg.get("reply_to"))
        if target is None:
            continue
        preview: dict = {}
        if target.get("from_name"):
            preview["from_name"] = target["from_name"]
        # `from` drives the quote's colour in a group, where every participant
        # has their own.
        if target.get("from"):
            preview["from"] = target["from"]
        excerpt = plain_text(target.get("text") or []).strip()
        if excerpt:
            preview["text"] = excerpt[:120]
        elif target.get("media"):
            preview["kind"] = target["media"]["kind"]
        msg["reply_preview"] = preview

    # Chunk in date order. The viewer resolves both jump-to-date and
    # jump-to-message by binary searching these ranges.
    chat_dir = out_dir / "chats" / conv.slug
    chat_dir.mkdir(parents=True, exist_ok=True)
    for stale in chat_dir.glob("chunk-*.json"):
        stale.unlink()

    chunks_meta = []
    for n, start in enumerate(range(0, len(messages), CHUNK_SIZE)):
        block = messages[start : start + CHUNK_SIZE]
        _write_json(chat_dir / f"chunk-{n:04d}.json", block)
        chunks_meta.append(
            {
                "n": n,
                "count": len(block),
                "first_id": block[0]["id"],
                "last_id": block[-1]["id"],
                "first_date": block[0]["date"],
                "last_date": block[-1]["date"],
                # The tail sender lets the next chunk decide whether its first
                # message continues a run or starts one, without loading it.
                "last_from": block[-1].get("from"),
                "media": sum(1 for m in block if m.get("media")),
            }
        )

    peer_list = [
        {"id": pid, "name": info["name"] or pid, "messages": info["messages"]}
        for pid, info in sorted(
            peers.items(), key=lambda kv: -kv[1]["messages"]
        )
    ]

    _write_json(
        chat_dir / "meta.json",
        {
            "slug": conv.slug,
            "name": header.get("name") or conv.name,
            "chunks": chunks_meta,
            "peers": peer_list,
            "exports": [
                {
                    "rel": e.rel,
                    "name": e.name,
                    "exported_at": e.exported_at,
                    "has_json": e.result_json is not None,
                    "html_pages": len(e.html_files),
                }
                for e in conv.exports
            ],
        },
    )
    # Newest first, matching the app: the library is for finding what someone
    # sent recently far more often than what they sent years ago. Built in
    # message order above, so each catalogue is simply reversed here.
    for entries in catalogs.values():
        entries.reverse()
    _write_json(chat_dir / "media.json", catalogs)

    report.chats += 1
    report.messages += len(messages)

    last_export = max(
        (e.exported_at for e in conv.exports if e.exported_at), default=None
    )
    return {
        "slug": conv.slug,
        "name": header.get("name") or conv.name,
        "folder": conv.name,
        "type": header.get("type") or "personal_chat",
        "tg_id": header.get("id"),
        "messages": len(messages),
        "first_date": messages[0]["date"],
        "last_date": messages[-1]["date"],
        "backed_up_at": last_export,
        "avatar": _find_avatar(conv, root),
        "exports": len(conv.exports),
        "chunks": len(chunks_meta),
        "peers": peer_list,
        "media_counts": dict(kind_counts),
        "library_counts": {tab: len(items) for tab, items in catalogs.items()},
    }


def build_search(
    chat_texts: list[tuple[int, list[tuple[int, int, str]]]], out_dir: Path
) -> int:
    """Write a sharded inverted index.

    Postings are a flat int array with stride 3 -- chat index, message id, and
    the day number (unix days). Flat beats nested arrays for size, and carrying
    the day means results sort newest-first without opening a single chunk;
    only the page actually being displayed gets fetched for its text.

    Whole words only, case-folded -- the same model Telegram search uses. The
    viewer narrows further with a substring check once it has the messages.
    Sharded by the token's first two characters so a query fetches kilobytes
    instead of the whole index.
    """
    shards: dict = defaultdict(lambda: defaultdict(list))
    for chat_index, entries in chat_texts:
        for msg_id, date, text in entries:
            day = date // 86400
            for token in tokenize(text):
                key = token[:2]
                shards[key][token].extend((chat_index, msg_id, day))

    search_dir = out_dir / "search"
    search_dir.mkdir(parents=True, exist_ok=True)
    for stale in search_dir.glob("*.json"):
        stale.unlink()

    for key, tokens in shards.items():
        # Hex-encode so shard names are filesystem-safe for any script.
        name = key.encode("utf-8").hex()
        _write_json(search_dir / f"{name}.json", tokens)

    _write_json(search_dir / "shards.json", sorted(
        key.encode("utf-8").hex() for key in shards
    ))
    return len(shards)


def collect_search_text(chat_dir: Path) -> list[tuple[int, int, str]]:
    """Re-read a chat's chunks to gather searchable text: (id, date, text)."""
    out = []
    for chunk in sorted(chat_dir.glob("chunk-*.json")):
        for msg in json.loads(chunk.read_text(encoding="utf-8")):
            text = plain_text(msg.get("text") or [])
            name = (msg.get("media") or {}).get("name") or ""
            blob = f"{text} {name}".strip()
            if blob:
                out.append((msg["id"], msg["date"], blob))
    return out


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))


def write_manifest(out_dir: Path, chats: list[dict], self_id: str | None) -> None:
    import time

    _write_json(
        out_dir / "manifest.json",
        {
            "schema": SCHEMA_VERSION,
            "generated": int(time.time()),
            "self_id": self_id,
            "chats": chats,
        },
    )
