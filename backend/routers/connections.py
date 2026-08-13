"""Snowflake connection catalog + browser OAuth callback."""
from __future__ import annotations

import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from backend.lib import db
from backend.lib import oauth_local
from backend.lib.snowflake_client import test_connection
from backend.security import get_current_user

router = APIRouter(tags=["connections"])


class ConnectionCreate(BaseModel):
    name: str | None = None
    account_identifier: str = Field(min_length=1)
    username: str = Field(min_length=1)
    auth_method: str = "pat"
    secret: str | None = None
    authenticator_url: str | None = None
    warehouse: str | None = None
    role_name: str | None = None
    team_id: int | None = None


class ConnectionTest(BaseModel):
    account_identifier: str = Field(min_length=1)
    username: str = Field(min_length=1)
    auth_method: str = "pat"
    secret: str | None = None
    authenticator_url: str | None = None
    warehouse: str | None = None
    role_name: str | None = None


class OAuthStart(BaseModel):
    account_identifier: str = Field(min_length=1)
    username: str = Field(min_length=1)
    name: str | None = None
    warehouse: str | None = None
    role_name: str | None = None
    team_id: int | None = None


def _serialize(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "account_identifier": row["account_identifier"],
        "username": row["username"],
        "auth_method": row.get("auth_method") or "pat",
        "authenticator_url": row.get("authenticator_url"),
        "warehouse": row.get("warehouse"),
        "role_name": row.get("role_name"),
        "team_id": row.get("team_id"),
        "team_name": row.get("team_name"),
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }


@router.get("/api/connections")
def list_connections(user: dict = Depends(get_current_user)):
    return [_serialize(c) for c in db.list_connections_for_user(user)]


@router.post("/api/connections/test")
def test_conn(body: ConnectionTest, user: dict = Depends(get_current_user)):
    _ = user
    ok, msg = test_connection(
        account=body.account_identifier,
        user=body.username,
        auth_method=body.auth_method,
        password=body.secret,
        authenticator_url=body.authenticator_url,
        warehouse=body.warehouse,
        role=body.role_name,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@router.post("/api/connections")
def create_connection(body: ConnectionCreate, user: dict = Depends(get_current_user)):
    team_id = body.team_id or user.get("team_id")
    try:
        ok, msg = test_connection(
            account=body.account_identifier,
            user=body.username,
            auth_method=body.auth_method,
            password=body.secret,
            authenticator_url=body.authenticator_url,
            warehouse=body.warehouse,
            role=body.role_name,
        )
        if not ok:
            raise HTTPException(status_code=400, detail=msg)

        conn_id = db.create_connection(
            name=(body.name or "").strip() or body.account_identifier.strip(),
            account_identifier=body.account_identifier,
            username=body.username,
            auth_method=body.auth_method,
            secret=body.secret,
            authenticator_url=body.authenticator_url,
            warehouse=body.warehouse,
            role_name=body.role_name,
            created_by=user["id"],
            team_id=team_id,
            acl_team_ids=[team_id] if team_id else [],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    row = db.get_connection_by_id(conn_id)
    return {"ok": True, "message": msg, "connection": _serialize(row)}


@router.delete("/api/connections/{connection_id}")
def delete_connection(connection_id: int, user: dict = Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Somente admin pode remover conexões.")
    if not db.get_connection_by_id(connection_id):
        raise HTTPException(status_code=404, detail="Conexão não encontrada.")
    db.delete_connection(connection_id)
    return {"ok": True}


@router.post("/api/connections/{connection_id}/activate")
def activate_connection(connection_id: int, user: dict = Depends(get_current_user)):
    if not db.user_can_access_connection(user, connection_id):
        raise HTTPException(status_code=403, detail="Sem permissão para esta conexão.")
    row = db.get_connection_by_id(connection_id)
    if not row:
        raise HTTPException(status_code=404, detail="Conexão não encontrada.")
    return {"ok": True, "connection": _serialize(row)}


@router.post("/api/connections/oauth/start")
def oauth_start(body: OAuthStart, user: dict = Depends(get_current_user)):
    """Start Snowflake Local Application OAuth (browser login like Cortex)."""
    team_id = body.team_id or user.get("team_id")
    try:
        started = oauth_local.create_oauth_pending(
            portal_user_id=user["id"],
            account=body.account_identifier,
            username=body.username,
            name=body.name,
            warehouse=body.warehouse,
            role_name=body.role_name,
            team_id=team_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "authorize_url": started["authorize_url"],
        "redirect_uri": started["redirect_uri"],
        "message": "Abra o authorize_url no browser para concluir o login Snowflake.",
    }


@router.get("/api/oauth/callback")
def oauth_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = Query(None, alias="error_description"),
):
    """OAuth redirect target (must be http://127.0.0.1:…). No JWT — uses state."""
    portal = oauth_local.portal_public_url().rstrip("/")
    fail = f"{portal}/conexoes?oauth=error"

    if error:
        msg = urllib.parse.quote(error_description or error)
        return RedirectResponse(f"{fail}&detail={msg}", status_code=302)

    if not code or not state:
        return RedirectResponse(
            f"{fail}&detail={urllib.parse.quote('callback sem code/state')}",
            status_code=302,
        )

    pending = oauth_local.pop_oauth_pending(state)
    if not pending:
        return RedirectResponse(
            f"{fail}&detail={urllib.parse.quote('state inválido ou expirado')}",
            status_code=302,
        )

    try:
        tokens = oauth_local.exchange_authorization_code(
            account=pending["account"],
            code=code,
            code_verifier=pending["code_verifier"],
            redirect_uri=pending["redirect_uri"],
        )
        secret = oauth_local.pack_oauth_secret(tokens)
        username = (
            (tokens.get("username") or pending["username"] or "").strip()
            or pending["username"]
        )
        ok, msg = test_connection(
            account=pending["account"],
            user=username,
            auth_method="oauth",
            password=secret,
            warehouse=pending.get("warehouse"),
            role=pending.get("role_name"),
        )
        if not ok:
            return RedirectResponse(
                f"{fail}&detail={urllib.parse.quote(msg[:300])}",
                status_code=302,
            )

        team_id = pending.get("team_id")
        conn_id = db.create_connection(
            name=pending.get("name") or pending["account"],
            account_identifier=pending["account"],
            username=username,
            auth_method="oauth",
            secret=secret,
            warehouse=pending.get("warehouse"),
            role_name=pending.get("role_name"),
            created_by=pending["portal_user_id"],
            team_id=team_id,
            acl_team_ids=[team_id] if team_id else [],
        )
    except Exception as exc:  # noqa: BLE001
        return RedirectResponse(
            f"{fail}&detail={urllib.parse.quote(str(exc)[:300])}",
            status_code=302,
        )

    return RedirectResponse(
        f"{portal}/conexoes?oauth=ok&connection_id={conn_id}",
        status_code=302,
    )
