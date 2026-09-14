#!/bin/sh
# Double-click to remove Telegram Archive. Your chat exports are kept.
cd "$(dirname "$0")" || exit 1
clear
for candidate in /usr/bin/python3 /usr/local/bin/python3 \
                 /opt/homebrew/bin/python3 "$(command -v python3 2>/dev/null)"; do
  [ -x "$candidate" ] && PY="$candidate" && break
done
[ -z "$PY" ] && { echo "Python 3 not found."; read -r _; exit 1; }

# --from . so it works whether run from the install folder or the download.
"$PY" tools/uninstall.py --from "$(pwd)"
echo
echo "Press return to close this window."
read -r _
