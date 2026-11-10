"""Token inventory for the "Tokens" screen: metadata listing + per-token edits.

Secrets are only ever resolved/stored server-side; responses carry metadata only.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from backend.lib import db, snowflake_client, token_status
from backend.lib.crypto import secret_fingerprint
from backend.routers import connections as connections_router
from backend.security import get_current_user

router = APIRouter(tags=["tokens"])

STATUSES = ("active", "expired", "revoked")
EXPIRING_SOON = timedelta(days=7)
# Secrets with no intrinsic validity: show "não se aplica" instead of "sem validade informada".
NO_EXPIRY_TYPES = ("password", "private_key")
FINGERPRINT_CHARS = 8

# Token types replaced by a user-supplied secret, and the connection auth_method they belong to.
SECRET_TYPE_METHOD = {"pat": "pat", "password": "password", "private_key": "keypair"}
# Types whose expiry the provider does not report, so a user may record it by hand.
MANUAL_EXPIRY_TYPES = ("pat", "private_key", "oauth_refresh")
OAUTH_METHODS = ("oauth", "local_oauth")
MAX_MANUAL_EXPIRY = timedelta(days=3650)

_COLUMNS = """
    v.id, v.connection_id, v.connection_name, v.account_identifier, v.username,
    v.role_name, v.auth_method, v.token_type, v.status, v.fingerprint,
    v.issued_at, v.expires_at, v.expires_at_source, v.last_refreshed_at, v.revoked_at,
    v.file_name, v.source, v.source_file, v.created_at, v.updated_at,
    (c.id IS NOT NULL) AS connection_exists, c.team_id, tm.name AS team_name,
    c.name AS conn_name, c.username AS conn_username, c.auth_method AS conn_auth_method,
    c.warehouse AS conn_warehouse, c.role_name AS conn_role_name,
    (c.pat_encrypted IS NOT NULL) AS conn_has_secret
"""

_FROM = """
    FROM v_connection_tokens v
    LEFT JOIN connections c ON c.id = v.connection_id
    LEFT JOIN teams tm ON tm.id = c.team_id
"""


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


def _expiry_note(row: dict) -> str | None:
    if row["expires_at"] is not None:
        return None
    if row["token_type"] in NO_EXPIRY_TYPES:
        return "não se aplica"
    return "sem validade informada"


def _matches_connection(row: dict) -> bool:
    """The row is (or was) the credential of the connection's current auth method."""
    if not row["connection_exists"]:
        return False
    method = row.get("conn_auth_method")
    if row["token_type"].startswith("oauth_"):
        return method in OAUTH_METHODS
    return SECRET_TYPE_METHOD.get(row["token_type"]) == method


def _actions(row: dict) -> dict:
    matches = _matches_connection(row)
    revoked = row["status"] == "revoked"
    oauth = row["token_type"].startswith("oauth_")
    return {
        "replace_secret": matches and not oauth,
        "edit_connection": matches and not revoked,
        "set_expiry": (
            matches
            and not revoked
            and row["token_type"] in MANUAL_EXPIRY_TYPES
            and row.get("expires_at_source") != "provider"
        ),
        "refresh": matches and oauth and not revoked and bool(row.get("conn_has_secret")),
        "reconnect": matches and oauth,
        "revoke": not revoked,
        "delete": revoked,
    }


def _public(row: dict) -> dict:
    fingerprint = row.get("fingerprint") or ""
    connection = None
    if row["connection_exists"]:
        connection = {
            "name": row.get("conn_name"),
            "username": row.get("conn_username"),
            "auth_method": row.get("conn_auth_method"),
            "warehouse": row.get("conn_warehouse"),
            "role_name": row.get("conn_role_name"),
            "has_secret": bool(row.get("conn_has_secret")),
        }
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
        "expires_at_source": row.get("expires_at_source"),
        "expiry_note": _expiry_note(row),
        "last_refreshed_at": _iso(row["last_refreshed_at"]),
        "revoked_at": _iso(row["revoked_at"]),
        "file_name": row["file_name"],
        "source": row["source"],
        "source_file": row["source_file"],
        "updated_at": _iso(row["updated_at"]),
        "connection": connection,
        "actions": _actions(row),
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
        {_FROM}
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


# ---------------------------------------------------------------- per-token edits


