#!/usr/bin/env python3
"""Local, offline file server for the Telegram archive viewer.

Two mount points:

    /          this program's own folder (the viewer + its index)
    /media/    the backup folder, READ-ONLY

Nothing leaves the machine: the socket binds to loopback only.

**Your exports are never written to.** Files are only ever read from /media/.
A deliberately small write surface exists under /api/ so the app can save its
own settings -- first-run setup has to persist somewhere the browser cannot
reach by itself:

    GET  /api/config     current config
    GET  /api/browse     list sub-folders (directories only, for the picker)
    GET  /api/ping       identifies this server to a second launch
    GET  /api/status     indexing progress, for the loading screen
    GET  /api/session    one open connection per window; closing it is the
                         signal that the window has gone
    POST /api/pickfolder open the system's folder chooser, return the choice
    POST /api/config     merge known keys into data/config.json
    POST /api/avatar     store data/avatars/<slug>.<ext>
    POST /api/wallpaper  store data/wallpapers/background.<ext>
    POST /api/reindex    run the indexer and return its report
    POST /api/shutdown   stop the server
    POST /api/log        events from the page, into the same log file
    POST /api/diagnostics write a redacted copy of the log, for sending on
    POST /api/index/cancel stop an index run in progress

Every one of those touches data/ and nothing else.

    python3 serve.py [--port 8730] [--root PATH] [--no-browser]
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import posixpath
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "data" / "config.json"
DEFAULT_PORT = 8730

sys.path.insert(0, str(APP_DIR))
from tools import logbook, nativepicker, volumes  # noqa: E402
from tools.logbook import log  # noqa: E402
from tools.tgindex.discover import (  # noqa: E402
    explain_denial, protected_location,
)


def volume_info(raw) -> dict:
    """Drive facts for the settings indicator, never fatal if unavailable."""
    try:
        detail = volumes.describe(raw)
        detail["summary"] = volumes.summary(detail)
        return detail
    except Exception:  # noqa: BLE001 - an indicator must not break the app
        return {"kind": "unknown", "connected": False, "summary": ""}

# Types Python's mimetypes database gets wrong or doesn't know, all of which the
# viewer depends on. .tgs is a gzipped Lottie animation the viewer inflates
# itself, so it must arrive as opaque bytes and must not be re-encoded.
EXTRA_TYPES = {
    ".tgs": "application/gzip",
    ".webp": "image/webp",
    ".webm": "video/webm",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp4": "video/mp4",
    ".m4a": "audio/mp4",
    ".json": "application/json",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
}

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")

# config.json is read-modify-written by several endpoints. Without this, two
# overlapping saves each load the old file and the later one silently drops
# the earlier one's change -- which is how `setup_complete` went missing.
CONFIG_LOCK = threading.RLock()


class ArchiveHandler(SimpleHTTPRequestHandler):
    """Serves two roots, supports Range requests, refuses everything else."""

    app_dir: Path
    media_root: Path | None

    # Keep-alive matters here: a single screenful of a media-heavy chat is
    # dozens of requests, and HTTP/1.0 would tear down the connection each time.
    protocol_version = "HTTP/1.1"

    # -- routing -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        route = urllib.parse.urlsplit(self.path).path
        if route == "/api/config":
            config = load_config()
            root = _resolve_root(config.get("backup_root"))
            raw_root = config.get("backup_root")
            self._json(HTTPStatus.OK, {
                "config": config,
                "resolved_root": str(root) if root else None,
                "root_exists": bool(root),
                "root_readable": _root_readable(root),
                "platform": sys.platform,
                # What the folder is sitting on, for the indicator: an
                # unplugged drive should not read as a broken setting.
                "volume": volume_info(raw_root),
                "native_picker": nativepicker.available(),
            })
            return
        if route == "/app/mode.js":
            # The same page code runs as the website and as this app. The file
            # on disk says 'web'; answered here, it says 'server'.
            body = b"export const MODE = 'server';\n"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/api/ping":
            # Deliberately tiny and unauthenticated: it exposes nothing beyond
            # the fact that this program is running here, which a second copy
            # of the program needs to know before it starts a rival server.
            self._json(HTTPStatus.OK, {
                "app": "telegram-archive",
                "app_dir": str(APP_DIR),
                "pid": os.getpid(),
            })
            return
        if route == "/api/status":
            self._json(HTTPStatus.OK, Indexing.snapshot())
            return
        if route == "/api/session":
            self._session_stream()
            return
        if route == "/api/browse":
            try:
                self._browse()
            except Exception as exc:  # noqa: BLE001
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        super().do_GET()

    def _session_stream(self) -> None:
        """Hold one connection open for as long as this window is open.

        Doubles as the progress channel: the loading screen reads indexing
        state from the same stream rather than polling for it.
        """
        token = object()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
        except OSError:
            return

        Watchdog.opened(token)
        last = None
        try:
            while True:
                state = Indexing.snapshot()
                if state != last:
                    payload = json.dumps(state)
                    self.wfile.write(f"event: status\ndata: {payload}\n\n"
                                     .encode("utf-8"))
                    self.wfile.flush()
                    last = state
                else:
                    # A comment keeps the socket honest: writing is what
                    # reveals that the other end has gone.
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                time.sleep(1.0)
        except (OSError, ValueError):
            pass  # the window closed; that is the whole point
        finally:
            Watchdog.closed(token)

    def _browse(self) -> None:
        """List sub-folders of a path, so setup can offer a folder picker.

        Read-only and directories-only: it never reveals file contents, and it
        is what lets the wizard confirm a path exists before saving it.
        """
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        raw = (query.get("path") or [str(Path.home())])[0]
        target = Path(raw).expanduser()
        if not target.is_absolute():
            # Config stores the root relative to the program folder (the
            # shipped default is "../Backups"), so resolve it that way first
            # and only fall back to home for a bare name typed by hand.
            from_app = (APP_DIR / raw).resolve()
            target = from_app if from_app.is_dir() else Path.home() / raw
        try:
            target = target.resolve()
        except OSError:
            raise ValueError("unreadable path")
        if not target.is_dir():
            raise ValueError("not a folder")

        entries = []
        try:
            for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
                if child.name.startswith(".") or not child.is_dir():
                    continue
                # Flag folders that already hold exports so the picker can show
                # which candidate is the right one. Exports sit up to three
                # levels down: <root>/<conversation>/<ChatExport_*>/result.json.
                looks_like_export = _holds_export(child, depth=3)
                entries.append({"name": child.name, "path": str(child),
                                "export": looks_like_export})
        except PermissionError:
            log("browse.denied", level="warn", path=target)
            raise ValueError(_denied_message(target))

        self._json(HTTPStatus.OK, {
            "path": str(target),
            "parent": str(target.parent) if target.parent != target else None,
            "entries": entries[:400],
            "places": _places(),
            "volume": volume_info(str(target)),
        })

    def translate_path(self, path: str) -> str:
        """Map a URL onto a real file, refusing anything outside the two roots."""
        clean = urllib.parse.urlsplit(path).path
        clean = urllib.parse.unquote(clean, errors="replace")
        clean = posixpath.normpath(clean)

        if clean == "/media" or clean.startswith("/media/"):
            if self.media_root is None:
                return ""
            base = self.media_root
            relative = clean[len("/media") :].lstrip("/")
        else:
            base = self.app_dir
            relative = clean.lstrip("/")
            if not relative:
                relative = "index.html"

        # Build the path segment by segment so no component can escape the root.
        target = base
        for part in relative.split("/"):
            if not part or part == ".":
                continue
            if part == ".." or os.sep in part or (os.altsep and os.altsep in part):
                return ""
            target = target / part

        try:
            resolved = target.resolve()
        except OSError:
            return ""
        if resolved.parts[: len(base.parts)] != base.parts:
            return ""
        return str(resolved)

    def guess_type(self, path):  # noqa: A003 - name fixed by the base class
        suffix = Path(path).suffix.lower()
        if suffix in EXTRA_TYPES:
            return EXTRA_TYPES[suffix]
        return super().guess_type(path)

    # -- the small write surface -------------------------------------------

    # The backup folder stays strictly read-only. These endpoints write only
    # inside the program's own data/ directory -- the config the server itself
    # needs, and the avatars the user uploads -- because first-run setup has to
    # persist somewhere the browser can't reach on its own.

    def _same_origin(self) -> bool:
        """Reject writes initiated by another site.

        /api/shutdown and /api/reindex take no request body, which makes them
        "simple requests": a browser will send them cross-site with no CORS
        preflight to block it. So any page the user happened to be visiting
        could stop the server or kick off a re-index. It could never read the
        reply, but the side effect still lands.

        A browser always attaches Origin to a cross-site POST, so an Origin
        that is present and foreign is the signal. A missing Origin means a
        non-browser client (curl, a script) and is allowed through.
        """
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("Host") or ""
        try:
            parsed = urllib.parse.urlsplit(origin)
        except ValueError:
            return False
        return parsed.netloc == host

    def do_POST(self) -> None:  # noqa: N802
        if not self._same_origin():
            self.send_error(HTTPStatus.FORBIDDEN,
                            "Cross-origin requests are not accepted")
            return
        route = urllib.parse.urlsplit(self.path).path
        handlers = {
            "/api/config": self._write_config,
            "/api/avatar": self._write_avatar,
            "/api/wallpaper": self._write_wallpaper,
            "/api/reindex": self._reindex,
            "/api/shutdown": self._shutdown,
            "/api/pickfolder": self._pick_folder,
            "/api/index/cancel": self._cancel_index,
            "/api/log": self._write_log,
            "/api/diagnostics": self._diagnostics,
        }
        handler = handlers.get(route)
        if handler is None:
            self.send_error(HTTPStatus.NOT_FOUND, "No such endpoint")
            return
        try:
            handler()
        except ValueError as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI verbatim
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})

    do_PUT = do_DELETE = do_PATCH = do_POST  # noqa: N815

    def _body(self, limit: int = 8 * 1024 * 1024) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ValueError("payload too large")
        return self.rfile.read(length)

    def _json(self, status: HTTPStatus, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _write_config(self) -> None:
        """Merge a few known keys into data/config.json."""
        incoming = json.loads(self._body(256 * 1024) or b"{}")
        if not isinstance(incoming, dict):
            raise ValueError("expected a JSON object")

        with CONFIG_LOCK:
            self._merge_config(incoming)

    def _merge_config(self, incoming: dict) -> None:
        config = load_config()
        if "backup_root" in incoming:
            # Checked here rather than trusted, so a folder that cannot be read
            # is refused while the person is still looking at the picker --
            # instead of being stored and failing at the next rebuild.
            config["backup_root"] = _validated_root(incoming["backup_root"])
        if "index_dir" in incoming:
            # The index is the only thing this program writes a lot of, so
            # where it goes is the one setting that could put writes near
            # someone's archive. It stays inside the program folder.
            config["index_dir"] = _validated_index_dir(incoming["index_dir"])
        if "setup_complete" in incoming:
            config["setup_complete"] = bool(incoming["setup_complete"])
        if isinstance(incoming.get("settings"), dict):
            # Merged rather than replaced: two windows with different panels
            # open should not undo each other's changes.
            merged = dict(config.get("settings") or {})
            merged.update(incoming["settings"])
            config["settings"] = merged
        if isinstance(incoming.get("self"), dict):
            current = config.get("self") or {}
            for key in ("id", "name", "username", "avatar"):
                if key in incoming["self"]:
                    current[key] = incoming["self"][key]
            config["self"] = current

        config.pop("config_recovered", None)
        config.pop("recovered_from", None)
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(config, indent=2), encoding="utf-8")
        tmp.replace(CONFIG_PATH)
        log("config.saved", keys=sorted(incoming.keys()))

        # Picking a new backup folder must re-point what /media/ serves, or the
        # very next image request would still resolve against the old root.
        root = _resolve_root(config.get("backup_root"))
        ArchiveHandler.media_root = root
        caution = protected_location(root) if root else None
        self._json(HTTPStatus.OK, {
            "ok": True,
            "config": config,
            "media_root": str(root) if root else None,
            "caution": {"severity": caution[0], "message": caution[1]}
            if caution else None,
        })

    def _write_avatar(self) -> None:
        """Store an uploaded picture as data/avatars/<slug>.<ext>."""
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        slug = (query.get("slug") or [""])[0]
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", slug):
            raise ValueError("bad slug")

        data = self._body()
        kind = (self.headers.get("Content-Type") or "").split(";")[0]
        extension = {"image/jpeg": ".jpg", "image/png": ".png",
                     "image/webp": ".webp"}.get(kind)
        if extension is None:
            raise ValueError(f"unsupported image type: {kind or 'unknown'}")

        folder = APP_DIR / "data" / "avatars"
        folder.mkdir(parents=True, exist_ok=True)
        # One picture per slug: drop any earlier format first.
        for old in folder.glob(f"{slug}.*"):
            old.unlink()
        (folder / f"{slug}{extension}").write_bytes(data)
        self._json(HTTPStatus.OK,
                   {"ok": True, "url": f"data/avatars/{slug}{extension}"})

    def _pick_folder(self) -> None:
        """Put up the system's own folder chooser and report what was picked.

        The page cannot do this itself -- a browser will hand back a file's
        contents but never its location -- so the local server, which is a
        normal desktop process, opens the real dialog on its behalf.
        """
        body = json.loads(self._body(4096) or b"{}")
        try:
            picked = nativepicker.choose(body.get("start"))
        except nativepicker.Cancelled:
            self._json(HTTPStatus.OK, {"ok": False, "cancelled": True})
            return
        except (RuntimeError, OSError, subprocess.SubprocessError) as problem:
            # Not fatal: the app falls back to its own browser.
            self._json(HTTPStatus.OK, {"ok": False, "error": str(problem)})
            return
        self._json(HTTPStatus.OK, {"ok": True, "path": picked})

    def _diagnostics(self) -> None:
        """Write the redacted log bundle and say where it went.

        Also reveals it in the file manager: the point of this file is to be
        sent to someone, and asking a person to go and find a path is a step
        where the whole thing tends to stop.
        """
        from tools import diagnostics
        target = diagnostics.write()
        log("diagnostics.written", path=target)
        _reveal_in_file_manager(target)
        self._json(HTTPStatus.OK, {"ok": True, "path": str(target),
                                   "raw_log": str(logbook.LOG_FILE)})

    def _cancel_index(self) -> None:
        """The loading screen's Cancel button."""
        self._json(HTTPStatus.OK, {"ok": True, "stopped": Indexing.cancel()})

    def _write_log(self) -> None:
        """Accept events from the page, so one file covers the whole program.

        Without this the browser half of a failure is invisible: a JavaScript
        error that blanks the window leaves no trace on disk at all.
        """
        body = json.loads(self._body(256 * 1024) or b"{}")
        entries = body.get("entries") or []
        if not isinstance(entries, list):
            raise ValueError("expected a list of entries")
        for entry in entries[:200]:
            if not isinstance(entry, dict):
                continue
            event = str(entry.get("event") or "app.event")[:120]
            level = entry.get("level") if entry.get("level") in (
                "info", "warn", "error") else "info"
            fields = {k: v for k, v in entry.items()
                      if k not in ("event", "level")}
            logbook.configure("app")
            log(event, level=level, **fields)
        logbook.configure("server")
        self._json(HTTPStatus.OK, {"ok": True})

    def _heartbeat(self) -> None:
        """The open page saying it is still there.

        Watched rather than trusted-on-close: `beforeunload` and `pagehide`
        are unreliable, and a beacon on unload cannot tell a closed tab from a
        reload — which would stop the server every time the page refreshed.
        Silence for a while is the only signal that means the window is
        actually gone.
        """
        body = json.loads(self._body(1024) or b"{}")
        Watchdog.beat(bool(body.get("watch")))
        self._json(HTTPStatus.OK, {"ok": True, "watching": Watchdog.watching})

    def _write_wallpaper(self) -> None:
        """Store the chat background as a file under data/wallpapers/.

        It used to live in localStorage as a data: URL, which meant clearing
        browser data lost it and it never travelled with the rest of the
        settings. data/ survives updates, so keeping it here makes the
        background as durable as the profile pictures beside it.
        """
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        folder = APP_DIR / "data" / "wallpapers"

        if (query.get("clear") or [""])[0] == "1":
            for old in folder.glob("background.*"):
                old.unlink()
            self._json(HTTPStatus.OK, {"ok": True, "url": None})
            return

        data = self._body(24 * 1024 * 1024)
        kind = (self.headers.get("Content-Type") or "").split(";")[0]
        extension = {"image/jpeg": ".jpg", "image/png": ".png",
                     "image/webp": ".webp"}.get(kind)
        if extension is None:
            raise ValueError(f"unsupported image type: {kind or 'unknown'}")

        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob("background.*"):
            old.unlink()
        (folder / f"background{extension}").write_bytes(data)
        # Cache-busted: the filename is stable, so the browser would otherwise
        # keep showing the previous picture.
        stamp = int(time.time())
        self._json(HTTPStatus.OK,
                   {"ok": True, "url": f"data/wallpapers/background{extension}?v={stamp}"})

    def _shutdown(self) -> None:
        """Stop the server at the user's request.

        The reply is sent before the socket goes down, and the actual shutdown
        happens on another thread because calling it from inside a handler
        would deadlock on the request that asked for it.
        """
        log("server.shutdown_requested", reason="power button")
        self._json(HTTPStatus.OK, {"ok": True})
        self.wfile.flush()
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def _reindex(self) -> None:
        """Start an index run and report how it went.

        Shares the background runner with startup, so Settings cannot kick off
        a second indexer while the first is still writing the same files.
        """
        started = Indexing.start("settings")
        if not started and Indexing.busy():
            self._json(HTTPStatus.OK,
                       {"ok": False, "busy": True,
                        "error": "An index run is already in progress."})
            return
        # Wait for it here so the button keeps its existing behaviour.
        while Indexing.busy():
            time.sleep(0.2)
        state = Indexing.snapshot()
        self._json(HTTPStatus.OK, {
            "ok": bool(state.get("ok")),
            "error": state.get("error"),
            "output": "",
        })

    def list_directory(self, path):
        # No directory listings: the viewer asks for known paths only, and an
        # index of someone's whole archive is not something to hand out.
        self.send_error(HTTPStatus.FORBIDDEN, "Directory listing disabled")
        return None

    # -- range support -----------------------------------------------------

    def send_head(self):
        """As the base class, but honours Range so video/audio can seek.

        SimpleHTTPRequestHandler always sends 200 with the whole body, which
        makes scrubbing a long video re-download it from the start.
        """
        path = self.translate_path(self.path)
        if not path:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return None

        target = Path(path)
        if target.is_dir():
            return super().send_head()
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return None

        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        match = RANGE_RE.fullmatch(range_header.strip())
        if not match:
            return super().send_head()

        size = target.stat().st_size
        start_raw, end_raw = match.groups()
        if start_raw:
            start = int(start_raw)
            end = int(end_raw) if end_raw else size - 1
        elif end_raw:
            # `bytes=-500`: the trailing 500 bytes.
            start = max(0, size - int(end_raw))
            end = size - 1
        else:
            return super().send_head()

        if start >= size:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        end = min(end, size - 1)
        handle = target.open("rb")
        handle.seek(start)

        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()  # adds Accept-Ranges for every response
        return _RangeReader(handle, end - start + 1)

    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        # The index changes whenever it is rebuilt; media never changes.
        if self.path.startswith("/media/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)


class _RangeReader:
    """File wrapper that stops after `remaining` bytes, for copyfile()."""

    def __init__(self, handle, remaining: int):
        self._handle = handle
        self._remaining = remaining

    def read(self, amount: int = -1) -> bytes:
        if self._remaining <= 0:
            return b""
        if amount is None or amount < 0:
            amount = self._remaining
        data = self._handle.read(min(amount, self._remaining))
        self._remaining -= len(data)
        return data

    def close(self) -> None:
        self._handle.close()


EXPORT_MARKERS = ("result.json", "messages.html")


def _holds_export(folder: Path, depth: int) -> bool:
    """Whether an export lives at or below `folder`, searching `depth` levels.

    Bounded on purpose: this runs for every entry the folder picker shows, and
    an unbounded walk of a home directory would stall the browser.
    """
    if depth <= 0:
        return False
    try:
        children = list(folder.iterdir())[:60]
    except (OSError, PermissionError):
        return False
    if any((folder / name).exists() for name in EXPORT_MARKERS):
        return True
    return any(
        child.is_dir() and not child.name.startswith(".")
        and _holds_export(child, depth - 1)
        for child in children
    )


class Indexing:
    """Runs the indexer in the background and keeps its progress readable.

    The window now opens before indexing finishes, so the page needs to be
    able to ask how far along it is. A big archive used to mean minutes of a
    bouncing dock icon and no window at all -- indistinguishable from a hang,
    and the natural reaction was to launch the program a second time.
    """

    _lock = threading.Lock()
    _state: dict = {"running": False, "phase": "idle", "done": 0, "total": 0,
                    "name": None, "ok": None, "error": None, "finished_at": 0}
    _process = None
    _cancelled = False

    @classmethod
    def cancel(cls) -> bool:
        """Stop the index run in progress, if there is one. True if stopped.

        Whatever it had written is simply rebuilt next time: the indexer writes
        its manifest last, so an interrupted run never looks complete.
        """
        process = cls._process
        if process is None or process.poll() is not None:
            return False
        cls._cancelled = True
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        log("index.cancelled")
        return True

    @classmethod
    def snapshot(cls) -> dict:
        with cls._lock:
            return dict(cls._state)

    @classmethod
    def _set(cls, **fields) -> None:
        with cls._lock:
            cls._state.update(fields)

    @classmethod
    def busy(cls) -> bool:
        with cls._lock:
            return bool(cls._state["running"])

    @classmethod
    def start(cls, reason: str) -> bool:
        """Kick off a run unless one is already going. True if it started."""
        with cls._lock:
            if cls._state["running"]:
                return False
            cls._state.update({"running": True, "phase": "starting", "done": 0,
                               "total": 0, "name": None, "ok": None,
                               "error": None})
        log("index.spawned", reason=reason)
        threading.Thread(target=cls._run, daemon=True).start()
        return True

    @classmethod
    def _run(cls) -> None:
        collected: list[str] = []
        try:
            process = subprocess.Popen(
                [sys.executable, "-m", "tools.tgindex"],
                cwd=str(APP_DIR), stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, bufsize=1,
            )
            cls._process = process
            cls._cancelled = False
        except OSError as problem:
            cls._set(running=False, ok=False, error=str(problem),
                     phase="failed", finished_at=time.time())
            log("index.failed", level="error", error=problem)
            return

        for line in process.stdout:
            line = line.rstrip("\n")
            collected.append(line)
            if line.startswith("@@progress "):
                try:
                    cls._set(**json.loads(line[len("@@progress "):]))
                except ValueError:
                    pass
            elif len(collected) > 4000:
                del collected[:1000]   # a huge archive must not fill memory
        code = process.wait()

        output = "\n".join(collected)
        cls._process = None
        if cls._cancelled:
            cls._set(running=False, ok=False, phase="cancelled",
                     finished_at=time.time(),
                     error="Indexing was cancelled. Nothing in your exports "
                           "was changed; it will start again next time.")
            return
        if code == 0:
            cls._set(running=False, ok=True, phase="done",
                     finished_at=time.time(), error=None)
            log("index.finished_bg")
        else:
            cls._set(running=False, ok=False, phase="failed",
                     finished_at=time.time(),
                     error=_failure_summary(output, ""))
            log("index.failed", level="error",
                error=_failure_summary(output, ""))


class Watchdog:
    """Stops the server when the last open window goes away.

    Each open page holds one long-lived connection. When a tab closes, the
    socket closes with it and this finds out on its next write -- from the
    operating system, not from anything the page had to remember to do.

    The version this replaces had the page ping on a timer. Browsers throttle
    timers in background tabs to about once a minute, so switching tabs for a
    moment looked exactly like closing the window and the server shut down
    underneath someone still using it. A connection is not throttled: it is
    either open or it is not.

    The only timing left is a few seconds to tell a reload (connection drops,
    a new one arrives immediately) from a close (nothing comes back).
    """

    GRACE = 4.0         # seconds to wait for a reload to reconnect
    INTERVAL = 1.0

    _lock = threading.Lock()
    _sessions: set = set()
    _empty_since: float | None = None
    _server = None

    @classmethod
    def opened(cls, token: object) -> None:
        with cls._lock:
            cls._sessions.add(token)
            cls._empty_since = None
        log("session.opened", open_windows=len(cls._sessions))

    @classmethod
    def closed(cls, token: object) -> None:
        with cls._lock:
            cls._sessions.discard(token)
            if not cls._sessions:
                cls._empty_since = time.monotonic()
            count = len(cls._sessions)
        log("session.closed", open_windows=count)

    @classmethod
    def count(cls) -> int:
        with cls._lock:
            return len(cls._sessions)

    @classmethod
    def start(cls, server) -> None:
        cls._server = server

        def loop() -> None:
            while True:
                time.sleep(cls.INTERVAL)
                if not _shutdown_on_close_enabled():
                    continue
                with cls._lock:
                    empty_since = cls._empty_since
                    idle = (time.monotonic() - empty_since) if empty_since else 0
                    gone = bool(empty_since) and not cls._sessions and idle > cls.GRACE
                if gone:
                    log("server.shutdown_requested", reason="last window closed")
                    print("\nThe viewer window was closed; shutting down.")
                    threading.Thread(target=server.shutdown, daemon=True).start()
                    return
        threading.Thread(target=loop, daemon=True).start()


def _shutdown_on_close_enabled() -> bool:
    """Read the preference from disk, so toggling it takes effect at once."""
    try:
        return bool((load_config().get("settings") or {}).get("shutdownOnClose"))
    except Exception:  # noqa: BLE001
        return False


def _reveal_in_file_manager(target: Path) -> None:
    """Open the folder holding `target`, selecting it where that is possible."""
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", str(target)], capture_output=True,
                           timeout=10, check=False)
        elif os.name == "nt":
            subprocess.run(["explorer", "/select,", str(target)],
                           capture_output=True, timeout=10, check=False)
        else:
            subprocess.run(["xdg-open", str(target.parent)],
                           capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        pass  # the path is in the reply either way


def _places() -> list:
    """Jumping-off points for the picker: home, and any mounted drive.

    Only the names of mount points are read -- what is *inside* a drive is
    listed if and only if someone clicks into it. Without this, reaching an
    external or network drive means knowing and typing its full path, which
    is precisely the chore the picker exists to remove.
    """
    found = [{"name": "Home", "path": str(Path.home()), "kind": "home"}]
    local = APP_DIR / "Backups"
    if local.is_dir():
        found.append({"name": "Backups (in this program)",
                      "path": str(local), "kind": "internal"})

    roots: list[Path] = []
    if sys.platform == "darwin":
        roots = [Path("/Volumes")]
    elif sys.platform.startswith("linux"):
        user = os.environ.get("USER") or ""
        roots = [Path("/media") / user, Path("/media"), Path("/mnt"),
                 Path("/run/media") / user]
    elif os.name == "nt":
        for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
            drive = Path(f"{letter}:\\")
            if drive.is_dir():
                detail = volume_info(str(drive))
                found.append({"name": f"{letter}: drive", "path": str(drive),
                              "kind": detail.get("kind", "unknown")})
        return found

    seen = {item["path"] for item in found}
    for root in roots:
        try:
            children = sorted(root.iterdir(), key=lambda p: p.name.lower())
        except (OSError, PermissionError):
            continue
        for child in children:
            if child.name.startswith(".") or not child.is_dir():
                continue
            # The boot disk shows up under /Volumes as a link to "/"; it is
            # already reachable from Home and only adds confusion here.
            if child.resolve() == Path("/") or str(child) in seen:
                continue
            seen.add(str(child))
            detail = volume_info(str(child))
            found.append({"name": child.name, "path": str(child),
                          "kind": detail.get("kind", "unknown")})
    return found


def _denied_message(path: Path) -> str:
    """Explain a refused folder, rather than just naming the errno.

    This fires at the exact moment someone is picking their archive, so it has
    to say what to do next -- macOS denies Documents, Desktop, Downloads and
    external drives to an unsigned app without ever prompting. The wording
    lives with the indexer so both halves of the program agree.
    """
    return explain_denial(path)


def _failure_summary(stderr: str, stdout: str) -> str:
    """The one thing worth showing when the indexer stops.

    The indexer deliberately reports the problems a person can fix as
    ``error: <explanation>``, so that is taken whole -- explanations run to
    several lines and truncating one strips exactly the part that says what to
    do. Anything else means an unexpected crash, where the final line of the
    traceback is the only informative one; the rest stays in `output`.
    """
    for index, line in enumerate(stderr.splitlines()):
        if line.startswith("error: "):
            return "\n".join(
                [line[len("error: "):], *stderr.splitlines()[index + 1:]]
            ).strip()
    tail = [line for line in stderr.splitlines() if line.strip()]
    if tail:
        return tail[-1].strip()
    body = [line for line in stdout.splitlines() if line.strip()]
    return body[-1].strip() if body else "The indexer stopped without saying why."


def _validated_index_dir(raw) -> str:
    """Keep the index inside the program's own folder.

    Nothing in the app offers to move it, so this only ever fires on a hand
    edit or a request that got past the origin check -- which is exactly when
    a guarantee about not writing near someone's archive should still hold.
    """
    text = str(raw or "").strip()
    if not text:
        raise ValueError("The index folder cannot be empty.")
    candidate = Path(text).expanduser()
    if not candidate.is_absolute():
        candidate = APP_DIR / candidate
    resolved = candidate.resolve()
    if resolved != APP_DIR and APP_DIR not in resolved.parents:
        raise ValueError(
            f"The index has to stay inside {APP_DIR}. "
            "Your exports are only ever read, so nothing is written near them."
        )
    return text


def _validated_root(raw) -> str:
    """Normalise a chosen backup folder, or refuse it with a reason.

    Three things go wrong here in practice: a path typed relative (which would
    otherwise be resolved against whatever directory the server started in), a
    drive that is not mounted, and a drive the system will not let this program
    read. Only the last one looks like a bug, so all three get told apart.
    """
    text = str(raw or "").strip()
    if not text:
        raise ValueError("Pick the folder that holds your exports.")

    candidate = Path(text).expanduser()
    relative = not candidate.is_absolute()
    if relative:
        candidate = APP_DIR / candidate
    try:
        candidate = candidate.resolve()
        exists = candidate.is_dir()
    except OSError:
        raise ValueError(_denied_message(candidate)) from None
    if not exists:
        # A dropped leading slash lands here, and "no folder at <program
        # dir>/Volumes/..." is baffling unless you are told why it looked there.
        hint = (
            f'"{text}" is not a full path, so it was looked for inside the '
            "program's own folder. A full path starts with a slash, like "
            "/Volumes/My Drive/Telegram backup."
            if relative else
            "If it is on an external drive, check the drive is plugged in and "
            "mounted, then try again."
        )
        raise ValueError(f"There is no folder at {candidate}.\n{hint}")
    try:
        next(iter(candidate.iterdir()), None)
    except PermissionError:
        raise ValueError(_denied_message(candidate)) from None
    except OSError as exc:
        raise ValueError(
            f"Could not read {candidate}: {exc.strerror or exc}"
        ) from None
    return str(candidate)


def _resolve_root(raw) -> Path | None:
    """Turn a configured backup_root into an existing absolute folder."""
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = (APP_DIR / candidate).resolve()
    return candidate.resolve() if candidate.is_dir() else None


def _root_readable(root: Path | None) -> bool:
    """Whether the backup folder can actually be listed, not just found.

    On macOS a folder inside Documents, Desktop or Downloads exists and stats
    fine, but listing it raises PermissionError unless the launching app has
    been granted access. Distinguishing "missing" from "blocked" is the
    difference between a useful message and a mystery.
    """
    if root is None:
        return False
    try:
        next(iter(root.iterdir()), None)
        return True
    except (PermissionError, OSError):
        return False


def load_config() -> dict:
    """Read data/config.json, keeping a damaged one rather than ignoring it.

    Silently returning {} was how a corrupt file turned into a lost setup: the
    app saw no `setup_complete`, ran first-time setup again, and the next write
    made the loss permanent. Now the bad file is set aside, the fact is
    logged, and `config_recovered` tells the app to say so instead of
    pretending this is a fresh install.
    """
    if not CONFIG_PATH.exists():
        return {}
    try:
        loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as problem:
        kept = CONFIG_PATH.with_name(f"config.damaged-{int(time.time())}.json")
        try:
            CONFIG_PATH.replace(kept)
        except OSError:
            kept = None
        log("config.unreadable", level="error", error=problem, kept_at=kept)
        return {"config_recovered": True, "recovered_from": str(kept or "")}
    if not isinstance(loaded, dict):
        log("config.not_an_object", level="error")
        return {}
    return loaded


def pick_port(preferred: int) -> int:
    """First free port at or after `preferred`."""
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"No free port in {preferred}..{preferred + 19}")


