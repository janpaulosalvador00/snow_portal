# Checklist de aceite — snow_portal

## Onda 1 — Fundação + conexão

- [x] Stack React + FastAPI + Postgres (sem Streamlit)
- [x] Sem sessão → somente tela de login
- [x] Pós-login → AppShell + hub / conexões / cost / admin
- [x] Logout volta à login pura
- [x] Browser OAuth (como Cortex) via `/api/connections/oauth/start` + callback `/api/oauth/callback`
- [x] PAT / Password como fallback; token OAuth criptografado em Postgres
- [x] Runbook `docs/CONECTAR_PAT.md` para PONCETECH_PARTNER
- [x] Docker: `OAUTH_REDIRECT_URI` + `PORTAL_PUBLIC_URL` no compose

## Onda 2 — Cost Management completo

- [x] Contas salvas: **Editar**, **Inativar**, **Ativar**, **Remover**
- [x] `PATCH /api/connections/{id}` (name / warehouse / role)
- [x] Warehouse vazio não força WH default (evita resource monitor)
- [x] Refresh automático de token OAuth nas leituras
- [x] APIs `/api/cost/*` para as 6 abas
- [x] Consumption + Account Overview + Anomalies + Resource Monitors + Budgets + Organization Overview (dados ou empty-state)
- [x] Hub alinhado a OAuth + conta ativa/inativa
- [x] `docs/ROADMAP.md`
- [ ] Validar Consumption com conta real após Editar WH (ação do operador)
