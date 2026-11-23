# Plano: Intervalo de atualização (Conexões)

Mockup aprovado: `docs/mockups/conexoes-intervalo-atualizacao.html`

## Todos

- [x] Backend: coluna `refresh_interval INTEGER NULL` + migrate em `db.py` (irmão)
- [x] Backend: create/update/list + schemas em `connections.py` (irmão)
- [x] Extrair `ConnectionEditModal` + `ConnectionCreateModal`
- [x] Campo intervalo no create/edit
- [x] Barra Contas salvas via `GlobalRefreshBar` (irmão)
- [x] Badge Global / N min nos cards
- [x] Timers auto-refresh no `RefreshProvider` (irmão)
- [x] Deep-link `?edit=` e OAuth callback reabrem modal
- [x] Deploy + verificação no browser

## Comportamento / contrato `refresh_interval`

| Valor | Significado | Timer |
|--------|-------------|--------|
| `NULL` | Global | Segue intervalo Global da barra Contas salvas; se Global=Desligada → sem auto |
| `0` | Desligada | Esta conexão NÃO agenda auto-refresh |
| `1..60` | Minutos fixos | POST `/api/connections/{id}/refresh` a cada N min |
| Botão ↻ manual | — | Continua refresh de TODAS as conexões |

## Decisões

- Create permanece na aba Sign in (form complexo); edit obrigatoriamente modal.
- Intervalo Global em localStorage (`snow_portal_connections_global_interval`), opções iguais ao Alerts (0/60/300/… segundos).
- Backend guarda minutos (`INTEGER NULL`).
