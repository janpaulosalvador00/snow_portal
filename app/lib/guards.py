"""Hide Administração page from non-admins via Streamlit page link filtering is limited;
this module is imported by pages that need shared connection picker helpers.
"""
from __future__ import annotations

from app.lib import auth, db


def active_connection_or_stop(st) -> dict:
    user = auth.require_login()
    conn_id = auth.get_active_connection_id()
    if not conn_id:
        st.warning("Selecione uma conexão ativa em **Conexões**.")
        st.stop()
    if not db.user_can_access_connection(user, conn_id):
        st.error("Sem permissão para a conexão ativa.")
        auth.set_active_connection_id(None)
        st.stop()
    return db.get_connection_credentials(conn_id)
