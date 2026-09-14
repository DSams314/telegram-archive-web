#!/usr/bin/env python3
"""Build the macOS .icns from the app's vector mark.

Rasterising happens through macOS's own Quick Look, so the icon and the in-app
logo can never diverge: both come from LOGO_MARKS in app/logo.js.

    python3 tools/make_icon.py
"""

from __future__ import annotations

import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
ICNS = APP_DIR / "Telegram Archive.app" / "Contents" / "Resources" / "AppIcon.icns"

# The .icns entry types Finder and the Dock actually consult.
SIZES = [(b"ic11", 32), (b"ic12", 64), (b"ic07", 128), (b"ic08", 256), (b"ic09", 512)]


def marks() -> str:
    source = (APP_DIR / "app" / "logo.js").read_text(encoding="utf-8")
    found = re.search(r"export const LOGO_MARKS = `(.*?)`;", source, re.S)
    if not found:
        raise SystemExit("could not find LOGO_MARKS in app/logo.js")
    return found.group(1)


def svg(size: int) -> str:
    return f"""<svg viewBox="0 0 124 124" width="{size}" height="{size}"
     xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#b9a3e3"/>
    <stop offset="0.45" stop-color="#d9b6d2"/>
    <stop offset="1" stop-color="#efb183"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="120" height="120" rx="30" fill="url(#g)"/>
  <g color="#fdf6e3">{marks()}</g>
</svg>"""


def render(size: int, work: Path) -> bytes:
    source = work / f"icon{size}.svg"
    source.write_text(svg(size), encoding="utf-8")
    subprocess.run(
        ["qlmanage", "-t", "-s", str(size), "-o", str(work), str(source)],
        capture_output=True, check=False,
    )
    produced = work / f"{source.name}.png"
    if not produced.exists():
        raise SystemExit(f"Quick Look produced no PNG at {size}px")
    # Quick Look pads to a square canvas of its own; normalise the pixel size.
    subprocess.run(
        ["sips", "-z", str(size), str(size), str(produced)],
        capture_output=True, check=False,
    )
    return produced.read_bytes()


def main() -> int:
    if sys.platform != "darwin":
        print("This builds a macOS icon and needs qlmanage; skipping.")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        body = b""
        for tag, size in SIZES:
            png = render(size, work)
            body += tag + struct.pack(">I", len(png) + 8) + png

    ICNS.parent.mkdir(parents=True, exist_ok=True)
    ICNS.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)
    print(f"wrote {ICNS.relative_to(APP_DIR)} ({ICNS.stat().st_size / 1024:.0f} KB)")

    # Re-sign so the bundle's seal still matches its contents.
    subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-",
         str(APP_DIR / "Telegram Archive.app")],
        capture_output=True, check=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
