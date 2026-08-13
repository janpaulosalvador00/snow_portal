"""Snowflake connector helpers (PAT, password, Local OAuth, SSO)."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Generator

import pandas as pd
import snowflake.connector


def normalize_account_identifier(account: str) -> str:
    """Trim and strip common URL suffixes pasted from the Snowflake UI."""
    value = (account or "").strip()
    lower = value.lower()
    for suffix in (
        ".snowflakecomputing.com",
        ".snowflakecomputing.cn",
    ):
        if lower.endswith(suffix):
            value = value[: -len(suffix)]
            lower = value.lower()
            break
    # https://app.snowflake.com/... or https://xxx.snowflakecomputing.com
    if "://" in value:
        value = value.split("://", 1)[1]
    value = value.split("/")[0].strip()
    if value.lower().endswith(".snowflakecomputing.com"):
        value = value[: -len(".snowflakecomputing.com")]
    return value.strip()


def friendly_connect_error(exc: BaseException, *, auth_method: str | None = None) -> str:
    """Map known Snowflake auth failures to actionable pt-BR guidance."""
    raw = str(exc)
    lower = raw.lower()
    method = (auth_method or "").lower()

    if "390190" in raw or "saml identity provider" in lower:
        return (
            "Esta conta rejeitou autenticação via browser/SAML (erro 390190). "
            "Provável causa: federated auth / SAML2 não configurado (ou legado) nesta conta. "
            "Use **Programmatic Access Token (PAT)** ou **Password**. "
            "SSO só funciona se a conta tiver SAML2 security integration; "
            "nesse caso informe a URL do IdP (`https://…`)."
        )

    if "390139" in raw or "authenticator_not_supported" in lower:
        return (
            "O authenticator informado não é aceito por esta conta Snowflake. "
            "Tente **PAT** ou **Password**, ou confirme a URL SSO com o administrador."
        )

    if method in ("local_oauth", "sso") and (
        "browser" in lower or "failed to open" in lower or "timeout" in lower
    ):
        return (
            f"{raw}\n\n"
            "Local OAuth / SSO precisam abrir o navegador no host do Docker. "
            "Se falhar, use **PAT** (recomendado para suporte)."
        )

    return raw


def _connect_kwargs(
    *,
    account: str,
    user: str,
    auth_method: str = "pat",
    password: str | None = None,
    authenticator_url: str | None = None,
    warehouse: str | None = None,
    role: str | None = None,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "account": normalize_account_identifier(account),
        "user": user,
        "warehouse": warehouse or None,
        "role": role or None,
        "client_session_keep_alive": False,
        "login_timeout": 120,
    }

    method = (auth_method or "pat").lower()
    if method in ("pat", "password"):
        if not password:
            raise ValueError("Senha/PAT obrigatório para este método de autenticação.")
        kwargs["password"] = password
    elif method == "local_oauth":
        kwargs["authenticator"] = "externalbrowser"
        kwargs["client_store_temporary_credential"] = True
    elif method == "sso":
        auth = (authenticator_url or "").strip() or "externalbrowser"
        kwargs["authenticator"] = auth
        kwargs["client_store_temporary_credential"] = True
    else:
        raise ValueError(f"Método de autenticação não suportado: {auth_method}")

    return kwargs


@contextmanager
def snowflake_connection(
    *,
    account: str,
    user: str,
    auth_method: str = "pat",
    password: str | None = None,
    authenticator_url: str | None = None,
    warehouse: str | None = None,
    role: str | None = None,
) -> Generator[Any, None, None]:
    conn = snowflake.connector.connect(
        **_connect_kwargs(
            account=account,
            user=user,
            auth_method=auth_method,
            password=password,
            authenticator_url=authenticator_url,
            warehouse=warehouse,
            role=role,
        )
    )
    try:
        yield conn
    finally:
        conn.close()


def test_connection(
    *,
    account: str,
    user: str,
    auth_method: str = "pat",
    password: str | None = None,
    authenticator_url: str | None = None,
    warehouse: str | None = None,
    role: str | None = None,
) -> tuple[bool, str]:
    try:
        with snowflake_connection(
            account=account,
            user=user,
            auth_method=auth_method,
            password=password,
            authenticator_url=authenticator_url,
            warehouse=warehouse,
            role=role,
        ) as conn:
            cur = conn.cursor()
            cur.execute("SELECT CURRENT_ACCOUNT(), CURRENT_USER(), CURRENT_ROLE()")
            account_name, current_user, current_role = cur.fetchone()
            return True, f"OK — conta={account_name}, user={current_user}, role={current_role}"
    except Exception as exc:  # noqa: BLE001 — surface to UI
        return False, friendly_connect_error(exc, auth_method=auth_method)


def run_query(
    *,
    account: str,
    user: str,
    sql: str,
    params: tuple | dict | None = None,
    auth_method: str = "pat",
    password: str | None = None,
    authenticator_url: str | None = None,
    warehouse: str | None = None,
    role: str | None = None,
) -> pd.DataFrame:
    with snowflake_connection(
        account=account,
        user=user,
        auth_method=auth_method,
        password=password,
        authenticator_url=authenticator_url,
        warehouse=warehouse,
        role=role,
    ) as conn:
        cur = conn.cursor()
        cur.execute(sql, params or ())
        columns = [col[0] for col in cur.description] if cur.description else []
        rows = cur.fetchall()
        return pd.DataFrame(rows, columns=columns)


def connect_from_credentials(creds: dict) -> Any:
    """Open a connection using get_connection_credentials() payload."""
    return snowflake.connector.connect(
        **_connect_kwargs(
            account=creds["account"],
            user=creds["user"],
            auth_method=creds.get("auth_method", "pat"),
            password=creds.get("password"),
            authenticator_url=creds.get("authenticator_url"),
            warehouse=creds.get("warehouse"),
            role=creds.get("role"),
        )
    )
