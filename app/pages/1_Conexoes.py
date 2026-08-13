"""Gerenciar conexões Snowflake (Sign in estilo Cortex + hub)."""
from __future__ import annotations

import streamlit as st

from app.lib import auth, db
from app.lib.db import AUTH_METHOD_LABELS
from app.lib.snowflake_client import normalize_account_identifier, test_connection
from app.lib.ui import inject_theme, page_setup, render_sidebar_user

METHOD_OPTIONS = [
    ("local_oauth", "Local OAuth"),
    ("sso", "SSO"),
    ("password", "Password"),
    ("pat", "Programmatic Access Token (PAT)"),
]

METHOD_DESCRIPTIONS = {
    "local_oauth": (
        "Abre o navegador para entrar com segurança. "
        "Tokens renovam automaticamente e ficam no cache local do connector. "
        "Requer federated auth na conta; se falhar (ex.: 390190), use PAT."
    ),
    "sso": (
        "Autenticação via provedor SSO (browser ou URL do IdP). "
        "A conta precisa de SAML2 security integration. "
        "Se falhar, use PAT ou Password."
    ),
    "password": (
        "Usa a senha do usuário Snowflake. "
        "A senha é criptografada em repouso e nunca exibida após salvar."
    ),
    "pat": (
        "Use um Programmatic Access Token do usuário Snowflake. "
        "O token é criptografado em repouso e nunca exibido após salvar. "
        "Método recomendado para o time de suporte no Docker."
    ),
}

page_setup("Conexões")
inject_theme()

user = auth.require_login()
render_sidebar_user(user)
with st.sidebar:
    if st.button("Sair", key="logout_conn"):
        auth.logout()
        st.rerun()

st.markdown("## Conexões Snowflake")
st.caption("Salve contas de clientes e alterne o ambiente ativo.")

tab_hub, tab_signin = st.tabs(["Contas salvas", "Sign in to Snowflake"])

with tab_hub:
    connections = db.list_connections_for_user(user)
    active_id = auth.get_active_connection_id()

    if not connections:
        st.info("Nenhuma conexão ainda. Use a aba **Sign in to Snowflake**.")
    else:
        for conn in connections:
            c1, c2, c3, c4 = st.columns([3, 2, 1.2, 1.2])
            is_active = active_id == conn["id"]
            label = f"**{conn['name']}**"
            if is_active:
                label += " · ativa"
            method_key = conn.get("auth_method") or "pat"
            method_label = AUTH_METHOD_LABELS.get(method_key, method_key)
            c1.markdown(label)
            c1.caption(f"{conn['account_identifier']} · {conn['username']} · {method_label}")
            if conn.get("team_name"):
                c2.caption(f"Time: {conn['team_name']}")
            else:
                c2.caption(method_label)
            if c3.button("Ativar", key=f"act_{conn['id']}", disabled=is_active):
                if not db.user_can_access_connection(user, conn["id"]):
                    st.error("Sem permissão para esta conexão.")
                else:
                    auth.set_active_connection_id(conn["id"])
                    st.rerun()
            if user["role"] == "admin":
                if c4.button("Remover", key=f"del_{conn['id']}"):
                    if active_id == conn["id"]:
                        auth.set_active_connection_id(None)
                    db.delete_connection(conn["id"])
                    st.rerun()

