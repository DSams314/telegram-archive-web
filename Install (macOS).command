#!/bin/sh
# Double-click to install Telegram Archive into ~/Applications.
cd "$(dirname "$0")" || exit 1
clear

# A GUI-launched shell gets a minimal PATH, so look where python3 actually is.
for candidate in /usr/bin/python3 /usr/local/bin/python3 \
                 /opt/homebrew/bin/python3 "$(command -v python3 2>/dev/null)"; do
  [ -x "$candidate" ] && PY="$candidate" && break
done

if [ -z "$PY" ]; then
  cat <<'MSG'
Telegram Archive needs Python 3.

macOS usually ships it. If this machine does not have it:
  1. Download Python 3 from https://www.python.org/downloads/
  2. Install it
  3. Run this installer again

MSG
  osascript -e 'display alert "Python 3 is required" message "Install Python 3 from python.org, then run this installer again."' >/dev/null 2>&1
  echo "Press return to close."; read -r _; exit 1
fi

"$PY" tools/install.py
status=$?
echo
echo "Press return to close this window."
read -r _
exit $status
