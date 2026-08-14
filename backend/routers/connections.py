"""Snowflake connection catalog + browser OAuth callback."""
from __future__ import annotations

import json
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from backend.lib import db
from backend.lib import oauth_local
from backend.lib.snowflake_client import test_connection
from backend.security import get_current_user

router = APIRouter(tags=["connections"])


def _oauth_result_page(*, title: str, body: str, redirect_url: str, delay_ms: int = 1200) -> HTMLResponse:
    safe_title = title.replace("<", "")
    safe_body = body.replace("<", "")
    redirect_js = json.dumps(redirect_url)
    html = f"""<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8"/>
<title>{safe_title}</title>
<meta http-equiv="refresh" content="{max(delay_ms/1000, 0.5)};url={redirect_url}">
<style>
body{{font-family:system-ui,sans-serif;background:#0f1419;color:#e7ecf3;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}}
.card{{max-width:440px;padding:1.5rem 1.75rem;border:1px solid #2a3544;border-radius:12px;
background:#151b24}}
h1{{font-size:1.1rem;margin:0 0 .5rem}}
p{{margin:0;color:#9aa8bc;line-height:1.45;word-break:break-word}}
.spinner{{width:1.1rem;height:1.1rem;border:2px solid #2a3544;border-top-color:#5b9fff;
border-radius:50%;display:inline-block;animation:spin .8s linear infinite;margin-right:.5rem;
vertical-align:-.2rem}}
@keyframes spin{{to{{transform:rotate(360deg)}}}}
a{{color:#5b9fff}}
</style></head>
<body><div class="card">
<h1><span class="spinner"></span>{safe_title}</h1>
<p>{safe_body}</p>
<p style="margin-top:1rem;font-size:.85rem">Aguarde o retorno ao portal…
Se não redirecionar, <a href="{redirect_url}">clique aqui</a>.</p>
</div>
<script>setTimeout(function(){{location.replace({redirect_js})}}, {int(delay_ms)});</script>
</body></html>"""
    return HTMLResponse(html)


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


class ConnectionUpdate(BaseModel):
    name: str | None = None
    warehouse: str | None = None
    role_name: str | None = None
    clear_warehouse: bool = False
    clear_role: bool = False


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


@router.patch("/api/connections/{connection_id}")
def patch_connection(
    connection_id: int,
    body: ConnectionUpdate,
    user: dict = Depends(get_current_user),
):
    if not db.user_can_access_connection(user, connection_id):
        raise HTTPException(status_code=403, detail="Sem permissão para esta conexão.")
    if not db.get_connection_by_id(connection_id):
        raise HTTPException(status_code=404, detail="Conexão não encontrada.")
    try:
        row = db.update_connection(
            connection_id,
            name=body.name,
            warehouse=body.warehouse,
            role_name=body.role_name,
            clear_warehouse=body.clear_warehouse,
            clear_role=body.clear_role,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "connection": _serialize(row)}


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
@router.get("/")
def oauth_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = Query(None, alias="error_description"),
):
    """OAuth redirect target (http://127.0.0.1:8000). No JWT — uses state."""
    if not code and not state and not error:
        return {"status": "ok", "service": "snow_portal-api"}

    portal = oauth_local.portal_public_url().rstrip("/")
    fail_base = f"{portal}/conexoes?oauth=error"

    if error:
        msg = error_description or error
        return _oauth_result_page(
            title="Falha no login Snowflake",
            body=msg,
            redirect_url=f"{fail_base}&detail={urllib.parse.quote(msg[:300])}",
            delay_ms=2500,
        )

    if not code or not state:
        msg = "Callback OAuth sem code/state."
        return _oauth_result_page(
            title="Falha no login Snowflake",
            body=msg,
            redirect_url=f"{fail_base}&detail={urllib.parse.quote(msg)}",
            delay_ms=2500,
        )

    pending = oauth_local.pop_oauth_pending(state)
    if not pending:
        msg = "Sessão OAuth expirada ou inválida. Tente Conectar via browser de novo."
        return _oauth_result_page(
            title="Falha no login Snowflake",
            body=msg,
            redirect_url=f"{fail_base}&detail={urllib.parse.quote(msg)}",
            delay_ms=2500,
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
            return _oauth_result_page(
                title="Token obtido, mas conexão falhou",
                body=msg,
                redirect_url=f"{fail_base}&detail={urllib.parse.quote(msg[:300])}",
                delay_ms=3500,
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
        msg = str(exc)
        return _oauth_result_page(
            title="Aguardando retorno — falha ao finalizar",
            body=msg[:400],
            redirect_url=f"{fail_base}&detail={urllib.parse.quote(msg[:300])}",
            delay_ms=3500,
        )

    ok_url = f"{portal}/conexoes?oauth=ok&connection_id={conn_id}"
    return _oauth_result_page(
        title="Conectado com sucesso",
        body=f"Conta {pending['account']} autenticada. Voltando ao portal…",
        redirect_url=ok_url,
        delay_ms=1200,
    )