def _load(token_id: int) -> dict | None:
    with db.db_cursor() as cur:
        cur.execute(f"SELECT {_COLUMNS} {_FROM} WHERE v.id = %s", (token_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def _visible(user: dict, token_id: int) -> dict:
    """Row the user may edit; 404 for missing rows and for other teams' connections."""
    row = _load(token_id)
    if row and (
        user["role"] == "admin"
        or (row["connection_exists"] and db.user_can_access_connection(user, row["connection_id"]))
    ):
        return row
    raise HTTPException(status_code=404, detail="Token não encontrado.")


def _require(row: dict, action: str, detail: str) -> None:
    if not _actions(row)[action]:
        raise HTTPException(status_code=409, detail=detail)


def _result(token_id: int, message: str) -> dict:
    row = _load(token_id)
    return {"ok": True, "message": message, "token": _public(row) if row else None}


def _manual_expiry(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if value > now + MAX_MANUAL_EXPIRY:
        raise HTTPException(status_code=400, detail="Validade longe demais (máximo de 10 anos).")
    if value < now - MAX_MANUAL_EXPIRY:
        raise HTTPException(status_code=400, detail="Data de validade inválida.")
    return value


def _not_editable_detail(row: dict) -> str:
    if not row["connection_exists"]:
        return "A conexão deste token foi removida; só é possível excluir o registro."
    if not _matches_connection(row):
        return "A conexão agora usa outro método de autenticação; este registro é só histórico."
    return "Ação indisponível para este token."


@router.get("/api/tokens/{token_id}")
def get_token(token_id: int, user: dict = Depends(get_current_user)):
    return {"token": _public(_visible(user, token_id))}


class ReplaceSecret(connections_router.SecretInput):
    expires_at: datetime | None = None


@router.post("/api/tokens/{token_id}/secret")
def replace_secret(token_id: int, body: ReplaceSecret, user: dict = Depends(get_current_user)):
    """Swap the PAT / password / private key; Snowflake must accept it before it is saved."""
    row = _visible(user, token_id)
    _require(row, "replace_secret", _not_editable_detail(row))
    method = SECRET_TYPE_METHOD[row["token_type"]]
    expires_at = _manual_expiry(body.expires_at)
    secret, origin = connections_router._require_secret(user, method, body)

    conn = db.get_connection_by_id(row["connection_id"])
    ok, msg = snowflake_client.test_connection(
        account=conn["account_identifier"],
        user=conn["username"],
        auth_method=method,
        password=secret,
        authenticator_url=conn.get("authenticator_url"),
        warehouse=conn.get("warehouse"),
        role=conn.get("role_name"),
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)

    same = (
        row["status"] != "revoked"
        and bool(row.get("conn_has_secret"))
        and secret_fingerprint(secret) == row.get("fingerprint")
    )
    if same:
        message = "O valor informado é igual ao já salvo; a conexão foi testada e nada mudou."
    else:
        try:
            db.update_connection(
                row["connection_id"], secret=secret, update_secret=True, secret_source=origin
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        db.delete_cache_for_connection(row["connection_id"])
        message = f"Valor trocado e validado no Snowflake. {msg}"
    if body.expires_at is not None and row["token_type"] in MANUAL_EXPIRY_TYPES:
        db.set_token_expiry(token_id, expires_at)
    return _result(token_id, message)


class EditConnection(BaseModel):
    name: str | None = None
    username: str | None = None
    role_name: str | None = None
    warehouse: str | None = None


def _changed(new: str | None, old: str | None) -> bool:
    return new is not None and (new or None) != (old or None)


@router.patch("/api/tokens/{token_id}/connection")
def edit_connection(token_id: int, body: EditConnection, user: dict = Depends(get_current_user)):
    """Edit name / user / role / warehouse of the token's connection.

    Identity fields are tested with the stored credential first; persistence and
    cache invalidation reuse PATCH /api/connections/{id}.
    """
    row = _visible(user, token_id)
    _require(row, "edit_connection", _not_editable_detail(row))
    conn = db.get_connection_by_id(row["connection_id"])
    method = connections_router._normalize_method(conn.get("auth_method"))

    name = body.name.strip() if body.name is not None else None
    if name is not None and not name:
        raise HTTPException(status_code=400, detail="Informe um nome para a conexão.")
    username = body.username.strip() if body.username is not None else None
    if username is not None and not username:
        raise HTTPException(status_code=400, detail="Informe o usuário Snowflake.")
    role = body.role_name.strip() if body.role_name is not None else None
    warehouse = body.warehouse.strip() if body.warehouse is not None else None

    if (
        method in OAUTH_METHODS
        and username is not None
        and username.lower() != (conn["username"] or "").lower()
    ):
        raise HTTPException(
            status_code=400,
            detail="O token OAuth pertence ao usuário que fez login. Para trocar o usuário, "
            "use Reconectar via browser e entre com o outro usuário.",
        )

    identity_changed = (
        _changed(username, conn["username"])
        or _changed(role, conn.get("role_name"))
        or _changed(warehouse, conn.get("warehouse"))
    )
    if not identity_changed and not _changed(name, conn["name"]):
        return _result(token_id, "Nenhuma alteração para salvar.")

    message = "Nome da conexão atualizado."
    if identity_changed:
        try:
            creds = db.get_connection_credentials(row["connection_id"])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        creds = snowflake_client.ensure_fresh_oauth_credentials(
            creds, connection_id=row["connection_id"]
        )
        ok, msg = snowflake_client.test_connection(
            account=conn["account_identifier"],
            user=username if username is not None else conn["username"],
            auth_method=method,
            password=creds["password"],
            authenticator_url=conn.get("authenticator_url"),
            warehouse=warehouse if warehouse is not None else conn.get("warehouse"),
            role=role if role is not None else conn.get("role_name"),
        )
        if not ok:
            raise HTTPException(status_code=400, detail=msg)
        message = f"Dados da conexão salvos e validados no Snowflake. {msg}"

    connections_router.patch_connection(
        row["connection_id"],
        connections_router.ConnectionUpdate(
            name=name,
            username=username,
            role_name=role or None,
            warehouse=warehouse or None,
            clear_role=role == "",
            clear_warehouse=warehouse == "",
            revalidate=False,
        ),
        user,
    )
    return _result(token_id, message)


class SetExpiry(BaseModel):
    expires_at: datetime | None = None


@router.put("/api/tokens/{token_id}/expiry")
def set_expiry(token_id: int, body: SetExpiry, user: dict = Depends(get_current_user)):
    """Record (or clear) a manual expiry; sync and the status sweep keep it."""
    row = _visible(user, token_id)
    if row.get("expires_at_source") == "provider":
        detail = "A validade deste token vem do Snowflake e não pode ser editada."
    elif row["token_type"] not in MANUAL_EXPIRY_TYPES:
        detail = "Este tipo de credencial não tem validade."
    else:
        detail = _not_editable_detail(row)
    _require(row, "set_expiry", detail)
    expires_at = _manual_expiry(body.expires_at)
    db.set_token_expiry(token_id, expires_at)
    return _result(
        token_id,
        "Validade removida." if expires_at is None else "Validade manual salva.",
    )


class RevokeToken(BaseModel):
    confirm: bool = False


@router.post("/api/tokens/{token_id}/revoke")
def revoke_token(token_id: int, body: RevokeToken, user: dict = Depends(get_current_user)):
    """Erase the secret from the portal.

    Every live row mirrors the connection's stored credential, so revoking it
    clears that credential (all its tokens, e.g. OAuth access + refresh): the
    connection stays configured but cannot query Snowflake until a new value
    is saved or it is reconnected. Nothing is revoked on the Snowflake side.
    """
    row = _visible(user, token_id)
    _require(row, "revoke", "Este token já está revogado.")
    if not body.confirm:
        raise HTTPException(status_code=400, detail="Confirme a revogação (confirm=true).")
    if row["connection_exists"]:
        revoked = db.clear_connection_secret(row["connection_id"])
        name = row.get("conn_name") or row["connection_name"]
        message = (
            f"Credencial apagada do portal ({revoked} token(s) revogado(s)). "
            f"A conexão {name} fica sem credencial até você trocar o valor ou reconectar."
        )
    else:
        db.revoke_token_row(token_id)
        message = "Token revogado."
    return _result(token_id, message)


@router.delete("/api/tokens/{token_id}")
def delete_token(token_id: int, user: dict = Depends(get_current_user)):
    """Remove a revoked row from the history (live tokens must be revoked first)."""
    row = _visible(user, token_id)
    _require(row, "delete", "Só é possível excluir registros revogados. Revogue o token antes.")
    if not db.delete_revoked_token(token_id):
        raise HTTPException(status_code=404, detail="Token não encontrado.")
    return {"ok": True, "message": "Registro excluído do histórico."}


@router.post("/api/tokens/{token_id}/refresh")
def refresh_token(token_id: int, user: dict = Depends(get_current_user)):
    """Renew the OAuth access token now with the stored refresh token."""
    row = _visible(user, token_id)
    _require(row, "refresh", "Só tokens OAuth com credencial salva podem ser renovados.")
    try:
        creds = db.get_connection_credentials(row["connection_id"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        with snowflake_client._oauth_refresh_lock(creds, row["connection_id"]):
            snowflake_client.refresh_oauth_credentials(creds, connection_id=row["connection_id"])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=f"Não foi possível renovar o token OAuth: {str(exc)[:300]} "
            "Se o refresh token expirou ou foi revogado, use Reconectar via browser.",
        ) from exc
    return _result(token_id, "Token OAuth renovado agora.")
