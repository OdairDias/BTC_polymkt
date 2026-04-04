# Estrategia: `main_2m`

## Em uma frase (para leigos)

Esta estrategia tenta "seguir o preco" do proprio mercado: ela escolhe o lado que estiver mais caro (mid maior) e entra pelo preco de compra.

## Objetivo

Reproduzir o comportamento legado da `main` para comparacao A/B direta contra a Sniper.

Na pratica, ela e o nosso "controle": um baseline simples para medir se os filtros e a ancoragem de preco da familia Sniper realmente agregam valor.

## Identidade

- `key`: `main_2m`
- `decisionMode`: `main_2m_mid`
- Janela tipica: `entryMinutesLeft=2.0` (2 minutos)
- Epsilon de empate tipico: `priceEpsilon=0.001`

## O que ela faz (passo a passo)

1. Precisa estar na janela final (`timeLeft <= entryMinutesLeft` e `> 0`).
2. Le `upMid` e `downMid` (os precos "no meio", sem spread de compra/venda).
3. Decide o lado:
   - `abs(upMid - downMid) <= epsilon` -> `SKIP_TIE` (nao entra se estiver 50/50)
   - `upMid > downMid` -> `UP`
   - caso contrario -> `DOWN`
4. Define o preco de entrada pelo preco de compra do lado (`upBuy` ou `downBuy`), nao `targetEntryPrice`.
5. Antes de "aceitar" a entrada (paper ou live), passam os guardas de risco e assimetria (ex: payout minimo, preco maximo, limites de perdas).

## Risco e assimetria

Mesmo framework de guardas apos definir preco:

- cheque de assimetria no preco real selecionado
- limite de perdas rolantes e sequencia de losses

## Parametros mais importantes

- `entryMinutesLeft`: define o tamanho da janela final. `2.0` significa entrar faltando 2 minutos.
- `priceEpsilon`: define o que e considerado "empate". Quanto maior, mais `SKIP_TIE` e menos trades.
- `notionalUsd`: tamanho do trade para essa estrategia (live) e escala do PnL simulado (paper).

## O que comparar no A/B

- Taxa de trades: `main_2m` tende a sinalizar mais porque quase sempre existe um lado com mid maior.
- Preco pago: como entra pelo `buy`, pode pagar mais caro do que uma estrategia ancorada em `targetEntryPrice`.
- Qualidade direcional: por depender menos de sinal externo, pode ficar mais exposta a ruido do proprio mercado.

