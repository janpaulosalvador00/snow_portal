"""Snowflake connection catalog + browser OAuth callback."""
from __future__ import annotations

import json
import logging
import urllib.parse
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from backend.lib import db
from backend.lib import oauth_local
from backend.lib import snowflake_cache as cache
from backend.lib import token_sources
from backend.lib.snowflake_client import (
    discover_session_options,
    friendly_connect_error,
    test_connection,
)
from backend.security import get_current_user

router = APIRouter(tags=["connections"])
logger = logging.getLogger(__name__)


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


class SecretInput(BaseModel):
    """Credential for PAT / password / key pair, from exactly one origin.

    ``token_id`` reuses a row of connection_tokens and ``token_file`` reads a file
    from the tokens folder (both server-side); ``secret`` is typed/pasted or the
    content of a browser upload (``secret_source='upload'`` + ``secret_file_name``).
    """

    secret: str | None = None
    secret_source: str | None = None
    secret_file_name: str | None = None
    token_id: int | None = None
    token_file: str | None = None
    passphrase: str | None = None

    def has_secret_input(self) -> bool:
        return bool(
            (self.secret or "").strip() or self.token_id is not None or (self.token_file or "").strip()
        )


class ConnectionCreate(SecretInput):
    name: str | None = None
    account_identifier: str = Field(min_length=1)
    username: str = Field(min_length=1)
    auth_method: str = "pat"
    authenticator_url: str | None = None
    warehouse: str | None = None
    role_name: str | None = None
    team_id: int | None = None
    options: dict[str, Any] | None = None


class ConnectionTest(SecretInput):
    account_identifier: str = Field(min_length=1)
    username: str = Field(min_length=1)
    auth_method: str = "pat"
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
    connection_id: int | None = None


class ConnectionUpdate(SecretInput):
    name: str | None = None
    account_identifier: str | None = None
    username: str | None = None
    auth_method: str | None = None
    authenticator_url: str | None = None
    warehouse: str | None = None
    role_name: str | None = None
    clear_warehouse: bool = False
    clear_role: bool = False
    revalidate: bool = True


class ConnectionDiscover(SecretInput):
    """Ad-hoc credentials for Sign-in form before a connection is saved."""

    account_identifier: str = Field(min_length=1)
    username: str = Field(min_length=1)
    auth_method: str = "pat"
    authenticator_url: str | None = None
    warehouse: str | None = None
    role_name: str | None = None


SECRET_REQUIRED_METHODS = tuple(db.TOKEN_TYPE_FOR_METHOD)
_MISSING_SECRET = {
    "pat": "Escolha um token salvo, selecione um arquivo ou cole o PAT.",
    "password": "Informe a senha do usuário Snowflake.",
    "keypair": "Escolha uma chave salva ou selecione o arquivo da chave privada (.p8).",
}


def _normalize_method(raw: str | None) -> str:
    method = (raw or "pat").strip().lower()
    return "oauth" if method == "browser_oauth" else method


