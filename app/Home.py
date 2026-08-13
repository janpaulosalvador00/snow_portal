"""snow_portal — login do time e hub inicial."""
from __future__ import annotations

import streamlit as st

from app.lib import auth, db
from app.lib.ui import inject_theme, page_setup, render_sidebar_user


page_setup("Início")


def render_login() -> None:
    st.markdown("## Entrar no snow_portal")
    st.caption("Autenticação do time de suporte — distinta da conexão Snowflake.")
    with st.form("login_form"):
        username = st.text_input("Usuário")
        password = st.text_input("Senha", type="password")
        submitted = st.form_submit_button("Entrar", type="primary")
        if submitted:
            ok, msg = auth.login(username, password)
            if ok:
                st.rerun()
            else:
                st.error(msg)


def render_home(user: dict) -> None:
    render_sidebar_user(user)
    with st.sidebar:
        if st.button("Sair"):
            auth.logout()
            st.rerun()

    st.markdown("## snow_portal")
    st.caption("Controle de créditos Snowflake para o time de suporte.")

    active_id = auth.get_active_connection_id()
    connections = db.list_connections_for_user(user)

    cols = st.columns(3)
    cols[0].metric("Conexões disponíveis", len(connections))
    cols[1].metric("Papel", user["role"])
    cols[2].metric("Conta ativa", "Sim" if active_id else "Não")

    st.markdown("---")
    st.markdown("### Próximos passos")
    st.markdown(
        """
1. Abra **Conexões** e adicione uma conta Snowflake (PAT).
2. Ative a conexão desejada.
3. Vá em **Cost Management** para ver o consumo de créditos.
        """
    )

    if active_id:
        conn = db.get_connection_by_id(active_id)
        if conn:
            st.success(f"Conta ativa: **{conn['name']}** (`{conn['account_identifier']}`)")
    elif connections:
        st.info("Nenhuma conta ativa. Selecione uma em **Conexões**.")
    else:
        st.warning("Nenhuma conexão cadastrada ainda.")


def main() -> None:
    inject_theme()
    try:
        db.ensure_bootstrap()
    except Exception as exc:  # noqa: BLE001
        st.error(
            "Não foi possível conectar ao Postgres. "
            "Verifique se `docker compose up` está rodando e se `DATABASE_URL` está correto."
        )
        st.code(str(exc))
        st.stop()

    if not auth.is_authenticated():
        render_login()
        return

    render_home(auth.current_user())


main()
