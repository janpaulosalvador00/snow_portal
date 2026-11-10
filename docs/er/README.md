# Modelo ER — Snow Portal

Diagramas do banco Postgres do portal (cadastro editável). A partir da v3, as métricas Snowflake ficam em cache por conexão na tabela `snowflake_cache` (o Snowflake continua sendo a fonte; o botão Atualizar re-consulta).

| Arquivo | Versão | Notas |
| --- | --- | --- |
| [snow_portal_er_v1.png](snow_portal_er_v1.png) | v1 | Baseline: teams, users, connections, ACL, oauth_pending + prefs Alerts/conexão ativa + canais de notificação |
| [snow_portal_er_v1.mmd](snow_portal_er_v1.mmd) | v1 | Fonte Mermaid do mesmo modelo |
| [snow_portal_er_v2.png](snow_portal_er_v2.png) | v2 | Adiciona `notification_deliveries` para histórico e KPIs de entregas |
| [snow_portal_er_v2.mmd](snow_portal_er_v2.mmd) | v2 | Fonte Mermaid do modelo atualizado |
| [snow_portal_er_v3.png](snow_portal_er_v3.png) | v3 | Adiciona `snowflake_cache`: cache por conexão dos dados do Snowflake (Consumption, Overview, Anomalies, Monitors, Budgets, Org, opções WH/roles) |
| [snow_portal_er_v3.mmd](snow_portal_er_v3.mmd) | v3 | Fonte Mermaid do modelo atualizado |

Próximas alterações: salvar como `snow_portal_er_v4.png` (+ `.mmd`) sem sobrescrever versões anteriores.
