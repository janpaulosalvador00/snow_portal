# Checklist de aceite — snow_portal (React + FastAPI)

- [x] Stack React + FastAPI + Postgres (sem Streamlit)
- [x] Sem sessão → somente tela de login
- [x] Pós-login → AppShell + hub / conexões / cost / admin
- [x] Logout volta à login pura
- [x] Browser OAuth (como Cortex) via `/api/connections/oauth/start` + callback `/api/oauth/callback`
- [x] PAT / Password como fallback; token OAuth criptografado em Postgres
- [x] Runbook `docs/CONECTAR_PAT.md` para PONCETECH_PARTNER
- [x] Docker: `OAUTH_REDIRECT_URI` + `PORTAL_PUBLIC_URL` no compose
- [ ] Conectar conta Snowflake real (Browser OAuth ou PAT) e ver Consumption *(ação do operador)*
