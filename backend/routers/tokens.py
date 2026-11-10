"""Reusable connection secrets: saved tokens (metadata only) and tokens-folder files."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.lib import db, token_sources
from backend.security import get_current_user

router = APIRouter(tags=["connection-tokens"])

FILE_KIND_FOR_METHOD = {"pat": "token", "keypair": "private_key"}


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


def _token_type(method: str | None, token_type: str | None) -> str | None:
    if token_type:
        if token_type not in db.TOKEN_TYPE_FOR_METHOD.values():
            raise HTTPException(status_code=400, detail=f"token_type inválido: {token_type}")
        return token_type
    if method:
        if method not in db.TOKEN_TYPE_FOR_METHOD:
            raise HTTPException(status_code=400, detail=f"Método sem token reutilizável: {method}")
        return db.TOKEN_TYPE_FOR_METHOD[method]
    return None


@router.get("/api/connection-tokens")
def list_tokens(
    method: str | None = Query(None, description="pat | password | keypair"),
    token_type: str | None = Query(None, description="pat | password | private_key"),
    user: dict = Depends(get_current_user),
):
    """Saved, non-revoked secrets the user can reuse. Never includes the secret itself."""
    rows = db.list_saved_tokens(user, token_type=_token_type(method, token_type))
    return [
        {
            "id": r["id"],
            "token_type": r["token_type"],
            "auth_method": r["auth_method"],
            "status": r["status"],
            "connection_id": r["connection_id"],
            "connection_name": r["connection_name"],
            "account_identifier": r["account_identifier"],
            "username": r["username"],
            "role_name": r["role_name"],
            "fingerprint": r["fingerprint"],
            "issued_at": _iso(r["issued_at"]),
            "expires_at": _iso(r["expires_at"]),
            "updated_at": _iso(r["updated_at"]),
            "source": r["source"],
            "source_file": r["source_file"],
            "connections": r["connections"],
        }
        for r in rows
    ]


@router.get("/api/connection-tokens/files")
def list_token_files(
    method: str | None = Query(None, description="pat | keypair"),
    user: dict = Depends(get_current_user),
):
    """Secret-like files in the tokens folder: name, size, date and kind only."""
    _ = user
    kind = FILE_KIND_FOR_METHOD.get(method or "")
    if method and kind is None:
        raise HTTPException(status_code=400, detail=f"Método sem arquivo de token: {method}")
    return token_sources.list_folder_files(kind)
