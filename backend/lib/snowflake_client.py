"""Snowflake connector helpers (PAT, password, OAuth browser, SSO)."""
from __future__ import annotations

import json
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

    if "resource monitor" in lower or "cannot be resumed" in lower or "090073" in raw:
        return (
            "Warehouse bloqueado por resource monitor / cota (ex.: WH_ANALISTA). "
            "Em Conexões → Editar, limpe o Warehouse ou use outro (ex.: COMPUTE_WH) "
            "e tente de novo."
        )

    if "390190" in raw or "saml identity provider" in lower:
        return (
            "Erro 390190 (SAML). Esta conta não tem External Browser/SSO configurado. "
            "Use Conectar via browser (OAuth local, como o Cortex) ou PAT."
        )

    if method == "sso":
        return (
            f"{raw}\n\n"
            "SSO/SAML exige IdP na conta. Prefira Conectar via browser (OAuth) ou PAT."
        )

    if "oauth" in lower and ("expired" in lower or "invalid" in lower or "390114" in raw):
        return (
            "Token OAuth inválido ou expirado. Use Inativar/Ativar após "
            "Conectar via browser de novo, ou Editar e reautenticar."
        )

    return raw


def _oauth_access_token(password: str | None) -> str:
    if not password:
        raise ValueError("Token OAuth ausente. Refaça o login via browser.")
    raw = password.strip()
    if raw.startswith("{"):
        data = json.loads(raw)
        token = data.get("access_token")
        if not token:
            raise ValueError("Blob OAuth sem access_token. Refaça o login via browser.")
        return token
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
        "client_session_keep_alive": False,
        "login_timeout": 120,
    }
    # Only set warehouse/role when explicit — empty must NOT fall back to user default WH
    wh = (warehouse or "").strip()
    if wh:
        kwargs["warehouse"] = wh
    role_val = (role or "").strip()
    if role_val:
        kwargs["role"] = role_val

    method = (auth_method or "pat").lower()
    if method in ("pat", "password"):
        if not password:
            raise ValueError("Senha/PAT obrigatório para este método de autenticação.")
        kwargs["password"] = password
    elif method in ("oauth", "local_oauth"):
        kwargs["authenticator"] = "oauth"
        kwargs["token"] = _oauth_access_token(password)
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
    def _execute(conn, wh_override: str | None = None) -> pd.DataFrame:
        cur = conn.cursor()
        if wh_override:
            cur.execute(f'USE WAREHOUSE "{wh_override}"')
        cur.execute(sql, params or ())
        columns = [col[0] for col in cur.description] if cur.description else []
        rows = cur.fetchall()
        return pd.DataFrame(rows, columns=columns)

    def _pick_fallback_warehouse(conn) -> str | None:
        cur = conn.cursor()
        try:
            cur.execute("SHOW WAREHOUSES")
            rows = cur.fetchall()
            cols = [c[0].lower() for c in cur.description] if cur.description else []
            name_idx = cols.index("name") if "name" in cols else 0
            state_idx = cols.index("state") if "state" in cols else None
            # Prefer started, then any name not looking like blocked default
            started = []
            others = []
            for row in rows:
                name = str(row[name_idx])
                state = str(row[state_idx]).upper() if state_idx is not None else ""
                if state == "STARTED":
                    started.append(name)
                else:
                    others.append(name)
            for candidate in started + others:
                if candidate.upper() != "WH_ANALISTA":
                    return candidate
            return (started or others or [None])[0]
        except Exception:  # noqa: BLE001
            return "COMPUTE_WH"

    with snowflake_connection(
        account=account,
        user=user,
        auth_method=auth_method,
        password=password,
        authenticator_url=authenticator_url,
        warehouse=warehouse,
        role=role,
    ) as conn:
        try:
            return _execute(conn)
        except Exception as exc:  # noqa: BLE001
            raw = str(exc).lower()
            if (warehouse or "").strip():
                raise
            if not (
                "resource monitor" in raw
                or "cannot be resumed" in raw
                or "090073" in str(exc)
                or "no active warehouse" in raw
                or "000606" in str(exc)
            ):
                raise
            fallback = _pick_fallback_warehouse(conn)
            if not fallback:
                raise
            try:
                return _execute(conn, fallback)
            except Exception:
                # last resort known name
                if fallback.upper() != "COMPUTE_WH":
                    return _execute(conn, "COMPUTE_WH")
                raise


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


def refresh_oauth_credentials(creds: dict, *, connection_id: int | None = None) -> dict:
    """Refresh OAuth access token using stored refresh_token; persist if connection_id given."""
    from backend.lib import db
    from backend.lib import oauth_local

    method = (creds.get("auth_method") or "").lower()
    if method not in ("oauth", "local_oauth"):
        return creds
    secret = creds.get("password") or ""
    blob = oauth_local.unpack_oauth_secret(secret)
    refresh = blob.get("refresh_token")
    if not refresh:
        raise RuntimeError(
            "Token OAuth sem refresh_token. Refaça Conectar via browser."
        )
    tokens = oauth_local.refresh_access_token(
        account=creds["account"],
        refresh_token=refresh,
    )
    # Keep previous refresh_token if response omits it
    if not tokens.get("refresh_token"):
        tokens["refresh_token"] = refresh
    if not tokens.get("username"):
        tokens["username"] = blob.get("username") or creds.get("user")
    packed = oauth_local.pack_oauth_secret(tokens)
    if connection_id is not None:
        db.update_connection_secret(connection_id, packed)
    creds = {**creds, "password": packed}
    return creds


def run_query_with_creds(creds: dict, sql: str, params: tuple | dict | None = None) -> pd.DataFrame:
    """Run SQL using connection credentials; auto-refresh OAuth once on auth failure."""
    connection_id = None
    row = creds.get("row")
    if isinstance(row, dict):
        connection_id = row.get("id")

    try:
        return run_query(
            account=creds["account"],
            user=creds["user"],
            sql=sql,
            params=params,
            auth_method=creds.get("auth_method", "pat"),
            password=creds.get("password"),
            authenticator_url=creds.get("authenticator_url"),
            warehouse=creds.get("warehouse"),
            role=creds.get("role"),
        )
    except Exception as first:  # noqa: BLE001
        method = (creds.get("auth_method") or "").lower()
        if method not in ("oauth", "local_oauth"):
            raise
        try:
            creds = refresh_oauth_credentials(creds, connection_id=connection_id)
        except Exception as refresh_exc:  # noqa: BLE001
            raise RuntimeError(
                friendly_connect_error(first, auth_method=method)
                + f" Refresh falhou: {refresh_exc}"
            ) from refresh_exc
        try:
            return run_query(
                account=creds["account"],
                user=creds["user"],
                sql=sql,
                params=params,
                auth_method=creds.get("auth_method", "pat"),
                password=creds.get("password"),
                authenticator_url=creds.get("authenticator_url"),
                warehouse=creds.get("warehouse"),
                role=creds.get("role"),
            )
        except Exception as second:  # noqa: BLE001
            raise RuntimeError(friendly_connect_error(second, auth_method=method)) from second
