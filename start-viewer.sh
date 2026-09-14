#!/bin/sh
# Linux: ./start-viewer.sh   Stop it with the power button in the app.
cd "$(dirname "$0")" || exit 1

# A failed index must not stop the server: a fresh copy has no backup folder
# yet, and the server is what serves the setup that asks for one.
python3 -m tools.tgindex || echo "(no index yet — the app will ask where your exports are)"
exec python3 serve.py
