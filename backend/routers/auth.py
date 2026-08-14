"""Auth routes — login is public; me/logout require JWT."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.lib import db
from backend.security import create_access_token, get_current_user, public_role

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


@router.post("/login")
def login(body: LoginRequest):
    db.ensure_bootstrap()
    user = db.get_user_by_username(body.username.strip())
    if not user or not db.verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")
    token = create_access_token(user)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "username": user["username"],
            "role": public_role(user["role"]),
            "team_id": user.get("team_id"),
            "team_name": user.get("team_name"),
        },
    }


@router.get("/me")
def me(user: dict = Depends(get_current_user)):
    return user


@router.post("/logout")
def logout(user: dict = Depends(get_current_user)):
    # JWT is client-side; logout is acknowledged for UX consistency
    return {"ok": True, "username": user["username"]}
