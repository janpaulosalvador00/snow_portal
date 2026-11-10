"""Tokens folder access. The portal never writes token files there.

The folder (``TOKENS_EXPORT_DIR``) holds only the user's own access token / key
files, read by ``token_sources``. The former JSON mirror of connection_tokens is
gone: write functions are no-ops and the remove functions only delete legacy
``conn<id>_<account>_<token_type>.json`` files, never anything else.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Callable

from backend.lib.config import get_settings

logger = logging.getLogger(__name__)

TOKEN_TYPES = ("oauth_access", "oauth_refresh", "pat", "password", "private_key")

_LEGACY_FILE_RE = re.compile(
    r"^conn(?P<cid>\d+)_.+_(?P<ttype>" + "|".join(TOKEN_TYPES) + r")\.json$"
)


def tokens_dir() -> Path | None:
    """Configured tokens folder (read-only use), or None if missing."""
    raw = get_settings().get("tokens_export_dir") or ""
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_dir() else None


def export_dir() -> Path | None:
    """JSON export is disabled; always None so no file_name is recorded."""
    return None


def file_name(connection_id: int, account: str, token_type: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", (account or "unknown").strip()) or "unknown"
    return f"conn{int(connection_id)}_{slug}_{token_type}.json"


def write_token_file(row: dict) -> str | None:
    return None


def _remove_legacy(should_remove: Callable[[int, str], bool]) -> int:
    folder = tokens_dir()
    if folder is None:
        return 0
    try:
        entries = list(folder.iterdir())
    except OSError as exc:
        logger.warning("tokens dir listing failed: %s", exc)
        return 0
    removed = 0
    for entry in entries:
        match = _LEGACY_FILE_RE.match(entry.name)
        if not match or not should_remove(int(match.group("cid")), entry.name):
            continue
        try:
            if entry.is_file():
                entry.unlink()
                removed += 1
        except OSError as exc:
            logger.warning("legacy token file remove failed %s: %s", entry.name, exc)
    return removed


def remove_token_files(connection_id: int, *, keep: set[str] | None = None) -> int:
    """Delete this connection's legacy JSON files (except names in ``keep``)."""
    cid, keep = int(connection_id), keep or set()
    return _remove_legacy(lambda file_cid, name: file_cid == cid and name not in keep)


def remove_orphan_files(active_connection_ids: set[int]) -> int:
    """Delete legacy JSON files of connections without active tokens."""
    return _remove_legacy(lambda file_cid, _name: file_cid not in active_connection_ids)
