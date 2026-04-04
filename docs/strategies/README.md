# Catalogo de Estrategias (PT-BR)

Esta pasta explica, em linguagem simples, o que cada estrategia faz e como interpretar os resultados no banco.

O objetivo do projeto e rodar uma ou mais estrategias em paralelo (paper e/ou live) para comparar, com base em dados reais, qual combina melhor "direcao + preco" com risco controlado.

## Visao geral (para leigos)

Em mercados binarios (ou de dois lados), cada "lado" tem um preco que varia de 0 a 1. Esse preco pode ser entendido como uma probabilidade implicita. Se voce compra um lado por `0.20` e ele vence, o retorno bruto aproximado e `1 / 0.20 = 5x` (antes de taxas/slippage). Se ele perde, voce perde o valor investido.

Ou seja:

- Direcao: escolher o lado correto (UP/DOWN).
- Asimetria: escolher um preco que compense o risco (payout multiple bom).
- Execucao: entrar na hora certa e conseguir fill sem pagar caro demais.

Este bot tenta combinar esses tres pontos usando dados externos (Binance/Chainlink) e dados do proprio mercado (precos UP/DOWN).

## Como o bot opera (pipeline)

1. Monitora os mercados-alvo (ex: janelas curtas, como 5m).
2. Quando o mercado entra na janela final (ex: faltando 2 minutos, 90s, 45s), a estrategia pode tomar uma decisao.
3. A estrategia escolhe `UP`, `DOWN` ou `SKIP`.
4. Em modo paper: gravamos um sinal e simulamos uma entrada com o preco escolhido.
5. Quando o mercado fecha e resolve, gravamos o resultado oficial (lado vencedor) e calculamos o PnL simulado.
6. Em modo live: apenas uma estrategia (a "armada") pode enviar ordens reais; as demais continuam em paper para comparacao.

## Estrategias ativas (strategy_key)

- `sniper_45s`: "Sniper" principal, decide no fim e tenta entrar com preco-ancora mais assimetrico.
- `main_2m`: estrategia legado (da branch `main`) para comparacao A/B, decide por `upMid` vs `downMid` e entra pelo preco de compra.
- `safe_90s`: variante sniper mais conservadora (preco alvo maior, notional menor e guardas possivelmente mais restritivos).
- `aggr_35s`: variante sniper mais agressiva (janela menor e preco alvo mais baixo).

Arquivos:

- [sniper_45s.md](/Users/Odair/Desktop/Cursor/projeto_PLMK_BTC/PolymarketBTC15mAssistant/docs/strategies/sniper_45s.md)
- [main_2m.md](/Users/Odair/Desktop/Cursor/projeto_PLMK_BTC/PolymarketBTC15mAssistant/docs/strategies/main_2m.md)
- [safe_90s.md](/Users/Odair/Desktop/Cursor/projeto_PLMK_BTC/PolymarketBTC15mAssistant/docs/strategies/safe_90s.md)
- [aggr_35s.md](/Users/Odair/Desktop/Cursor/projeto_PLMK_BTC/PolymarketBTC15mAssistant/docs/strategies/aggr_35s.md)

## Modos de decisao (decisionMode)

O `decisionMode` define "como" a estrategia decide o lado.

### `sniper_v2` (familia Sniper)

Ideia simples:

- Primeiro: decide direcao usando um sinal externo (ex: `ptbDelta` no contexto Binance/Chainlink).
- Depois: aplica filtros para evitar entradas contra o momento (ex: RSI e MACD/Heiken).
- Por fim: se a direcao passar nos filtros, tenta "ancorar" o preco de entrada em `targetEntryPrice` para buscar melhor payout.

Esse modo costuma ser mais seletivo: entra menos, mas tenta entrar melhor.

### `main_2m_mid` (legado)

Ideia simples:

- Compara os precos "mid" dos dois lados (`upMid` vs `downMid`).
- Se estiver empatado dentro do `priceEpsilon`, faz `SKIP_TIE`.
- Caso contrario, escolhe o lado com mid maior.
- O preco de entrada e o preco de compra (`upBuy`/`downBuy`), nao `targetEntryPrice`.

Esse modo e mais "colado" no mercado e menos dependente de sinal externo.

## Parametros (o que significam)

Os parametros abaixo aparecem em `STRATEGY_VARIANTS_JSON` (por estrategia) e/ou nas configs globais.

| Parametro | Onde fica | O que faz (em linguagem simples) |
|---|---|---|
| `key` | variante | Identificador unico da estrategia (vira `strategy_key` no banco). |
| `label` | variante (opcional) | Nome amigavel para logs/dashboards (se nao tiver, usamos o `key`). |
| `decisionMode` | variante | Escolhe o motor de decisao: `sniper_v2` ou `main_2m_mid`. |
| `entryMinutesLeft` | variante | "Faltando quantos minutos para acabar" a estrategia pode entrar (ex: `0.75` = 45s). |
| `targetEntryPrice` | variante (sniper) | Preco ancora que a sniper usa para simular/avaliar a entrada (quanto menor, maior payout, mas mais dificil). |
| `priceEpsilon` | variante (main) | Tolerancia para empate entre `upMid` e `downMid` (evita entrar quando estiver 50/50). |
| `notionalUsd` | variante | Tamanho (em USD) da posicao por trade para essa estrategia. |
| `minPayoutMultiple` | variante/guard | Exige que o payout minimo seja bom. Ex: `2.0` implica evitar precos muito altos. |
| `maxEntryPrice` | variante/guard | Impede pagar caro demais (preco acima disso faz SKIP). |

