"""Postgres access layer."""
from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Generator, Iterable

import bcrypt
import psycopg2
import psycopg2.extras

from backend.lib import token_export
from backend.lib.config import get_settings
from backend.lib.crypto import decrypt_secret, encrypt_secret, secret_fingerprint
from backend.lib.snowflake_client import normalize_account_identifier

logger = logging.getLogger(__name__)

AUTH_METHODS = ("local_oauth", "sso", "password", "pat", "oauth", "keypair")
AUTH_METHOD_LABELS = {
    "oauth": "Browser OAuth (Cortex)",
    "local_oauth": "Browser OAuth (Cortex)",
    "sso": "External Browser (SSO)",
    "password": "Password",
    "pat": "Programmatic Access Token (PAT)",
    "keypair": "Key pair (RSA)",
}
# Methods whose credential lives (encrypted) in connections.pat_encrypted.
SECRET_METHODS = ("pat", "password", "keypair", "oauth", "local_oauth")

TOKEN_TYPES = ("oauth_access", "oauth_refresh", "pat", "password", "private_key")
TOKEN_STATUSES = ("active", "expired", "revoked")
TOKEN_SOURCES = ("oauth", "typed", "upload", "folder", "saved_token")
# Who set connection_tokens.expires_at: the provider (OAuth expires_in) or a user (manual).
EXPIRY_SOURCES = ("provider", "manual")
_SQL_TOKEN_TYPES = ", ".join(f"'{t}'" for t in TOKEN_TYPES)
_SQL_AUTH_METHODS = ", ".join(f"'{m}'" for m in AUTH_METHODS)

# No FK to connections: revoked rows outlive the connection as an audit trail.
CONNECTION_TOKENS_DDL = """
CREATE TABLE IF NOT EXISTS connection_tokens (
    id                  SERIAL PRIMARY KEY,
    connection_id       INT NOT NULL,
    connection_name     VARCHAR(200),
    account_identifier  VARCHAR(200),
    username            VARCHAR(200),
    role_name           VARCHAR(200),
    auth_method         VARCHAR(32),
    token_type          VARCHAR(32) NOT NULL
                        CONSTRAINT connection_tokens_token_type_check
                        CHECK (token_type IN ({_SQL_TOKEN_TYPES})),
    token_encrypted     TEXT,
    fingerprint         VARCHAR(16),
    status              VARCHAR(16) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'expired', 'revoked')),
    issued_at           TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    expires_at_source   VARCHAR(16),
    last_refreshed_at   TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    file_name           VARCHAR(300),
    source              VARCHAR(16),
    source_file         VARCHAR(300),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (connection_id, token_type)
)
""".replace("{_SQL_TOKEN_TYPES}", _SQL_TOKEN_TYPES)

