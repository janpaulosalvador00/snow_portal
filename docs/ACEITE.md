# Checklist de aceite — snow_portal (React + FastAPI)

- [x] Stack React + FastAPI + Postgres (sem Streamlit)
- [x] Sem sessão → somente tela de login
- [x] Pós-login → AppShell + hub / conexões / cost / admin
- [x] Logout volta à login pura
- [x] UI PAT-first + botão “Trocar para PAT” no erro 390190
- [x] Local OAuth → oauth_authorization_code; SSO → externalbrowser; labels Cortex
- [x] Banner Docker vs Cortex desktop + runbook “Por que o Cortex autentica…”
- [x] Runbook `docs/CONECTAR_PAT.md` para PONCETECH_PARTNER
- [x] Docker rebuild (`snowflake-connector-python` 3.16.0; mensagem 390190 nova no container)
- [x] API `/connections/test` com SSO → mensagem Cortex/Docker (não texto SAML antigo)
- [ ] Conectar conta Snowflake real (PAT) e ver Consumption *(ação do operador — cole o PAT no portal)*
