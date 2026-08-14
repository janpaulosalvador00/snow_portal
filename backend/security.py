"""JWT helpers for portal authentication."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.lib import db
from backend.lib.config import get_settings

security = HTTPBearer(auto_error=False)


def public_role(role: str | None) -> str:
    value = (role or "").strip().lower()
    return "suporte" if value == "analyst" else value


def create_access_token(user: dict) -> str:
    settings = get_settings()
    hours = int(settings.get("session_timeout_hours", 12))
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "role": public_role(user["role"]),
        "team_id": user.get("team_id"),
        "exp": datetime.now(timezone.utc) + timedelta(hours=hours),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, settings["secret_key"], algorithm="HS256")


def decode_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        return jwt.decode(token, settings["secret_key"], algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido ou expirado.",
        ) from exc


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict:
    if not creds or not creds.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Autenticação necessária.",
        )
    payload = decode_token(creds.credentials)
    user = db.get_user_by_username(payload.get("username", ""))
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário não encontrado.",
        )
    return {
        "id": user["id"],
        "username": user["username"],
        "role": public_role(user["role"]),
        "team_id": user.get("team_id"),
        "team_name": user.get("team_name"),
    }


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Acesso restrito a administradores.")
    return user
