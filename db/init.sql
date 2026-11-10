-- snow_portal schema

CREATE TABLE IF NOT EXISTS teams (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        VARCHAR(100) NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'suporte')),
    team_id         INT REFERENCES teams(id) ON DELETE SET NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connections (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(200) NOT NULL,
    account_identifier  VARCHAR(200) NOT NULL,
    username            VARCHAR(200) NOT NULL,
    auth_method         VARCHAR(32) NOT NULL DEFAULT 'oauth'
                        CHECK (auth_method IN ('local_oauth', 'sso', 'password', 'pat', 'oauth', 'keypair')),
    authenticator_url   VARCHAR(500),
    pat_encrypted       TEXT,
    warehouse           VARCHAR(200),
    role_name           VARCHAR(200),
    created_by          INT REFERENCES users(id) ON DELETE SET NULL,
    team_id             INT REFERENCES teams(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connection_acl (
    connection_id   INT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    team_id         INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (connection_id, team_id)
);

CREATE TABLE IF NOT EXISTS oauth_pending (
    state           VARCHAR(128) PRIMARY KEY,
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS notification_channel_events (
    channel_id  INT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    event_key   VARCHAR(64) NOT NULL,
    PRIMARY KEY (channel_id, event_key)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id          BIGSERIAL PRIMARY KEY,
    channel_id  INT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    event_key   VARCHAR(64) NOT NULL DEFAULT 'test',
    ok          BOOLEAN NOT NULL,
    detail      VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snowflake_cache (
    connection_id       INT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    dataset             VARCHAR(64) NOT NULL,
    params_key          TEXT NOT NULL DEFAULT '{}',
    payload             JSONB NOT NULL,
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (connection_id, dataset, params_key)
);

-- Connection secrets, one row per (connection, token_type). Value stays Fernet-encrypted;
-- no FK so revoked rows survive connection deletion as an audit trail.
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
                        CHECK (token_type IN ('oauth_access', 'oauth_refresh', 'pat', 'password', 'private_key')),
    token_encrypted     TEXT,
    fingerprint         VARCHAR(16),
    status              VARCHAR(16) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'expired', 'revoked')),
    issued_at           TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    last_refreshed_at   TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    file_name           VARCHAR(300),
    -- origin of the secret: oauth | typed | upload | folder | saved_token (+ original file name)
    source              VARCHAR(16),
    source_file         VARCHAR(300),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (connection_id, token_type)
);

CREATE OR REPLACE VIEW v_connection_tokens AS
SELECT id, connection_id, connection_name, account_identifier, username, role_name,
       auth_method, token_type,
       CASE WHEN status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
            THEN 'expired' ELSE status END AS status,
       fingerprint, issued_at, expires_at, last_refreshed_at, revoked_at,
       file_name, created_at, updated_at, source, source_file
FROM connection_tokens;

CREATE INDEX IF NOT EXISTS idx_oauth_pending_created ON oauth_pending(created_at);
CREATE INDEX IF NOT EXISTS idx_connection_tokens_connection ON connection_tokens(connection_id);
CREATE INDEX IF NOT EXISTS idx_connection_tokens_status_expires
ON connection_tokens(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_connection_tokens_account ON connection_tokens(account_identifier);
CREATE INDEX IF NOT EXISTS idx_snowflake_cache_accessed
ON snowflake_cache(connection_id, last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_connections_team ON connections(team_id);
CREATE INDEX IF NOT EXISTS idx_connections_account ON connections(account_identifier);
CREATE INDEX IF NOT EXISTS idx_notification_channels_team ON notification_channels(team_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
ON notification_deliveries(created_at);

-- Default team (admin user is seeded by the app on first boot)
INSERT INTO teams (name) VALUES ('Suporte')
ON CONFLICT (name) DO NOTHING;