CONNECTION_TOKENS_VIEW_DDL = """
CREATE OR REPLACE VIEW v_connection_tokens AS
SELECT id, connection_id, connection_name, account_identifier, username, role_name,
       auth_method, token_type,
       CASE WHEN status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
            THEN 'expired' ELSE status END AS status,
       fingerprint, issued_at, expires_at, last_refreshed_at, revoked_at,
       file_name, created_at, updated_at, source, source_file, expires_at_source
FROM connection_tokens
"""


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
        # Canonical public/stored roles. Existing analyst rows become suporte.
        cur.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check")
        cur.execute("UPDATE users SET role = 'suporte' WHERE role = 'analyst'")
        cur.execute(
            """
            ALTER TABLE users
            ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'suporte'))
            """
        )
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
        # Expand auth_method check to include oauth
        cur.execute(
            """
            ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_auth_method_check
            """
        )
        cur.execute(
            f"""
            ALTER TABLE connections
            ADD CONSTRAINT connections_auth_method_check
            CHECK (auth_method IN ({_SQL_AUTH_METHODS}))
            """
        )
        # Browser OAuth pending state must survive API restarts (in-memory alone loses mid-login).
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS oauth_pending (
                state       VARCHAR(128) PRIMARY KEY,
                payload     JSONB NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_oauth_pending_created
            ON oauth_pending(created_at)
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS notification_channels (
                id                  SERIAL PRIMARY KEY,
                name                VARCHAR(200) NOT NULL,
                provider            VARCHAR(32) NOT NULL
                                    CHECK (provider IN ('teams', 'slack', 'gchat')),
                destination         VARCHAR(200),
                webhook_encrypted   TEXT NOT NULL,
                team_id             INT REFERENCES teams(id) ON DELETE SET NULL,
                is_active           BOOLEAN NOT NULL DEFAULT TRUE,
                last_delivery_at    TIMESTAMPTZ,
                last_ok             BOOLEAN,
                created_by          INT REFERENCES users(id) ON DELETE SET NULL,
                created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS notification_channel_events (
                channel_id  INT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
                event_key   VARCHAR(64) NOT NULL,
                PRIMARY KEY (channel_id, event_key)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS notification_deliveries (
                id          BIGSERIAL PRIMARY KEY,
                channel_id  INT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
                event_key   VARCHAR(64) NOT NULL DEFAULT 'test',
                ok          BOOLEAN NOT NULL,
                detail      VARCHAR(500),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_notification_channels_team
            ON notification_channels(team_id)
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
            ON notification_deliveries(created_at)
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS snowflake_cache (
                connection_id       INT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
                dataset             VARCHAR(64) NOT NULL,
                params_key          TEXT NOT NULL DEFAULT '{}',
                payload             JSONB NOT NULL,
                fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_accessed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (connection_id, dataset, params_key)
            )
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_snowflake_cache_accessed
            ON snowflake_cache(connection_id, last_accessed_at)
            """
        )
        cur.execute(CONNECTION_TOKENS_DDL)
        cur.execute("ALTER TABLE connection_tokens ADD COLUMN IF NOT EXISTS source VARCHAR(16)")
        cur.execute(
            "ALTER TABLE connection_tokens ADD COLUMN IF NOT EXISTS source_file VARCHAR(300)"
        )
        cur.execute(
            "ALTER TABLE connection_tokens ADD COLUMN IF NOT EXISTS expires_at_source VARCHAR(16)"
        )
        # Rows written before the column existed: any stored expiry came from the provider.
        cur.execute(
            """
            UPDATE connection_tokens SET expires_at_source = 'provider'
            WHERE expires_at IS NOT NULL AND expires_at_source IS NULL
            """
        )
        cur.execute(
            "ALTER TABLE connection_tokens DROP CONSTRAINT IF EXISTS connection_tokens_token_type_check"
        )
        cur.execute(
            f"""
            ALTER TABLE connection_tokens
            ADD CONSTRAINT connection_tokens_token_type_check
            CHECK (token_type IN ({_SQL_TOKEN_TYPES}))
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_connection_tokens_connection
            ON connection_tokens(connection_id)
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_connection_tokens_status_expires
            ON connection_tokens(status, expires_at)
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_connection_tokens_account
            ON connection_tokens(account_identifier)
            """
        )
        cur.execute(CONNECTION_TOKENS_VIEW_DDL)


def get_cache(connection_id: int, dataset: str, params_key: str) -> dict | None:
    """Return {payload, fetched_at} and bump last_accessed_at, or None."""
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            UPDATE snowflake_cache
            SET last_accessed_at = NOW()
            WHERE connection_id = %s AND dataset = %s AND params_key = %s
            RETURNING payload, fetched_at
            """,
            (connection_id, dataset, params_key),
        )
        row = cur.fetchone()
    if not row:
        return None
    payload = row["payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    return {"payload": payload, "fetched_at": row["fetched_at"]}


def upsert_cache(connection_id: int, dataset: str, params_key: str, payload_json: str):
    """Store a serialized payload; returns fetched_at."""
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO snowflake_cache
                (connection_id, dataset, params_key, payload, fetched_at, last_accessed_at)
            VALUES (%s, %s, %s, %s::jsonb, NOW(), NOW())
            ON CONFLICT (connection_id, dataset, params_key) DO UPDATE
            SET payload = EXCLUDED.payload,
                fetched_at = NOW(),
                last_accessed_at = NOW()
            RETURNING fetched_at
            """,
            (connection_id, dataset, params_key, payload_json),
        )
        return cur.fetchone()["fetched_at"]


def delete_cache_for_connection(connection_id: int) -> None:
    with db_cursor(commit=True) as cur:
        cur.execute("DELETE FROM snowflake_cache WHERE connection_id = %s", (connection_id,))


def list_recent_cache_keys(connection_id: int, *, hours: int = 24) -> list[dict]:
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT dataset, params_key
            FROM snowflake_cache
            WHERE connection_id = %s
              AND last_accessed_at >= NOW() - (%s || ' hours')::interval
            """,
            (connection_id, str(int(hours))),
        )
        return [dict(r) for r in cur.fetchall()]


def purge_stale_cache(connection_id: int, *, days: int = 7) -> int:
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            DELETE FROM snowflake_cache
            WHERE connection_id = %s
              AND last_accessed_at < NOW() - (%s || ' days')::interval
            """,
            (connection_id, str(int(days))),
        )
        return cur.rowcount


def put_oauth_pending(state: str, payload: dict, *, ttl_sec: int = 600) -> None:
    """Store OAuth PKCE pending row; purge expired first."""
    with db_cursor(commit=True) as cur:
        cur.execute(
            "DELETE FROM oauth_pending WHERE created_at < NOW() - (%s || ' seconds')::interval",
            (str(int(ttl_sec)),),
        )
        cur.execute(
            """
            INSERT INTO oauth_pending (state, payload, created_at)
            VALUES (%s, %s::jsonb, NOW())
            ON CONFLICT (state) DO UPDATE
            SET payload = EXCLUDED.payload, created_at = NOW()
            """,
            (state, json.dumps(payload)),
        )


def pop_oauth_pending(state: str, *, ttl_sec: int = 600) -> dict | None:
    """Atomically take pending OAuth state if still within TTL."""
    with db_cursor(commit=True) as cur:
        cur.execute(
            "DELETE FROM oauth_pending WHERE created_at < NOW() - (%s || ' seconds')::interval",
            (str(int(ttl_sec)),),
        )
        cur.execute(
            """
            DELETE FROM oauth_pending
            WHERE state = %s
            RETURNING payload
            """,
            (state,),
        )
        row = cur.fetchone()
        if not row:
            return None
        payload = row["payload"]
        if isinstance(payload, str):
            return json.loads(payload)
        return dict(payload)


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


def update_user(
    user_id: int,
    *,
    username: str | None = None,
    password: str | None = None,
    role: str | None = None,
    team_id: int | None = None,
    clear_team: bool = False,
    is_active: bool | None = None,
) -> bool:
    fields: list[str] = []
    values: list[Any] = []
    if username is not None:
        fields.append("username = %s")
        values.append(username)
    if password:
        fields.append("password_hash = %s")
        values.append(hash_password(password))
    if role is not None:
        fields.append("role = %s")
        values.append(role)
    if clear_team:
        fields.append("team_id = NULL")
    elif team_id is not None:
        fields.append("team_id = %s")
        values.append(team_id)
    if is_active is not None:
        fields.append("is_active = %s")
        values.append(is_active)
    if not fields:
        return False
    values.append(user_id)
    with db_cursor(commit=True) as cur:
        cur.execute(
            f"UPDATE users SET {', '.join(fields)} WHERE id = %s",
            values,
        )
        return cur.rowcount > 0


def list_teams() -> list[dict]:
    with db_cursor() as cur:
        cur.execute("SELECT id, name FROM teams ORDER BY name")
        return list(cur.fetchall())


def create_team(name: str) -> int:
    with db_cursor(commit=True) as cur:
        cur.execute("INSERT INTO teams (name) VALUES (%s) RETURNING id", (name,))
        return cur.fetchone()["id"]


def update_team(team_id: int, name: str) -> bool:
    with db_cursor(commit=True) as cur:
        cur.execute("UPDATE teams SET name = %s WHERE id = %s", (name, team_id))
        return cur.rowcount > 0


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

    if method in SECRET_METHODS and not secret:
        raise ValueError("Conexão sem credencial armazenada. Refaça o login via browser ou PAT.")

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
    secret_source: dict | None = None,
    # legacy alias
    pat: str | None = None,
) -> int:
    if auth_method not in AUTH_METHODS:
        raise ValueError(f"auth_method inválido: {auth_method}")

    secret_value = secret if secret is not None else pat
    if auth_method in SECRET_METHODS:
        if not secret_value:
            raise ValueError("Credencial obrigatória para este método.")
        encrypted = encrypt_secret(secret_value)
    else:
        encrypted = None

    url = (authenticator_url or "").strip() or None
    if url and auth_method == "sso" and not url.startswith("https://"):
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
    _sync_tokens_safely(conn_id, source=secret_source)
    return conn_id


def delete_connection(connection_id: int) -> None:
    with db_cursor(commit=True) as cur:
        _revoke_tokens(cur, connection_id)
        cur.execute("DELETE FROM connections WHERE id = %s", (connection_id,))
    token_export.remove_token_files(connection_id)


def update_connection(
    connection_id: int,
    *,
    name: str | None = None,
    account_identifier: str | None = None,
    username: str | None = None,
    auth_method: str | None = None,
    secret: str | None = None,
    authenticator_url: str | None = None,
    warehouse: str | None = None,
    role_name: str | None = None,
    clear_warehouse: bool = False,
    clear_role: bool = False,
    update_secret: bool = False,
    secret_source: dict | None = None,
) -> dict:
    """Update connection fields; optionally replace credentials (re-auth)."""
    row = get_connection_by_id(connection_id)
    if not row:
        raise ValueError("Conexão não encontrada.")

    new_name = (name if name is not None else row["name"]) or row["name"]
    new_name = str(new_name).strip() or row["name"]

    new_account = (
        normalize_account_identifier(account_identifier)
        if account_identifier is not None
        else row["account_identifier"]
    )
    new_user = username.strip() if username is not None else row["username"]
    new_method = auth_method if auth_method is not None else (row.get("auth_method") or "pat")
    if new_method == "browser_oauth":
        new_method = "oauth"
    if new_method not in AUTH_METHODS:
        raise ValueError(f"auth_method inválido: {new_method}")

    new_url = row.get("authenticator_url")
    if authenticator_url is not None:
        new_url = (authenticator_url or "").strip() or None

    if clear_warehouse:
        new_wh = None
    elif warehouse is not None:
        new_wh = warehouse.strip() or None
    else:
        new_wh = row.get("warehouse")

    if clear_role:
        new_role = None
    elif role_name is not None:
        new_role = role_name.strip() or None
    else:
        new_role = row.get("role_name")

    encrypted = row.get("pat_encrypted")
    if update_secret:
        if new_method in SECRET_METHODS:
            if not secret:
                raise ValueError("Credencial obrigatória para revalidar este método.")
            encrypted = encrypt_secret(secret)
        else:
            encrypted = None

    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            UPDATE connections
            SET name = %s,
                account_identifier = %s,
                username = %s,
                auth_method = %s,
                authenticator_url = %s,
                pat_encrypted = %s,
                warehouse = %s,
                role_name = %s,
                updated_at = NOW()
            WHERE id = %s
            RETURNING *
            """,
            (
                new_name,
                new_account,
                new_user,
                new_method,
                new_url,
                encrypted,
                new_wh,
                new_role,
                connection_id,
            ),
        )
        updated = cur.fetchone()
    _sync_tokens_safely(connection_id, source=secret_source if update_secret else None)
    return updated


def update_connection_secret(connection_id: int, secret: str) -> None:
    """Re-encrypt and store OAuth/PAT secret (e.g. after token refresh)."""
    encrypted = encrypt_secret(secret)
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            UPDATE connections
            SET pat_encrypted = %s, updated_at = NOW()
            WHERE id = %s
            """,
            (encrypted, connection_id),
        )
    _sync_tokens_safely(connection_id, refreshed=True)


def _derive_tokens(row: dict) -> list[dict] | None:
    """Split a connection's stored secret into token entries (None = undecryptable)."""
    method = row.get("auth_method") or "pat"
    if not row.get("pat_encrypted"):
        return []
    try:
        secret = decrypt_secret(row["pat_encrypted"])
    except ValueError as exc:
        logger.warning("connection_tokens: cannot decrypt connection %s: %s", row["id"], exc)
        return None
    if method in ("pat", "password"):
        return [{"token_type": method, "value": secret, "expires_in": None}]
    if method == "keypair":
        return [{"token_type": "private_key", "value": secret, "expires_in": None}]
    if method in ("oauth", "local_oauth"):
        stripped = secret.strip()
        blob = json.loads(stripped) if stripped.startswith("{") else {"access_token": stripped}
        tokens = []
        if blob.get("access_token"):
            tokens.append(
                {
                    "token_type": "oauth_access",
                    "value": blob["access_token"],
                    "expires_in": blob.get("expires_in"),
                }
            )
        if blob.get("refresh_token"):
            tokens.append(
                {
                    "token_type": "oauth_refresh",
                    "value": blob["refresh_token"],
                    "expires_in": blob.get("refresh_token_expires_in"),
                }
            )
        return tokens
    return []


def _revoke_tokens(cur, connection_id: int, token_types: Iterable[str] | None = None) -> int:
    sql = """
        UPDATE connection_tokens
        SET status = 'revoked', token_encrypted = NULL, file_name = NULL,
            revoked_at = NOW(), updated_at = NOW()
        WHERE connection_id = %s AND status <> 'revoked'
    """
    params: list[Any] = [connection_id]
    if token_types is not None:
        sql += " AND token_type = ANY(%s)"
        params.append(list(token_types))
    cur.execute(sql, params)
    return cur.rowcount


def sync_connection_tokens(
    connection_id: int,
    *,
    refreshed: bool = False,
    source: dict | None = None,
) -> list[dict]:
    """Mirror connections.pat_encrypted into connection_tokens + JSON files.

    Unchanged tokens (same fingerprint) keep their ciphertext, issued_at,
    expires_at and origin; tokens no longer present are revoked. ``source``
    ({"source", "source_file"}) records where a newly supplied secret came from.
    Returns the active rows.
    """
    now = datetime.now(timezone.utc)
    exporting = token_export.export_dir() is not None
    with db_cursor(commit=True) as cur:
        cur.execute("SELECT * FROM connections WHERE id = %s", (connection_id,))
        conn = cur.fetchone()
        if not conn:
            _revoke_tokens(cur, connection_id)
            tokens: list[dict] | None = []
        else:
            tokens = _derive_tokens(conn)
        if tokens is None:
            return []
        cur.execute("SELECT * FROM connection_tokens WHERE connection_id = %s", (connection_id,))
        existing = {r["token_type"]: r for r in cur.fetchall()}
        for tok in tokens:
            ttype = tok["token_type"]
            fingerprint = secret_fingerprint(tok["value"])
            prev = existing.get(ttype)
            unchanged = (
                prev is not None
                and prev["status"] != "revoked"
                and prev["token_encrypted"]
                and prev["fingerprint"] == fingerprint
            )
            if unchanged:
                encrypted = prev["token_encrypted"]
                issued_at = prev["issued_at"]
                expires_at = prev["expires_at"]
                expires_at_source = prev.get("expires_at_source")
                last_refreshed_at = prev["last_refreshed_at"]
            else:
                encrypted = encrypt_secret(tok["value"])
                issued_at = conn.get("updated_at") or now
                expires_at = None
                if tok.get("expires_in"):
                    try:
                        expires_at = issued_at + timedelta(seconds=int(tok["expires_in"]))
                    except (TypeError, ValueError):
                        expires_at = None
                expires_at_source = "provider" if expires_at is not None else None
                last_refreshed_at = (
                    now if refreshed else (prev["last_refreshed_at"] if prev else None)
                )
            if source and source.get("source") in TOKEN_SOURCES:
                origin, origin_file = source["source"], source.get("source_file")
            elif unchanged and prev.get("source"):
                origin, origin_file = prev["source"], prev.get("source_file")
            elif ttype.startswith("oauth_"):
                origin, origin_file = "oauth", None
            else:
                origin, origin_file = None, None
            origin_file = (origin_file or "")[:300] or None
            status = "expired" if expires_at is not None and expires_at <= now else "active"
            fname = (
                token_export.file_name(connection_id, conn["account_identifier"], ttype)
                if exporting
                else None
            )
            cur.execute(
                """
                INSERT INTO connection_tokens (
                    connection_id, connection_name, account_identifier, username,
                    role_name, auth_method, token_type, token_encrypted, fingerprint,
                    status, issued_at, expires_at, last_refreshed_at, revoked_at, file_name,
                    source, source_file, expires_at_source
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, %s, %s, %s, %s)
                ON CONFLICT (connection_id, token_type) DO UPDATE
                SET connection_name = EXCLUDED.connection_name,
                    account_identifier = EXCLUDED.account_identifier,
                    username = EXCLUDED.username,
                    role_name = EXCLUDED.role_name,
                    auth_method = EXCLUDED.auth_method,
                    token_encrypted = EXCLUDED.token_encrypted,
                    fingerprint = EXCLUDED.fingerprint,
                    status = EXCLUDED.status,
                    issued_at = EXCLUDED.issued_at,
                    expires_at = EXCLUDED.expires_at,
                    last_refreshed_at = EXCLUDED.last_refreshed_at,
                    revoked_at = NULL,
                    file_name = EXCLUDED.file_name,
                    source = EXCLUDED.source,
                    source_file = EXCLUDED.source_file,
                    expires_at_source = EXCLUDED.expires_at_source,
                    updated_at = NOW()
                WHERE (
                    connection_tokens.connection_name, connection_tokens.account_identifier,
                    connection_tokens.username, connection_tokens.role_name,
                    connection_tokens.auth_method, connection_tokens.token_encrypted,
                    connection_tokens.status, connection_tokens.issued_at,
                    connection_tokens.expires_at, connection_tokens.last_refreshed_at,
                    connection_tokens.revoked_at, connection_tokens.file_name,
                    connection_tokens.source, connection_tokens.source_file,
                    connection_tokens.expires_at_source
                ) IS DISTINCT FROM (
                    EXCLUDED.connection_name, EXCLUDED.account_identifier,
                    EXCLUDED.username, EXCLUDED.role_name,
                    EXCLUDED.auth_method, EXCLUDED.token_encrypted,
                    EXCLUDED.status, EXCLUDED.issued_at,
                    EXCLUDED.expires_at, EXCLUDED.last_refreshed_at,
                    NULL::timestamptz, EXCLUDED.file_name,
                    EXCLUDED.source, EXCLUDED.source_file,
                    EXCLUDED.expires_at_source
                )
                """,
                (
                    connection_id,
                    conn["name"],
                    conn["account_identifier"],
                    conn["username"],
                    conn.get("role_name"),
                    conn.get("auth_method") or "pat",
                    ttype,
                    encrypted,
                    fingerprint,
                    status,
                    issued_at,
                    expires_at,
                    last_refreshed_at,
                    fname,
                    origin,
                    origin_file,
                    expires_at_source,
                ),
            )
        stale = [t for t in existing if t not in {tok["token_type"] for tok in tokens}]
        if stale:
            _revoke_tokens(cur, connection_id, stale)
        cur.execute(
            """
            SELECT * FROM connection_tokens
            WHERE connection_id = %s AND status <> 'revoked'
            ORDER BY token_type
            """,
            (connection_id,),
        )
        active = [dict(r) for r in cur.fetchall()]

    written = {name for name in (token_export.write_token_file(r) for r in active) if name}
    token_export.remove_token_files(connection_id, keep=written)
    return active


def _sync_tokens_safely(
    connection_id: int, *, refreshed: bool = False, source: dict | None = None
) -> None:
    try:
        sync_connection_tokens(connection_id, refreshed=refreshed, source=source)
    except Exception:  # noqa: BLE001
        logger.exception("connection_tokens sync failed for connection %s", connection_id)


TOKEN_TYPE_FOR_METHOD = {"pat": "pat", "password": "password", "keypair": "private_key"}


def list_saved_tokens(user: dict, *, token_type: str | None = None) -> list[dict]:
    """Reusable secrets (metadata only), one entry per distinct secret.

    Rows sharing a fingerprint (same secret reused by several connections) are
    merged; ``connections`` lists every connection using it.
    """
    allowed = None if user["role"] == "admin" else {
        c["id"] for c in list_connections_for_user(user)
    }
    sql = """
        SELECT v.id, v.connection_id, v.connection_name, v.account_identifier, v.username,
               v.role_name, v.auth_method, v.token_type, v.status, v.fingerprint,
               v.issued_at, v.expires_at, v.last_refreshed_at, v.updated_at,
               v.source, v.source_file
        FROM v_connection_tokens v
        JOIN connections c ON c.id = v.connection_id
        WHERE v.status <> 'revoked' AND v.token_type = ANY(%s)
        ORDER BY v.updated_at DESC, v.id DESC
    """
    reusable = list(TOKEN_TYPE_FOR_METHOD.values())
    params: list[Any] = [[token_type] if token_type in reusable else reusable]
    with db_cursor() as cur:
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]

    merged: dict[tuple, dict] = {}
    for row in rows:
        if allowed is not None and row["connection_id"] not in allowed:
            continue
        key = (row["token_type"], row["fingerprint"])
        ref = {"id": row["connection_id"], "name": row["connection_name"]}
        if key in merged:
            merged[key]["connections"].append(ref)
            continue
        row["connections"] = [ref]
        merged[key] = row
    return list(merged.values())


def get_saved_token_secret(user: dict, token_id: int, *, token_type: str) -> tuple[dict, str]:
    """Decrypt a saved token for server-side reuse; never return it to the client."""
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT v.*, t.token_encrypted
            FROM v_connection_tokens v
            JOIN connection_tokens t ON t.id = v.id
            WHERE v.id = %s
            """,
            (token_id,),
        )
        row = cur.fetchone()
    if not row or row["status"] == "revoked" or not row.get("token_encrypted"):
        raise ValueError("Token salvo não encontrado ou revogado. Escolha outro ou selecione um arquivo.")
    if not user_can_access_connection(user, row["connection_id"]):
        raise PermissionError("Sem permissão para usar este token.")
    if row["token_type"] != token_type:
        raise ValueError("O token salvo escolhido não é do tipo deste método.")
    if row["status"] == "expired":
        raise ValueError("Token salvo expirado. Escolha outro ou selecione um arquivo novo.")
    secret = decrypt_secret(row.pop("token_encrypted"))
    return dict(row), secret


def get_token_row(token_id: int) -> dict | None:
    """connection_tokens row (live status from the view), without the ciphertext."""
    with db_cursor() as cur:
        cur.execute("SELECT * FROM v_connection_tokens WHERE id = %s", (token_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def set_token_expiry(token_id: int, expires_at: datetime | None) -> dict | None:
    """Set (manual) or clear a token's expiry; recomputes status and rewrites its file."""
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            UPDATE connection_tokens
            SET expires_at = %(exp)s,
                expires_at_source = CASE WHEN %(exp)s::timestamptz IS NULL THEN NULL
                                         ELSE 'manual' END,
                status = CASE WHEN %(exp)s::timestamptz IS NOT NULL AND %(exp)s <= NOW()
                              THEN 'expired' ELSE 'active' END,
                updated_at = NOW()
            WHERE id = %(id)s AND status <> 'revoked'
            RETURNING *
            """,
            {"exp": expires_at, "id": token_id},
        )
        row = cur.fetchone()
    if row and row.get("file_name"):
        token_export.write_token_file(dict(row))
    return dict(row) if row else None


def clear_connection_secret(connection_id: int) -> int:
    """Erase a connection's stored credential; its token rows end up revoked.

    The connection itself (name, ACL, warehouse, cache) is kept so it can be
    re-authenticated later. Returns how many token rows were revoked.
    """
    with db_cursor(commit=True) as cur:
        cur.execute(
            "UPDATE connections SET pat_encrypted = NULL, updated_at = NOW() WHERE id = %s",
            (connection_id,),
        )
        revoked = _revoke_tokens(cur, connection_id)
    token_export.remove_token_files(connection_id)
    return revoked


def revoke_token_row(token_id: int) -> int:
    """Revoke a single row (orphans whose connection no longer exists)."""
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            UPDATE connection_tokens
            SET status = 'revoked', token_encrypted = NULL, file_name = NULL,
                revoked_at = NOW(), updated_at = NOW()
            WHERE id = %s AND status <> 'revoked'
            RETURNING connection_id
            """,
            (token_id,),
        )
        hit = cur.fetchone()
    return 1 if hit else 0


