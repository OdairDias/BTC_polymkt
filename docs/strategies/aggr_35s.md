# Estrategia: `aggr_35s`

## Em uma frase (para leigos)

Esta e uma "Sniper mais agressiva": decide muito perto do fim e tenta um preco ainda mais baixo para buscar maior assimetria, aceitando mais risco de nao executar e mais ruido.

## Objetivo

Variante Sniper agressiva para buscar entrada mais rapida e maior convexidade.

## Identidade

- `key`: `aggr_35s`
- `decisionMode`: `sniper_v2`
- Janela tipica: `entryMinutesLeft=0.58` (~35 segundos)
- Alvo tipico: `targetEntryPrice=0.18`
- Epsilon tipico: `priceEpsilon=0.06`

## O que ela faz (passo a passo)

Mesmo nucleo `sniper_v2`:

- direcao por `ptbDelta`
- filtros RSI + MACD/Heiken
- entrada ancorada em `targetEntryPrice`

Na pratica:

1. Espera o mercado entrar na janela final (por volta de 35s).
2. Decide `UP`/`DOWN` via `ptbDelta` e filtra por RSI + MACD/Heiken.
3. Se passar, tenta entrar com `targetEntryPrice=0.18` (mais assimetrico, mas mais dificil).
4. Aplica guardas de risco e assimetria antes de registrar/operar.

## Por que "aggressive"

- janela de reacao menor
- ancora de preco mais baixa
- tende a menos entradas, com payoff potencial maior

## Parametros mais importantes

- `entryMinutesLeft`: `0.58` (aprox 35s) faz a estrategia agir muito no final.
- `targetEntryPrice`: `0.18` aumenta payout potencial, mas aumenta chance de ficar sem fill e aumenta sensibilidade a microestrutura.
- `notionalUsd`: deve ser controlado com cuidado aqui; um perfil agressivo nao deve carregar um notional alto sem guardas.

## Observacoes

- Mais sensivel a ruido de microestrutura e dinamica de fill.
- Deve ser monitorada de perto para streak de perdas e baixa taxa de execucao.
