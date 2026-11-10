"""Mirror connection_tokens rows as JSON files (encrypted value only, never plaintext).

File writes are best-effort: errors are logged and never propagate to the caller.
Only files matching ``conn<id>_<account>_<token_type>.json`` are ever created or
removed, so unrelated files in the export folder are left untouched.
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.lib.config import get_settings

logger = logging.getLogger(__name__)

TOKEN_TYPES = ("oauth_access", "oauth_refresh", "pat", "password", "private_key")
FILE_SCHEMA = "snow_portal.connection_token.v1"
ENCRYPTION_LABEL = "fernet(sha256(SNOW_PORTAL_SECRET_KEY))"

_FILE_RE = re.compile(
    r"^conn(?P<cid>\d+)_.+_(?P<ttype>" + "|".join(TOKEN_TYPES) + r")\.json$"
)

_EXPORTED_FIELDS = (
    "connection_id",
    "connection_name",
    "account_identifier",
    "username",
    "role_name",
    "auth_method",
    "token_type",
    "status",
    "fingerprint",
    "issued_at",
    "expires_at",
    "last_refreshed_at",
    "source",
    "source_file",
    "created_at",
    "updated_at",
)


def export_dir() -> Path | None:
    raw = get_settings().get("tokens_export_dir") or ""
    if not raw:
        return None
    path = Path(raw)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("token export dir unavailable %s: %s", raw, exc)
        return None
    return path


def file_name(connection_id: int, account: str, token_type: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", (account or "unknown").strip()) or "unknown"
    return f"conn{int(connection_id)}_{slug}_{token_type}.json"


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def write_token_file(row: dict) -> str | None:
    """Atomically write one token row; returns the file name or None."""
    folder = export_dir()
    if folder is None:
        return None
    name = file_name(row["connection_id"], row.get("account_identifier") or "", row["token_type"])
    doc = {"schema": FILE_SCHEMA}
    doc.update({k: _jsonable(row.get(k)) for k in _EXPORTED_FIELDS})
    doc["encryption"] = ENCRYPTION_LABEL
    doc["token_encrypted"] = row.get("token_encrypted")
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".json", dir=folder)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, folder / name)
        tmp_path = None
        return name
    except OSError as exc:
        logger.warning("token file write failed %s: %s", name, exc)
        return None
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def remove_token_files(connection_id: int, *, keep: set[str] | None = None) -> int:
    """Delete this connection's token files except names in ``keep``."""
    folder = export_dir()
    if folder is None:
        return 0
    removed = 0
    try:
        entries = list(folder.iterdir())
    except OSError as exc:
        logger.warning("token export dir listing failed: %s", exc)
        return 0
    for entry in entries:
        match = _FILE_RE.match(entry.name)
        if not match or int(match.group("cid")) != int(connection_id):
            continue
        if keep and entry.name in keep:
            continue
        try:
            entry.unlink()
            removed += 1
        except OSError as exc:
            logger.warning("token file remove failed %s: %s", entry.name, exc)
    return removed


def remove_orphan_files(active_connection_ids: set[int]) -> int:
    """Delete token files whose connection has no active tokens anymore."""
    folder = export_dir()
    if folder is None:
        return 0
    removed = 0
    try:
        entries = list(folder.iterdir())
    except OSError as exc:
        logger.warning("token export dir listing failed: %s", exc)
        return 0
    for entry in entries:
        match = _FILE_RE.match(entry.name)
        if not match or int(match.group("cid")) in active_connection_ids:
            continue
        try:
            entry.unlink()
            removed += 1
        except OSError as exc:
            logger.warning("token file remove failed %s: %s", entry.name, exc)
    return removed
