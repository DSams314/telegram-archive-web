#!/bin/sh
# Remove Telegram Archive. Your chat exports are kept.
cd "$(dirname "$0")" || exit 1
exec python3 tools/uninstall.py --from "$(pwd)" "$@"