def stop_orphaned_indexer() -> None:
    """End an index run that outlived the server which started it."""
    try:
        from tools.tgindex.__main__ import other_index_run
        out_dir = APP_DIR / "data" / "index"
        pid = other_index_run(out_dir)
    except Exception:  # noqa: BLE001 - never let a tidy-up stop the launch
        return
    if not pid:
        return
    import signal
    try:
        os.kill(pid, signal.SIGTERM)
        log("index.orphan_stopped", pid=pid)
    except OSError:
        pass


def find_running(preferred: int) -> str | None:
    """The URL of a copy already running from this same folder, if any.

    Opening the app twice used to start a second server on the next port up,
    which is how someone waiting on a slow first launch ended up with two
    programs, two indexers writing the same files, and a browser tab pointed
    at whichever one died first.

    The folder is part of the check on purpose: two different installs are
    genuinely two programs and are each allowed to run.
    """
    for port in range(preferred, preferred + 20):
        url = f"http://127.0.0.1:{port}/"
        try:
            request = urllib.request.Request(
                f"{url}api/ping", headers={"Origin": url.rstrip("/")})
            with urllib.request.urlopen(request, timeout=1.5) as answer:
                found = json.loads(answer.read())
        except (OSError, ValueError):
            continue
        if (found.get("app") == "telegram-archive"
                and found.get("app_dir") == str(APP_DIR)):
            return url
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--root", help="Backup folder (overrides config.json)")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--index-on-start", action="store_true",
                        help="index in the background once the server is up")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    for suffix, kind in EXTRA_TYPES.items():
        mimetypes.add_type(kind, suffix)

    config = load_config()
    raw_root = args.root or config.get("backup_root")
    media_root = _resolve_root(raw_root)
    if raw_root and media_root is None:
        print(f"warning: backup folder not found: {raw_root}", file=sys.stderr)

    # Opening the app while it is already open should bring you to the copy
    # that is running, not start a rival one. Two servers meant two indexers
    # writing the same files and a browser tab pointed at whichever died.
    already = find_running(args.port)
    if already:
        log("launch.already_running", url=already)
        print(f"Telegram Archive is already running at {already}")
        if not args.no_browser:
            webbrowser.open(already)
        return 0

    handler = partial(ArchiveHandler, directory=str(APP_DIR))
    ArchiveHandler.app_dir = APP_DIR
    ArchiveHandler.media_root = media_root

    port = pick_port(args.port)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{port}/"

    logbook.configure("server")
    logbook.boot_snapshot(port=port, url=url,
                          media_root=str(media_root) if media_root else None,
                          volume=volume_info(raw_root).get("summary"))

    print(f"Viewer    {url}")
    print(f"App       {APP_DIR}")
    print(f"Media     {media_root or '(not configured — run first-time setup)'}")
    print("\nLoopback only, nothing leaves this machine.")
    print("Your backup folder is mounted read-only; writes touch data/ only.")
    print("Press Ctrl+C to stop.\n")

    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    # An indexer left running by an earlier session -- the window closed, the
    # server stopped, but its child carried on reading the archive -- is
    # stopped before a new one starts. Two at once is how a slow first launch
    # turned into two copies of a download from a network drive.
    stop_orphaned_indexer()

    if args.index_on_start:
        Indexing.start("startup")

    Watchdog.start(server)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("server.stopped", reason="keyboard interrupt")
    finally:
        # The indexer is this server's child and goes when it does; left alone
        # it would carry on reading the archive with nobody watching.
        Indexing.cancel()
        server.server_close()
    log("server.closed")
    print("\nTelegram Archive stopped. You can close this window.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
