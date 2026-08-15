# Modelo ER — Snow Portal

Diagramas do banco Postgres do portal (cadastro editável). Métricas Snowflake ficam fora deste modelo.

| Arquivo | Versão | Notas |
| --- | --- | --- |
| [snow_portal_er_v1.png](snow_portal_er_v1.png) | v1 | Baseline: teams, users, connections, ACL, oauth_pending + prefs Alerts/conexão ativa + canais de notificação |
| [snow_portal_er_v1.mmd](snow_portal_er_v1.mmd) | v1 | Fonte Mermaid do mesmo modelo |
| [snow_portal_er_v2.png](snow_portal_er_v2.png) | v2 | Adiciona `notification_deliveries` para histórico e KPIs de entregas |
| [snow_portal_er_v2.mmd](snow_portal_er_v2.mmd) | v2 | Fonte Mermaid do modelo atualizado |

Próximas alterações: salvar como `snow_portal_er_v3.png` (+ `.mmd`) sem sobrescrever versões anteriores.
