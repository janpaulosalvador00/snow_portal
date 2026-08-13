# Conectar conta PONCETECH (erro 390190)

## Por que falhou

**Local OAuth / SSO** usam `externalbrowser` (SAML). A conta `A8614549778771-PONCETECH_PARTNER` rejeitou com **390190** — SAML2 não configurado (ou legado).

**Não use Local OAuth nesta conta.** Use **PAT** ou **Password**.

## Passo a passo (PAT)

1. Abra https://app.snowflake.com e entre na conta partner.
2. Avatar (canto inferior esquerdo) → **Settings** → **Authentication** / **Programmatic access tokens**  
   (ou peça a um ACCOUNTADMIN para gerar o PAT do usuário `JANSALVADOR`).
3. No snow_portal → **Conexões** → **Sign in to Snowflake**:
   - **Method:** Programmatic Access Token (PAT) *(padrão)*
   - **Account Identifier:** `A8614549778771-PONCETECH_PARTNER`
   - **Connection Name:** `PONCETECH`
   - **Username:** `JANSALVADOR`
   - **PAT:** cole o token
   - Optional: Warehouse `COMPUTE_WH`, Role com acesso a `SNOWFLAKE.ACCOUNT_USAGE`
4. **Testar conexão** → **Sign In / Salvar** → Ativar.
5. **Cost Management** → Consumption.

## Alternativa: Password

Se a política da conta permitir login por senha, use Method **Password** com a senha do usuário.

## Role mínima para créditos

A role usada na conexão precisa de SELECT em `SNOWFLAKE.ACCOUNT_USAGE` (ex.: `ACCOUNTADMIN` ou role custom com grants no database `SNOWFLAKE`).

## Se ainda falhar com PAT

- Confirme account identifier (sem `.snowflakecomputing.com`).
- Confirme que o PAT não expirou e está associado ao mesmo `username`.
- Confirme warehouse existente e role válida.
