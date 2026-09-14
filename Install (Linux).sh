#!/bin/sh
# Run this to install Telegram Archive for the current user:
#   ./Install\ \(Linux\).sh
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  cat <<'MSG'
Telegram Archive needs Python 3.

Install it with your package manager, then run this again:
  Debian / Ubuntu   sudo apt install python3
  Fedora            sudo dnf install python3
  Arch              sudo pacman -S python
MSG
  exit 1
fi

exec python3 tools/install.py "$@"
