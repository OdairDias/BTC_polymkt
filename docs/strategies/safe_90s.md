# Estrategia: `safe_90s`

## Em uma frase (para leigos)

Esta e uma "Sniper mais segura": entra um pouco antes e aceita um preco menos assimetrico, com tamanho menor, para reduzir variancia e drawdown.

## Objetivo

Variante Sniper conservadora: mais cautelosa que perfis agressivos.

## Identidade

- `key`: `safe_90s`
- `decisionMode`: `sniper_v2`
- Janela tipica: `entryMinutesLeft=0.9` (~54 segundos)
- Alvo tipico: `targetEntryPrice=0.25`
- Tamanho tipico: `notionalUsd=0.75`

## O que ela faz (passo a passo)

Mesma familia da `sniper_45s`:

- gate direcional por `ptbDelta`
- filtros de contradicao RSI e MACD/Heiken
- usa ancora de entrada por `targetEntryPrice`

Na pratica:

1. Espera o mercado entrar na janela final (por volta de 54s).
2. Decide `UP`/`DOWN` via `ptbDelta` e filtra por RSI + MACD/Heiken.
3. Se passar, tenta entrar com `targetEntryPrice=0.25` (menos assimetrico que `0.20`, mas tende a executar com mais frequencia).
4. Aplica guardas de risco e assimetria antes de registrar/operar.

## Por que "safe"

- entrada menos extrema que `0.20`
- notional menor
- pode operar com guardas de risco mais restritivos

## Parametros mais importantes

- `entryMinutesLeft`: `0.9` (aprox 54s) costuma dar um pouco mais de tempo que `0.75` (45s).
- `targetEntryPrice`: `0.25` reduz payout potencial vs `0.20`, mas tende a dar mais fills.
- `notionalUsd`: `0.75` reduz o impacto de sequencias de perdas durante teste.
- `minPayoutMultiple`: se definido, ajuda a manter a asimetria a favor mesmo com preco alvo mais alto.

## Observacoes

- Boa para teste de controle de drawdown.
- Compare contra `sniper_45s` para medir se menor variancia compensa o payoff menor.
