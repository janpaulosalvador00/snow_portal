"""Administração de usuários e times (admin)."""
from __future__ import annotations

import streamlit as st

from app.lib import auth, db
from app.lib.ui import inject_theme, page_setup, render_sidebar_user

page_setup("Administração")
inject_theme()

user = auth.require_admin()
render_sidebar_user(user)
with st.sidebar:
    if st.button("Sair", key="logout_admin"):
        auth.logout()
        st.rerun()

st.markdown("## Administração")
st.caption("Gerencie usuários do portal (capacidade ≥ 20 operadores).")

tab_users, tab_teams = st.tabs(["Usuários", "Times"])

with tab_users:
    st.markdown("### Usuários cadastrados")
    users = db.list_users()
    if users:
        st.dataframe(
            [
                {
                    "id": u["id"],
                    "username": u["username"],
                    "role": u["role"],
                    "team": u.get("team_name"),
                    "ativo": u["is_active"],
                }
                for u in users
            ],
            use_container_width=True,
            hide_index=True,
        )
    else:
        st.info("Nenhum usuário.")

    st.markdown("### Novo usuário")
    teams = db.list_teams()
    team_map = {t["name"]: t["id"] for t in teams}
    with st.form("create_user"):
        username = st.text_input("Username")
        password = st.text_input("Senha temporária", type="password")
        role = st.selectbox("Papel", ["analyst", "admin"])
        team_name = st.selectbox("Time", list(team_map.keys()) if team_map else ["—"])
        if st.form_submit_button("Criar usuário", type="primary"):
            if not username or not password:
                st.error("Username e senha são obrigatórios.")
            else:
                try:
                    db.create_user(
                        username=username.strip(),
                        password=password,
                        role=role,
                        team_id=team_map.get(team_name),
                    )
                    st.success(f"Usuário {username} criado.")
                    st.rerun()
                except Exception as exc:  # noqa: BLE001
                    st.error(str(exc))

with tab_teams:
    st.markdown("### Times")
    for t in db.list_teams():
        st.write(f"- {t['name']} (id={t['id']})")

    with st.form("create_team"):
        name = st.text_input("Nome do time")
        if st.form_submit_button("Criar time", type="primary"):
            if not name.strip():
                st.error("Informe o nome.")
            else:
                try:
                    db.create_team(name.strip())
                    st.success("Time criado.")
                    st.rerun()
                except Exception as exc:  # noqa: BLE001
                    st.error(str(exc))
