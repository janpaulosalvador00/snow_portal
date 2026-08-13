"""Postgres access layer."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Generator, Iterable

import bcrypt
import psycopg2
import psycopg2.extras

from backend.lib.config import get_settings
from backend.lib.crypto import decrypt_secret, encrypt_secret
from backend.lib.snowflake_client import normalize_account_identifier

AUTH_METHODS = ("local_oauth", "sso", "password", "pat")
AUTH_METHOD_LABELS = {
    "local_oauth": "Local OAuth",
    "sso": "External Browser (SSO)",
    "password": "Password",
    "pat": "Programmatic Access Token (PAT)",
}


def get_connection():
    return psycopg2.connect(get_settings()["database_url"])


@contextmanager
def db_cursor(commit: bool = False) -> Generator[Any, None, None]:
    conn = get_connection()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        yield cur
        if commit:
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def ensure_schema() -> None:
    """Apply additive migrations for existing databases."""
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            ALTER TABLE connections
            ADD COLUMN IF NOT EXISTS auth_method VARCHAR(32) NOT NULL DEFAULT 'pat'
            """
        )
        cur.execute(
            """
            ALTER TABLE connections
            ADD COLUMN IF NOT EXISTS authenticator_url VARCHAR(500)
            """
        )
        # Allow OAuth/SSO rows without a stored secret
        cur.execute(
            """
            ALTER TABLE connections
            ALTER COLUMN pat_encrypted DROP NOT NULL
            """
        )


def ensure_bootstrap() -> None:
    """Create default team + admin user if missing."""
    ensure_schema()
    settings = get_settings()
    with db_cursor(commit=True) as cur:
        cur.execute("SELECT id FROM teams WHERE name = %s", ("Suporte",))
        row = cur.fetchone()
        if row:
            team_id = row["id"]
        else:
            cur.execute("INSERT INTO teams (name) VALUES (%s) RETURNING id", ("Suporte",))
            team_id = cur.fetchone()["id"]

        cur.execute("SELECT id FROM users WHERE username = %s", (settings["admin_username"],))
        if not cur.fetchone():
            cur.execute(
                """
                INSERT INTO users (username, password_hash, role, team_id)
                VALUES (%s, %s, 'admin', %s)
                """,
                (
                    settings["admin_username"],
                    hash_password(settings["admin_password"]),
                    team_id,
                ),
            )


def get_user_by_username(username: str) -> dict | None:
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT u.*, t.name AS team_name
            FROM users u
            LEFT JOIN teams t ON t.id = u.team_id
            WHERE u.username = %s AND u.is_active = TRUE
            """,
            (username,),
        )
        return cur.fetchone()


def list_users() -> list[dict]:
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT u.id, u.username, u.role, u.is_active, u.created_at, t.name AS team_name
            FROM users u
            LEFT JOIN teams t ON t.id = u.team_id
            ORDER BY u.username
            """
        )
        return list(cur.fetchall())


