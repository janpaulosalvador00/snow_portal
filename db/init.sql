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
                        CHECK (auth_method IN ('local_oauth', 'sso', 'password', 'pat', 'oauth')),
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

CREATE INDEX IF NOT EXISTS idx_oauth_pending_created ON oauth_pending(created_at);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_connections_team ON connections(team_id);
CREATE INDEX IF NOT EXISTS idx_connections_account ON connections(account_identifier);
CREATE INDEX IF NOT EXISTS idx_notification_channels_team ON notification_channels(team_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
ON notification_deliveries(created_at);

-- Default team (admin user is seeded by the app on first boot)
INSERT INTO teams (name) VALUES ('Suporte')
ON CONFLICT (name) DO NOTHING;
