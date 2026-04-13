# Estrategia: `cheap_15m_tp35`

## Em uma frase (para leigos)

Esta estrategia compra cedo o lado mais barato do mercado de `15 minutos` e tenta sair com lucro em `0.45` ou antes, quando o lucro bruto realizavel ja estiver bom, sem precisar esperar o resultado final.

## Objetivo

Capturar uma reprecificacao curta no meio da janela, em vez de depender apenas de acertar o vencedor no vencimento.

## Identidade

- `key`: `cheap_15m_tp35`
- `decisionMode`: `cheap_revert`
- Mercado: BTC `15m`
- Inicio da janela de entrada: `entryMinutesLeft=13.75` (cerca de 1m15s depois da abertura)
- Fim da janela de entrada: `entryCloseMinutesLeft=5.0`
- Compra maxima: `targetEntryPrice=0.35`
- Piso de compra: `minEntryPrice=0.05`
- Saida no lucro: `takeProfitPrice=0.45`
- Trava de lucro bruto: `grossProfitTargetUsd=0.22`
- Filtro de edge: `minEdge=0.04`
- Filtro de probabilidade: `minModelProb=0.54`
- Filtro de microestrutura (book): `minBookImbalance=0.80`
- Filtro de custo de execução: `maxSpreadToEdgeRatio=0.50`
- Paper fill conservador: `paperFillMode=pessimistic`
- Slippage paper: `paperEntrySlippageBps=25`, `paperExitSlippageBps=35`
- Guard de staleness: `maxOracleLagMs=20000`, `maxBinanceLagMs=6000`, `maxSnapshotAgeMs=4000`
- Sizing dinamico: `sizingMode=kelly`, `kellyFraction=0.35`, faixa `0.70` a `1.00` USD
- Kill-switch diario: `maxDailyLossUsd=2.0` no timezone `America/Sao_Paulo`
- Saida por tempo: `forceExitMinutesLeft=2.5`
- Tipo de ordem: `liveEntryOrderType=FAK`, `liveExitOrderType=FAK`

## O que ela faz (passo a passo)

1. Espera o mercado `15m` abrir e deixa passar um pequeno trecho inicial.
2. A partir de `13.75` minutos restantes, monitora continuamente o mercado ate `5.0` minutos restantes.
3. Em cada tick dentro dessa janela, compara os dois lados (`UP` e `DOWN`).
4. Escolhe o lado mais barato.
5. So entra se esse lado estiver barato, mas ainda "vivo":
   - nao pode estar acima de `0.35`
   - nao pode estar abaixo de `0.05`
   - edge modelado do lado escolhido precisa ser >= `0.04`
  - probabilidade modelada do lado escolhido precisa ser >= `0.54`
   - book imbalance do lado escolhido precisa ser >= `0.80` (bid/ask de liquidez)
   - spread do lado escolhido precisa ser menor que `0.50 * edge` (evita pagar friccao demais)
6. No live, a entrada FAK faz um preflight no book e pode virar `skip` se nao houver asks/lote suficiente ate o preco aceito naquele instante.
7. No paper, aplica modelo pessimista de execucao (slippage + penalidade de spread) para evitar PnL otimista.
8. Se o bid bater `0.45`, sai no lucro antes do vencimento.
9. Mesmo sem bater `0.45`, se o lucro bruto realizavel ja for de pelo menos `+$0.22`, sai no bid atual para nao devolver ganho.
10. Se o alvo nao vier e o tempo estiver acabando, tenta sair quando faltarem `2.5` minutos.
11. Se nem o alvo nem a saida por tempo conseguirem acontecer, a operacao ainda pode acabar sendo resolvida no fechamento oficial.

## Ideia por tras

Essa estrategia nasceu para atacar um problema que apareceu nas operacoes reais: em varias situacoes, a entrada ate era boa, mas o mercado virava no final.

Entao a logica aqui e diferente da sniper:

- a sniper tenta achar um ponto extremo perto do fim para buscar payout alto
- a `cheap_15m_tp35` tenta explorar um exagero de preco mais cedo
- o foco e "comprar barato e vender melhor", nao necessariamente acertar o vencedor final

## Como o mercado 15m e resolvido

A estrategia usa tres tentativas em ordem:

1. **Slug por timestamp** — gera candidatos no formato `btc-updown-15m-{unix_seconds}` para
   a janela atual, a anterior e a proxima. Essa e a resolucao mais rapida.
