# snow_portal

Portal local (Docker) — **React** + **FastAPI** + Postgres — para o time de suporte conectar contas Snowflake e ver **Cost Management → Consumption**.

## Stack

- Frontend: Vite + React + TypeScript (nginx)
- API: FastAPI (JWT)
- Postgres (usuários, times, conexões + ACL)
- Auth Snowflake: **Browser OAuth** (como Cortex, sem PAT), Password, PAT


## Gate de login

Sem sessão, a UI mostra **somente** a tela de login. Hub, conexões, créditos e admin só aparecem após autenticar.

## Subir

```bash
cp .env.example .env
docker compose up --build
```

- App: http://localhost:8501  
- API: http://localhost:8010/api/health (porta do host via `API_PORT`)  

Login: `admin` / `admin123` (ou `.env`)

## Desenvolvimento

```bash
docker compose up postgres api -d
cd frontend && npm install && npm run dev   # :5173 com proxy /api
```

## Segurança

- JWT Bearer no header
- PAT/senha criptografados em Postgres
- `.env` fora do git

### Tokens de conexão (`connection_tokens`)

Cada segredo de conexão (OAuth `oauth_access` / `oauth_refresh`, `pat`, `password`) fica em uma linha de `connection_tokens`, com o valor **criptografado (Fernet)** e metadados legíveis: conexão, conta, usuário, role, método, `status` (`active`/`expired`/`revoked`), `issued_at`, `expires_at`, `last_refreshed_at` e `fingerprint` (HMAC, serve para ver se o token mudou sem decifrar). `connections.pat_encrypted` continua sendo o que a API lê para conectar; a tabela é sincronizada em criar/editar/remover conexão, no callback OAuth e no refresh do token. Na subida da API roda um backfill idempotente.

Consulta rápida (status `expired` calculado na hora):

```bash
docker compose exec postgres psql -U snow_portal -d snow_portal \
  -c "SELECT connection_id, connection_name, token_type, status, expires_at, last_refreshed_at FROM v_connection_tokens ORDER BY 1, 2;"
```

Pasta de tokens: `TOKENS_HOST_DIR` (no `.env`) é montado em `/app/tokens` no container `api` e deve conter **somente os seus arquivos de token/chave de acesso** (ex.: `rsa_key.p8`, PAT em `.txt`). O portal só lê essa pasta, nunca grava nela (os tokens ficam apenas em `connection_tokens`). Arquivos `conn<id>_<conta>_<token_type>.json` de versões antigas são removidos automaticamente na sincronização; nenhum outro arquivo é tocado. Ao remover a conexão, as linhas viram `revoked` (valor apagado).

Reaproveitar token na conexão (PAT e Key pair RSA): em Conexões, escolha **Token salvo** (lista `GET /api/connection-tokens?method=pat|keypair`, só metadados) ou **Arquivo** (arquivos `.p8/.pem/.key/.txt/.token` da mesma pasta via `GET /api/connection-tokens/files`, ou envio do computador). A API recebe `token_id` / `token_file` / `secret`, lê e decifra no servidor e grava o segredo em `connection_tokens` com a origem em `source` + `source_file`. O segredo nunca volta para o navegador.

## Auth Snowflake

Preferência: **Conectar via browser** (OAuth local `SNOWFLAKE$LOCAL_APPLICATION`, callback em `http://127.0.0.1:8010`). Alternativa: PAT — guia [`docs/CONECTAR_PAT.md`](docs/CONECTAR_PAT.md). Também há **Key pair (RSA)** (`SNOWFLAKE_JWT`): a chave pública precisa estar registrada no usuário (`ALTER USER … SET RSA_PUBLIC_KEY='…'`); se o Snowflake recusar (390144), a mensagem mostra o fingerprint `SHA256:…` da chave para comparar com `DESC USER` → `RSA_PUBLIC_KEY_FP`.

Em **Conexões → Contas salvas**: Editar (warehouse/role), Ativar, Inativar, Remover. Warehouse vazio evita WH default bloqueado por resource monitor; a API tenta um WH disponível automaticamente.

O access token OAuth (~10 min) é renovado **antes de vencer**: o blob guarda `expires_at` (epoch) e, faltando ≤ 60 s, a API usa o refresh token antes de abrir a sessão (um refresh por conexão por vez). O refresh após erro de autenticação continua como fallback.

### OAuth fora do localhost (ex.: Azure)

O `SNOWFLAKE$LOCAL_APPLICATION` só aceita redirect em `127.0.0.1`/`localhost`. Para usar o portal por um endereço público, crie uma integração OAuth **CUSTOM** (como ACCOUNTADMIN) com o redirect HTTPS público. O nginx do container `web` já repassa `/api` para a API, então o callback é `https://<portal>/api/oauth/callback`:

```sql
CREATE SECURITY INTEGRATION SNOW_PORTAL_OAUTH
  TYPE = OAUTH
  ENABLED = TRUE
  OAUTH_CLIENT = CUSTOM
  OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
  OAUTH_REDIRECT_URI = 'https://portal.example.com/api/oauth/callback'
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 7776000   -- 90 dias (máximo padrão)
  OAUTH_ENFORCE_PKCE = TRUE;               -- o portal sempre envia PKCE

SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('SNOW_PORTAL_OAUTH');  -- OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET
```

No `.env`:

```bash
OAUTH_REDIRECT_URI=https://portal.example.com/api/oauth/callback   # idêntico ao da integração
PORTAL_PUBLIC_URL=https://portal.example.com
OAUTH_CLIENT_ID=<OAUTH_CLIENT_ID>
OAUTH_CLIENT_SECRET=<OAUTH_CLIENT_SECRET>
```

Com `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` vazios o comportamento é o local (LOCAL_APPLICATION + PKCE em `http://127.0.0.1:8010`). Cada token guarda o `client_id` que o emitiu e é renovado pelo mesmo client; conexões criadas com o LOCAL_APPLICATION continuam renovando sem a integração. Se o redirect não for localhost e não houver client CUSTOM, `oauth/start` responde 400 explicando isso.

**Roles bloqueadas no OAuth:** por padrão o Snowflake bloqueia `ACCOUNTADMIN`, `SECURITYADMIN` e `ORGADMIN` em sessões OAuth (`BLOCKED_ROLES_LIST`), em qualquer integração. Use uma role comum na conexão e libere o Cost Management para ela:

```sql
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE <role_da_conexao>;
GRANT USAGE ON WAREHOUSE <wh> TO ROLE <role_da_conexao>;
```

Com PAT/senha o portal ainda tenta `USE ROLE ACCOUNTADMIN` quando a role da conexão não enxerga `ACCOUNT_USAGE`.

Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md).
