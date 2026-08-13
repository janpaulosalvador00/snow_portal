# Checklist de aceite — snow_portal MVP

## Automatizado / ambiente local (2026-08-13)

- [x] `docker compose up --build` sobe `portal` + `postgres`
- [x] Healthcheck Streamlit (`/_stcore/health`) = ok
- [x] Schema Postgres: users, teams, connections, connection_acl
- [x] Bootstrap admin (`admin` / `admin123` via `.env`)
- [x] Admin cria segundo usuário (`analyst1`) — suporte a time ≥20 via UI Administração
- [x] PAT criptografado em repouso (Fernet); plaintext ausente na coluna `pat_encrypted`
- [x] Métodos Local OAuth, SSO, Password e PAT no Sign in (schema `auth_method`)
- [x] ACL: analyst do mesmo time acessa conexão do time

## Manual (requer conta Snowflake real)

- [ ] Login na UI http://localhost:8501
- [ ] Sign in com account identifier + username + PAT válido
- [ ] Testar conexão OK
- [ ] Cost Management → Consumption com totais na mesma ordem de grandeza do console Snowflake
- [ ] Dois browsers/sessões sem cruzar conta ativa

## Pré-requisito Snowflake

Role com SELECT em `SNOWFLAKE.ACCOUNT_USAGE.METERING_HISTORY` + warehouse.