def create_user(username: str, password: str, role: str, team_id: int | None) -> None:
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO users (username, password_hash, role, team_id)
            VALUES (%s, %s, %s, %s)
            """,
            (username, hash_password(password), role, team_id),
        )


def list_teams() -> list[dict]:
    with db_cursor() as cur:
        cur.execute("SELECT id, name FROM teams ORDER BY name")
        return list(cur.fetchall())


def create_team(name: str) -> int:
    with db_cursor(commit=True) as cur:
        cur.execute("INSERT INTO teams (name) VALUES (%s) RETURNING id", (name,))
        return cur.fetchone()["id"]


def list_connections_for_user(user: dict) -> list[dict]:
    with db_cursor() as cur:
        if user["role"] == "admin":
            cur.execute(
                """
                SELECT c.id, c.name, c.account_identifier, c.username,
                       c.auth_method, c.authenticator_url,
                       c.warehouse, c.role_name, c.team_id, c.created_at,
                       t.name AS team_name
                FROM connections c
                LEFT JOIN teams t ON t.id = c.team_id
                ORDER BY c.name
                """
            )
        else:
            cur.execute(
                """
                SELECT DISTINCT c.id, c.name, c.account_identifier, c.username,
                       c.auth_method, c.authenticator_url,
                       c.warehouse, c.role_name, c.team_id, c.created_at,
                       t.name AS team_name
                FROM connections c
                LEFT JOIN teams t ON t.id = c.team_id
                LEFT JOIN connection_acl a ON a.connection_id = c.id
                WHERE c.team_id = %s OR a.team_id = %s OR c.created_by = %s
                ORDER BY c.name
                """,
                (user.get("team_id"), user.get("team_id"), user["id"]),
            )
        return list(cur.fetchall())


def get_connection_by_id(connection_id: int) -> dict | None:
    with db_cursor() as cur:
        cur.execute("SELECT * FROM connections WHERE id = %s", (connection_id,))
        return cur.fetchone()


def get_connection_credentials(connection_id: int) -> dict:
    """Return connection row fields needed to open a Snowflake session."""
    row = get_connection_by_id(connection_id)
    if not row:
        raise ValueError("Conexão não encontrada.")

    method = row.get("auth_method") or "pat"
    secret = None
    if row.get("pat_encrypted"):
        secret = decrypt_secret(row["pat_encrypted"])

    if method in ("pat", "password") and not secret:
        raise ValueError("Conexão sem credencial armazenada. Recadastre com PAT ou senha.")

    return {
        "account": row["account_identifier"],
        "user": row["username"],
        "auth_method": method,
        "password": secret,
        "authenticator_url": row.get("authenticator_url"),
        "warehouse": row.get("warehouse"),
        "role": row.get("role_name"),
        "row": row,
    }


def get_connection_secret(connection_id: int) -> tuple[dict, str | None]:
    """Backward-compatible helper: (row, decrypted_secret_or_None)."""
    creds = get_connection_credentials(connection_id)
    return creds["row"], creds["password"]


def create_connection(
    *,
    name: str,
    account_identifier: str,
    username: str,
    auth_method: str = "pat",
    secret: str | None = None,
    authenticator_url: str | None = None,
    warehouse: str | None = None,
    role_name: str | None = None,
    created_by: int,
    team_id: int | None,
    acl_team_ids: Iterable[int] | None = None,
    # legacy alias
    pat: str | None = None,
) -> int:
    if auth_method not in AUTH_METHODS:
        raise ValueError(f"auth_method inválido: {auth_method}")

    secret_value = secret if secret is not None else pat
    if auth_method in ("pat", "password"):
        if not secret_value:
            raise ValueError("PAT/senha obrigatório para este método.")
        encrypted = encrypt_secret(secret_value)
    else:
        encrypted = None

    url = (authenticator_url or "").strip() or None
    if url and not url.startswith("https://"):
        raise ValueError("URL do IdP SSO deve começar com https://")

    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO connections (
                name, account_identifier, username, auth_method,
                authenticator_url, pat_encrypted,
                warehouse, role_name, created_by, team_id
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                name,
                normalize_account_identifier(account_identifier),
                username.strip(),
                auth_method,
                url,
                encrypted,
                warehouse or None,
                role_name or None,
                created_by,
                team_id,
            ),
        )
        conn_id = cur.fetchone()["id"]
        for tid in acl_team_ids or []:
            cur.execute(
                """
                INSERT INTO connection_acl (connection_id, team_id)
                VALUES (%s, %s)
                ON CONFLICT DO NOTHING
                """,
                (conn_id, tid),
            )
        return conn_id


def delete_connection(connection_id: int) -> None:
    with db_cursor(commit=True) as cur:
        cur.execute("DELETE FROM connections WHERE id = %s", (connection_id,))


def user_can_access_connection(user: dict, connection_id: int) -> bool:
    if user["role"] == "admin":
        return True
    allowed = {c["id"] for c in list_connections_for_user(user)}
    return connection_id in allowed
