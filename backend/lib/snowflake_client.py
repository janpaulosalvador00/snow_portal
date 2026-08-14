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
        mon = None
        for marker in ("resource monitor '", 'resource monitor "'):
            if marker in lower:
                start = lower.index(marker) + len(marker)
                end = start
                quote = marker[-1]
                while end < len(raw) and raw[end] != quote:
                    end += 1
                mon = raw[start:end]
                break
        mon_label = mon or "resource monitor"
        return (
            f"Warehouse bloqueado: cota do {mon_label} esgotada (090073). "
            "Na conta PONCETECH o monitor ACCOUNT MONITORAMENTO_EMPRESA está acima da cota "
            "e impede TODOS os warehouses de resumir. "
            "No Snowflake (ACCOUNTADMIN), aumente a cota, por exemplo:\n"
            "ALTER RESOURCE MONITOR MONITORAMENTO_EMPRESA SET CREDIT_QUOTA = 50;\n"
            "Ou aguarde o reset do período (MONTHLY). "
            "Trocar o WH na conexão não resolve enquanto o monitor de conta estiver estourado."
        )

    if "000606" in raw or "no active warehouse" in lower:
        return (
            "Nenhum warehouse ativo na sessão. Em Conexões → Editar, informe um Warehouse "
            "válido (ex.: WH_CON_EXT), revalide a autenticação e tente de novo."
        )

    if "002043" in raw or (
        "object does not exist" in lower and "operation cannot be performed" in lower
    ):
        return (
            "Objeto inexistente ou sem permissão (002043). Causas comuns: "
            "(1) Warehouse da conexão não existe nesta conta — em Conexões → Editar use um WH "
            "real (ex.: WH_CON_EXT, WH_ARQUITETO) ou deixe vazio para auto; "
            "(2) Sem acesso a ACCOUNT_USAGE — execute "
            "GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE <sua_role>."
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
            _prepare_session(conn, role=role)
            cur = conn.cursor()
            wh = (warehouse or "").strip()
            if wh:
                try:
                    cur.execute(f"USE WAREHOUSE {_quote_ident(wh)}")
                except Exception:  # noqa: BLE001
                    pass
            cur.execute(
                "SELECT CURRENT_ACCOUNT(), CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE()"
            )
            account_name, current_user, current_role, current_wh = cur.fetchone()
            # Soft check ACCOUNT_USAGE visibility for Cost Management
            au_note = ""
            try:
                cur.execute(
                    "SELECT 1 FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_HISTORY LIMIT 1"
                )
                cur.fetchone()
                au_note = " ACCOUNT_USAGE=ok."
            except Exception as au_exc:  # noqa: BLE001
                au_note = (
                    " ACCOUNT_USAGE=sem acesso (Cost vai falhar até "
                    "GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE). "
                    f"({au_exc})"
                )
            return (
                True,
                f"OK — conta={account_name}, user={current_user}, "
                f"role={current_role}, wh={current_wh or '—'}.{au_note}",
            )
    except Exception as exc:  # noqa: BLE001 — surface to UI
        return False, friendly_connect_error(exc, auth_method=auth_method)


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', "") + '"'


def _prepare_session(conn, *, role: str | None) -> None:
    """Apply role explicitly — OAuth often ignores connect(role=) and leaves a limited default."""
    cur = conn.cursor()
    try:
        cur.execute("USE SECONDARY ROLES ALL")
    except Exception:  # noqa: BLE001 — older accounts / restricted roles
        pass

    preferred = (role or "").strip()
    tried: list[str] = []
    if preferred:
        tried.append(preferred)
    # Cost / ACCOUNT_USAGE typically needs a privileged role; try ACCOUNTADMIN if preferred fails later
    if preferred.upper() != "ACCOUNTADMIN":
        tried.append("ACCOUNTADMIN")

    last_role_exc: BaseException | None = None
    for candidate in tried:
        try:
            cur.execute(f"USE ROLE {_quote_ident(candidate)}")
            return
        except Exception as exc:  # noqa: BLE001
            last_role_exc = exc
            continue
    # Keep going with whatever default role the session has; query may still work
    _ = last_role_exc


def _is_warehouse_session_error(exc: BaseException) -> bool:
    raw = str(exc)
    lower = raw.lower()
    return (
        "resource monitor" in lower
        or "cannot be resumed" in lower
        or "090073" in raw
        or "no active warehouse" in lower
        or "000606" in raw
        # Missing / unauthorized WH often surfaces as 002043 (same code as ACCOUNT_USAGE)
        or "002043" in raw
        or "002003" in raw
        or ("warehouse" in lower and "does not exist" in lower)
        or ("object does not exist" in lower and "operation cannot be performed" in lower)
    )


def _is_account_usage_access_error(exc: BaseException) -> bool:
    """True when failure looks like ACCOUNT_USAGE privilege after a WH was already selected."""
    raw = str(exc)
    lower = raw.lower()
    if "account_usage" in lower or "metering_history" in lower:
        return True
    return "002043" in raw or (
        "object does not exist" in lower and "operation cannot be performed" in lower
    )


def _list_warehouse_candidates(conn, preferred: str | None) -> list[str]:
    """Ordered WH names from the account; preferred first only if it exists."""
    candidates: list[str] = []
    seen: set[str] = set()
    known: set[str] = set()

    def _add(name: str | None) -> None:
        if not name:
            return
        key = name.strip().upper()
        if not key or key in seen:
            return
        # Skip Snowflake-managed system warehouses
        if key.startswith("SYSTEM$"):
            return
        # Known blocked / quota-prone default in this estate
        if key == "WH_ANALISTA":
            return
        seen.add(key)
        candidates.append(name.strip())

    started: list[str] = []
    others: list[str] = []
    try:
        cur = conn.cursor()
        cur.execute("SHOW WAREHOUSES")
        rows = cur.fetchall()
        cols = [c[0].lower() for c in cur.description] if cur.description else []
        name_idx = cols.index("name") if "name" in cols else 0
        state_idx = cols.index("state") if "state" in cols else None
        for row in rows:
            name = str(row[name_idx])
            known.add(name.strip().upper())
            state = str(row[state_idx]).upper() if state_idx is not None else ""
            if name.upper().startswith("SYSTEM$") or name.upper() == "WH_ANALISTA":
                continue
            if state == "STARTED":
                started.append(name)
            else:
                others.append(name)
    except Exception:  # noqa: BLE001
        pass

    pref = (preferred or "").strip()
    if pref and (not known or pref.upper() in known):
        _add(pref)
    elif pref:
        # Preferred not in account — still try once (rename race), then real list
        _add(pref)

    # Prefer WH_CON_EXT when present (named for external connections)
    for name in started + others:
        if name.upper() == "WH_CON_EXT":
            _add(name)
    for name in started + others:
        _add(name)

    if not candidates and pref:
        _add(pref)
    return candidates


def _exhausted_account_monitors(conn) -> list[str]:
    """Return ACCOUNT-level resource monitor names with no remaining credits."""
    out: list[str] = []
    try:
        cur = conn.cursor()
        cur.execute("SHOW RESOURCE MONITORS")
        cols = [c[0].lower() for c in cur.description] if cur.description else []
        name_i = cols.index("name") if "name" in cols else 0
        level_i = cols.index("level") if "level" in cols else None
        rem_i = cols.index("remaining_credits") if "remaining_credits" in cols else None
        if rem_i is None:
            return out
        for row in cur.fetchall():
            level = str(row[level_i]).upper() if level_i is not None else ""
            if level and level != "ACCOUNT":
                continue
            try:
                remaining = float(row[rem_i])
            except (TypeError, ValueError):
                continue
            if remaining <= 0:
                out.append(str(row[name_i]))
    except Exception:  # noqa: BLE001
        return out
    return out


def _quota_blocked_error(conn, last_exc: BaseException) -> BaseException:
    """Prefer a clear account-monitor message when every WH is blocked by quota."""
    exhausted = _exhausted_account_monitors(conn)
    if exhausted:
        names = ", ".join(exhausted)
        return RuntimeError(
            f"Warehouse bloqueado: cota do resource monitor '{exhausted[0]}' esgotada (090073). "
            f"Monitor(es) de ACCOUNT sem crédito: {names}. "
            "Isso impede TODOS os warehouses de resumir. "
            "No Snowflake (ACCOUNTADMIN), aumente a cota, por exemplo:\n"
            f"ALTER RESOURCE MONITOR {exhausted[0]} SET CREDIT_QUOTA = 50;\n"
            "Ou aguarde o reset do período (MONTHLY). "
            "Trocar o WH na conexão não resolve enquanto o monitor de conta estiver estourado."
        )
    return last_exc


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
    preferred = (warehouse or "").strip() or None
    preferred_role = (role or "").strip() or None

    def _execute(conn, wh: str | None) -> pd.DataFrame:
        cur = conn.cursor()
        if wh:
            # Explicit USE — connector warehouse= alone can leave session without WH (OAuth)
            cur.execute(f"USE WAREHOUSE {_quote_ident(wh)}")
        cur.execute(sql, params or ())
        columns = [col[0] for col in cur.description] if cur.description else []
        rows = cur.fetchall()
        return pd.DataFrame(rows, columns=columns)

    def _run_with_warehouses(conn) -> pd.DataFrame:
        # Fast-fail when account-level monitor already exhausted
        exhausted = _exhausted_account_monitors(conn)
        if exhausted:
            raise _quota_blocked_error(conn, RuntimeError("090073 resource monitor"))

        candidates = _list_warehouse_candidates(conn, preferred)
        if not candidates:
            return _execute(conn, None)
        last_exc: BaseException | None = None
        saw_quota = False
        for wh in candidates:
            try:
                return _execute(conn, wh)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if _is_warehouse_session_error(exc):
                    raw = str(exc).lower()
                    if "090073" in str(exc) or "resource monitor" in raw:
                        saw_quota = True
                    continue
                raise
        assert last_exc is not None
        if saw_quota:
            raise _quota_blocked_error(conn, last_exc)
        raise last_exc

    with snowflake_connection(
        account=account,
        user=user,
        auth_method=auth_method,
        password=password,
        authenticator_url=authenticator_url,
        warehouse=warehouse,
        role=role,
    ) as conn:
        _prepare_session(conn, role=preferred_role)
        try:
            return _run_with_warehouses(conn)
        except Exception as first:  # noqa: BLE001
            # ACCOUNT_USAGE often needs ACCOUNTADMIN / imported privileges on SNOWFLAKE
            if not _is_account_usage_access_error(first):
                raise
            if "090073" in str(first) or "resource monitor" in str(first).lower():
                raise
            if (preferred_role or "").upper() == "ACCOUNTADMIN":
                raise
            cur = conn.cursor()
            try:
                cur.execute(f"USE ROLE {_quote_ident('ACCOUNTADMIN')}")
            except Exception:  # noqa: BLE001
                raise first from None
            return _run_with_warehouses(conn)


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


def _list_roles_for_user(conn) -> list[str]:
    """Roles the current user can use (prefer CURRENT_AVAILABLE_ROLES, else SHOW ROLES)."""
    roles: list[str] = []
    seen: set[str] = set()

    def _add(name: str | None) -> None:
        if not name:
            return
        key = name.strip().upper()
        if not key or key in seen:
            return
        seen.add(key)
        roles.append(name.strip())

    cur = conn.cursor()
    try:
        cur.execute("SELECT CURRENT_AVAILABLE_ROLES()")
        row = cur.fetchone()
        raw = row[0] if row else None
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = [p.strip() for p in raw.strip("[]").split(",") if p.strip()]
            if isinstance(parsed, list):
                for item in parsed:
                    _add(str(item).strip().strip('"').strip("'"))
        elif isinstance(raw, (list, tuple)):
            for item in raw:
                _add(str(item))
    except Exception:  # noqa: BLE001
        pass

    if roles:
        return roles

    try:
        cur.execute("SHOW ROLES")
        rows = cur.fetchall()
        cols = [c[0].lower() for c in cur.description] if cur.description else []
        name_idx = cols.index("name") if "name" in cols else 0
        for row in rows:
            _add(str(row[name_idx]))
    except Exception:  # noqa: BLE001
        pass
    return roles


def _warehouse_options_from_show(conn) -> list[dict[str, Any]]:
    """Full WH list from SHOW WAREHOUSES (includes SYSTEM$/WH_ANALISTA for UI awareness)."""
    out: list[dict[str, Any]] = []
    try:
        cur = conn.cursor()
        cur.execute("SHOW WAREHOUSES")
        rows = cur.fetchall()
        cols = [c[0].lower() for c in cur.description] if cur.description else []
        name_idx = cols.index("name") if "name" in cols else 0
        state_idx = cols.index("state") if "state" in cols else None
        for row in rows:
            name = str(row[name_idx]).strip()
            state = str(row[state_idx]).upper() if state_idx is not None else ""
            key = name.upper()
            suggested = not (key.startswith("SYSTEM$") or key == "WH_ANALISTA")
            out.append(
                {
                    "name": name,
                    "state": state or None,
                    "suggested": suggested,
                }
            )
    except Exception:  # noqa: BLE001
        return out

    # Prefer WH_CON_EXT first among suggested
    def _sort_key(item: dict[str, Any]) -> tuple:
        name_u = str(item["name"]).upper()
        suggested = 0 if item.get("suggested") else 1
        prefer = 0 if name_u == "WH_CON_EXT" else 1
        started = 0 if (item.get("state") or "").upper() == "STARTED" else 1
        return (suggested, prefer, started, name_u)

    out.sort(key=_sort_key)
    return out


def discover_session_options(
    *,
    account: str,
    user: str,
    auth_method: str = "pat",
    password: str | None = None,
    authenticator_url: str | None = None,
    warehouse: str | None = None,
    role: str | None = None,
) -> dict[str, Any]:
    """
    Connect and list live warehouses + roles for the connection form.
    Connects without forcing the stored warehouse so a bad COMPUTE_WH still discovers.
    """
    # Do not pass a possibly-invalid warehouse into connect kwargs
    with snowflake_connection(
        account=account,
        user=user,
        auth_method=auth_method,
        password=password,
        authenticator_url=authenticator_url,
        warehouse=None,
        role=role,
    ) as conn:
        _prepare_session(conn, role=role)
        warehouses = _warehouse_options_from_show(conn)
        roles = _list_roles_for_user(conn)
        suggested = [w["name"] for w in warehouses if w.get("suggested")]
        preferred = None
        for name in suggested:
            if name.upper() == "WH_CON_EXT":
                preferred = name
                break
        if preferred is None and suggested:
            preferred = suggested[0]

        hint = (
            "Prefira WH_CON_EXT quando disponível. WH_ANALISTA e SYSTEM$* costumam "
            "bater no resource monitor MONITORAMENTO_EMPRESA (090073) — deixe Warehouse "
            "vazio (auto) ou escolha um WH sugerido. Se a cota de ACCOUNT estiver "
            "esgotada, trocar o WH não resolve até aumentar a cota ou aguardar o reset."
        )
        stored = (warehouse or "").strip()
        stored_ok = False
        if stored:
            known = {w["name"].upper() for w in warehouses}
            stored_ok = stored.upper() in known

        return {
            "warehouses": warehouses,
            "roles": roles,
            "suggested_warehouse": preferred,
            "stored_warehouse_exists": stored_ok if stored else None,
            "hint": hint,
        }


def discover_session_options_with_creds(creds: dict) -> dict[str, Any]:
    """Discover WH/roles using stored credentials; refresh OAuth once on auth failure."""
    connection_id = None
    row = creds.get("row")
    if isinstance(row, dict):
        connection_id = row.get("id")

    def _run(c: dict) -> dict[str, Any]:
        return discover_session_options(
            account=c["account"],
            user=c["user"],
            auth_method=c.get("auth_method", "pat"),
            password=c.get("password"),
            authenticator_url=c.get("authenticator_url"),
            warehouse=c.get("warehouse"),
            role=c.get("role"),
        )

    try:
        return _run(creds)
    except Exception as first:  # noqa: BLE001
        method = (creds.get("auth_method") or "").lower()
        if method not in ("oauth", "local_oauth"):
            raise RuntimeError(friendly_connect_error(first, auth_method=method)) from first
        try:
            creds = refresh_oauth_credentials(creds, connection_id=connection_id)
        except Exception as refresh_exc:  # noqa: BLE001
            raise RuntimeError(
                friendly_connect_error(first, auth_method=method)
                + f" Refresh falhou: {refresh_exc}"
            ) from refresh_exc
        try:
            return _run(creds)
        except Exception as second:  # noqa: BLE001
            raise RuntimeError(friendly_connect_error(second, auth_method=method)) from second


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
