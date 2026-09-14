#!/bin/sh
# macOS: double-click this file. Stop it with the power button in the app.
cd "$(dirname "$0")" || exit 1

# Refresh the index if there is already a backup folder configured. A failure
# here must NOT stop the server: on a brand-new copy there is no folder yet,
# and the server is what serves the first-run setup that asks for one.
python3 -m tools.tgindex || echo "(no index yet — the app will ask where your exports are)"
exec python3 serve.py
