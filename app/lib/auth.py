"""Portal session authentication."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import streamlit as st

from app.lib.config import get_settings
from app.lib import db


SESSION_USER_KEY = "portal_user"
SESSION_LOGIN_AT = "portal_login_at"
ACTIVE_CONNECTION_KEY = "active_connection_id"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def is_authenticated() -> bool:
    user = st.session_state.get(SESSION_USER_KEY)
    login_at = st.session_state.get(SESSION_LOGIN_AT)
    if not user or not login_at:
        return False
    timeout = timedelta(hours=get_settings()["session_timeout_hours"])
    if _utcnow() - login_at > timeout:
        logout()
        return False
    return True


def current_user() -> dict | None:
    if not is_authenticated():
        return None
    return st.session_state.get(SESSION_USER_KEY)


def require_login() -> dict:
    user = current_user()
    if not user:
        st.warning("Faça login para continuar.")
        st.stop()
    return user


def require_admin() -> dict:
    user = require_login()
    if user["role"] != "admin":
        st.error("Acesso restrito a administradores.")
        st.stop()
    return user


def login(username: str, password: str) -> tuple[bool, str]:
    db.ensure_bootstrap()
    user = db.get_user_by_username(username.strip())
    if not user or not db.verify_password(password, user["password_hash"]):
        return False, "Usuário ou senha inválidos."
    # Drop hash from session
    session_user = {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "team_id": user["team_id"],
        "team_name": user.get("team_name"),
    }
    st.session_state[SESSION_USER_KEY] = session_user
    st.session_state[SESSION_LOGIN_AT] = _utcnow()
    return True, "ok"


def logout() -> None:
    for key in (SESSION_USER_KEY, SESSION_LOGIN_AT, ACTIVE_CONNECTION_KEY):
        st.session_state.pop(key, None)


def get_active_connection_id() -> int | None:
    return st.session_state.get(ACTIVE_CONNECTION_KEY)


def set_active_connection_id(connection_id: int | None) -> None:
    if connection_id is None:
        st.session_state.pop(ACTIVE_CONNECTION_KEY, None)
    else:
        st.session_state[ACTIVE_CONNECTION_KEY] = connection_id
