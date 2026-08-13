"""Snowflake connection catalog."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.lib import db
from backend.lib.snowflake_client import test_connection
from backend.security import get_current_user

router = APIRouter(prefix="/api/connections", tags=["connections"])


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


@router.get("")
def list_connections(user: dict = Depends(get_current_user)):
    return [_serialize(c) for c in db.list_connections_for_user(user)]


@router.post("/test")
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


@router.post("")
def create_connection(body: ConnectionCreate, user: dict = Depends(get_current_user)):
    team_id = body.team_id or user.get("team_id")
    try:
        # Validate credentials before saving
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


@router.delete("/{connection_id}")
def delete_connection(connection_id: int, user: dict = Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Somente admin pode remover conexões.")
    if not db.get_connection_by_id(connection_id):
        raise HTTPException(status_code=404, detail="Conexão não encontrada.")
    db.delete_connection(connection_id)
    return {"ok": True}


@router.post("/{connection_id}/activate")
def activate_connection(connection_id: int, user: dict = Depends(get_current_user)):
    if not db.user_can_access_connection(user, connection_id):
        raise HTTPException(status_code=403, detail="Sem permissão para esta conexão.")
    row = db.get_connection_by_id(connection_id)
    if not row:
        raise HTTPException(status_code=404, detail="Conexão não encontrada.")
    return {"ok": True, "connection": _serialize(row)}
