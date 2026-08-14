# Alerts — handoff de UX

## Objetivo

Centralizar o acompanhamento das conexões ativas e priorizar clientes pelo Resource Monitor com maior percentual de consumo.

## Estrutura da tela

- Navegação lateral com item **Alerts** e contador de clientes em alerta.
- O item ativo da sidebar usa um degradê horizontal suave no accent, sem borda e sem sombra (spec em **Sidebar — estado ativo**).
- O bloco de identificação da sidebar mostra apenas o time (**Time: Suporte**); a linha de usuário/papel (`admin · admin`) foi removida.
- Cabeçalho com atualização automática global e ação manual **Atualizar todas**.
- Legenda de severidade posicionada junto ao status de atualização.
- Quatro KPIs: abaixo de 50%, de 50% a 69,9%, de 70% a 89,9% e 90% ou mais.
- Toolbar com contagem dinâmica, busca compacta e filtro de severidade.
- Cards ordenados pelo monitor mais crítico, em ordem decrescente.
- Estado **Desligada** (conta fora de monitoramento) aparece somente em **Todas as severidades**.

## Comportamento

- No desktop, cabeçalho, legenda, KPIs e toolbar permanecem fixos no topo do painel principal; somente os cards e o conteúdo abaixo rolam.
- A sidebar permanece fixa e independente.
- No mobile, o conteúdo volta ao fluxo natural para evitar que o bloco fixo ocupe quase toda a viewport.
- Busca e severidade são combinadas: um card precisa atender aos dois critérios para aparecer.
- A contagem do título é recalculada após cada filtro e desconsidera contas desligadas.
- Em cada conta, o menu segue a ordem **Desligado**, **Automático**, **1 min**, **5 min**, **10 min**, **15 min**, **30 min** e **60 min**. **Automático** herda o intervalo global; qualquer intervalo explícito ignora o global.
- No cabeçalho, o menu global segue a ordem **Desligada**, **1 min**, **5 min**, **10 min**, **15 min**, **30 min** e **60 min**.
- **Desligado** em um card desativa a atualização automática só daquela conta.
- Se o intervalo global estiver **Desligada**, cards em **Automático** também não fazem auto-refresh.
- **Atualizar todas** é um refresh manual forçado: atualiza **todos** os cards na hora, sem olhar o intervalo de cada conta (**Automático**, intervalo próprio ou **Desligado**), inclusive cards filtrados pela busca ou severidade e o card de conta **Desligada**.
- O botão não altera a preferência de intervalo de nenhuma conta; ele apenas dispara a atualização agora e reinicia a contagem dos timers automáticos a partir daquele momento.
- Ao final do refresh manual, **Última atualização** recebe o horário atual e **Próxima atualização** é recalculada pelo intervalo global (ou **Auto desligada**, se o global estiver desativado).
- Atualizações manuais de um card mostram estado ocupado apenas no card afetado; falhas de uma conta não bloqueiam as demais.
- Cada card exibe **Última atualização** e **Próxima atualização** com data e hora. A próxima usa o intervalo global para **Automático**, o intervalo da conta para uma opção explícita e **Auto desligada** quando não há auto-refresh.
- O status do cabeçalho mostra as duas quantidades: **18 conexões ativas · 1 conta desligada**, com plural ajustado quando a contagem for diferente de 1. As desligadas vêm da contagem de cards fora de monitoramento.
- **Conta desligada** e **auto-refresh desligado** são conceitos distintos: a primeira é a conexão fora de monitoramento (badge **Desligada** no card) e a segunda é só o intervalo automático da conta (**Desligado** no menu, **Sem auto** no rodapé, **Auto desligada** em **Próxima atualização**).

## Regras de severidade

- **Saudável:** abaixo de 50%.
- **Atenção:** de 50% a 69,9%.
- **Alerta:** de 70% a 89,9%, em amarelo.
- **Crítico:** 90% ou mais, em vermelho.
- A classificação do cliente usa seu Resource Monitor mais crítico.

## Sidebar — estado ativo

Portar para o `AppShell` como estado do item de navegação atual (`aria-current="page"`).

**Geometria do item (todos os estados)**

- Altura mínima `38px`, `padding: 0 0.7rem`, `border-radius: 10px`, `gap: 0.625rem` entre ícone e label.
- Recuo lateral vem do `padding: 0 0.75rem` da sidebar, então o item nunca toca as bordas.
- Ritmo vertical: `gap: 0.125rem` entre itens e `gap: 0.5rem` entre os blocos da sidebar (marca, usuário, nav, sair).
- Ícones sempre `16px`; label `0.9rem`.

**Estados**

| Estado | Fundo | Cor do texto/ícone |
| --- | --- | --- |
| Inativo | transparente | `--muted` (`#8b939e`), ícone `opacity: 0.7` |
| Hover | `rgba(255, 255, 255, 0.03)` | `--text` (`#e8eaed`), ícone `opacity: 1` |
| Ativo | `linear-gradient(90deg, rgba(41, 181, 232, 0.14), rgba(41, 181, 232, 0.04) 55%, transparent)` | `--accent` (`#29b5e8`), ícone `opacity: 1` |
| Foco (teclado) | mantém o fundo do estado | `outline: 2px solid var(--accent)` com `outline-offset: 1px` |

- Sem borda, sem `box-shadow` e sem glow em nenhum estado: o degradê é a única marcação de superfície.
- Marcador de accent: barra de `2px × 18px`, `border-radius: 999px`, `background: var(--accent)`, colada na borda esquerda do item e centrada verticalmente (`top: 50%` + `translateY(-50%)`). Não usar barra de altura total.
- Transição de `background` e `color` em `150ms ease`; `opacity` do ícone também em `150ms ease`.
- Badge de contagem: `margin-left: auto` (alinhado à direita dentro do item), pílula `min-width: 18px` / `height: 18px`, `border-radius: 999px`, fundo `#d0615f`, texto `#fff` em `0.68rem`/`600`.
- Contraste verificado no fundo da sidebar (`#14171c`): accent ativo ≈ 7:1 e label inativo ≈ 5,8:1.
- Marca **Snow Portal**: `600`, `1.05rem`, `letter-spacing: -0.02em`, alinhada ao mesmo recuo horizontal dos itens.

## Diretrizes visuais

- Usar os tokens existentes do Snow Portal para fundo, painéis, bordas, texto e estados.
- Separadores usam cinza suave (`rgba(232, 234, 237, 0.1)`).
- O rodapé de cada card tem separador superior, respiro inferior e mantém atualização, intervalo e refresh juntos.
- Não usar skeletons no card durante refresh; preservar os últimos dados e sinalizar **Atualizando…** no rodapé.

## Implementação sugerida

- Criar uma rota `/alerts` e adicionar o item ao `AppShell`.
- Consultar somente conexões ativas.
- Agregar cada conta pelo maior `quota_used_pct` dos seus Resource Monitors.
- Aplicar ordenação no backend ou imediatamente após a agregação.
- Isolar erros e estados de carregamento por conexão.
- Persistir a preferência de intervalo global e as exceções por conta conforme a estratégia de preferências do portal.
- **Atualizar todas** deve disparar a busca de todas as conexões ativas ignorando os timers, sem gravar preferência, e reagendar os timers a partir da resposta.
- Implementar busca e severidade no cliente sobre a lista já agregada.

## Referência

O mockup funcional está em `html/alerts.html` e contém interações locais para busca, severidade, refresh e intervalos.