with tab_signin:
    st.markdown("### Sign in to Snowflake")
    st.markdown(
        """
        <div class="sp-guide">
          <strong>Como obter account identifier e login name</strong>
          <ol>
            <li>Acesse <a href="https://app.snowflake.com" target="_blank">https://app.snowflake.com</a> e entre.</li>
            <li>Clique no avatar (canto inferior esquerdo) para abrir o menu.</li>
            <li>Selecione <em>Account</em>.</li>
            <li>Clique em <em>View account details</em>.</li>
            <li>Copie o <em>account identifier</em> e o <em>login name</em>.</li>
          </ol>
        </div>
        """,
        unsafe_allow_html=True,
    )

    # Method outside the form so credential fields update immediately
    st.markdown("**Method**")
    method_labels = [label for _, label in METHOD_OPTIONS]
    label_to_key = {label: key for key, label in METHOD_OPTIONS}
    default_method_index = method_labels.index("Programmatic Access Token (PAT)")
    selected_label = st.selectbox(
        "Method",
        method_labels,
        index=default_method_index,
        label_visibility="collapsed",
        key="signin_method",
    )
    method = label_to_key[selected_label]
    st.markdown(
        f'<div class="sp-info">{METHOD_DESCRIPTIONS[method]}</div>',
        unsafe_allow_html=True,
    )

    if method in ("local_oauth", "sso"):
        st.markdown(
            """
            <div class="sp-banner">
              Local OAuth / SSO abrem o navegador no host onde o Docker está rodando
              e exigem federated auth (SAML2) na conta Snowflake.
              Se aparecer erro <strong>390190</strong> / SAML, use <strong>PAT</strong> ou <strong>Password</strong>.
            </div>
            """,
            unsafe_allow_html=True,
        )

    if method == "sso":
        st.warning(
            "SSO exige SAML2 security integration nesta conta. "
            "Informe a URL do IdP (`https://…`) quando souber; "
            "deixar vazio usa `externalbrowser` e falha se SAML não estiver ok."
        )

    with st.form("signin_form"):
        account = st.text_input(
            "Account Identifier *",
            placeholder="myorg-myaccount",
            help="Formato org-account ou locator. Não precisa do sufixo .snowflakecomputing.com.",
        )
        name = st.text_input(
            "Connection Name",
            placeholder="auto-generated from account",
            help="Gerado automaticamente se vazio. Edite para personalizar.",
        )
        sf_user = st.text_input("Username *", placeholder="your-username")

        secret = None
        authenticator_url = None
        if method == "pat":
            secret = st.text_input("Programmatic Access Token *", type="password")
        elif method == "password":
            secret = st.text_input("Password *", type="password")
        elif method == "sso":
            authenticator_url = st.text_input(
                "URL do IdP (SSO)",
                placeholder="https://<org>.okta.com/...",
                help="Recomendado. Deixe vazio apenas se a conta já tiver SAML2 e externalbrowser funcionar.",
            )

        with st.expander("Optional Settings"):
            warehouse = st.text_input("Warehouse", placeholder="ex.: COMPUTE_WH")
            role_name = st.text_input("Role", placeholder="ex.: ACCOUNTADMIN")

        teams = db.list_teams()
        team_options = {t["name"]: t["id"] for t in teams}
        team_name = st.selectbox(
            "Time (ACL)",
            options=list(team_options.keys()) if team_options else ["Suporte"],
            help="Times com acesso a esta conexão.",
        )

        col_a, col_b = st.columns([1, 1])
        test_only = col_a.form_submit_button("Testar conexão")
        save = col_b.form_submit_button("Sign In / Salvar", type="primary")

        if test_only or save:
            errors = []
            if not account:
                errors.append("Account Identifier")
            if not sf_user:
                errors.append("Username")
            if method in ("pat", "password") and not secret:
                errors.append("PAT" if method == "pat" else "Password")
            if method == "sso" and authenticator_url and not authenticator_url.strip().startswith("https://"):
                errors.append("URL do IdP deve começar com https://")
            if errors:
                st.error("Preencha: " + ", ".join(errors))
            else:
                account_norm = normalize_account_identifier(account)
                ok, msg = test_connection(
                    account=account_norm,
                    user=sf_user,
                    auth_method=method,
                    password=secret,
                    authenticator_url=authenticator_url,
                    warehouse=warehouse or None,
                    role=role_name or None,
                )
                if not ok:
                    st.error(f"Falha na conexão: {msg}")
                elif test_only:
                    st.success(msg)
                else:
                    conn_name = name.strip() or account_norm
                    team_id = team_options.get(team_name) or user.get("team_id")
                    try:
                        conn_id = db.create_connection(
                            name=conn_name,
                            account_identifier=account_norm,
                            username=sf_user,
                            auth_method=method,
                            secret=secret,
                            authenticator_url=authenticator_url,
                            warehouse=warehouse or None,
                            role_name=role_name or None,
                            created_by=user["id"],
                            team_id=team_id,
                            acl_team_ids=[team_id] if team_id else [],
                        )
                    except ValueError as exc:
                        st.error(str(exc))
                    else:
                        auth.set_active_connection_id(conn_id)
                        st.success(f"Conexão salva e ativada: {conn_name}")
                        st.rerun()
