"""Admin — users and teams."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.lib import db
from backend.security import get_current_user, require_admin

router = APIRouter(prefix="/api", tags=["admin"])


class UserCreate(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
    role: str = "analyst"
    team_id: int | None = None


class TeamCreate(BaseModel):
    name: str = Field(min_length=1)


@router.get("/users")
def list_users(user: dict = Depends(require_admin)):
    _ = user
    rows = db.list_users()
    return [
        {
            "id": u["id"],
            "username": u["username"],
            "role": u["role"],
            "team_name": u.get("team_name"),
            "is_active": u["is_active"],
        }
        for u in rows
    ]


@router.post("/users")
def create_user(body: UserCreate, user: dict = Depends(require_admin)):
    _ = user
    if body.role not in ("admin", "analyst"):
        raise HTTPException(status_code=400, detail="Papel inválido.")
    try:
        db.create_user(body.username.strip(), body.password, body.role, body.team_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.get("/teams")
def list_teams(user: dict = Depends(get_current_user)):
    _ = user
    return db.list_teams()


@router.post("/teams")
def create_team(body: TeamCreate, user: dict = Depends(require_admin)):
    _ = user
    try:
        team_id = db.create_team(body.name.strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "id": team_id}
