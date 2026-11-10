"""Snowflake browser OAuth (no PAT).

Default: ``SNOWFLAKE$LOCAL_APPLICATION`` + PKCE, redirect on localhost only.
With ``OAUTH_CLIENT_ID``/``OAUTH_CLIENT_SECRET`` set: a CUSTOM confidential security
integration, which accepts a public HTTPS redirect (e.g. .../api/oauth/callback).
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import time
import urllib.parse
from typing import Any

import requests

from backend.lib import db
from backend.lib.config import get_settings
from backend.lib.snowflake_client import normalize_account_identifier

CLIENT_ID = "LOCAL_APPLICATION"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:8010"
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
_PENDING_TTL_SEC = 600
logger = logging.getLogger(__name__)


def custom_client() -> tuple[str, str] | None:
    """(client_id, client_secret) of the CUSTOM integration, or None for LOCAL_APPLICATION."""
    settings = get_settings()
    client_id = (settings.get("oauth_client_id") or "").strip()
    client_secret = (settings.get("oauth_client_secret") or "").strip()
    if not client_id and not client_secret:
        return None
    if not client_id or not client_secret:
        raise ValueError(
            "Configure OAUTH_CLIENT_ID e OAUTH_CLIENT_SECRET juntos (integração OAuth CUSTOM) "
            "ou deixe os dois vazios para usar o LOCAL_APPLICATION."
        )
    return client_id, client_secret


def active_client_id() -> str:
    client = custom_client()
    return client[0] if client else CLIENT_ID


def _is_loopback_uri(uri: str) -> bool:
    host = (urllib.parse.urlparse(uri).hostname or "").lower()
    return host in _LOOPBACK_HOSTS


def _token_request(account: str, data: dict[str, str], client_id: str | None) -> requests.Response:
    """POST to /oauth/token-request; Basic auth for CUSTOM clients, client_id in body for local."""
    token_url = f"{account_base_url(account)}/oauth/token-request"
    payload = dict(data)
    auth: tuple[str, str] | None = None
    cid = (client_id or CLIENT_ID).strip()
    if cid == CLIENT_ID:
        payload["client_id"] = CLIENT_ID
    else:
        client = custom_client()
        if not client or client[0] != cid:
            raise RuntimeError(
                "Este token foi emitido por outra integração OAuth (client_id diferente do "
                "OAUTH_CLIENT_ID atual). Refaça Conectar via browser."
            )
        auth = client
    return requests.post(
        token_url,
        data=payload,
        auth=auth,
        headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
        timeout=60,
    )


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def make_pkce() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def account_host(account: str) -> str:
    """Hostname for Snowflake HTTPS endpoints (underscores → hyphens per Snowflake docs)."""
    acct = normalize_account_identifier(account).lower().replace("_", "-")
    return f"{acct}.snowflakecomputing.com"


def account_base_url(account: str) -> str:
    return f"https://{account_host(account)}"


def oauth_redirect_uri() -> str:
    settings = get_settings()
    raw = (settings.get("oauth_redirect_uri") or "").strip() or DEFAULT_REDIRECT_URI
    # LOCAL_APPLICATION expects http://127.0.0.1[:port] (empty path, like the drivers).
    # A path (e.g. /api/oauth/callback) must match the integration's OAUTH_REDIRECT_URI byte for byte.
    if urllib.parse.urlparse(raw).path in ("", "/"):
        return raw.rstrip("/")
    return raw


def portal_public_url() -> str:
    settings = get_settings()
    return settings.get("portal_public_url") or "http://localhost:8501"


def create_oauth_pending(
    *,
    portal_user_id: int,
    account: str,
    username: str,
    name: str | None,
    warehouse: str | None,
    role_name: str | None,
    team_id: int | None,
    connection_id: int | None = None,
) -> dict[str, str]:
    redirect_uri = oauth_redirect_uri()
    client_id = active_client_id()
    if client_id == CLIENT_ID and not _is_loopback_uri(redirect_uri):
        raise ValueError(
            f"OAUTH_REDIRECT_URI={redirect_uri} não é localhost, e o SNOWFLAKE$LOCAL_APPLICATION "
            "só aceita redirect em 127.0.0.1/localhost. Para um endereço público crie uma "
            "security integration OAuth CUSTOM no Snowflake e configure OAUTH_CLIENT_ID e "
            "OAUTH_CLIENT_SECRET (veja o README)."
        )
    verifier, challenge = make_pkce()
    state = secrets.token_urlsafe(24)
    acct = normalize_account_identifier(account)
    scope_parts = ["refresh_token"]
    if role_name and role_name.strip():
        scope_parts.append(f"session:role:{role_name.strip()}")
    scope = " ".join(scope_parts)
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "state": state,
        "scope": scope,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    authorize_url = f"{account_base_url(acct)}/oauth/authorize?{urllib.parse.urlencode(params)}"
    payload = {
        "portal_user_id": portal_user_id,
        "account": acct,
        "username": username.strip(),
        "name": (name or "").strip() or acct,
        "warehouse": warehouse or None,
        "role_name": role_name or None,
        "team_id": team_id,
        "connection_id": connection_id,
        "code_verifier": verifier,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
    }
    # Persist in Postgres so docker/api restarts mid-login do not drop the PKCE session.
    db.put_oauth_pending(state, payload, ttl_sec=_PENDING_TTL_SEC)
    logger.info(
        "oauth_pending created state=%s… account=%s name=%s",
        state[:8],
        acct,
        payload["name"],
    )
    return {"authorize_url": authorize_url, "state": state, "redirect_uri": redirect_uri}


def pop_oauth_pending(state: str) -> dict[str, Any] | None:
    pending = db.pop_oauth_pending(state, ttl_sec=_PENDING_TTL_SEC)
    if not pending:
        logger.warning("oauth_pending missing/expired state=%s…", (state or "")[:8])
    return pending


def exchange_authorization_code(
    *,
    account: str,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    client_id: str | None = None,
) -> dict[str, Any]:
    cid = client_id or active_client_id()
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    resp = _token_request(account, data, cid)
    if resp.status_code >= 400:
        detail = resp.text[:400]
        raise RuntimeError(f"Falha ao trocar code por token OAuth ({resp.status_code}): {detail}")
    payload = resp.json()
    if not payload.get("access_token"):
        raise RuntimeError(f"Resposta OAuth sem access_token: {payload}")
    payload["client_id"] = cid
    return payload


def refresh_access_token(
    *, account: str, refresh_token: str, client_id: str | None = None
) -> dict[str, Any]:
    """Refresh with the client that issued the token (blobs without client_id = LOCAL_APPLICATION)."""
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }
    resp = _token_request(account, data, client_id or CLIENT_ID)
    if resp.status_code >= 400:
        raise RuntimeError(f"Falha ao renovar token OAuth ({resp.status_code}): {resp.text[:300]}")
    return resp.json()


def _absolute_expiry(token_payload: dict[str, Any], key: str, now: int) -> int | None:
    """Epoch seconds for ``<key>_expires_at``; an explicit ``*_expires_at`` (even None) wins."""
    at_key = f"{key}expires_at"
    if at_key in token_payload:
        return token_payload.get(at_key)
    expires_in = token_payload.get(f"{key}expires_in")
    try:
        return now + int(expires_in) if expires_in else None
    except (TypeError, ValueError):
        return None


def pack_oauth_secret(token_payload: dict[str, Any]) -> str:
    now = int(time.time())
    return json.dumps(
        {
            "access_token": token_payload.get("access_token"),
            "refresh_token": token_payload.get("refresh_token"),
            "token_type": token_payload.get("token_type", "Bearer"),
            "expires_in": token_payload.get("expires_in"),
            "expires_at": _absolute_expiry(token_payload, "", now),
            "refresh_token_expires_in": token_payload.get("refresh_token_expires_in"),
            "refresh_token_expires_at": _absolute_expiry(token_payload, "refresh_token_", now),
            "username": token_payload.get("username"),
            "client_id": token_payload.get("client_id"),
        },
        separators=(",", ":"),
    )


def unpack_oauth_secret(secret: str) -> dict[str, Any]:
    secret = (secret or "").strip()
    if secret.startswith("{"):
        return json.loads(secret)
    return {"access_token": secret}
