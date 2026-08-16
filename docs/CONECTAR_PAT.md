# Conectar conta PONCETECH

## Recomendado: Browser OAuth (como Cortex)

1. Portal → **Conexões** → **Sign in to Snowflake**
2. Method: **Browser OAuth (como Cortex)**
3. Account: `A8614549778771-PONCETECH_PARTNER`
4. Username: `JANSALVADOR`
5. Optional: Warehouse `COMPUTE_WH`, Role `ACCOUNTADMIN`
6. **Conectar via browser** → faça login no Snowflake → volta ao portal com a conexão salva

O callback OAuth usa `http://127.0.0.1:8010` (igual aos drivers Snowflake / Cortex, com a porta do host definida em `API_PORT`).

## Alternativa: PAT

Se o OAuth via browser falhar:

1. Snowsight → Settings → Authentication → Programmatic access tokens
2. No portal, Method **PAT**, cole o token → Testar → Salvar

## Role mínima para créditos

A role precisa de SELECT em `SNOWFLAKE.ACCOUNT_USAGE`.