def _resolve_secret(user: dict, method: str, body: SecretInput) -> tuple[str | None, dict | None]:
    try:
        return token_sources.resolve_secret(
            user,
            method,
            secret=body.secret,
            secret_source=body.secret_source,
            secret_file_name=body.secret_file_name,
            token_id=body.token_id,
            token_file=body.token_file,
            passphrase=body.passphrase,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _require_secret(user: dict, method: str, body: SecretInput) -> tuple[str | None, dict | None]:
    secret, origin = _resolve_secret(user, method, body)
    if method in SECRET_REQUIRED_METHODS and not secret:
        raise HTTPException(status_code=400, detail=_MISSING_SECRET[method])
    return secret, origin


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
    method = _normalize_method(body.auth_method)
    secret, _origin = _require_secret(user, method, body)
    ok, msg = test_connection(
        account=body.account_identifier,
        user=body.username,
        auth_method=method,
        password=secret,
        authenticator_url=body.authenticator_url,
        warehouse=body.warehouse,
        role=body.role_name,
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


def _heal_warehouse(connection_id: int, options: dict) -> str | None:
    """Persist the suggested warehouse when the stored one no longer exists.

    Only call with fresh Snowflake data, never with a cached payload.
    """
    if options.get("stored_warehouse_exists") is not False:
        return None
    suggested = (options.get("suggested_warehouse") or "").strip()
    if not suggested:
        return None
    try:
        db.update_connection(connection_id, warehouse=suggested)
    except ValueError:
        return None
    options["stored_warehouse_exists"] = True
    cache.store(
        connection_id,
        "options",
        {},
        {k: v for k, v in options.items() if k not in ("cached", "fetched_at")},
    )
    return suggested


def _access_creds(user: dict, connection_id: int) -> dict:
    if not db.user_can_access_connection(user, connection_id):
        raise HTTPException(status_code=403, detail="Sem permissão para esta conexão.")
    try:
        return db.get_connection_credentials(connection_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/connections/{connection_id}/options")
def connection_options(
    connection_id: int,
    refresh: bool = Query(False),
    user: dict = Depends(get_current_user),
):
    """Warehouses and roles for a saved connection, from the Postgres cache.

    Snowflake is queried only when nothing is cached or ``refresh=1``. A dead
    stored warehouse is healed only from fresh data.
    """
    creds = _access_creds(user, connection_id)
    try:
        options = cache.cached_fetch(
            connection_id, "options", {}, creds=creds, force=refresh
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    warehouse_auto_saved = None if options.get("cached") else _heal_warehouse(connection_id, options)
    return {
        "ok": True,
        **options,
        "warehouse_auto_saved": warehouse_auto_saved,
    }


@router.post("/api/connections/{connection_id}/refresh")
def refresh_connection_data(connection_id: int, user: dict = Depends(get_current_user)):
    """Re-query Snowflake for every screen/tab dataset of this connection and store it."""
    creds = _access_creds(user, connection_id)
    results = cache.refresh_connection(connection_id, creds)
    warehouse_auto_saved = None
    for entry in results:
        payload = entry.pop("payload", None)
        if payload is not None:
            warehouse_auto_saved = _heal_warehouse(connection_id, payload)
    failed = [r for r in results if not r["ok"]]
    return {
        "ok": not failed,
        "refreshed_at": datetime.now(timezone.utc).isoformat(),
        "total": len(results),
        "failed": len(failed),
        "results": results,
        "warehouse_auto_saved": warehouse_auto_saved,
    }


@router.post("/api/connections/discover")
def discover_options(body: ConnectionDiscover, user: dict = Depends(get_current_user)):
    """Discover WH/roles with ad-hoc credentials (Sign-in / before save)."""
    method = _normalize_method(body.auth_method)
    if method in ("oauth", "local_oauth") and not (body.secret or "").strip():
        raise HTTPException(
            status_code=400,
            detail="Browser OAuth precisa de token salvo. Após conectar, use Editar → atualizar lista.",
        )
    secret, _origin = _require_secret(user, method, body)
    try:
        options = discover_session_options(
            account=body.account_identifier,
            user=body.username,
            auth_method=method,
            password=secret,
            authenticator_url=body.authenticator_url,
            warehouse=body.warehouse,
            role=body.role_name,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=friendly_connect_error(exc, auth_method=method, secret=secret),
        ) from exc
    return {"ok": True, **options}


@router.post("/api/connections")
def create_connection(body: ConnectionCreate, user: dict = Depends(get_current_user)):
    team_id = body.team_id or user.get("team_id")
    method = _normalize_method(body.auth_method)
    secret, origin = _require_secret(user, method, body)
    try:
        ok, msg = test_connection(
            account=body.account_identifier,
            user=body.username,
            auth_method=method,
            password=secret,
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
            auth_method=method,
            secret=secret,
            authenticator_url=body.authenticator_url,
            warehouse=body.warehouse,
            role_name=body.role_name,
            created_by=user["id"],
            team_id=team_id,
            acl_team_ids=[team_id] if team_id else [],
            secret_source=origin,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if body.options:
        try:
            cache.store(
                conn_id,
                "options",
                {},
                {k: v for k, v in body.options.items() if k not in ("ok", "cached", "fetched_at")},
            )
        except Exception:  # noqa: BLE001
            logger.warning("could not cache discover options for connection %s", conn_id)

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
    existing = db.get_connection_by_id(connection_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Conexão não encontrada.")

    method = _normalize_method(body.auth_method or existing.get("auth_method"))
    secret, origin = (
        _resolve_secret(user, method, body) if body.has_secret_input() else (None, None)
    )

    method_changed = method != _normalize_method(existing.get("auth_method"))
    if method_changed and method in SECRET_REQUIRED_METHODS and not secret:
        raise HTTPException(status_code=400, detail=_MISSING_SECRET[method])

    message = "Conexão atualizada."
    # Full revalidation like a new signup (PAT/password/key pair require a credential)
    if body.revalidate and method in SECRET_REQUIRED_METHODS:
        if not secret:
            raise HTTPException(status_code=400, detail=_MISSING_SECRET[method])
        ok, msg = test_connection(
            account=body.account_identifier or existing["account_identifier"],
            user=body.username or existing["username"],
            auth_method=method,
            password=secret,
            authenticator_url=body.authenticator_url,
            warehouse=None
            if body.clear_warehouse
            else (
                body.warehouse
                if body.warehouse is not None
                else existing.get("warehouse")
            ),
            role=None
            if body.clear_role
            else (
                body.role_name if body.role_name is not None else existing.get("role_name")
            ),
        )
        if not ok:
            raise HTTPException(status_code=400, detail=msg)
        message = msg
    elif body.revalidate and method in ("oauth", "local_oauth"):
        raise HTTPException(
            status_code=400,
            detail="Para revalidar Browser OAuth, use 'Reconectar via browser' (não PATCH com secret).",
        )

    try:
        row = db.update_connection(
            connection_id,
            name=body.name,
            account_identifier=body.account_identifier,
            username=body.username,
            auth_method=method,
            secret=secret,
            authenticator_url=body.authenticator_url,
            warehouse=body.warehouse,
            role_name=body.role_name,
            clear_warehouse=body.clear_warehouse,
            clear_role=body.clear_role,
            update_secret=bool(secret) and method in db.SECRET_METHODS,
            secret_source=origin,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    identity_changed = (
        bool(secret)
        or (
            body.account_identifier is not None
            and row["account_identifier"] != existing["account_identifier"]
        )
        or (body.username is not None and row["username"] != existing["username"])
        or (row.get("auth_method") or "pat") != (existing.get("auth_method") or "pat")
        # Role changes what ACCOUNT_USAGE / SHOW commands return.
        or (row.get("role_name") or "") != (existing.get("role_name") or "")
    )
    if identity_changed:
        db.delete_cache_for_connection(connection_id)

    return {"ok": True, "message": message, "connection": _serialize(row)}


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
    if body.connection_id is not None:
        if not db.user_can_access_connection(user, body.connection_id):
            raise HTTPException(status_code=403, detail="Sem permissão para esta conexão.")
        if not db.get_connection_by_id(body.connection_id):
            raise HTTPException(status_code=404, detail="Conexão não encontrada.")
    try:
        started = oauth_local.create_oauth_pending(
            portal_user_id=user["id"],
            account=body.account_identifier,
            username=body.username,
            name=body.name,
            warehouse=body.warehouse,
            role_name=body.role_name,
            team_id=team_id,
            connection_id=body.connection_id,
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
    """OAuth redirect target (http://127.0.0.1:8010). No JWT — uses state."""
    if not code and not state and not error:
        return {"status": "ok", "service": "snow_portal-api"}

    portal = oauth_local.portal_public_url().rstrip("/")
    fail_base = f"{portal}/conexoes?oauth=error"

    if error:
        msg = error_description or error
        logger.warning("oauth_callback error=%s detail=%s", error, msg)
        return _oauth_result_page(
            title="Falha no login Snowflake",
            body=msg,
            redirect_url=f"{fail_base}&detail={urllib.parse.quote(msg[:300])}",
            delay_ms=2500,
        )

    if not code or not state:
        msg = "Callback OAuth sem code/state."
        logger.warning("oauth_callback missing code/state")
        return _oauth_result_page(
            title="Falha no login Snowflake",
            body=msg,
            redirect_url=f"{fail_base}&detail={urllib.parse.quote(msg)}",
            delay_ms=2500,
        )

    pending = oauth_local.pop_oauth_pending(state)
    if not pending:
        msg = "Sessão OAuth expirada ou inválida. Tente Conectar via browser de novo."
        logger.warning("oauth_callback pending miss state=%s…", state[:8])
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
            client_id=pending.get("client_id"),
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
            logger.warning(
                "oauth_callback test_connection failed account=%s: %s",
                pending["account"],
                msg[:200],
            )
            return _oauth_result_page(
                title="Token obtido, mas conexão falhou",
                body=msg,
                redirect_url=f"{fail_base}&detail={urllib.parse.quote(msg[:300])}",
                delay_ms=3500,
            )

        team_id = pending.get("team_id")
        existing_id = pending.get("connection_id")
        if existing_id:
            db.update_connection(
                int(existing_id),
                name=pending.get("name") or pending["account"],
                account_identifier=pending["account"],
                username=username,
                auth_method="oauth",
                secret=secret,
                warehouse=pending.get("warehouse"),
                role_name=pending.get("role_name"),
                clear_warehouse=not pending.get("warehouse"),
                clear_role=not pending.get("role_name"),
                update_secret=True,
            )
            conn_id = int(existing_id)
            db.delete_cache_for_connection(conn_id)
        else:
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
        logger.info(
            "oauth_callback saved connection_id=%s name=%s account=%s",
            conn_id,
            pending.get("name"),
            pending["account"],
        )
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        logger.exception("oauth_callback finalize failed: %s", msg[:300])
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
