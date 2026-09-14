#!/usr/bin/env python3
"""Install the privacy check as a git pre-commit hook.

    python3 tools/install_hooks.py

Git keeps hooks inside the hidden .git folder, which is never uploaded, so a
fresh copy of the repository needs this run once. After that, every commit is
checked first, and one that would add personal information is refused.
"""

from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
HOOK = APP_DIR / ".git" / "hooks" / "pre-commit"

HOOK.parent.mkdir(parents=True, exist_ok=True)
HOOK.write_text(
    "#!/bin/sh\n"
    "# Refuses a commit that would add personal information to the project.\n"
    "# See tools/privacy_audit.py. To check by hand: python3 tools/privacy_audit.py\n"
    "exec python3 tools/privacy_audit.py --staged\n",
    encoding="utf-8",
)
HOOK.chmod(0o755)
print(f"installed {HOOK.relative_to(APP_DIR)}")
