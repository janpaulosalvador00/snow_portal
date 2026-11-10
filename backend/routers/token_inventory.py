"""Read-only token inventory for the "Tokens" screen (metadata only, never the secret)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.lib import db, token_status
from backend.security import get_current_user

router = APIRouter(tags=["tokens"])

STATUSES = ("active", "expired", "revoked")
EXPIRING_SOON = timedelta(days=7)
# Secrets with no intrinsic validity: show "não se aplica" instead of "sem validade informada".
NO_EXPIRY_TYPES = ("password", "private_key")
FINGERPRINT_CHARS = 8

_COLUMNS = """
    v.id, v.connection_id, v.connection_name, v.account_identifier, v.username,
    v.role_name, v.auth_method, v.token_type, v.status, v.fingerprint,
    v.issued_at, v.expires_at, v.last_refreshed_at, v.revoked_at,
    v.file_name, v.source, v.source_file, v.created_at, v.updated_at,
    (c.id IS NOT NULL) AS connection_exists, c.team_id, tm.name AS team_name
"""


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


def _expiry_note(row: dict) -> str | None:
    if row["expires_at"] is not None:
        return None
    if row["token_type"] in NO_EXPIRY_TYPES:
        return "não se aplica"
    return "sem validade informada"


def _public(row: dict) -> dict:
    fingerprint = row.get("fingerprint") or ""
    return {
        "id": row["id"],
        "connection_id": row["connection_id"],
        "connection_name": row["connection_name"],
        "connection_exists": bool(row["connection_exists"]),
        "team_name": row.get("team_name"),
        "account_identifier": row["account_identifier"],
        "username": row["username"],
        "role_name": row["role_name"],
        "auth_method": row["auth_method"],
        "auth_method_label": db.AUTH_METHOD_LABELS.get(row["auth_method"] or ""),
        "token_type": row["token_type"],
        "status": row["status"],
        "fingerprint_short": fingerprint[:FINGERPRINT_CHARS] or None,
        "issued_at": _iso(row["issued_at"]),
        "expires_at": _iso(row["expires_at"]),
        "expiry_note": _expiry_note(row),
        "last_refreshed_at": _iso(row["last_refreshed_at"]),
        "revoked_at": _iso(row["revoked_at"]),
        "file_name": row["file_name"],
        "source": row["source"],
        "source_file": row["source_file"],
        "updated_at": _iso(row["updated_at"]),
    }


@router.get("/api/tokens")
def list_tokens(
    include_revoked: bool = Query(False, description="Inclui tokens revogados"),
    connection_id: int | None = Query(None),
    token_type: str | None = Query(None),
    status: str | None = Query(None),
    user: dict = Depends(get_current_user),
):
    """Tokens visible to the user (admin: all; others: their connections). No secrets."""
    if token_type and token_type not in db.TOKEN_TYPES:
        raise HTTPException(status_code=400, detail=f"token_type inválido: {token_type}")
    if status and status not in STATUSES:
        raise HTTPException(status_code=400, detail=f"status inválido: {status}")

    # Best-effort: persists expiry flips + JSON mirror; the view already derives status live.
    try:
        token_status.sweep_token_status()
    except Exception:  # noqa: BLE001
        token_status.logger.exception("token status sweep (on read) failed")

    where = ["1=1"]
    params: list = []
    if not include_revoked and status != "revoked":
        where.append("v.status <> 'revoked'")
    if connection_id is not None:
        where.append("v.connection_id = %s")
        params.append(connection_id)
    if token_type:
        where.append("v.token_type = %s")
        params.append(token_type)
    if status:
        where.append("v.status = %s")
        params.append(status)
    sql = f"""
        SELECT {_COLUMNS}
        FROM v_connection_tokens v
        LEFT JOIN connections c ON c.id = v.connection_id
        LEFT JOIN teams tm ON tm.id = c.team_id
        WHERE {" AND ".join(where)}
        ORDER BY v.connection_name NULLS LAST, v.connection_id, v.token_type
    """
    with db.db_cursor() as cur:
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]

    if user["role"] != "admin":
        allowed = {c["id"] for c in db.list_connections_for_user(user)}
        rows = [r for r in rows if r["connection_id"] in allowed]

    now = datetime.now(timezone.utc)
    summary = {"active": 0, "expired": 0, "revoked": 0, "expiring_soon": 0, "total": len(rows)}
    for r in rows:
        summary[r["status"]] = summary.get(r["status"], 0) + 1
        if r["status"] == "active" and r["expires_at"] and r["expires_at"] - now <= EXPIRING_SOON:
            summary["expiring_soon"] += 1

    return {
        "tokens": [_public(r) for r in rows],
        "summary": summary,
        "server_time": now.isoformat(),
        "last_sweep": token_status.last_result(),
        "sweep_interval_sec": token_status.interval_seconds(),
    }
