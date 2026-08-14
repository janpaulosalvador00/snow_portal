# Roadmap — snow_portal

| Onda | Status | Entrega |
| --- | --- | --- |
| **1 — Fundação + conexão** | Feita | React + FastAPI + Postgres, login portal, Browser OAuth/PAT, conexões, shell Cost |
| **2 — Cost Management completo** | Em curso | Editar/Inativar conexão; sessão WH/role; refresh OAuth; **6 abas** Cost; aceite “ver créditos” |
| **3 — Time de suporte (≥20)** | Planejada | Onboarding usuários/times, ACL por conexão, auditoria básica, UX multi-conta |
| **4 — Operação / FinOps ativo** | Planejada | Alertas (e-mail/webhook), ações controladas, snapshots locais |
| **5 — Org & produção** | Planejada | Org-connection first-class, hardening, deploy não-local, higiene repo |

```mermaid
flowchart LR
  o1[Onda1_Auth_Conexao]
  o2[Onda2_Cost_6_abas]
  o3[Onda3_Time_ACL]
  o4[Onda4_Alertas]
  o5[Onda5_Org_Prod]
  o1 --> o2 --> o3 --> o4 --> o5
```
