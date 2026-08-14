"""Admin — users and teams."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.lib import db
from backend.security import get_current_user, require_admin

router = APIRouter(prefix="/api", tags=["admin"])

VALID_ROLES = ("admin", "suporte", "analyst")


def normalize_role(role: str) -> str:
    value = (role or "").strip().lower()
    if value == "analyst":
        return "suporte"
    return value


def public_role(role: str) -> str:
    return "suporte" if role == "analyst" else role


class UserCreate(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
    role: str = "suporte"
    team_id: int | None = None


class UserUpdate(BaseModel):
    username: str | None = Field(default=None, min_length=1)
    password: str | None = None
    role: str | None = None
    team_id: int | None = None
    clear_team: bool = False
    is_active: bool | None = None


class TeamCreate(BaseModel):
    name: str = Field(min_length=1)


class TeamUpdate(BaseModel):
    name: str = Field(min_length=1)


@router.get("/users")
def list_users(user: dict = Depends(require_admin)):
    _ = user
    rows = db.list_users()
    return [
        {
            "id": u["id"],
            "username": u["username"],
            "role": public_role(u["role"]),
            "team_name": u.get("team_name"),
            "is_active": u["is_active"],
        }
        for u in rows
    ]


@router.post("/users")
def create_user(body: UserCreate, user: dict = Depends(require_admin)):
    _ = user
    role = normalize_role(body.role)
    if role not in ("admin", "suporte"):
        raise HTTPException(status_code=400, detail="Papel inválido.")
    try:
        db.create_user(body.username.strip(), body.password, role, body.team_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserUpdate, user: dict = Depends(require_admin)):
    _ = user
    role = normalize_role(body.role) if body.role is not None else None
    if role is not None and role not in ("admin", "suporte"):
        raise HTTPException(status_code=400, detail="Papel inválido.")
    try:
        ok = db.update_user(
            user_id,
            username=body.username.strip() if body.username is not None else None,
            password=body.password if body.password else None,
            role=role,
            team_id=body.team_id,
            clear_team=body.clear_team,
            is_active=body.is_active,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
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


@router.patch("/teams/{team_id}")
def update_team(team_id: int, body: TeamUpdate, user: dict = Depends(require_admin)):
    _ = user
    try:
        ok = db.update_team(team_id, body.name.strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(status_code=404, detail="Time não encontrado.")
    return {"ok": True}
