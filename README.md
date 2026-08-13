# snow_portal

Portal local (Docker) para o time de suporte conectar contas Snowflake e visualizar **Cost Management → Consumption** (créditos via `ACCOUNT_USAGE.METERING_HISTORY`).

## Stack

- Streamlit (UI dark estilo Snowflake)
- Postgres (usuários, times, conexões + ACL)
- Snowflake connector com **Local OAuth**, **SSO**, **Password** e **PAT**
- Segredos (PAT/senha) criptografados com Fernet

## Subir

```bash
cp .env.example .env
# edite SNOW_PORTAL_SECRET_KEY e senhas

docker compose up --build
```

Abra http://localhost:8501

**Login inicial**

- Usuário: `admin` (ou `ADMIN_USERNAME` do `.env`)
- Senha: `admin123` (ou `ADMIN_PASSWORD` do `.env`)

## Fluxo

1. Login no portal
2. **Conexões** → Sign in to Snowflake (escolha o Method)
3. Ativar a conta
4. **Cost Management** → aba Consumption
5. **Administração** (admin) → criar usuários/times

## Métodos de autenticação Snowflake

| Method | Como funciona | Segredo salvo |
| --- | --- | --- |
| Local OAuth | `externalbrowser` — abre o navegador no host | nenhum (cache do connector) |
| SSO | browser ou URL do IdP (`https://…`) | nenhum (cache) |
| Password | senha do usuário Snowflake | criptografada |
| PAT | Programmatic Access Token | criptografado |

**Local OAuth / SSO no Docker:** o browser abre no host onde o container roda. Tokens ficam no volume `snowflake_cache` (`/root/.cache/snowflake`).

## Papéis

| Papel | Pode |
| --- | --- |
| `admin` | Tudo: usuários, conexões, créditos |
| `analyst` | Conexões do seu time + créditos |

## Pré-requisito na Snowflake

Role com acesso a `SNOWFLAKE.ACCOUNT_USAGE` e um warehouse para as queries. Os dados de Account Usage podem atrasar algumas horas.

## Desenvolvimento local (sem rebuild da imagem)

Com o compose no ar, o código em `app/` é montado via volume. Para Postgres só:

```bash
docker compose up postgres -d
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=postgresql://snow_portal:snow_portal@localhost:5432/snow_portal
export PYTHONPATH=.
export SNOW_PORTAL_SECRET_KEY=dev-secret-change-me-please-32chars
streamlit run app/Home.py
```

## Segurança

- PAT/senha criptografados em `connections.pat_encrypted`
- Senhas do portal com bcrypt
- Sessão com timeout (`SESSION_TIMEOUT_HOURS`)
- Sem SQL livre na UI (apenas SELECT internos)

## Backlog

Organization Overview, Anomalies, Budgets, Resource Monitors, tags.
