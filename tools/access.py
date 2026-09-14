#!/usr/bin/env python3
"""Ask the system for the backup folder early, while someone is watching.

    python3 -m tools.access        # exit 0 fine, 2 refused, 3 not there

macOS decides whether to show its "would like to access" prompt at the moment
of the first read. Left to itself that moment arrives deep inside indexing, in
a child process, long after launch -- a bad time to ask a question and an easy
one to miss. Doing one deliberate read here moves the prompt to launch, where
it is expected, and turns a refusal into something the launcher can explain.

Nothing is written. The whole probe is a single directory listing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.tgindex.discover import explain_denial  # noqa: E402

OK, REFUSED, MISSING = 0, 2, 3


def configured_root(app_dir: Path) -> Path | None:
    """The backup folder from data/config.json, if one has been chosen."""
    try:
        config = json.loads((app_dir / "data" / "config.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    raw = config.get("backup_root")
    if not raw:
        return None
    root = Path(raw).expanduser()
    return root if root.is_absolute() else (app_dir / root)


def main() -> int:
    app_dir = Path(__file__).resolve().parent.parent
    root = configured_root(app_dir)
    if root is None:
        return OK  # nothing chosen yet; setup will ask

    try:
        next(iter(root.iterdir()), None)
        return OK
    except PermissionError:
        # This is the read that makes macOS ask. If it still lands here, the
        # answer was no -- or the system never offered the choice.
        print(explain_denial(root), file=sys.stderr)
        return REFUSED
    except FileNotFoundError:
        print(f"There is no folder at {root}.", file=sys.stderr)
        return MISSING
    except OSError as exc:
        print(f"Could not read {root}: {exc.strerror or exc}", file=sys.stderr)
        return REFUSED


if __name__ == "__main__":
    raise SystemExit(main())
