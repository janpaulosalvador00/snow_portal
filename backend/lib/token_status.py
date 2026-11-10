"""Keep connection_tokens.status / expires_at current without waiting for a sync.

``sweep_token_status`` is idempotent and single-flight (thread lock in-process,
Postgres advisory lock across processes). It:

* fills ``expires_at`` of OAuth refresh tokens when the stored OAuth blob carries
  ``refresh_token_expires_in`` (only if the blob's refresh token is the same
  secret, checked by fingerprint); a manual expiry (``expires_at_source =
  'manual'``) is never touched;
* flips ``active`` -> ``expired`` once ``expires_at`` has passed, and
  ``expired`` -> ``active`` when ``expires_at`` moved back into the future;
* rewrites the JSON mirror (token_export) of every row it changed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

from backend.lib import db, token_export
from backend.lib.crypto import decrypt_secret, secret_fingerprint

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SEC = 300
MIN_INTERVAL_SEC = 30
_ADVISORY_LOCK_KEY = 0x534E4F57_544B  # "SNOW" "TK"

_lock = threading.Lock()
_last_result: dict | None = None


def interval_seconds() -> int:
    raw = os.environ.get("TOKEN_STATUS_INTERVAL_SEC", "")
    try:
        value = int(raw) if raw else DEFAULT_INTERVAL_SEC
    except ValueError:
        value = DEFAULT_INTERVAL_SEC
    return max(MIN_INTERVAL_SEC, value)


def last_result() -> dict | None:
    return dict(_last_result) if _last_result else None


def _refresh_expiry_candidates(cur) -> list[dict]:
    cur.execute(
        """
        SELECT t.id, t.fingerprint, t.issued_at, t.created_at,
               c.pat_encrypted, c.updated_at AS conn_updated_at
        FROM connection_tokens t
        JOIN connections c ON c.id = t.connection_id
        WHERE t.token_type = 'oauth_refresh'
          AND t.status <> 'revoked'
          AND t.expires_at IS NULL
          AND t.expires_at_source IS DISTINCT FROM 'manual'
          AND c.pat_encrypted IS NOT NULL
        """
    )
    return [dict(r) for r in cur.fetchall()]


def _refresh_expires_at(row: dict) -> datetime | None:
    try:
        raw = decrypt_secret(row["pat_encrypted"]).strip()
    except ValueError:
        return None
    if not raw.startswith("{"):
        return None
    try:
        blob = json.loads(raw)
    except ValueError:
        return None
    refresh = blob.get("refresh_token")
    seconds = blob.get("refresh_token_expires_in")
    if not refresh or not seconds:
        return None
    if secret_fingerprint(refresh) != row["fingerprint"]:
        return None
    base = row["issued_at"] or row["conn_updated_at"] or row["created_at"]
    if base is None:
        return None
    try:
        return base + timedelta(seconds=int(seconds))
    except (TypeError, ValueError, OverflowError):
        return None


def _sweep_locked() -> dict:
    changed: list[dict] = []
    refresh_filled = 0
    with db.db_cursor(commit=True) as cur:
        cur.execute("SELECT pg_try_advisory_xact_lock(%s) AS ok", (_ADVISORY_LOCK_KEY,))
        if not cur.fetchone()["ok"]:
            return {"skipped": "busy"}

        for row in _refresh_expiry_candidates(cur):
            expires_at = _refresh_expires_at(row)
            if expires_at is None:
                continue
            cur.execute(
                """
                UPDATE connection_tokens
                SET expires_at = %s, expires_at_source = 'provider', updated_at = NOW()
                WHERE id = %s AND expires_at IS NULL
                  AND expires_at_source IS DISTINCT FROM 'manual'
                RETURNING *
                """,
                (expires_at, row["id"]),
            )
            hit = cur.fetchone()
            if hit:
                refresh_filled += 1
                changed.append(dict(hit))

        cur.execute(
            """
            UPDATE connection_tokens
            SET status = CASE WHEN status = 'active' THEN 'expired' ELSE 'active' END,
                updated_at = NOW()
            WHERE (status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW())
               OR (status = 'expired' AND expires_at IS NOT NULL AND expires_at > NOW()
                   AND token_encrypted IS NOT NULL)
            RETURNING *
            """
        )
        flipped = [dict(r) for r in cur.fetchall()]

    by_id = {r["id"]: r for r in changed}
    by_id.update({r["id"]: r for r in flipped})
    files = 0
    for row in by_id.values():
        if row.get("file_name") and row.get("status") != "revoked":
            if token_export.write_token_file(row):
                files += 1
    return {
        "expired": sum(1 for r in flipped if r["status"] == "expired"),
        "reactivated": sum(1 for r in flipped if r["status"] == "active"),
        "refresh_expiry_filled": refresh_filled,
        "files_rewritten": files,
    }


def sweep_token_status() -> dict | None:
    """Run one sweep; returns None when another sweep is already running here."""
    global _last_result
    if not _lock.acquire(blocking=False):
        return None
    try:
        result = _sweep_locked()
        result["checked_at"] = datetime.now(timezone.utc).isoformat()
        if result.get("expired") or result.get("reactivated") or result.get("refresh_expiry_filled"):
            logger.info("token status sweep: %s", result)
        _last_result = result
        return result
    finally:
        _lock.release()


async def _loop(interval: int) -> None:
    while True:
        try:
            await asyncio.to_thread(sweep_token_status)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("token status sweep failed")
        await asyncio.sleep(interval)


def start_background_loop() -> asyncio.Task:
    interval = interval_seconds()
    logger.info("token status loop every %ss", interval)
    return asyncio.create_task(_loop(interval), name="token-status-loop")


async def stop_background_loop(task: asyncio.Task | None) -> None:
    if task is None:
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