2. **Fallback por seriesId** — usa o campo `marketSeriesId` da variante (se preenchido).
3. **Fallback por seriesSlug** — usa `marketSeriesSlug=btc-up-or-down-15m` para buscar o
   mercado ativo mais recente diretamente na Gamma API. Este e o safety net principal.

Os logs mostram qual caminho foi usado:
```
[market] resolved via slug: btc-updown-15m-1775...
# ou
[market] slug candidates not found: ... — trying series fallback
[market] resolved via seriesSlug=btc-up-or-down-15m: btc-updown-15m-...
# ou
[market] WARN: market not found for config prefix=btc-updown-15m ...
```

## Parametros mais importantes

- `entryMinutesLeft=13.75`
  - abre a janela de entrada cedo, mas nao no primeiro segundo
- `entryCloseMinutesLeft=5.0`
  - permite novas entradas ate faltarem `5` minutos para o fechamento
- `targetEntryPrice=0.35`
  - se o lado barato estiver acima disso, a estrategia faz skip (`SKIP_CHEAP_TOO_EXPENSIVE`)
- `minEntryPrice=0.05`
  - evita entrar em um lado que ja pode estar esmagado demais (`SKIP_CHEAP_TOO_CHEAP`)
- `minPayoutMultiple=2.0`
  - exige payout minimo de 2x, o que implica preco de entrada <= ~0.50
- `takeProfitPrice=0.45`
  - alvo de saida antecipada no bid
- `grossProfitTargetUsd=0.22`
  - realiza lucro mais cedo quando o valor vendavel da posicao ja estiver acima do custo em pelo menos `$0.22`
- `minEdge=0.04`
  - exige distorcao minima entre probabilidade modelada e probabilidade implicita de mercado
- `minModelProb=0.54`
  - evita entrada quando o proprio modelo nao esta convicto o suficiente
- `forceExitMinutesLeft=2.5`
  - saida por tempo quando faltam 2.5 min, evita carregar ate o fim
- `minBookImbalance=0.80`
  - evita comprar lado com fila muito fraca no bid em relacao ao ask
- `maxSpreadToEdgeRatio=0.50`
  - rejeita trades onde o spread consome metade (ou mais) da vantagem estatistica estimada
- `paperFillMode=pessimistic`
  - simula entrada/saida de forma conservadora (mais perto do que ocorre em execucao real)
- `maxOracleLagMs=20000`, `maxBinanceLagMs=6000`, `maxSnapshotAgeMs=4000`
  - evita abrir novas posicoes quando os dados chegam velhos (stale)
- `sizingMode=kelly`, `kellyFraction=0.35`, `kellyMinNotionalUsd=0.70`, `kellyMaxNotionalUsd=1.00`
  - ajusta o notional por confianca/edge sem passar de `$1.00` por entrada
- no live, compra marketable respeita piso operacional de `$1.00`
  - isso evita rejeicao do CLOB quando o Kelly sugerir algo abaixo do minimo aceito
- `maxDailyLossUsd=2.0`, `riskDayTimezone=America/Sao_Paulo`
  - pausa novas entradas no dia quando a perda acumulada bate o limite

## Leituras praticas

- Se entrar pouco (`SKIP_CHEAP_TOO_EXPENSIVE` frequente): relaxar `targetEntryPrice` e
  recalibrar `minPayoutMultiple` de forma consistente (ex.: 0.38 / 1.55x).
- Se entrar bem, mas nao realizar: calibrar `grossProfitTargetUsd`, `takeProfitPrice` ou antecipar `forceExitMinutesLeft`.
- Se tomar muitas reversoes tardias: revisar a saida por tempo.
- Se ver sempre os mesmos precos nos logs (dado congelado): verificar se o mercado 15m
  esta sendo encontrado; checar as linhas `[market]` no Railway.

## Observacoes

- Esta estrategia roda de forma isolada das de `5m`; observa outro mercado e usa outro grupo de snapshot.
- O resultado dela precisa ser comparado separadamente no painel e no banco, porque a janela e a dinamica sao diferentes.
- Como depende de saida antecipada, faz ainda mais sentido acompanhar `fills`, liquidez no bid e `time stop`.
- O `marketSeriesSlug` em `variants.js` e essencial para o fallback funcionar; nao remover.
- A estrategia continua limitada a uma entrada por mercado; se um tick for `skip`, ela pode tentar de novo enquanto a janela ainda estiver aberta.