Observacao: a regra exata de "payout multiple" depende do tipo de mercado, mas para binario simples a aproximacao `payout ~ 1/price` costuma servir como intuicao.

## Configuracao rapida (Railway)

Variaveis de ambiente mais importantes:

- `STRATEGY_ENABLED`: liga/desliga a automacao de estrategia.
- `STRATEGY_DRY_RUN`: `true` significa "nao enviar ordens reais" (paper only).
- `STRATEGY_LIVE_ARMED`: `true` significa "permitido operar live" (se `STRATEGY_DRY_RUN` for `false`).
- `STRATEGY_LIVE_STRATEGY_KEY`: qual `key` tem permissao para enviar ordem real quando live estiver armado.
- `STRATEGY_VARIANTS_JSON`: lista (JSON) das estrategias que devem rodar em paralelo.

Recomendacao operacional: durante testes, manter `STRATEGY_DRY_RUN=true` e rodar varias estrategias em paralelo. Quando for ligar live, armar apenas uma `STRATEGY_LIVE_STRATEGY_KEY` e manter as demais em paper.

### Exemplo: rodar 2 estrategias (Sniper + Main)

```json
[
  { "key": "sniper_45s", "decisionMode": "sniper_v2", "entryMinutesLeft": 0.75, "targetEntryPrice": 0.20, "notionalUsd": 1 },
  { "key": "main_2m", "decisionMode": "main_2m_mid", "entryMinutesLeft": 2.0, "priceEpsilon": 0.001, "notionalUsd": 1 }
]
```

### Exemplo: rodar 4 estrategias (comparacao)

```json
[
  { "key": "sniper_45s", "decisionMode": "sniper_v2", "entryMinutesLeft": 0.75, "targetEntryPrice": 0.20, "notionalUsd": 1 },
  { "key": "main_2m", "decisionMode": "main_2m_mid", "entryMinutesLeft": 2.0, "priceEpsilon": 0.001, "notionalUsd": 1 },
  { "key": "safe_90s", "decisionMode": "sniper_v2", "entryMinutesLeft": 0.9, "targetEntryPrice": 0.25, "notionalUsd": 0.75, "minPayoutMultiple": 2.0 },
  { "key": "aggr_35s", "decisionMode": "sniper_v2", "entryMinutesLeft": 0.58, "targetEntryPrice": 0.18, "notionalUsd": 1 }
]
```

Como adicionar mais estrategias:

1. Duplique um objeto existente.
2. Troque o `key` para um nome novo e unico.
3. Ajuste `entryMinutesLeft`, `targetEntryPrice`/`priceEpsilon`, `notionalUsd` e guardas.
4. Confira no banco se os sinais/outcomes estao sendo gravados com o novo `strategy_key`.

## Como escolher valores (guia rapido)

Se voce vai criar "mais duas estrategias", a forma mais segura e variar um parametro por vez e manter o resto igual.

- `entryMinutesLeft`:
  - maior (ex: 2.0): entra mais cedo e tende a gerar mais trades
  - menor (ex: 0.58): entra mais tarde e tende a ser mais seletiva, mas mais sensivel a ruido
- `targetEntryPrice` (sniper):
  - menor (ex: 0.18): maior payout potencial, menor chance de executar
  - maior (ex: 0.25): menor payout potencial, maior chance de executar
- `priceEpsilon` (main):
  - maior: mais `SKIP_TIE`, menos trades
  - menor: menos `SKIP_TIE`, mais trades
- `notionalUsd`:
  - durante testes, prefira menor (principalmente para variantes agressivas)
- `minPayoutMultiple` e `maxEntryPrice`:
  - sao guardas de "nao pagar caro demais"
  - ajudam a manter a assimetria a favor, mesmo quando a direcao estiver certa

Uma boa pratica e nomear a estrategia pelo que ela muda: `sniper_45s`, `safe_90s`, `aggr_35s` deixam claro tempo e perfil.

## Rastreamento no banco (paper e live)

Os resultados ficam separados por `strategy_key` em:

- `strategy_paper_signals`: cada "decisao" registrada (UP/DOWN/SKIP + contexto de preco).
- `strategy_paper_outcomes`: resultado final oficial (lado vencedor) + hit rate + pnl simulado.
- `strategy_live_orders`: ordens reais quando o live estiver armado.

Queries rapidas para comparar sinais:

```sql
select
  strategy_key,
  count(*) as signals,
  sum(case when chosen_side in ('UP','DOWN') then 1 else 0 end) as actionable_signals
from strategy_paper_signals
group by strategy_key
order by strategy_key;
```

Query para comparar resultado oficial:

```sql
select
  strategy_key,
  count(*) as outcomes,
  avg(case when entry_correct is true then 1.0 else 0.0 end) as hit_rate,
  sum(coalesce(pnl_simulated_usd, 0)) as pnl_simulated
from strategy_paper_outcomes
group by strategy_key
order by strategy_key;
```