def delete_revoked_token(token_id: int) -> bool:
    with db_cursor(commit=True) as cur:
        cur.execute(
            "DELETE FROM connection_tokens WHERE id = %s AND status = 'revoked'", (token_id,)
        )
        return cur.rowcount > 0


def backfill_connection_tokens() -> dict:
    """Reconcile connection_tokens + files with every connection (idempotent)."""
    with db_cursor() as cur:
        cur.execute("SELECT id FROM connections ORDER BY id")
        ids = [r["id"] for r in cur.fetchall()]
    errors = 0
    for cid in ids:
        try:
            sync_connection_tokens(cid)
        except Exception:  # noqa: BLE001
            errors += 1
            logger.exception("connection_tokens backfill failed for connection %s", cid)
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            UPDATE connection_tokens
            SET status = 'revoked', token_encrypted = NULL, file_name = NULL,
                revoked_at = NOW(), updated_at = NOW()
            WHERE status <> 'revoked'
              AND connection_id NOT IN (SELECT id FROM connections)
            """
        )
        orphans_revoked = cur.rowcount
        cur.execute(
            "SELECT DISTINCT connection_id FROM connection_tokens WHERE status <> 'revoked'"
        )
        active_ids = {r["connection_id"] for r in cur.fetchall()}
        cur.execute("SELECT status, COUNT(*) AS n FROM v_connection_tokens GROUP BY status")
        by_status = {r["status"]: int(r["n"]) for r in cur.fetchall()}
    orphan_files = token_export.remove_orphan_files(active_ids)
    return {
        "connections": len(ids),
        "errors": errors,
        "orphans_revoked": orphans_revoked,
        "orphan_files_removed": orphan_files,
        "by_status": by_status,
        "export_dir": str(token_export.export_dir() or ""),
    }


def user_can_access_connection(user: dict, connection_id: int) -> bool:
    if user["role"] == "admin":
        return True
    allowed = {c["id"] for c in list_connections_for_user(user)}
    return connection_id in allowed


def list_notification_channels() -> list[dict]:
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT c.id, c.name, c.provider, c.destination, c.team_id,
                   c.is_active, c.last_delivery_at, c.last_ok,
                   c.created_by, c.created_at, c.updated_at,
                   t.name AS team_name,
                   COALESCE(
                       array_agg(e.event_key ORDER BY e.event_key)
                       FILTER (WHERE e.event_key IS NOT NULL),
                       ARRAY[]::VARCHAR[]
                   ) AS events
            FROM notification_channels c
            LEFT JOIN teams t ON t.id = c.team_id
            LEFT JOIN notification_channel_events e ON e.channel_id = c.id
            GROUP BY c.id, t.name
            ORDER BY c.name
            """
        )
        return list(cur.fetchall())


