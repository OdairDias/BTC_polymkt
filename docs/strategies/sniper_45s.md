# Estrategia: `sniper_45s`

## Em uma frase (para leigos)

Esta estrategia tenta acertar a direcao bem no fim da janela e so entra se o preco permitir um bom "retorno potencial" (assimetria).

## Objetivo

Perfil Sniper principal, focado em conviccao direcional no final da janela com entrada assimetrica.

## Identidade

- `key`: `sniper_45s`
- `decisionMode`: `sniper_v2`
- Janela tipica: `entryMinutesLeft=0.75` (45 segundos)

## O que ela faz (passo a passo)

1. Precisa estar na janela final (`timeLeft <= entryMinutesLeft` e `> 0`).
2. Decide a direcao com base no sinal externo `ptbDelta` (Binance/Chainlink):
   - `ptbDelta >= +5` vira candidato a `UP`
   - `ptbDelta <= -5` vira candidato a `DOWN`
   - entre esses valores, normalmente vira `SKIP` por falta de conviccao
3. Aplica filtros para evitar entradas "no final do movimento":
   - RSI: evita comprar `UP` com RSI muito alto (ex: >= 75) e evita `DOWN` com RSI muito baixo (ex: <= 25)
   - MACD + Heiken: evita entrar quando o momento esta contraditorio com a direcao escolhida
4. Se a direcao passar nos filtros, a estrategia ancora o preco de entrada em `targetEntryPrice`.
5. Antes de "aceitar" a entrada (paper ou live), passam os guardas de risco e assimetria (ex: payout minimo, preco maximo, limites de perdas).

## Risco e assimetria

Esta estrategia respeita os guardas globais/da variante:

- `minPayoutMultiple`
- `maxEntryPrice`
- limite de perdas rolantes e sequencia de losses

## Parametros mais importantes

- `entryMinutesLeft`: define o quao "no final" a estrategia pode agir. `0.75` significa entrar faltando 45s.
- `targetEntryPrice`: define o preco-ancora. Quanto menor, mais assimetrico, mas mais dificil de executar e mais sujeito a ficar sem entrada.
- `notionalUsd`: define o tamanho do trade para essa estrategia no modo live (em paper tambem afeta o PnL simulado).
- `minPayoutMultiple`: define o minimo retorno potencial aceitavel (intuicao: `payout ~ 1/price`).

## Observacoes

- Recomendada como `STRATEGY_LIVE_STRATEGY_KEY` quando live estiver ligado.
- Boa referencia para comparar contra `main_2m`.
