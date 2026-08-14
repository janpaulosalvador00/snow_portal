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
- API: http://localhost:8000/api/health  

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

## Auth Snowflake

Preferência: **Conectar via browser** (OAuth local `SNOWFLAKE$LOCAL_APPLICATION`, callback em `http://127.0.0.1:8000`). Alternativa: PAT — guia [`docs/CONECTAR_PAT.md`](docs/CONECTAR_PAT.md).

Em **Conexões → Contas salvas**: Editar (warehouse/role), Ativar, Inativar, Remover. Warehouse vazio evita WH default bloqueado por resource monitor; a API tenta um WH disponível automaticamente.

Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md).