def get_notification_channel(channel_id: int, *, include_webhook: bool = False) -> dict | None:
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT c.*, t.name AS team_name,
                   COALESCE(
                       array_agg(e.event_key ORDER BY e.event_key)
                       FILTER (WHERE e.event_key IS NOT NULL),
                       ARRAY[]::VARCHAR[]
                   ) AS events
            FROM notification_channels c
            LEFT JOIN teams t ON t.id = c.team_id
            LEFT JOIN notification_channel_events e ON e.channel_id = c.id
            WHERE c.id = %s
            GROUP BY c.id, t.name
            """,
            (channel_id,),
        )
        row = cur.fetchone()
        if row and not include_webhook:
            row.pop("webhook_encrypted", None)
        return row


def create_notification_channel(
    *,
    name: str,
    provider: str,
    destination: str | None,
    webhook: str,
    team_id: int | None,
    is_active: bool,
    events: Iterable[str],
    created_by: int,
) -> int:
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO notification_channels (
                name, provider, destination, webhook_encrypted,
                team_id, is_active, created_by
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                name,
                provider,
                destination,
                encrypt_secret(webhook),
                team_id,
                is_active,
                created_by,
            ),
        )
        channel_id = cur.fetchone()["id"]
        for event_key in events:
            cur.execute(
                """
                INSERT INTO notification_channel_events (channel_id, event_key)
                VALUES (%s, %s)
                """,
                (channel_id, event_key),
            )
        return channel_id


def update_notification_channel(
    channel_id: int,
    *,
    name: str,
    provider: str,
    destination: str | None,
    webhook: str | None,
    team_id: int | None,
    clear_team: bool,
    is_active: bool,
    events: Iterable[str],
) -> bool:
    resolved_team_id = None if clear_team else team_id
    with db_cursor(commit=True) as cur:
        if webhook:
            cur.execute(
                """
                UPDATE notification_channels
                SET name = %s, provider = %s, destination = %s,
                    webhook_encrypted = %s,
                    team_id = %s,
                    is_active = %s, updated_at = NOW()
                WHERE id = %s
                """,
                (
                    name,
                    provider,
                    destination,
                    encrypt_secret(webhook),
                    resolved_team_id,
                    is_active,
                    channel_id,
                ),
            )
        else:
            cur.execute(
                """
                UPDATE notification_channels
                SET name = %s, provider = %s, destination = %s,
                    team_id = %s,
                    is_active = %s, updated_at = NOW()
                WHERE id = %s
                """,
                (name, provider, destination, resolved_team_id, is_active, channel_id),
            )
        if cur.rowcount == 0:
            return False
        cur.execute("DELETE FROM notification_channel_events WHERE channel_id = %s", (channel_id,))
        for event_key in events:
            cur.execute(
                """
                INSERT INTO notification_channel_events (channel_id, event_key)
                VALUES (%s, %s)
                """,
                (channel_id, event_key),
            )
        return True


def get_notification_webhook(channel_id: int) -> tuple[dict, str]:
    row = get_notification_channel(channel_id, include_webhook=True)
    if not row:
        raise ValueError("Canal não encontrado.")
    encrypted = row.get("webhook_encrypted")
    if not encrypted:
        raise ValueError("Canal sem webhook configurado.")
    return row, decrypt_secret(encrypted)


def record_notification_delivery(
    channel_id: int,
    *,
    event_key: str,
    ok: bool,
    detail: str | None,
) -> None:
    with db_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO notification_deliveries (channel_id, event_key, ok, detail)
            VALUES (%s, %s, %s, %s)
            """,
            (channel_id, event_key, ok, (detail or "")[:500] or None),
        )
        cur.execute(
            """
            UPDATE notification_channels
            SET last_delivery_at = NOW(), last_ok = %s, updated_at = NOW()
            WHERE id = %s
            """,
            (ok, channel_id),
        )


def notification_delivery_kpis() -> dict:
    with db_cursor() as cur:
        cur.execute(
            """
            SELECT
                COUNT(*) FILTER (
                    WHERE ok = FALSE AND created_at >= NOW() - INTERVAL '24 hours'
                ) AS failures_24h,
                COUNT(*) FILTER (
                    WHERE ok = TRUE AND created_at >= CURRENT_DATE
                ) AS delivered_today
            FROM notification_deliveries
            """
        )
        row = cur.fetchone() or {}
        return {
            "failures_24h": int(row.get("failures_24h") or 0),
            "delivered_today": int(row.get("delivered_today") or 0),
        }
