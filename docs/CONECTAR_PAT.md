# Conectar conta PONCETECH (erro 390190)

## Por que o Cortex autentica e o portal não

No **Cortex Code Desktop**, **Local OAuth** usa `oauth_authorization_code` (app local `SNOWFLAKE$LOCAL_APPLICATION`): o browser abre no Mac e o callback volta para o processo desktop.

Neste **portal web**, a API Python roda no **Docker**. Mesmo com o mapeamento correto (`local_oauth` → `oauth_authorization_code`), o callback OAuth (`127.0.0.1` no container) não chega ao browser do seu Mac — Local OAuth de desktop **não se aplica** da mesma forma.

Além disso, versões antigas do portal mapeavam Local OAuth para `externalbrowser` (SAML). Contas sem SAML2 (ex.: `A8614549778771-PONCETECH_PARTNER`) respondiam **390190**.

| Label Cortex | Authenticator | Neste portal (Docker) |
| --- | --- | --- |
| Local OAuth | `oauth_authorization_code` | Frágil / desktop-only — use PAT |
| External Browser (SSO) | `externalbrowser` | Só com SAML2 + IdP |
| Password / PAT | password | **Recomendado** |

**Método suportado e estável no portal:** **PAT** (ou Password).

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
