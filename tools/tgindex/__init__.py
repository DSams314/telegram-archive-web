"""Telegram chat-export indexer for the offline viewer.

Reads exports read-only and emits a chunked static index the viewer can stream.
"""

__all__ = ["build", "discover", "htmlmap", "model", "normalize", "resolve"]
