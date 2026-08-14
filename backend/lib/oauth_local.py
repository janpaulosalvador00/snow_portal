"""Snowflake Local Application OAuth (browser login, no PAT)."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.parse
from typing import Any

import requests

from backend.lib.config import get_settings
from backend.lib.snowflake_client import normalize_account_identifier

CLIENT_ID = "LOCAL_APPLICATION"
_PENDING: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()
_PENDING_TTL_SEC = 600


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
    # LOCAL_APPLICATION expects http://127.0.0.1[:port] (empty path, like the drivers)
    return (settings.get("oauth_redirect_uri") or "http://127.0.0.1:8000").rstrip("/")


def portal_public_url() -> str:
    settings = get_settings()
    return settings.get("portal_public_url") or "http://localhost:8501"


def _purge_expired() -> None:
    now = time.time()
    dead = [k for k, v in _PENDING.items() if now - v.get("created_at", 0) > _PENDING_TTL_SEC]
    for k in dead:
        _PENDING.pop(k, None)


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
    verifier, challenge = make_pkce()
    state = secrets.token_urlsafe(24)
    redirect_uri = oauth_redirect_uri()
    acct = normalize_account_identifier(account)
    scope_parts = ["refresh_token"]
    if role_name and role_name.strip():
        scope_parts.append(f"session:role:{role_name.strip()}")
    scope = " ".join(scope_parts)
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "state": state,
        "scope": scope,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    authorize_url = f"{account_base_url(acct)}/oauth/authorize?{urllib.parse.urlencode(params)}"
    with _LOCK:
        _purge_expired()
        _PENDING[state] = {
            "created_at": time.time(),
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
        }
    return {"authorize_url": authorize_url, "state": state, "redirect_uri": redirect_uri}


def pop_oauth_pending(state: str) -> dict[str, Any] | None:
    with _LOCK:
        _purge_expired()
        return _PENDING.pop(state, None)


def exchange_authorization_code(
    *,
    account: str,
    code: str,
    code_verifier: str,
    redirect_uri: str,
) -> dict[str, Any]:
    token_url = f"{account_base_url(account)}/oauth/token-request"
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": CLIENT_ID,
        "code_verifier": code_verifier,
    }
    resp = requests.post(
        token_url,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
        timeout=60,
    )
    if resp.status_code >= 400:
        detail = resp.text[:400]
        raise RuntimeError(f"Falha ao trocar code por token OAuth ({resp.status_code}): {detail}")
    payload = resp.json()
    if not payload.get("access_token"):
        raise RuntimeError(f"Resposta OAuth sem access_token: {payload}")
    return payload


def refresh_access_token(*, account: str, refresh_token: str) -> dict[str, Any]:
    token_url = f"{account_base_url(account)}/oauth/token-request"
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
    }
    resp = requests.post(
        token_url,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
        timeout=60,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Falha ao renovar token OAuth ({resp.status_code}): {resp.text[:300]}")
    return resp.json()


def pack_oauth_secret(token_payload: dict[str, Any]) -> str:
    return json.dumps(
        {
            "access_token": token_payload.get("access_token"),
            "refresh_token": token_payload.get("refresh_token"),
            "token_type": token_payload.get("token_type", "Bearer"),
            "expires_in": token_payload.get("expires_in"),
            "username": token_payload.get("username"),
        },
        separators=(",", ":"),
    )


def unpack_oauth_secret(secret: str) -> dict[str, Any]:
    secret = (secret or "").strip()
    if secret.startswith("{"):
        return json.loads(secret)
    return {"access_token": secret}
